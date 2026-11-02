package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestGatewayProxyFailoverThenKeepsSuccessfulNode(t *testing.T) {
	a := testApp(t)
	_, secret, accounts := testPool(t, a, 1)
	a.origin = "http://upstream.invalid"
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	dead.Close()
	var blockedCalls, wafCalls, goodCalls atomic.Int32
	blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		blockedCalls.Add(1)
		writeJSON(w, 405, M{"code": 3012, "msg": "request has been blocked due to unusual activity. " + strings.Repeat("details ", 1000)})
	}))
	defer blocked.Close()
	waf := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wafCalls.Add(1)
		w.WriteHeader(403)
		io.WriteString(w, "<html>errors.aliyun.com/ block_message</html>")
	}))
	defer waf.Close()
	good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		goodCalls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, wire(syntheticEvents(false)))
	}))
	defer good.Close()
	// Legacy switches must not disable failure recovery or re-enable timed rotation.
	setTestProxy(a, M{"enabled": true, "rotation_enabled": false, "rotation_interval_sec": 60, "urls": []any{dead.URL, blocked.URL, waf.URL, good.URL}})
	for range 3 {
		response := request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
		if response.Code != 200 || !strings.Contains(response.Body.String(), "你好") {
			t.Fatalf("proxy failover failed: %d %s", response.Code, response.Body.String())
		}
	}
	equal(t, blockedCalls.Load(), 1)
	equal(t, wafCalls.Load(), 1)
	equal(t, goodCalls.Load(), 3)
	equal(t, len(a.proxies.unavailable), 3)
	logs := a.rows("SELECT attempt_count,account_id FROM usage_log ORDER BY id")
	equal(t, obj(logs[0])["attempt_count"], 4)
	for _, log := range logs {
		equal(t, obj(log)["account_id"], accounts[0]["id"])
	}
}

func TestProxyRiskExhaustionDoesNotReplayFailedNodes(t *testing.T) {
	a := testApp(t)
	_, secret, _ := testPool(t, a, 1)
	a.origin = "http://upstream.invalid"
	var calls atomic.Int32
	newBlocked := func() *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			writeJSON(w, 403, M{"error": M{"code": "3012", "message": strings.Repeat("blocked ", 1000)}})
		}))
	}
	first, second := newBlocked(), newBlocked()
	defer first.Close()
	defer second.Close()
	setTestProxy(a, M{"enabled": true, "urls": []any{first.URL, second.URL}})
	response := request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
	equal(t, response.Code, 502)
	if !strings.Contains(response.Body.String(), "上游风控拦截") || strings.Contains(response.Body.String(), "blocked ") {
		t.Fatal("risk response was not summarized", response.Body.String())
	}
	response = request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
	if !strings.Contains(response.Body.String(), "proxy_pool_exhausted") {
		t.Fatal("exhausted pool must return a clear error", response.Body.String())
	}
	equal(t, calls.Load(), 2)
}

func TestProxyFailureIgnoresCancellationOverridesAndStaleSelections(t *testing.T) {
	a := networkTestApp(t)
	options := M{"enabled": true, "urls": []any{"http://one:80", "http://two:80"}}
	setTestProxy(a, options)
	old, release, err := a.pinOutboundProxy(context.Background(), M{})
	must(t, err)
	defer release()
	canceled, cancel := context.WithCancel(old)
	cancel()
	if a.markProxyFailure(canceled) || len(a.proxies.unavailable) != 0 {
		t.Fatal("client cancellation retired a healthy node")
	}
	override, end, err := a.pinOutboundProxy(context.Background(), M{"proxy_url": "http://one:80"})
	must(t, err)
	defer end()
	if a.markProxyFailure(override) || len(a.proxies.unavailable) != 0 {
		t.Fatal("account override altered the global pool")
	}
	setTestProxy(a, options)
	current, done, err := a.pinOutboundProxy(context.Background(), M{})
	must(t, err)
	defer done()
	if a.markProxyFailure(old) || len(a.proxies.unavailable) != 0 || selectedProxy(current) != "http://one:80" {
		t.Fatal("failure from the old configuration poisoned the new pool")
	}
}

