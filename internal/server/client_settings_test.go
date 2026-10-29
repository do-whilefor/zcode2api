package server

import (
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestClientVersionSettingsValidateBothAPIs(t *testing.T) {
	for _, settings := range []M{
		{"app_version": "3.16.2"},
		{"http": M{"client_version": "0.17.0"}},
	} {
		must(t, validateSettings(settings))
	}
	for _, settings := range []M{
		{"app_version": ""},
		{"app_version": "3.16.2\r\nX-Extra: 1"},
		{"app_version": "latest"},
		{"http": M{"client_version": "latest"}},
	} {
		if validateSettings(settings) == nil {
			t.Fatalf("accepted malformed client version: %v", settings)
		}
	}
}

func TestRiskRejectionStopsWithoutRetryOrAccountRotation(t *testing.T) {
	a := testApp(t)
	_, secret, _ := testPool(t, a, 2)
	var calls atomic.Int32
	installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		writeJSON(w, 405, M{"code": 3012, "msg": "request has been blocked due to unusual activity."})
	})
	w := request(a.GatewayHandler(), "POST", "/v1/chat/completions", secret, baseBody("chat", false))
	equal(t, calls.Load(), 1)
	equal(t, w.Code, 502)
	if !strings.Contains(w.Body.String(), "3012") {
		t.Fatal("risk error code was not preserved for the client")
	}
	for _, status := range []int{403, 405, 503, 529} {
		f := classify(&Failure{Status: status, Code: "3012"})
		equal(t, f.Kind, "risk")
		equal(t, f.Retryable, false)
	}
}
