package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
	"time"
)

func TestTimedRotationAndFailureFailover(t *testing.T) {
	options := merge(proxyDefaults(), M{"rotation_enabled": true, "rotation_interval_sec": 60})
	endpoints := []proxyEndpoint{{URL: "http://one:80"}, {URL: "http://two:80"}, {URL: "http://three:80"}}
	manager := &outboundProxyManager{}
	start := time.Unix(1000, 0)
	for _, item := range []struct{ seconds, expected int }{{0, 0}, {1, 0}, {59, 0}, {60, 1}, {61, 1}, {119, 1}, {120, 2}} {
		if actual := manager.selectEndpoint(options, endpoints, start.Add(time.Duration(item.seconds)*time.Second)); actual != item.expected {
			t.Fatalf("at %ds got node %d, want %d", item.seconds, actual, item.expected)
		}
	}
	manager.unavailable = map[string]time.Time{endpoints[2].URL: start.Add(160 * time.Second)}
	if actual := manager.selectEndpoint(options, endpoints, start.Add(121*time.Second)); actual != 0 {
		t.Fatal("network failure must advance immediately, before the timer expires")
	}
	if actual := manager.selectEndpoint(options, endpoints, start.Add(180*time.Second)); actual != 0 {
		t.Fatal("failover must start a fresh interval")
	}
	if actual := manager.selectEndpoint(options, endpoints, start.Add(181*time.Second)); actual != 1 {
		t.Fatal("timed rotation did not resume after failover")
	}
	for _, endpoint := range endpoints {
		manager.unavailable[endpoint.URL] = start.Add(time.Hour)
	}
	first := manager.selectEndpoint(options, endpoints, start.Add(182*time.Second))
	second := manager.selectEndpoint(options, endpoints, start.Add(183*time.Second))
	if first == second {
		t.Fatal("all-cooling probes must still visit different exits")
	}
}

func TestTimedRotationKeepsInflightRequestsPinned(t *testing.T) {
	a := networkTestApp(t)
	setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "rotation_interval_sec": 60, "urls": []any{"http://one:80", "http://two:80"}})
	first, release, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	a.proxies.mu.Lock()
	a.proxies.rotatedAt = time.Now().Add(-time.Minute)
	a.proxies.mu.Unlock()
	second, end, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	if selectedProxy(first) != "http://one:80" || selectedProxy(second) != "http://two:80" {
		t.Fatal("new operations must rotate without changing the original context")
	}
	nested, done, err := a.pinOutboundProxy(first, M{})
	if err != nil || selectedProxy(nested) != selectedProxy(first) {
		t.Fatal("a nested SDK/retry call changed its existing exit")
	}
	done()
	_, status, err := a.adminRoute(httptest.NewRequest("PUT", "/api/settings", nil), M{"outbound_proxy": M{"rotation_interval_sec": 45}})
	if err != nil || status != 200 || num(obj(obj(a.setting("config_overrides", M{}))["outbound_proxy"])["rotation_interval_sec"]) != 45 {
		t.Fatal("rotation interval was not persisted")
	}
}

func TestRotationIntervalValidation(t *testing.T) {
	for _, value := range []any{-1, 0.5, 86401, "60", nil, true, math.NaN()} {
		if err := validateOutboundProxyFields(M{"rotation_interval_sec": value}); err == nil {
			t.Fatalf("accepted invalid interval %v", value)
		}
	}
	for _, value := range []any{0, 1, 60, 86400, json.Number("45")} {
		if err := validateOutboundProxyFields(M{"rotation_interval_sec": value}); err != nil {
			t.Fatalf("rejected valid interval %v: %v", value, err)
		}
	}
}
