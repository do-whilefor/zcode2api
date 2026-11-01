//go:build integration

package server

import (
	"context"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// This opt-in check uses an installed, trusted Mihomo binary and a private
// subscription supplied by the operator. Ordinary tests stay fully offline.
func TestManagedMihomoSubscription(t *testing.T) {
	binary, subscription := os.Getenv("ZCODE2API_TEST_MIHOMO"), os.Getenv("ZCODE2API_TEST_SUBSCRIPTION")
	if binary == "" || subscription == "" {
		t.Skip("set ZCODE2API_TEST_MIHOMO and ZCODE2API_TEST_SUBSCRIPTION for the opt-in integration check")
	}
	a := networkTestApp(t)
	options := merge(proxyDefaults(), M{"enabled": true, "rotation_enabled": true, "source": "subscription", "subscription_url": subscription, "subscription_filter": os.Getenv("ZCODE2API_TEST_NODE_FILTER"), "mihomo_path": binary})
	setTestProxy(a, options)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	first, release, err := a.pinOutboundProxy(ctx, M{})
	if err != nil {
		t.Fatal(asProxyFailure(err).Message)
	}
	runtime := a.proxies.current
	if len(runtime.endpoints) < 2 {
		release()
		t.Fatal("the integration check requires two filtered nodes")
	}
	// MATCH,REJECT is the runtime default. A successful upstream response proves
	// the per-node HTTP listener's explicit proxy binding is taking effect.
	response, err := a.api(first, M{}, "GET", "/api/v1/client/configs?app_version=3.16.2&platform=linux-x64", "", nil, nil, nil)
	if err != nil || !response.OK {
		release()
		t.Fatal("fixed-node listener could not reach the upstream config API")
	}
	seen := map[string]bool{selectedProxy(first): true}
	release()
	for i := 1; i < len(runtime.endpoints); i++ {
		pinned, done, err := a.pinOutboundProxy(ctx, M{})
		if err != nil {
			t.Fatal(asProxyFailure(err).Message)
		}
		seen[selectedProxy(pinned)] = true
		response, err := a.api(pinned, M{}, "GET", "/api/v1/client/configs?app_version=3.16.2&platform=linux-x64", "", nil, nil, nil)
		done()
		if err != nil || !response.OK {
			t.Fatal("a filtered subscription node failed its upstream check")
		}
	}
	if len(seen) != len(runtime.endpoints) {
		t.Fatal("subscription rotation did not visit every node listener")
	}
	result, err := a.testOutboundProxies(ctx, options)
	if err != nil {
		t.Fatal(asProxyFailure(err).Message)
	}
	for _, value := range arr(result["results"]) {
		if !truth(obj(value)["reachable"]) {
			t.Fatal("draft subscription connectivity check did not return the expected authentication response")
		}
	}
	a.Close()
	for address := range seen {
		u, _ := url.Parse(address)
		connection, err := net.DialTimeout("tcp", u.Host, 100*time.Millisecond)
		if err == nil {
			connection.Close()
			t.Fatal("managed proxy port survived App.Close")
		}
	}
	entries, err := os.ReadDir(filepath.Join(a.data, "runtime"))
	if err != nil || len(entries) != 0 {
		t.Fatal("managed proxy credentials or runtime files survived shutdown")
	}
	t.Logf("validated %d fixed-node listeners, draft probes, and process cleanup", len(seen))
}
