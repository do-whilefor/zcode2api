package server

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func marketingClaimDelivery(position, id string) M {
	visual := "background"
	if position == "popup" {
		visual = "hero"
	}
	return M{"resource_position": position, position: M{
		"buttons": []any{M{"action": M{"type": "close"}}, M{"action": M{"type": "claim_zcode_plan", "args": M{"plan_id": id}}}},
		visual: M{"args": M{"zcode_plan": M{
			"plan_id": id, "name": "Weekend Build", "starts_at": 100, "ends_at": 300,
			"entitlements": []any{M{"show_name": "GLM-5.3-Flash", "grant_units": 300000000, "unit_type": "token", "effective_at": 200}},
		}}},
		"success_popup": M{"buttons": []any{M{"action": M{"type": "claim_zcode_plan", "args": M{"plan_id": "not-available"}}}}},
	}}
}

func TestMarketingClaimsDiscoveryAndAutoClaim(t *testing.T) {
	a := testApp(t)
	_, _, accounts := testPool(t, a, 1)
	id := str(accounts[0]["id"])
	const planID = "weekend-card"
	var claims atomic.Int32
	installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer synthetic-0" || r.Method == "GET" && r.URL.Path == "/api/v1/marketing/touch" && r.Header.Get("X-Device-Mid") != str(accounts[0]["device_mid"]) {
			t.Error("missing account authorization or device identity")
		}
		switch r.URL.Path {
		case "/api/v1/marketing/touch":
			writeJSON(w, 200, M{"code": 0, "data": M{"deliveries": []any{
				marketingClaimDelivery("banner", planID), marketingClaimDelivery("popup", planID),
			}}})
		case "/api/v1/zcode-plan/billing/preview":
			// Reproduce the legacy endpoint's observed success without data.
			writeJSON(w, 200, M{"code": 0, "msg": ""})
		case "/api/v1/incentive/referral/summary":
			writeJSON(w, 200, M{"code": 0, "data": M{"gameplay": M{"status": "online"}, "inviter": M{"rewards": []any{
				M{"state": "in_progress", "plan": M{"plan_id": "unearned-referral-card"}},
			}}}})
		case "/api/v1/zcode-plan/billing/claim":
			claims.Add(1)
			equal(t, r.Method, "POST")
			body, e := readBody(w, r)
			must(t, e)
			equal(t, body["plan_id"], planID)
			writeJSON(w, 200, M{"code": 0, "data": M{"plan": M{"plan_id": planID, "user_plan_id": "claimed"}}})
		case "/api/v1/zcode-plan/billing/balance":
			writeJSON(w, 200, M{"code": 0, "data": M{"plans": []any{}, "balances": []any{}}})
		default:
			t.Errorf("unexpected request: %s", r.URL.Path)
			w.WriteHeader(404)
		}
	})

	discovery := a.discover(context.Background(), id)
	equal(t, len(arr(discovery["previews"])), 1)
	preview := obj(arr(discovery["previews"])[0])
	equal(t, preview["error"], nil)
	if !strings.Contains(str(preview["warning"]), "缺少 data") {
		t.Fatalf("missing partial-source warning: %s", js(preview))
	}
	plans := arr(preview["plans"])
	equal(t, len(plans), 1)
	plan := obj(plans[0])
	equal(t, plan["plan_id"], planID)
	equal(t, plan["name"], "Weekend Build")
	equal(t, plan["ends_at"], 300)
	entitlement := obj(arr(plan["entitlements"])[0])
	equal(t, entitlement["grant_units"], 300000000)
	equal(t, entitlement["effective_at"], 200)

	dry, e := a.autoClaim(context.Background(), true)
	must(t, e)
	jobs := []any{}
	for _, v := range arr(dry["results"]) {
		if truth(obj(v)["would_claim"]) {
			jobs = append(jobs, v)
		}
	}
	equal(t, jobs, []any{M{"account": id, "plan_id": planID, "would_claim": true}})
	equal(t, claims.Load(), 0)

	result, e := a.autoClaim(context.Background(), false)
	must(t, e)
	equal(t, result["claimed"], 1)
	equal(t, claims.Load(), 1)
	equal(t, a.rows("SELECT plan_id,trigger,ok FROM claim_log"), []any{M{"plan_id": planID, "trigger": "auto", "ok": 1}})
}

func TestMarketingPreviewRequiresExplicitClaimAction(t *testing.T) {
	a := testApp(t)
	_, _, accounts := testPool(t, a, 1)
	delivery := marketingClaimDelivery("popup", "action-plan")
	content := obj(delivery["popup"])
	obj(obj(obj(content["hero"])["args"])["zcode_plan"])["plan_id"] = "different-metadata-plan"
	metadataOnly := marketingClaimDelivery("banner", "metadata-only")
	obj(metadataOnly["banner"])["buttons"] = []any{M{"action": M{"type": "open_url", "args": M{"plan_id": "not-a-claim"}}}}
	installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"code": 0, "data": M{"deliveries": []any{metadataOnly, delivery}}})
	})
	preview, e := a.marketingPreview(context.Background(), accounts[0])
	must(t, e)
	equal(t, preview["plans"], []any{M{"plan_id": "action-plan", "name": "action-plan", "entitlements": []any{}}})
}

func TestClaimPreviewSourcesAndValidation(t *testing.T) {
	emptyBilling := M{"code": 0, "data": M{"plans": []any{}}}
	emptyMarketing := M{"code": 0, "data": M{"deliveries": []any{}}}
	billingCard := M{"code": 0, "data": M{"plans": []any{M{"plan_id": "legacy-card"}}}}
	marketingCard := M{"code": 0, "data": M{"deliveries": []any{marketingClaimDelivery("banner", "legacy-card")}}}
	for _, tc := range []struct {
		name               string
		billing, marketing M
		count              int
		warning, failure   bool
	}{
		{"empty lists", emptyBilling, emptyMarketing, 0, false, false},
		{"legacy fallback", billingCard, M{"code": 500, "msg": "unavailable"}, 1, true, false},
		{"deduplicate sources", billingCard, marketingCard, 1, false, false},
		{"missing billing data", M{"code": 0}, emptyMarketing, 0, true, false},
		{"invalid billing plans", M{"code": 0, "data": M{"plans": M{}}}, emptyMarketing, 0, true, false},
		{"missing deliveries", emptyBilling, M{"code": 0, "data": M{}}, 0, true, false},
		{"both unavailable", M{"code": 0}, M{"code": 0}, 0, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := testApp(t)
			_, _, accounts := testPool(t, a, 1)
			installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/marketing/touch" {
					writeJSON(w, 200, tc.marketing)
				} else {
					writeJSON(w, 200, tc.billing)
				}
			})
			preview, e := a.preview(context.Background(), accounts[0])
			equal(t, e != nil, tc.failure)
			equal(t, truth(preview["warning"]), tc.warning)
			equal(t, len(arr(preview["plans"])), tc.count)
		})
	}
}
