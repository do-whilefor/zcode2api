package server

import (
	"context"
	"fmt"
	"net/url"
)

func (a *App) preview(ctx context.Context, r M) (M, error) {
	res, e := a.api(ctx, r, "GET", "/api/v1/zcode-plan/billing/preview?app_version="+url.QueryEscape(str(a.config()["app_version"]))+"&platform="+url.QueryEscape(platform()), str(a.tokens(str(r["id"]))["zcode_jwt"]), nil, M{"X-Device-Mid": r["device_mid"]}, a.jar(str(r["id"])))
	if e != nil {
		return nil, e
	}
	if !res.OK || !codeIs(res.JSON["code"], 0) {
		return nil, apiFailure(res, "preview 失败")
	}
	return obj(res.JSON["data"]), nil
}
func (a *App) incentives(ctx context.Context, r M) (M, error) {
	res, e := a.api(ctx, r, "GET", "/api/v1/incentive/referral/summary", str(a.tokens(str(r["id"]))["zcode_jwt"]), nil, nil, nil)
	if e != nil {
		return nil, e
	}
	if !res.OK {
		return nil, apiFailure(res, "奖励任务查询失败")
	}
	d := obj(res.JSON["data"])
	rewards, tasks := []any{}, []any{}
	for _, role := range []string{"invitee", "inviter"} {
		section := obj(d[role])
		if section["visible"] == false {
			continue
		}
		for _, v := range arr(section["rewards"]) {
			r := obj(v)
			p := obj(r["progress"])
			var plan any
			if r["plan"] != nil {
				x := obj(r["plan"])
				plan = M{"name": x["name"], "plan_id": x["plan_id"], "entitlements": arr(x["entitlements"])}
			}
			rewards = append(rewards, M{"role": role, "title": first(r["title"], r["reward_type"], "活动奖励"), "description": fallback(r["description"], ""), "rule": fallback(r["rule"], ""), "state": fallback(r["state"], ""), "current": first(p["current"], r["current"], 0), "target": first(p["target"], r["target"], 0), "issued": first(r["issued"], 0), "plan": plan})
		}
	}
	for _, v := range arr(obj(d["invitee"])["tasks"]) {
		t := obj(v)
		tasks = append(tasks, M{"key": t["key"], "completed": truth(t["completed"])})
	}
	return M{"active": str(obj(d["gameplay"])["status"]) == "online", "ends_at": obj(d["gameplay"])["ends_at"], "tasks": tasks, "rewards": rewards}, nil
}
func (a *App) discover(ctx context.Context, id string) M {
	accounts := a.rows("SELECT * FROM accounts ORDER BY created_at")
	if id != "" {
		accounts = []any{}
		if r := a.account(id); r != nil {
			accounts = append(accounts, r)
		}
	}
	previews := []any{}
	for _, v := range accounts {
		r := obj(v)
		if !truth(a.tokens(str(r["id"]))["zcode_jwt"]) {
			continue
		}
		m := M{"account_id": r["id"], "label": r["label"], "plans": []any{}}
		if p, e := a.preview(ctx, r); e == nil {
			m["plans"] = arr(p["plans"])
		} else {
			m["error"] = e.Error()
		}
		if reward, e := a.incentives(ctx, r); e == nil {
			m["incentives"] = reward
		} else {
			m["incentives_error"] = e.Error()
		}
		previews = append(previews, m)
	}
	return M{"previews": previews}
}
func (a *App) claim(ctx context.Context, id, plan, trigger string) (M, error) {
	lock := id + ":" + plan
	a.mu.Lock()
	if a.claimLocks[lock] {
		a.mu.Unlock()
		return M{"ok": false, "code": "in_progress", "message": "该奖励正在领取，请稍候"}, nil
	}
	a.claimLocks[lock] = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.claimLocks, lock); a.mu.Unlock() }()
	r := a.account(id)
	if r == nil {
		return nil, fmt.Errorf("账号不存在")
	}
	token := str(a.tokens(id)["zcode_jwt"])
	if token == "" {
		return nil, fmt.Errorf("该账号无 zcode_jwt，无法领取")
	}
	res, e := a.api(ctx, r, "POST", "/api/v1/zcode-plan/billing/claim", token, M{"plan_id": plan}, M{"X-Device-Mid": r["device_mid"]}, a.jar(id))
	if e != nil {
		return nil, e
	}
	data := obj(res.JSON["data"])
	p := obj(data["plan"])
	ok := res.Status == 200 && codeIs(res.JSON["code"], 0) && len(p) > 0
	var code any
	if res.JSON["code"] != nil {
		code = str(res.JSON["code"])
	}
	message := first(data["message"], res.JSON["msg"], "")
	end := secondsMS(p["ends_at"])
	_ = a.exec("INSERT INTO claim_log(account_id,ts,plan_id,ok,code,message,user_plan_id,ends_at,trigger) VALUES(?,?,?,?,?,?,?,?,?)", id, nowMS(), plan, integer(ok), code, message, p["user_plan_id"], end, trigger)
	a.audit("system", "claim", M{"account": id, "plan_id": plan, "ok": ok, "code": code}, "")
	if ok {
		if b, e := a.fetchBalance(ctx, r); e == nil && truth(b["ok"]) {
			a.applyBalance(r, b, true)
		}
	}
	var resultPlan any
	if len(p) > 0 {
		resultPlan = p
	}
	return M{"ok": ok, "httpStatus": res.Status, "code": code, "message": message, "plan": resultPlan, "endsAt": end}, nil
}
func (a *App) autoClaim(ctx context.Context, dry bool) (M, error) {
	lock := "__auto"
	a.mu.Lock()
	if a.claimLocks[lock] {
		a.mu.Unlock()
		return M{"checked": 0, "claimed": 0, "results": []any{}, "in_progress": true}, nil
	}
	a.claimLocks[lock] = true
	a.mu.Unlock()
	defer func() { a.mu.Lock(); delete(a.claimLocks, lock); a.mu.Unlock() }()
	checked, claimed := 0, 0
	results := []any{}
	for _, v := range a.rows("SELECT * FROM accounts WHERE status IN ('active','unverified','cooldown') ORDER BY created_at") {
		if ctx.Err() != nil {
			break
		}
		r := obj(v)
		id := str(r["id"])
		if !truth(a.tokens(id)["zcode_jwt"]) {
			continue
		}
		checked++
		p, e := a.preview(ctx, r)
		if e != nil {
			results = append(results, M{"account": id, "error": e.Error()})
			continue
		}
		seen := map[string]bool{}
		for _, v := range arr(p["plans"]) {
			plan := str(obj(v)["plan_id"])
			if plan == "" || seen[plan] {
				continue
			}
			seen[plan] = true
			if dry {
				results = append(results, M{"account": id, "plan_id": plan, "would_claim": true})
				continue
			}
			res, e := a.claim(ctx, id, plan, "auto")
			if e != nil {
				results = append(results, M{"account": id, "error": e.Error()})
				continue
			}
			if truth(res["ok"]) {
				claimed++
			}
			results = append(results, merge(res, M{"account": id, "plan_id": plan}))
		}
	}
	return M{"checked": checked, "claimed": claimed, "results": results}, nil
}
