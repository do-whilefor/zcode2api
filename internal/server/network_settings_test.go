package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"
)

func networkTestApp(t *testing.T) *App {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"admin_password":"test-admin-password"}`), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := New(root, filepath.Join(root, "data"), fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	return a
}

func setTestProxy(a *App, options M) {
	a.configMu.Lock()
	a.cfg["outbound_proxy"] = merge(proxyDefaults(), options)
	a.configMu.Unlock()
	a.resetOutboundProxies()
}

func TestProxySelectionIsConcurrentAndPinned(t *testing.T) {
	a := networkTestApp(t)
	addresses := []any{"http://127.0.0.1:18001", "http://127.0.0.1:18002", "http://127.0.0.1:18003"}
	setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "urls": addresses})
	var group sync.WaitGroup
	var mu sync.Mutex
	counts := map[string]int{}
	for range ninetyRequests {
		group.Go(func() {
			ctx, release, err := a.pinOutboundProxy(context.Background(), M{})
			if err != nil {
				t.Error(err)
				return
			}
			defer release()
			nested, end, err := a.pinOutboundProxy(ctx, M{"proxy_url": "http://different.invalid:80"})
			if err != nil || selectedProxy(nested) != selectedProxy(ctx) {
				t.Error("nested operation changed its pinned exit")
			}
			end()
			mu.Lock()
			counts[selectedProxy(ctx)]++
			mu.Unlock()
		})
	}
	group.Wait()
	if counts[str(addresses[0])] != ninetyRequests || len(counts) != 1 {
		t.Fatalf("successful operations must stay on one exit: %v", counts)
	}
	setTestProxy(a, M{"enabled": true, "rotation_enabled": false, "urls": addresses})
	for range 5 {
		ctx, release, err := a.pinOutboundProxy(context.Background(), M{})
		if err != nil || selectedProxy(ctx) != str(addresses[0]) {
			t.Fatal("rotation off must keep the first proxy")
		}
		release()
	}
	ctx, release, err := a.pinOutboundProxy(context.Background(), M{"proxy_url": str(addresses[2])})
	if err != nil || selectedProxy(ctx) != str(addresses[2]) {
		t.Fatal("account proxy must override global settings")
	}
	release()
	setTestProxy(a, M{"enabled": false, "urls": addresses})
	ctx, release, err = a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(ctx) != "" {
		t.Fatal("disabled proxy must use direct transport")
	}
	release()
}

const ninetyRequests = 90

func TestProxyConfigurationPersistenceAndDraftProbe(t *testing.T) {
	a := networkTestApp(t)
	var probes atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probes.Add(1)
		if r.Header.Get("Authorization") != "" {
			t.Error("connectivity probe leaked an account token")
		}
		w.WriteHeader(401)
	}))
	defer proxy.Close()
	a.origin = "http://upstream.invalid"
	handler := httptest.NewServer(a.AdminHandler())
	defer handler.Close()
	call := func(method, path string, body M, token string) (int, M) {
		t.Helper()
		request, err := http.NewRequest(method, handler.URL+path, strings.NewReader(js(body)))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var value M
		if err = json.NewDecoder(response.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, value
	}
	status, _ := call("POST", "/api/settings/proxy/test", M{"outbound_proxy": proxyDefaults()}, "")
	if status != 401 {
		t.Fatal("proxy test must require admin authentication")
	}
	_, login := call("POST", "/api/auth/login", M{"password": "test-admin-password"}, "")
	token := str(login["token"])
	options := merge(proxyDefaults(), M{"enabled": true, "rotation_enabled": true, "urls": []any{proxy.URL, "http://127.0.0.1:18002"}})
	status, result := call("POST", "/api/settings/proxy/test", M{"outbound_proxy": merge(options, M{"urls": []any{proxy.URL}})}, token)
	if status != 200 || !truth(obj(arr(result["results"])[0])["reachable"]) || probes.Load() != 1 {
		t.Fatalf("draft proxy probe failed: %d %v", status, result)
	}
	if truth(obj(a.config()["outbound_proxy"])["enabled"]) || a.proxies.selected != "" {
		t.Fatal("testing a draft must not save or advance production rotation")
	}
	status, result = call("PUT", "/api/settings", M{"outbound_proxy": options, "http": M{"captcha": M{"mode": "auto", "simulate_canvas_webgl": false}}}, token)
	if status != 200 {
		t.Fatalf("save failed: %v", result)
	}
	pinned, end, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(pinned) != proxy.URL {
		t.Fatal("first proxy selection failed")
	}
	a.markProxyFailure(pinned)
	end()
	status, result = call("PUT", "/api/settings", M{"outbound_proxy": options, "poll_interval_sec": 120}, token)
	if status != 200 {
		t.Fatal(result)
	}
	pinned, end, err = a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(pinned) != "http://127.0.0.1:18002" {
		t.Fatal("saving unrelated settings reset the proxy pool cursor")
	}
	end()
	status, result = call("PUT", "/api/settings", M{"outbound_proxy": M{"enabled": false}}, token)
	if status != 200 {
		t.Fatal(result)
	}
	status, result = call("PUT", "/api/settings", M{"outbound_proxy": M{"enabled": true}}, token)
	if status != 200 {
		t.Fatal("partial enable must preserve the saved proxy list", result)
	}
	a.Close()
	reopened, err := New(a.root, a.data, fstest.MapFS{})
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if js(reopened.config()["outbound_proxy"]) != js(options) || truth(obj(obj(reopened.config()["http"])["captcha"])["simulate_canvas_webgl"]) {
		t.Fatal("network settings did not survive restart")
	}
}

func TestProxyPinsSDKSceneAndExpiredTicketRetry(t *testing.T) {
	a := networkTestApp(t)
	var firstMessages, secondMessages, firstConfigs atomic.Int32
	stream := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"test\",\"content\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"OK\"}}\n\nevent: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	handler := func(first bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "configs") {
				if first {
					firstConfigs.Add(1)
				}
				writeJSON(w, 200, M{"code": 0, "data": M{"configs": M{"captcha": M{"enabled": true, "skip_model_request": false, "sceneId": "test-scene", "region": "cn", "prefix": "test-prefix"}}}})
				return
			}
			if r.Header.Get("X-Aliyun-Captcha-Verify-Param") == "" || r.Header.Get("X-Aliyun-Captcha-Verify-Region") != "cn" {
				t.Error("ticket headers missing from the actual inference request")
			}
			if first && firstMessages.Add(1) == 1 {
				writeJSON(w, 403, M{"error": M{"code": "captcha_expired", "message": "expired"}})
				return
			}
			if !first {
				secondMessages.Add(1)
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, stream)
		}
	}
	first := httptest.NewServer(handler(true))
	defer first.Close()
	second := httptest.NewServer(handler(false))
	defer second.Close()
	setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "urls": []any{first.URL, second.URL}})
	a.origin = "http://upstream.invalid"
	obj(obj(a.cfg["http"])["captcha"])["mode"] = "always"
	account, err := a.insertAccount(M{"family": "bigmodel", "device_mid": "test-device", "app_version": "3.16.2"}, M{"zcode_jwt": "test-token"})
	if err != nil {
		t.Fatal(err)
	}
	var issued atomic.Int32
	a.captcha.run = func(ctx context.Context, parameters M) (M, error) {
		if parameters["proxy_url"] != selectedProxy(ctx) {
			t.Error("SDK did not receive the same exit as Go transport")
		}
		return M{"ok": true, "param": fmt.Sprintf("test-ticket-%d", issued.Add(1))}, nil
	}
	for range 2 {
		result, failure := a.inferHTTP(context.Background(), account, inferOptions{ID: "test", Upstream: M{}})
		if failure != nil || result.Text != "OK" {
			t.Fatalf("inference failed: %+v", failure)
		}
	}
	if firstMessages.Load() != 3 || secondMessages.Load() != 0 || firstConfigs.Load() != 2 || issued.Load() != 3 {
		t.Fatalf("scene/SDK/retry changed the sticky exit: messages %d/%d configs %d tickets %d", firstMessages.Load(), secondMessages.Load(), firstConfigs.Load(), issued.Load())
	}
}

func TestSubscriptionFieldsAndSecretSafeErrors(t *testing.T) {
	input := "vless://00000000-0000-0000-0000-000000000001@node.example:443?type=tcp&security=reality&pbk=public-key&sid=12&flow=xtls-rprx-vision&sni=cdn.example#香港高速02\n" +
		"hysteria2://test-password@node.example:8443?insecure=false&sni=cert.example&pinSHA256=AA:BB#香港专线01\n" +
		"vless://00000000-0000-0000-0000-000000000002@node.example:443?type=ws&security=tls&host=cdn.example&path=%2Fsocket#新加坡01"
	nodes, err := decodeSubscription([]byte(base64.StdEncoding.EncodeToString([]byte(input))), "香港")
	if err != nil || len(nodes) != 2 {
		t.Fatalf("subscription decoding/filtering failed: %v", err)
	}
	if obj(nodes[0].config["reality-opts"])["public-key"] != "public-key" || nodes[0].config["flow"] != "xtls-rprx-vision" {
		t.Fatal("Reality parameters lost")
	}
	if nodes[1].config["fingerprint"] != "AABB" || nodes[1].config["skip-cert-verify"] != false || nodes[1].config["password"] != "test-password" {
		t.Fatal("Hysteria certificate pin or authentication parameters lost")
	}
	for _, address := range []string{"https://example.com/sub?token=must-not-leak", "socks5://example.com:1080", "http://example.com:65536", "http://example.com/path"} {
		err := validateOutboundProxy(merge(proxyDefaults(), M{"enabled": true, "urls": []any{address}}))
		if err == nil || strings.Contains(err.Error(), "must-not-leak") {
			t.Fatal("invalid proxy accepted or credentials disclosed")
		}
	}
}

func TestManagedProxyLeaseAndRefreshFallback(t *testing.T) {
	a := networkTestApp(t)
	options := merge(proxyDefaults(), M{"enabled": true, "source": "subscription", "subscription_url": "https://example.invalid/sub?secret=test", "mihomo_path": "missing-test-mihomo"})
	setTestProxy(a, options)
	var stopped atomic.Int32
	runtime := &managedProxyRuntime{key: hash(js(options)), endpoints: []proxyEndpoint{{URL: "http://127.0.0.1:18001", Name: "test"}}, expires: time.Now().Add(-time.Minute), done: make(chan struct{})}
	runtime.stopFn = func() { stopped.Add(1); close(runtime.done) }
	a.proxies.current = runtime
	a.proxies.runtimes = map[*managedProxyRuntime]bool{runtime: true}
	ctx, release, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(ctx) != runtime.endpoints[0].URL {
		t.Fatal("failed refresh discarded a live runtime", err)
	}
	a.resetOutboundProxies()
	if stopped.Load() != 0 {
		t.Fatal("reconfiguration killed a leased runtime")
	}
	release()
	release()
	if stopped.Load() != 1 {
		t.Fatal("retired runtime not stopped exactly once")
	}
}

func TestLegacyProxyConfigurationMigration(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(`{"admin_password":"test","proxy_url":"http://127.0.0.1:18001"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig(root, filepath.Join(root, "data"))
	if err != nil || !truth(obj(cfg["outbound_proxy"])["enabled"]) || len(arr(obj(cfg["outbound_proxy"])["urls"])) != 1 {
		t.Fatal("legacy proxy_url did not migrate", err)
	}
}

