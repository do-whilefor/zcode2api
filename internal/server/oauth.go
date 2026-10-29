package server

import (
	"context"
	"fmt"
	"net/url"
	"time"
)

func publicFlow(r M) M {
	return M{"ok": true, "flow_id": r["flow_id"], "status": r["status"], "error": r["error"], "account_id": r["account_id"], "result": parse(r["result_json"], nil), "authorize_url": r["authorize_url"], "expires_at": r["expires_at"], "provider": r["provider"], "target_id": r["account_rowid"]}
}
func (a *App) startOAuth(ctx context.Context, provider, target string, force bool) (M, error) {
	if provider != "bigmodel" && provider != "zai" {
		return nil, fmt.Errorf("provider 须为 bigmodel|zai")
	}
	if target != "" {
		r := a.account(target)
		if r == nil || str(r["family"]) != provider {
			return nil, fmt.Errorf("账号不存在或授权平台不匹配")
		}
		a.mu.Lock()
		if a.flowLocks["start:"+target] {
			a.mu.Unlock()
			return M{"ok": false, "error": "正在准备授权流程"}, nil
		}
		a.flowLocks["start:"+target] = true
		last := a.reauth[target]
		a.mu.Unlock()
		defer func() { a.mu.Lock(); delete(a.flowLocks, "start:"+target); a.mu.Unlock() }()
		if r := a.row("SELECT * FROM oauth_flows WHERE account_rowid=? AND status='pending' AND expires_at>?", target, nowMS()); r != nil {
			return merge(publicFlow(r), M{"reused": true}), nil
		}
		if !force && last > 0 && nowMS()-last < 30*60000 {
			return nil, nil
		}
		a.mu.Lock()
		a.reauth[target] = nowMS()
		a.mu.Unlock()
	}
	token := random(32)
	res, e := a.api(ctx, nil, "POST", "/api/v1/oauth/cli/init", token, M{"provider": provider}, nil, nil)
	if e != nil {
		return nil, e
	}
	if !res.OK {
		return nil, apiFailure(res, "授权初始化失败")
	}
	d := obj(res.JSON["data"])
	id := str(d["flow_id"])
	u, e := url.Parse(str(d["authorize_url"]))
	if id == "" || e != nil || u.Scheme != "https" || u.Host == "" {
		return nil, fmt.Errorf("授权初始化响应无效")
	}
	expires := integer(d["expires_at"]) * 1000
	if expires == 0 {
		expires = nowMS() + 10*60000
	}
	enc, e := encrypt(token, a.secret)
	if e != nil {
		return nil, e
	}
	interval := max(2, num(first(d["poll_interval_sec"], 3)))
	e = a.exec("INSERT INTO oauth_flows(flow_id,account_rowid,provider,poll_token_enc,authorize_url,status,created_at,expires_at,poll_interval_sec,updated_at) VALUES(?,?,?,?,?,'pending',?,?,?,?)", id, nullable(target), provider, enc, u.String(), nowMS(), expires, interval, nowMS())
	if e != nil {
		return nil, e
	}
	a.watchOAuth(id)
	return M{"ok": true, "reused": false, "flow_id": id, "authorize_url": u.String(), "expires_at": expires, "provider": provider}, nil
}
func (a *App) restoreOAuth() {
	for _, v := range a.rows("SELECT * FROM oauth_flows WHERE status IN ('pending','exchanging')") {
		r := obj(v)
		id := str(r["flow_id"])
		if str(r["status"]) == "exchanging" {
			_ = a.exec("UPDATE oauth_flows SET status='failed',error=?,updated_at=? WHERE flow_id=?", "服务在令牌处理中断，请重新授权", nowMS(), id)
		} else {
			a.watchOAuth(id)
		}
	}
}
func (a *App) watchOAuth(id string) {
	a.mu.Lock()
	if a.flowLocks[id] {
		a.mu.Unlock()
		return
	}
	a.flowLocks[id] = true
	a.mu.Unlock()
	a.background(func() {
		defer func() { a.mu.Lock(); delete(a.flowLocks, id); a.mu.Unlock() }()
		for {
			r := a.row("SELECT * FROM oauth_flows WHERE flow_id=?", id)
			if r == nil || str(r["status"]) != "pending" {
				return
			}
			if integer(r["expires_at"]) <= nowMS() {
				_ = a.exec("UPDATE oauth_flows SET status='expired',error=?,updated_at=? WHERE flow_id=? AND status='pending'", "授权流程已过期", nowMS(), id)
				return
			}
			if pause(a.ctx, time.Duration(max(2, num(r["poll_interval_sec"])))*time.Second) != nil {
				return
			}
			token, e := decrypt(str(r["poll_token_enc"]), a.secret)
			if e != nil {
				_ = a.exec("UPDATE oauth_flows SET status='failed',error=?,updated_at=? WHERE flow_id=?", "无法恢复授权流程", nowMS(), id)
				return
			}
			res, e := a.api(a.ctx, nil, "GET", "/api/v1/oauth/cli/poll/"+url.PathEscape(id), token, nil, nil, nil)
			if e != nil {
				_ = a.exec("UPDATE oauth_flows SET error=?,updated_at=? WHERE flow_id=? AND status='pending'", "轮询暂时失败: "+e.Error(), nowMS(), id)
				continue
			}
			if res.Status >= 400 && res.Status < 500 && res.Status != 408 && res.Status != 429 {
				_ = a.exec("UPDATE oauth_flows SET status='failed',error=?,updated_at=? WHERE flow_id=? AND status='pending'", fmt.Sprintf("授权失败 HTTP %d", res.Status), nowMS(), id)
				return
			}
			if !res.OK {
				continue
			}
			d := obj(res.JSON["data"])
			state := str(d["status"])
			if state == "failed" || state == "expired" {
				_ = a.exec("UPDATE oauth_flows SET status=?,error=?,updated_at=? WHERE flow_id=? AND status='pending'", state, "授权失败", nowMS(), id)
				return
			}
			if state != "ready" && !truth(d["code"]) {
				continue
			}
			result, e := a.db.Exec("UPDATE oauth_flows SET status='exchanging',updated_at=? WHERE flow_id=? AND status='pending'", nowMS(), id)
			if e != nil {
				return
			}
			n, _ := result.RowsAffected()
			if n == 0 {
				return
			}
			completed, e := a.completeOAuth(a.ctx, r, d)
			if e != nil {
				_ = a.exec("UPDATE oauth_flows SET status='failed',error=?,updated_at=? WHERE flow_id=?", e.Error(), nowMS(), id)
			} else {
				_ = a.exec("UPDATE oauth_flows SET status='done',error=NULL,account_id=?,result_json=?,updated_at=? WHERE flow_id=?", completed["id"], js(completed), nowMS(), id)
			}
			return
		}
	})
}
func (a *App) completeOAuth(ctx context.Context, flow, data M) (M, error) {
	provider := str(flow["provider"])
	if !truth(data["token"]) {
		res, e := a.api(ctx, nil, "POST", "/api/v1/oauth/token", "", M{"provider": provider, "code": data["code"], "redirect_uri": "zcode://oauth/callback", "state": data["state"]}, nil, nil)
		if e != nil {
			return nil, e
		}
		if !res.OK {
			return nil, apiFailure(res, "令牌交换失败")
		}
		data = obj(res.JSON["data"])
	}
	if !truth(data["token"]) {
		return nil, fmt.Errorf("授权响应缺少 ZCode token")
	}
	tokens := M{"zcode_jwt": data["token"], "active_provider": provider}
	var expiry any
	if provider == "bigmodel" {
		d := obj(data["bigmodel"])
		access := first(d["access_token"], d["accessToken"])
		if !truth(access) {
			return nil, fmt.Errorf("授权响应缺少 BigModel 业务令牌")
		}
		tokens["business_token"] = access
		if refresh := first(d["refresh_token"], d["refreshToken"]); refresh != nil {
			tokens["refresh_token"] = refresh
		}
	} else {
		access := obj(data["zai"])["access_token"]
		if !truth(access) {
			return nil, fmt.Errorf("授权响应缺少 Z.ai 业务令牌")
		}
		res, e := a.api(ctx, nil, "POST", "https://api.z.ai/api/auth/z/login", "", M{"token": access}, nil, nil)
		if e != nil {
			return nil, e
		}
		d := obj(res.JSON["data"])
		if !res.OK || !truth(d["access_token"]) {
			return nil, apiFailure(res, "业务令牌兑换失败")
		}
		tokens["business_token"], tokens["oauth_access"] = d["access_token"], access
		if truth(d["expires_in"]) {
			expiry = nowMS() + integer(d["expires_in"])*1000
		}
	}
	identity := str(first(obj(data["user"])["user_id"], jwtPayload(str(data["token"]))["user_id"]))
	if identity == "" {
		return nil, fmt.Errorf("授权响应缺少账号身份，无法安全入库")
	}
	target := str(flow["account_rowid"])
	var account M
	if target != "" {
		account = a.account(target)
		if account == nil || str(account["customer_id"]) != identity {
			return nil, fmt.Errorf("授权账号与待续期账号不一致，未更新凭据")
		}
	} else {
		account = a.row("SELECT * FROM accounts WHERE family=? AND customer_id=?", provider, identity)
	}
	updated := account != nil
	var e error
	if updated {
		e = a.setTokens(str(account["id"]), tokens)
	} else {
		account, e = a.insertAccount(M{"label": "OAuth-" + provider + "-" + identity[max(0, len(identity)-4):], "family": provider, "customer_id": identity, "source": "oauth"}, tokens)
	}
	if e != nil {
		return nil, e
	}
	_ = a.updateAccount(str(account["id"]), M{"business_token_expires_at": expiry})
	verified, e := a.verify(ctx, a.account(str(account["id"])))
	if e != nil {
		verified = M{"ok": false, "status": "unverified", "reason": e.Error()}
		_ = a.updateAccount(str(account["id"]), M{"status": "unverified", "last_error": e.Error()})
	}
	a.scheduleNext(str(account["id"]), time.Second)
	a.mu.Lock()
	delete(a.reauth, str(account["id"]))
	a.mu.Unlock()
	return M{"id": account["id"], "updated": updated, "verified": verified["ok"], "status": verified["status"], "reason": verified["reason"]}, nil
}
