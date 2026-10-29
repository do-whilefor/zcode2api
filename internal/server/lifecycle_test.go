package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func TestAsyncOAuthRestoresPendingFlow(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	a, e := New(root, data, fstest.MapFS{})
	must(t, e)
	var ready atomic.Bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/cli/init"):
			writeJSON(w, 200, M{"code": 0, "data": M{"flow_id": "test-flow", "authorize_url": "https://example.test/authorize", "expires_at": time.Now().Add(time.Minute).Unix(), "poll_interval_sec": 2}})
		case strings.Contains(r.URL.Path, "/cli/poll/"):
			if !ready.Load() {
				writeJSON(w, 200, M{"code": 0, "data": M{"status": "pending"}})
				return
			}
			writeJSON(w, 200, M{"code": 0, "data": M{"status": "ready", "token": "x.eyJ1c2VyX2lkIjoiMjcwMDE3OTMxNTQwMTk3NzQifQ.x", "bigmodel": M{"access_token": "synthetic-business"}}})
		default:
			writeJSON(w, 200, M{"code": 0, "data": M{}})
		}
	}))
	defer upstream.Close()
	a.origin = upstream.URL
	flow, e := a.startOAuth(context.Background(), "bigmodel", "", true)
	must(t, e)
	equal(t, flow["flow_id"], "test-flow")
	stored := a.row("SELECT poll_token_enc FROM oauth_flows")
	if !strings.HasPrefix(str(stored["poll_token_enc"]), "enc:v1:") {
		t.Fatal("poll token not encrypted")
	}
	a.Close()
	ready.Store(true)
	b, e := New(root, data, fstest.MapFS{})
	must(t, e)
	defer b.Close()
	b.origin = upstream.URL
	b.restoreOAuth()
	deadline := time.Now().Add(4 * time.Second)
	for {
		row := b.row("SELECT * FROM oauth_flows WHERE flow_id='test-flow'")
		if str(row["status"]) == "done" {
			equal(t, b.account(str(row["account_id"]))["customer_id"], "27001793154019774")
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("flow did not complete: %s", js(row))
		}
		time.Sleep(10 * time.Millisecond)
	}
}
func TestCookieIdentityAndProfileCache(t *testing.T) {
	a := testApp(t)
	jwt := func(s string) string { return "x." + base64URL(s) + ".x" }
	token := jwt(`{"user_id":"identity","user_channel":"WEB"}`)
	var calls atomic.Int32
	transport := roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"code":200,"data":{"customerName":"profile-user"}}`)), Request: r}, nil
	})
	a.mu.Lock()
	a.clients[""] = &http.Client{Transport: transport}
	a.mu.Unlock()
	r, e := a.insertAccount(M{"family": "bigmodel", "customer_id": "identity", "label": "备注", "status": "web_only"}, M{"web_jwt": token})
	must(t, e)
	id := str(r["id"])
	equal(t, a.platformName(context.Background(), r), "profile-user")
	equal(t, a.platformName(context.Background(), r), "profile-user")
	equal(t, calls.Load(), 1)
	res, e := a.importCookie(context.Background(), M{"webJwt": jwt(`{"user_id":"wrong","user_channel":"WEB"}`)}, r)
	must(t, e)
	equal(t, res["ok"], false)
	equal(t, a.tokens(id)["web_jwt"], token)
	res, e = a.importCookie(context.Background(), M{"webJwt": token, "expiresAt": nowMS() + 86400000}, r)
	must(t, e)
	equal(t, res["ok"], true)
	if strings.Contains(js(a.publicAccount(a.account(id))), token) {
		t.Fatal("public account leaked token")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func TestErrorClassificationAndStatuses(t *testing.T) {
	for _, tc := range []struct {
		code, kind string
		status     int
	}{{"3008", "busy", 529}, {"1302", "rate_limit", 429}, {"3103", "quota", 403}, {"3007", "auth", 401}, {"3012", "risk", 502}, {"3001", "invalid", 400}, {"1261", "context", 400}} {
		f := classify(&Failure{Status: 500, Code: tc.code, Message: "synthetic"})
		equal(t, f.Kind, tc.kind)
		status, _ := errorShape(f, "chat")
		equal(t, status, tc.status)
	}
	equal(t, classify(&Failure{Status: 403}).Kind, "permission")
	equal(t, retryAfter("3", time.Now()), 3*time.Second)
	now := time.Unix(0, 0)
	equal(t, retryAfter("Thu, 01 Jan 1970 00:00:10 GMT", now), 10*time.Second)
}
func TestGatewayCancellationReleasesSlot(t *testing.T) {
	a := testApp(t)
	_, secret, accounts := testPool(t, a, 1)
	seen := make(chan struct{})
	upstreamCancelled := make(chan struct{})
	installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(seen)
		<-r.Context().Done()
		close(upstreamCancelled)
	})
	s := httptest.NewServer(a.GatewayHandler())
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "POST", s.URL+"/v1/chat/completions", strings.NewReader(js(baseBody("chat", true))))
	req.Header.Set("Authorization", "Bearer "+secret)
	res, e := s.Client().Do(req)
	must(t, e)
	<-seen
	cancel()
	res.Body.Close()
	select {
	case <-upstreamCancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream not cancelled")
	}
	deadline := time.Now().Add(time.Second)
	for {
		a.mu.Lock()
		inflight := a.state(str(accounts[0]["id"])).Inflight
		a.mu.Unlock()
		if !inflight {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("slot not released")
		}
		time.Sleep(time.Millisecond)
	}
}
func TestNativeStartupHasEmbeddedConsole(t *testing.T) {
	a := testApp(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error)
	go func() { done <- a.Run(ctx) }()
	file := filepath.Join(a.data, "ports.json")
	var info M
	deadline := time.Now().Add(2 * time.Second)
	for {
		if b, e := os.ReadFile(file); e == nil {
			info = obj(parse(string(b), nil))
			if info["web_port"] != nil {
				break
			}
		}
		if time.Now().After(deadline) {
			cancel()
			t.Fatal("no runtime info")
		}
		time.Sleep(5 * time.Millisecond)
	}
	defer func() { cancel(); must(t, <-done) }()
	for _, scope := range []string{"web", "gateway"} {
		port := integer(info[scope+"_port"])
		res, e := http.Get(fmt.Sprintf("http://127.0.0.1:%d/healthz", port))
		must(t, e)
		res.Body.Close()
		equal(t, res.StatusCode, 200)
	}
	res, e := http.Get(fmt.Sprintf("http://127.0.0.1:%d/", integer(info["web_port"])))
	must(t, e)
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	equal(t, string(b), "console")
	res, e = http.Get(fmt.Sprintf("http://127.0.0.1:%d/readyz", integer(info["gateway_port"])))
	must(t, e)
	res.Body.Close()
	equal(t, res.StatusCode, 503)
	equal(t, info["backend"], "go")
}

func base64URL(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }

func TestSettingsOverridesSurviveRestart(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "data")
	a, e := New(root, data, fstest.MapFS{})
	must(t, e)
	token := adminToken(t, a)
	w := request(a.AdminHandler(), "PUT", "/api/settings", token, M{"aliases": M{"custom": "m"}, "http": M{"first_token_timeout_ms": 3210}})
	equal(t, w.Code, 200)
	a.Close()
	b, e := New(root, data, fstest.MapFS{})
	must(t, e)
	defer b.Close()
	equal(t, b.config()["aliases"], M{"custom": "m"})
	equal(t, obj(b.config()["http"])["first_token_timeout_ms"], 3210)
	equal(t, obj(b.config()["http"])["idle_timeout_ms"], 120000)
}