func TestConfigTransportFailuresRetryButRiskRefusalsStop(t *testing.T) {
	for _, item := range []struct {
		name, kind, code string
		status           int
		body             string
		retry, cooling   bool
	}{
		{"transport EOF", "network", "captcha_config_unavailable", 0, "", false, true},
		{"WAF HTML", "risk", "upstream_waf_blocked", 405, `<html>errors.aliyun.com/ block_message</html>`, false, true},
		{"business refusal", "risk", "3012", 405, `{"error":{"code":"3012","message":"blocked"}}`, false, true},
		{"proxy auth failure", "network", "proxy_auth_failed", 407, "proxy authentication required", false, true},
		{"temporary origin failure", "server", "captcha_config_unavailable", 503, `{"message":"unavailable"}`, true, false},
	} {
		t.Run(item.name, func(t *testing.T) {
			a := networkTestApp(t)
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if item.status == 0 {
					connection, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					connection.Close()
					return
				}
				w.WriteHeader(item.status)
				io.WriteString(w, item.body)
			}))
			defer proxy.Close()
			setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "urls": []any{proxy.URL}})
			a.origin = "http://upstream.invalid"
			obj(obj(a.cfg["http"])["captcha"])["mode"] = "always"
			_, failure := a.inferHTTP(context.Background(), M{}, inferOptions{ID: "test", Upstream: M{}})
			if failure == nil || failure.Kind != item.kind || failure.Code != item.code || failure.Retryable != item.retry {
				t.Fatalf("incorrect failure classification: %+v", failure)
			}
			_, cooling := a.proxies.unavailable[proxy.URL]
			if cooling != item.cooling {
				t.Fatal("risk refusal or transport failure affected cooldown incorrectly")
			}
		})
	}
}

