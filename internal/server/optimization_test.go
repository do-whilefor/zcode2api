package server

import (
	"context"
	"fmt"
	"io"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"
)

func benchmarkApp(b *testing.B, count int) (*App, inferOptions) {
	b.Helper()
	root := b.TempDir()
	a, e := New(root, filepath.Join(root, "data"), fstest.MapFS{})
	if e != nil {
		b.Fatal(e)
	}
	a.log.SetOutput(io.Discard)
	b.Cleanup(a.Close)
	for i := 0; i < count; i++ {
		r, e := a.insertAccount(M{"label": fmt.Sprint(i), "family": "bigmodel", "status": "active"}, M{"zcode_jwt": "synthetic"})
		if e != nil {
			b.Fatal(e)
		}
		if e = a.updateAccount(str(r["id"]), M{"capabilities": []any{"m"}, "last_balance": M{"data": M{"balances": []any{M{"remaining_units": 1000, "total_units": 2000, "used_units": 1000}}}}}); e != nil {
			b.Fatal(e)
		}
	}
	return a, inferOptions{Key: M{"id": "benchmark", "group_order": `["g_main"]`}, Model: "m"}
}
func BenchmarkConfigSnapshot(b *testing.B) {
	a, _ := benchmarkApp(b, 0)
	b.ReportAllocs()
	for b.Loop() {
		_ = a.config()
	}
}
func BenchmarkSelectAccount(b *testing.B) {
	a, o := benchmarkApp(b, 32)
	b.ReportAllocs()
	for b.Loop() {
		r, _, _, _ := a.selectAccount(o, nil)
		if r == nil {
			b.Fatal("no account")
		}
		a.release(str(r["id"]))
	}
}
func BenchmarkAccountSummary(b *testing.B) {
	a, _ := benchmarkApp(b, 16)
	b.ReportAllocs()
	for b.Loop() {
		_ = a.summary()
	}
}

func TestCloneIsolationAndIntegerPrecision(t *testing.T) {
	original := M{"nested": M{"list": []any{M{"value": "original"}}}, "identity": int64(27001793154019774)}
	copied := clone(original)
	obj(arr(obj(copied["nested"])["list"])[0])["value"] = "changed"
	equal(t, obj(arr(obj(original["nested"])["list"])[0])["value"], "original")
	equal(t, integer(copied["identity"]), int64(27001793154019774))
	a := testApp(t)
	cfg := a.config()
	obj(cfg["http"])["first_token_timeout_ms"] = 1
	equal(t, obj(a.config()["http"])["first_token_timeout_ms"], 60000)
}

func TestDatabaseWaitDoesNotBlockAccountRelease(t *testing.T) {
	a := testApp(t)
	k, _, accounts := testPool(t, a, 1)
	o := inferOptions{Key: k, Model: "m"}
	selected, _, _, _ := a.selectAccount(o, nil)
	if selected == nil {
		t.Fatal("no account")
	}
	conn, e := a.db.Conn(context.Background())
	must(t, e)
	defer conn.Close()
	initial := a.db.Stats().WaitCount
	done := make(chan M, 1)
	go func() { r, _, _, _ := a.selectAccount(o, nil); done <- r }()
	deadline := time.Now().Add(time.Second)
	for a.db.Stats().WaitCount == initial {
		if time.Now().After(deadline) {
			t.Fatal("selector never queried database")
		}
		time.Sleep(time.Millisecond)
	}
	released := make(chan struct{})
	go func() { a.release(str(accounts[0]["id"])); close(released) }()
	select {
	case <-released:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("database query held reservation lock")
	}
	must(t, conn.Close())
	select {
	case r := <-done:
		if r != nil {
			a.release(str(r["id"]))
		}
	case <-time.After(time.Second):
		t.Fatal("selector did not resume")
	}
}