func TestProxyDoesNotRetireNodesForBusinessErrors(t *testing.T) {
	for _, item := range []struct {
		status int
		code   string
	}{{401, "authentication_error"}, {403, "permission_error"}, {400, "invalid_request_error"}, {403, "insufficient_quota"}, {429, "rate_limit_error"}, {503, "overloaded_error"}} {
		t.Run(item.code, func(t *testing.T) {
			a := networkTestApp(t)
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writeJSON(w, item.status, M{"error": M{"code": item.code, "message": "business error"}})
			}))
			defer proxy.Close()
			a.origin = "http://upstream.invalid"
			setTestProxy(a, M{"enabled": true, "urls": []any{proxy.URL}})
			_, failure := a.inferHTTP(context.Background(), M{}, inferOptions{ID: "test", Upstream: M{}})
			if failure == nil || len(a.proxies.unavailable) != 0 {
				t.Fatal("business error retired a healthy proxy", failure)
			}
		})
	}
}

func TestProxyStreamRiskRetriesOnlyBeforeOutput(t *testing.T) {
	for _, visible := range []bool{false, true} {
		t.Run(fmt.Sprintf("visible=%v", visible), func(t *testing.T) {
			a := testApp(t)
			_, secret, _ := testPool(t, a, 1)
			a.origin = "http://upstream.invalid"
			var blockedCalls, goodCalls atomic.Int32
			blocked := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				blockedCalls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				prefix := syntheticEvents(false)[:1]
				if visible {
					prefix = syntheticEvents(false)[:3]
				}
				io.WriteString(w, wire(append(prefix, M{"type": "error", "error": M{"code": "3012", "message": "blocked"}})))
			}))
			defer blocked.Close()
			good := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				goodCalls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				io.WriteString(w, wire(syntheticEvents(false)))
			}))
			defer good.Close()
			setTestProxy(a, M{"enabled": true, "urls": []any{blocked.URL, good.URL}})
			response := request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", true))
			equal(t, response.Code, 200)
			if visible {
				equal(t, goodCalls.Load(), 0)
				if !strings.Contains(response.Body.String(), "上游风控拦截") {
					t.Fatal("committed stream must end with a concise error")
				}
			} else {
				equal(t, goodCalls.Load(), 1)
				if !strings.Contains(response.Body.String(), "你好") {
					t.Fatal("uncommitted stream did not fail over")
				}
			}
			equal(t, blockedCalls.Load(), 1)
			response = request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
			equal(t, response.Code, 200)
			equal(t, blockedCalls.Load(), 1)
		})
	}
}

func TestProxySDKRiskSwitchesAndObtainsFreshTickets(t *testing.T) {
	a := testApp(t)
	_, secret, _ := testPool(t, a, 1)
	a.origin = "http://upstream.invalid"
	obj(obj(a.cfg["http"])["captcha"])["mode"] = "always"
	var firstMessages, goodMessages atomic.Int32
	handler := func(first bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "configs") {
				writeJSON(w, 200, M{"code": 0, "data": M{"configs": M{"captcha": M{"enabled": true, "sceneId": "test", "region": "cn", "prefix": "test"}}}})
				return
			}
			if first {
				firstMessages.Add(1)
			} else {
				goodMessages.Add(1)
			}
			if r.Header.Get("X-Aliyun-Captcha-Verify-Param") == "" {
				t.Error("new exit did not obtain a verification ticket")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, wire(syntheticEvents(false)))
		}
	}
	first, second := httptest.NewServer(handler(true)), httptest.NewServer(handler(false))
	defer first.Close()
	defer second.Close()
	var issued, rejected atomic.Int32
	a.captcha.run = func(ctx context.Context, parameters M) (M, error) {
		if parameters["proxy_url"] != selectedProxy(ctx) {
			t.Error("SDK used a different exit")
		}
		if selectedProxy(ctx) == first.URL {
			rejected.Add(1)
			return M{"ok": false, "verify_code": "F001"}, nil
		}
		return M{"ok": true, "param": fmt.Sprintf("ticket-%d", issued.Add(1))}, nil
	}
	setTestProxy(a, M{"enabled": true, "urls": []any{first.URL, second.URL}})
	for range 2 {
		response := request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
		if response.Code != 200 {
			t.Fatal(response.Code, response.Body.String())
		}
	}
	equal(t, firstMessages.Load(), 0)
	equal(t, rejected.Load(), 1)
	equal(t, goodMessages.Load(), 2)
	equal(t, issued.Load(), 2)
}