func TestProxyFailoverRemovesFailuresAndSticksToNextNode(t *testing.T) {
	a := networkTestApp(t)
	addresses := []any{"http://127.0.0.1:18001", "http://127.0.0.1:18002", "http://127.0.0.1:18003"}
	setTestProxy(a, M{"enabled": true, "rotation_enabled": true, "urls": addresses})
	ctx, release, err := a.pinOutboundProxy(context.Background(), M{})
	if err != nil {
		t.Fatal(err)
	}
	a.markProxyFailure(ctx)
	release()
	counts := map[string]int{}
	for range 8 {
		ctx, done, err := a.pinOutboundProxy(context.Background(), M{})
		if err != nil {
			t.Fatal(err)
		}
		counts[selectedProxy(ctx)]++
		done()
	}
	if counts[str(addresses[0])] != 0 || counts[str(addresses[1])] != 8 || counts[str(addresses[2])] != 0 {
		t.Fatalf("unhealthy exit was not skipped: %v", counts)
	}
	ctx, release, err = a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(ctx) != str(addresses[1]) || !a.markProxyFailure(ctx) {
		t.Fatal("second failed node must advance to the third")
	}
	release()
	ctx, release, err = a.pinOutboundProxy(context.Background(), M{})
	if err != nil || selectedProxy(ctx) != str(addresses[2]) || a.markProxyFailure(ctx) {
		t.Fatal("last failed node must exhaust the pool")
	}
	release()
	_, release, err = a.pinOutboundProxy(context.Background(), M{})
	release()
	if err == nil || asProxyFailure(err).Code != "proxy_pool_exhausted" {
		t.Fatal("exhausted pool must fail without reusing failed nodes or going direct")
	}
}
