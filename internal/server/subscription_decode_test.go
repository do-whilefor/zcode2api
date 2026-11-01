package server

import (
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
)

func TestSubscriptionEncodingsAndProtocolOptions(t *testing.T) {
	content := "\ufeffhttps://user:password@proxy.example:8443#TLS\nvless://identity@ws.example:443?type=ws&security=tls&host=cdn.example&path=%2Fsocket&alpn=h2,http%2F1.1#WebSocket\nhy2://user:password@hy.example:8443?peer=cert.example&obfs=salamander&obfs-password=offline#Hysteria\nhttp://plain.example#Plain"
	for _, encoding := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		nodes, err := decodeSubscription([]byte(encoding.EncodeToString([]byte(content))), "")
		must(t, err)
		equal(t, len(nodes), 4)
		equal(t, nodes[0].config["tls"], true)
		equal(t, nodes[0].config["username"], "user")
		equal(t, nodes[0].config["password"], "password")
		equal(t, obj(nodes[1].config["ws-opts"])["path"], "/socket")
		equal(t, obj(obj(nodes[1].config["ws-opts"])["headers"])["Host"], "cdn.example")
		equal(t, nodes[1].config["alpn"], []any{"h2", "http/1.1"})
		equal(t, nodes[2].config["password"], "user:password")
		equal(t, nodes[2].config["sni"], "cert.example")
		equal(t, nodes[2].config["obfs-password"], "offline")
		equal(t, nodes[3].config["port"], 80)
	}
	nodes, err := decodeSubscription([]byte("http://same.example#one\nhttp://same.example#two\nvless://identity@tcp.example?type=raw#raw"), "")
	must(t, err)
	equal(t, len(nodes), 2)
	equal(t, nodes[1].config["network"], "tcp")
}

func TestSubscriptionRejectsMalformedAndExcessiveNodes(t *testing.T) {
	for _, item := range []struct{ source, filter, code string }{
		{"%%%", "", "proxy_subscription_invalid"},
		{"http://host", "[", "proxy_subscription_invalid"},
		{"socks5://host\nvless://host\nvless://id@host?type=grpc\nvless://id@host?security=reality\nhy2://host\nhttp://host:99999\nnot-a-url", "", "proxy_subscription_empty"},
		{"http://host#name", "no-match", "proxy_subscription_empty"},
	} {
		_, err := decodeSubscription([]byte(item.source), item.filter)
		if err == nil || asProxyFailure(err).Code != item.code {
			t.Fatalf("unexpected subscription result: %v", err)
		}
	}
	var lines []string
	for i := 0; i < 65; i++ {
		lines = append(lines, fmt.Sprintf("http://node-%d.example#node-%d", i, i))
	}
	_, err := decodeSubscription([]byte(strings.Join(lines, "\n")), "")
	if err == nil || asProxyFailure(err).Code != "proxy_subscription_too_large" {
		t.Fatal("oversized node list accepted")
	}
}
