package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// The test executable can act as a tiny local Mihomo protocol fixture. It never
// opens an outbound connection or needs a real subscription, proxy or API key.
func init() {
	if os.Getenv("Z2A_OFFLINE_MIHOMO_HELPER") != "1" {
		return
	}
	var filename string
	for i := 1; i+1 < len(os.Args); i++ {
		if os.Args[i] == "-f" {
			filename = os.Args[i+1]
		}
	}
	body, err := os.ReadFile(filename)
	if err != nil {
		os.Exit(2)
	}
	var config struct {
		AllowLAN  bool     `json:"allow-lan"`
		Rules     []string `json:"rules"`
		Listeners []struct {
			Listen string `json:"listen"`
			Port   int    `json:"port"`
			Proxy  string `json:"proxy"`
		} `json:"listeners"`
	}
	if json.Unmarshal(body, &config) != nil || config.AllowLAN || len(config.Listeners) == 0 || len(config.Rules) != 1 || config.Rules[0] != "MATCH,REJECT" {
		os.Exit(3)
	}
	for _, listener := range config.Listeners {
		if listener.Listen != "127.0.0.1" || listener.Proxy == "" {
			os.Exit(4)
		}
		connection, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", listener.Port))
		if err != nil {
			os.Exit(5)
		}
		name := listener.Proxy
		go http.Serve(connection, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "messages") {
				writeJSON(w, http.StatusUnauthorized, M{"error": M{"code": "authentication_error"}})
			} else {
				writeJSON(w, 200, M{"code": 0, "data": M{"node": name}})
			}
		}))
	}
	select {}
}

func offlineSubscription(t *testing.T, content string, status int) string {
	t.Helper()
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("subscription download sent account credentials")
		}
		w.WriteHeader(status)
		fmt.Fprint(w, content)
	}))
	t.Cleanup(server.Close)
	previous := http.DefaultTransport
	http.DefaultTransport = server.Client().Transport.(*http.Transport).Clone()
	t.Cleanup(func() {
		http.DefaultTransport.(*http.Transport).CloseIdleConnections()
		http.DefaultTransport = previous
	})
	return server.URL + "/subscription?token=offline-only"
}

func TestManagedProxyOfflineLifecycleAndDraftProbe(t *testing.T) {
	t.Setenv("Z2A_OFFLINE_MIHOMO_HELPER", "1")
	binary, err := os.Executable()
	must(t, err)
	subscription := offlineSubscription(t, "http://first.example:8080#first\nhttp://second.example:8080#second", 200)
	a := networkTestApp(t)
	a.origin = "http://offline-upstream.invalid"
	options := merge(proxyDefaults(), M{"enabled": true, "rotation_enabled": true, "source": "subscription", "subscription_url": subscription, "mihomo_path": binary})
	setTestProxy(a, options)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	first, releaseFirst, err := a.pinOutboundProxy(ctx, nil)
	must(t, err)
	old := a.proxies.current
	response, err := a.api(first, nil, "GET", "/configs", "", nil, nil, nil)
	must(t, err)
	equal(t, obj(response.JSON["data"])["node"], "node-1")
	second, releaseSecond, err := a.pinOutboundProxy(ctx, nil)
	must(t, err)
	if selectedProxy(first) == selectedProxy(second) {
		t.Fatal("different nodes shared a listener")
	}
	response, err = a.api(second, nil, "GET", "/configs", "", nil, nil, nil)
	must(t, err)
	equal(t, obj(response.JSON["data"])["node"], "node-2")
	releaseSecond()
	a.proxies.mu.Lock()
	old.expires = time.Now().Add(-time.Second)
	a.proxies.mu.Unlock()
	_, releaseNew, err := a.pinOutboundProxy(ctx, nil)
	must(t, err)
	if a.proxies.current == old || !old.alive() {
		t.Fatal("refresh did not replace the runtime while preserving its active lease")
	}
	releaseNew()
	releaseFirst()
	if old.alive() {
		t.Fatal("retired process survived its final lease")
	}
	probe, err := a.testOutboundProxies(ctx, options)
	must(t, err)
	for _, row := range arr(probe["results"]) {
		equal(t, obj(row)["reachable"], true)
	}
	current := a.proxies.current
	a.Close()
	if current.alive() {
		t.Fatal("managed child survived application shutdown")
	}
}

func TestManagedSubscriptionDownloadFailuresStayOffline(t *testing.T) {
	binary, err := os.Executable()
	must(t, err)
	for _, item := range []struct {
		status        int
		content, code string
	}{
		{503, "unavailable", "proxy_subscription_unavailable"},
		{200, strings.Repeat("a", (2<<20)+1), "proxy_subscription_unavailable"},
		{200, "%%%", "proxy_subscription_invalid"},
	} {
		t.Run(item.code+fmt.Sprint(item.status, len(item.content)), func(t *testing.T) {
			subscription := offlineSubscription(t, item.content, item.status)
			a := networkTestApp(t)
			_, err := a.startManagedProxy(context.Background(), merge(proxyDefaults(), M{"mihomo_path": binary, "subscription_url": subscription}))
			if err == nil || asProxyFailure(err).Code != item.code || strings.Contains(err.Error(), "offline-only") {
				t.Fatalf("unexpected download failure: %v", err)
			}
		})
	}
}
