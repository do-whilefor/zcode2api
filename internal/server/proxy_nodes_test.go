package server

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
)

func TestProxyNodeListingIsSecretSafeAndDoesNotChangePool(t *testing.T) {
	a := networkTestApp(t)
	options := merge(proxyDefaults(), M{"enabled": true, "urls": []any{"http://user:private-password@one:80", "http://two:80", "http://two:80"}})
	result, err := a.outboundProxyNodes(context.Background(), options)
	must(t, err)
	equal(t, len(arr(result["nodes"])), 2)
	if strings.Contains(js(result), "private-password") || strings.Contains(js(result), "user:") {
		t.Fatal("node listing exposed proxy credentials")
	}
	if a.proxies.key != "" || a.proxies.selected != "" || truth(obj(a.config()["outbound_proxy"])["enabled"]) {
		t.Fatal("draft listing selected a route or saved settings")
	}
	response := request(a.AdminHandler(), "POST", "/api/settings/proxy/nodes", "", M{"outbound_proxy": options})
	equal(t, response.Code, 401)
}

func TestPreferredProxyPersistsAndStillFailsOver(t *testing.T) {
	a := networkTestApp(t)
	addresses := []any{"http://one:80", "http://two:80"}
	preferred := (proxyEndpoint{URL: str(addresses[1])}).selectionID()
	_, status, err := a.adminRoute(httptest.NewRequest("PUT", "/api/settings", nil), M{"outbound_proxy": M{"enabled": true, "urls": addresses, "preferred_node": preferred}})
	must(t, err)
	equal(t, status, 200)
	ctx, release, err := a.pinOutboundProxy(context.Background(), nil)
	must(t, err)
	equal(t, selectedProxy(ctx), addresses[1])
	if !a.markProxyFailure(ctx) {
		t.Fatal("preferred node failure must permit a replacement")
	}
	release()
	for range 3 {
		ctx, release, err = a.pinOutboundProxy(context.Background(), nil)
		must(t, err)
		equal(t, selectedProxy(ctx), addresses[0])
		release()
	}
	result, _, err := a.adminRoute(httptest.NewRequest("POST", "/api/settings/proxy/nodes", nil), M{"outbound_proxy": M{}})
	must(t, err)
	nodes := arr(obj(result)["nodes"])
	equal(t, obj(nodes[0])["current"], true)
	equal(t, obj(nodes[1])["unavailable"], true)
	a.Close()
	reopened, err := New(a.root, a.data, fstest.MapFS{})
	must(t, err)
	defer reopened.Close()
	equal(t, obj(reopened.config()["outbound_proxy"])["preferred_node"], preferred)
	ctx, release, err = reopened.pinOutboundProxy(context.Background(), nil)
	must(t, err)
	defer release()
	equal(t, selectedProxy(ctx), addresses[1])
}

func TestSubscriptionNodesCanBeListedWithoutMihomoAndSelectedByIdentity(t *testing.T) {
	t.Setenv("Z2A_OFFLINE_MIHOMO_HELPER", "1")
	content := "http://user:node-private-password@first.example:8080#香港01\nhttp://second.example:8080#香港02"
	subscription := offlineSubscription(t, content, 200)
	a := networkTestApp(t)
	a.origin = "http://upstream.invalid"
	options := merge(proxyDefaults(), M{"enabled": true, "source": "subscription", "subscription_url": subscription, "mihomo_path": "missing-mihomo"})
	result, err := a.outboundProxyNodes(context.Background(), options)
	must(t, err)
	nodes := arr(result["nodes"])
	equal(t, len(nodes), 2)
	equal(t, obj(nodes[0])["name"], "香港01")
	if a.proxies.current != nil || strings.Contains(js(result), "node-private-password") || strings.Contains(js(result), "first.example") {
		t.Fatal("listing started Mihomo or exposed node connection details")
	}
	binary, err := os.Executable()
	must(t, err)
	options["mihomo_path"], options["preferred_node"] = binary, obj(nodes[1])["id"]
	setTestProxy(a, options)
	ctx, release, err := a.pinOutboundProxy(context.Background(), nil)
	must(t, err)
	defer release()
	response, err := a.api(ctx, nil, "GET", "/configs", "", nil, nil, nil)
	must(t, err)
	equal(t, obj(response.JSON["data"])["node"], "node-2")
}

func TestPreferredProxyValidationAndMissingNodeFallback(t *testing.T) {
	for _, value := range []any{nil, 1, "http://user:secret@one:80", strings.Repeat("z", 64)} {
		if validateOutboundProxyFields(M{"preferred_node": value}) == nil {
			t.Fatal("accepted invalid preferred node ID", value)
		}
	}
	manager := &outboundProxyManager{}
	options := merge(proxyDefaults(), M{"preferred_node": hash("removed-node")})
	index, _ := manager.selectEndpoint(options, []proxyEndpoint{{URL: "http://one:80"}})
	equal(t, index, 0)
}
