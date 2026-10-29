package server

import (
	"context"
	"strings"
	"time"
)

type schedulingCandidate struct {
	row       M
	remaining float64
	skip      string
}
type schedulingPool struct {
	group    M
	accounts []schedulingCandidate
}

func (a *App) schedulingPools(key M) []schedulingPool {
	query := `SELECT a.*,g.id AS _gid,g.name AS _name,g.role AS _role,g.policy AS _policy,g.family_filter AS _family,g.urgent_window_min AS _urgent FROM groups g LEFT JOIN accounts a ON a.group_id=g.id WHERE g.enabled=1`
	chain, explicit := parse(key["group_order"], nil).([]any)
	args := []any{}
	if explicit {
		if len(chain) == 0 {
			return nil
		}
		query += " AND g.id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(chain)), ",") + ")"
		args = append(args, chain...)
	}
	query += " ORDER BY g.created_at,g.id,a.created_at,a.id"
	pools := map[string]*schedulingPool{}
	order := []string{}
	for _, v := range a.rows(query, args...) {
		r := obj(v)
		gid := str(r["_gid"])
		pool := pools[gid]
		if pool == nil {
			pool = &schedulingPool{group: M{"id": gid, "name": r["_name"], "role": r["_role"], "policy": r["_policy"], "family_filter": r["_family"], "urgent_window_min": r["_urgent"]}}
			pools[gid] = pool
			order = append(order, gid)
		}
		if r["id"] != nil {
			pool.accounts = append(pool.accounts, schedulingCandidate{row: r})
		}
	}
	if !explicit {
		chain = []any{}
		for _, role := range []string{"primary", "backup"} {
			for _, id := range order {
				if str(pools[id].group["role"]) == role {
					chain = append(chain, id)
					break
				}
			}
		}
	}
	out := make([]schedulingPool, 0, len(chain))
	seen := map[string]bool{}
	for _, id := range chain {
		gid := str(id)
		if p := pools[gid]; p != nil && !seen[gid] {
			out = append(out, *p)
			seen[gid] = true
		}
	}
	return out
}

func (a *App) selectAccount(o inferOptions, excluded map[string]bool) (M, bool, []any, string) {
	params := a.retryParams()
	now := nowMS()
	minWindow := int64(num(fallback(params["min_request_window_sec"], 60)) * 1000)
	pools := a.schedulingPools(o.Key)
	for pi := range pools {
		p := &pools[pi]
		for i := range p.accounts {
			c := &p.accounts[i]
			r := c.row
			switch {
			case excluded[str(r["id"])]:
				c.skip = "excluded_for_request"
			case str(r["status"]) != "active":
				c.skip = "status=" + str(r["status"])
			case truth(r["card_expires_at"]) && integer(r["card_expires_at"])-now < minWindow:
				c.skip = "card_expiring"
			case truth(p.group["family_filter"]) && p.group["family_filter"] != r["family"]:
				c.skip = "family_filter"
			}
			if c.skip != "" {
				continue
			}
			caps := arr(parse(r["capabilities"], nil))
			if len(caps) > 0 {
				allowed := false
				for _, cap := range caps {
					if strings.EqualFold(str(cap), o.Model) {
						allowed = true
						break
					}
				}
				if !allowed {
					c.skip = "model_not_available"
					continue
				}
			}
			data := balanceData(r)
			balances := liveBalances(data, now)
			for _, v := range balances {
				c.remaining += num(obj(v)["remaining_units"])
			}
			if len(arr(data["balances"])) > 0 && (len(balances) == 0 || c.remaining <= 0) {
				c.skip = "quota_remaining=0"
			}
		}
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	candidates := []any{}
	busy := false
	for _, p := range pools {
		usable := make([]schedulingCandidate, 0, len(p.accounts))
		for _, c := range p.accounts {
			reason := c.skip
			id := str(c.row["id"])
			if reason == "" && a.state(id).Cooldown > now {
				reason = "cooldown"
			}
			candidates = append(candidates, M{"account": id, "label": c.row["label"], "skip": nullable(reason), "picked": false})
			if reason == "" {
				usable = append(usable, c)
			}
		}
		policy := str(p.group["policy"])
		sticky := a.sticky[o.Affinity]
		stickyValid := o.Sticky > 0 && float64(now-sticky.At) <= o.Sticky*60000
		urgentWindow := int64(num(fallback(p.group["urgent_window_min"], 180)) * 60000)
		preferred := func(x, y schedulingCandidate) bool {
			xs, ys := a.state(str(x.row["id"])), a.state(str(y.row["id"]))
			if stickyValid {
				xp, yp := str(x.row["id"]) == sticky.Account && !xs.Inflight, str(y.row["id"]) == sticky.Account && !ys.Inflight
				if xp != yp {
					return xp
				}
			}
			switch policy {
			case "remaining_desc":
				return x.remaining > y.remaining
			case "expiring_first":
				xe, ye := integer(x.row["card_expires_at"]), integer(y.row["card_expires_at"])
				xu, yu := xe > 0 && xe-now < urgentWindow, ye > 0 && ye-now < urgentWindow
				if xu != yu {
					return xu
				}
				if xu {
					return xe < ye
				}
				return xs.LastUsed > ys.LastUsed
			default:
				return xs.LastUsed < ys.LastUsed
			}
		}
		var picked *schedulingCandidate
		for i := range usable {
			c := &usable[i]
			id := str(c.row["id"])
			s := a.state(id)
			if s.Inflight {
				busy = true
				continue
			}
			if picked == nil || preferred(*c, *picked) {
				picked = c
			}
		}
		if picked != nil {
			id := str(picked.row["id"])
			a.state(id).Inflight = true
			for _, v := range candidates {
				if m := obj(v); str(m["account"]) == id {
					m["picked"] = true
				}
			}
			return picked.row, busy, candidates, policy
		}
	}
	return nil, busy, candidates, ""
}

func (a *App) availability() <-chan struct{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.available == nil {
		a.available = make(chan struct{})
	}
	return a.available
}
func (a *App) notifyAvailableLocked() {
	if a.available != nil {
		close(a.available)
	}
	a.available = make(chan struct{})
}
func (a *App) notifyAvailable() { a.mu.Lock(); a.notifyAvailableLocked(); a.mu.Unlock() }
func (a *App) release(id string) {
	a.mu.Lock()
	s := a.state(id)
	s.Inflight = false
	s.LastUsed = nowMS()
	a.notifyAvailableLocked()
	a.mu.Unlock()
}
func (a *App) acquire(ctx context.Context, o inferOptions, skip map[string]bool, limit time.Duration) (M, bool, []any, string, error) {
	deadline := time.Now().Add(limit)
	var lastCandidates []any
	firstTry := true
	for {
		if e := ctx.Err(); e != nil {
			return nil, false, lastCandidates, "", e
		}
		if !firstTry && !time.Now().Before(deadline) {
			return nil, true, lastCandidates, "", nil
		}
		firstTry = false
		changed := a.availability()
		r, b, c, p := a.selectAccount(o, skip)
		lastCandidates = c
		if r != nil || !b {
			return r, b, c, p, nil
		}
		left := time.Until(deadline)
		if left <= 0 {
			return nil, true, c, p, nil
		}
		timer := time.NewTimer(min(left, time.Second))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, false, c, p, ctx.Err()
		case <-changed:
			timer.Stop()
		case <-timer.C:
		}
	}
}
