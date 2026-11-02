package server

import (
	"context"
	"encoding/json"
	"math"
	"net/http/httptest"
	"testing"
)

func TestLegacyRotationOptionsKeepHealthyNodePinned(t *testing.T) {
	options := merge(proxyDefaults(), M{"rotation_enabled": true, "rotation_interval_sec": 60})
	endpoints := []proxyEndpoint{{URL: "http://one:80"}, {URL: "http://two:80"}, {URL: "http://three:80"}}
	manager := &outboundProxyManager{}
	for range 100 {
		if actual, _ := manager.selectEndpoint(options, endpoints); actual != 0 {
			t.Fatalf("legacy timer changed a healthy exit: %d", actual)
		}
	}
}

func TestFailoverKeepsInflightRequestsPinned(t *testing.T) {
	a := networkTestApp(t)
	setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "rotation_interval_sec": 60, "urls": []any{"http://one:80", "http://two:80"}})
	first, release, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	a.markProxyFailure(first)
	second, end, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil {
		t.Fatal(err)
	}
	defer end()
	if selectedProxy(first) != "http://one:80" || selectedProxy(second) != "http://two:80" {
		t.Fatal("failover must change new operations while preserving the original context")
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