func TestAvailabilityBroadcastAndRecovery(t *testing.T) {
	a := testApp(t)
	k, _, accounts := testPool(t, a, 1)
	id := str(accounts[0]["id"])
	r, _, _, _ := a.selectAccount(inferOptions{Key: k, Model: "m"}, nil)
	if r == nil {
		t.Fatal("no reservation")
	}
	first, second := a.availability(), a.availability()
	a.release(id)
	for _, ch := range []<-chan struct{}{first, second} {
		select {
		case <-ch:
		default:
			t.Fatal("waiter was not notified")
		}
	}
	next := a.availability()
	must(t, a.updateAccount(id, M{"status": "cooldown"}))
	select {
	case <-next:
	default:
		t.Fatal("account change not broadcast")
	}
}

func TestResponsesOverlappingToolsKeepOutputOrder(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/", nil)
	s := newStream(w, r, "responses", "resp_test", "m", false)
	defer s.end()
	for _, e := range []Event{{Type: "text_delta", Text: "before"}, {Type: "tool_start", Index: 4, ID: "call_a", Name: "lookup"}, {Type: "tool_start", Index: 7, ID: "call_b", Name: "lookup"}, {Type: "tool_delta", Index: 7, Delta: `{"b":2}`}, {Type: "text_delta", Text: "after"}, {Type: "tool_delta", Index: 4, Delta: `{"a":1}`}, {Type: "tool_end", Index: 7}, {Type: "tool_end", Index: 4}} {
		must(t, s.onEvent(e))
	}
	result := &Result{Text: "beforeafter", Calls: []any{M{"id": "call_a"}, M{"id": "call_b"}}, Usage: M{}}
	response := s.complete(result, M{"id": "resp_test"})
	items := arr(response["output"])
	equal(t, len(items), 4)
	equal(t, obj(items[0])["type"], "message")
	equal(t, obj(items[1])["call_id"], "call_a")
	equal(t, obj(items[2])["call_id"], "call_b")
	equal(t, obj(items[3])["type"], "message")
	equal(t, obj(items[1])["arguments"], `{"a":1}`)
	equal(t, response["output_text"], "beforeafter")
}

func TestSchedulerPoliciesAndStickyEligibility(t *testing.T) {
	for _, tc := range []struct {
		policy string
		want   int
	}{{"balanced", 2}, {"remaining_desc", 1}, {"expiring_first", 0}} {
		t.Run(tc.policy, func(t *testing.T) {
			a := testApp(t)
			k, _, accounts := testPool(t, a, 3)
			must(t, a.update("groups", "id", "g_main", M{"policy": tc.policy}, "policy"))
			for i, remaining := range []int{100, 300, 200} {
				must(t, a.updateAccount(str(accounts[i]["id"]), M{"last_balance": M{"balances": []any{M{"remaining_units": remaining}}}}))
			}
			must(t, a.updateAccount(str(accounts[0]["id"]), M{"card_expires_at": nowMS() + 30*60000}))
			a.mu.Lock()
			for i, r := range accounts {
				a.state(str(r["id"])).LastUsed = int64(30 - i*10)
			}
			a.mu.Unlock()
			o := inferOptions{Key: k, Model: "m", Affinity: str(k["id"]), Sticky: 10}
			r, _, _, _ := a.selectAccount(o, nil)
			equal(t, r["id"], accounts[tc.want]["id"])
			a.release(str(r["id"]))
			a.mu.Lock()
			a.sticky[o.Affinity] = stickyEntry{str(accounts[0]["id"]), nowMS()}
			a.mu.Unlock()
			r, _, _, _ = a.selectAccount(o, nil)
			equal(t, r["id"], accounts[0]["id"])
			a.release(str(r["id"]))
			must(t, a.updateAccount(str(accounts[0]["id"]), M{"last_balance": M{"balances": []any{M{"remaining_units": 0}}}}))
			r, _, _, _ = a.selectAccount(o, nil)
			if r == nil || r["id"] == accounts[0]["id"] {
				t.Fatal("sticky bypassed quota filter")
			}
			a.release(str(r["id"]))
		})
	}
}
