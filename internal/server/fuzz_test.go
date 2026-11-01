package server

import (
	"strings"
	"testing"
)

func FuzzDecodeSubscription(f *testing.F) {
	for _, seed := range []string{"http://localhost:8080#node", "vless://offline@localhost:443?type=ws&path=%2Fsocket#node", "hy2://offline@localhost:8443", "aHR0cDovL2xvY2FsaG9zdDo4MDgw", "%%%", ""} {
		f.Add(seed, "")
	}
	f.Fuzz(func(t *testing.T, source, filter string) {
		if len(source) > 8192 || len(filter) > 256 {
			t.Skip()
		}
		nodes, err := decodeSubscription([]byte(source), filter)
		if err != nil {
			return
		}
		if len(nodes) == 0 || len(nodes) > 64 {
			t.Fatalf("invalid node count: %d", len(nodes))
		}
		for _, node := range nodes {
			if str(node.config["server"]) == "" || num(node.config["port"]) < 1 || num(node.config["port"]) > 65535 {
				t.Fatal("accepted invalid endpoint")
			}
		}
	})
}

func FuzzSSEFraming(f *testing.F) {
	for _, seed := range []string{"data: {}\n\n", "event: message_start\r\ndata: {\"type\":\"message_start\"}\r\n\r\n", ": heartbeat\n\ndata: one\ndata: two\n\n", "", "data: partial"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, input string) {
		if len(input) > 8192 {
			t.Skip()
		}
		frames := 0
		_ = readSSE(strings.NewReader(input), func(frame Frame) error {
			frames++
			if frames > len(input)+1 || len(frame.Data) > len(input)+1 {
				t.Fatal("SSE parser produced unbounded output")
			}
			return nil
		})
	})
}
