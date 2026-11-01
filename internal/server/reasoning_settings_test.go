package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"testing/fstest"
)

func TestDefaultReasoningSettingsPersistAndClientTakesPriority(t *testing.T) {
	a := networkTestApp(t)
	key, secret, _ := testPool(t, a, 1)
	admin := a.AdminHandler()
	login := request(admin, "POST", "/api/auth/login", "", M{"password": "test-admin-password"})
	equal(t, login.Code, http.StatusOK)
	token := str(obj(parse(login.Body.String(), nil))["token"])
	for _, invalid := range []any{"off", "none", "medium", "", nil} {
		w := request(admin, "PUT", "/api/settings", token, M{"default_reasoning_level": invalid})
		equal(t, w.Code, http.StatusBadRequest)
	}
	captured := make(chan M, 1)
	installUpstream(t, a, func(w http.ResponseWriter, r *http.Request) {
		var sent M
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		captured <- sent
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, wire(syntheticEvents(false)))
	})
	infer := func(t *testing.T, protocol string, body M) M {
		t.Helper()
		w := request(a.GatewayHandler(), "POST", route(protocol), secret, body)
		equal(t, w.Code, http.StatusOK)
		return <-captured
	}
	for _, level := range []string{"low", "high", "max"} {
		t.Run(level, func(t *testing.T) {
			w := request(admin, "PUT", "/api/settings", token, M{"default_reasoning_level": level})
			equal(t, w.Code, http.StatusOK)
			settings := request(admin, "GET", "/api/settings", token, nil)
			equal(t, obj(parse(settings.Body.String(), nil))["default_reasoning_level"], level)
			for _, protocol := range []string{"chat", "responses", "anthropic"} {
				t.Run(protocol, func(t *testing.T) {
					body := baseBody(protocol, false)
					original := js(body)
					sent := infer(t, protocol, body)
					equal(t, obj(sent["thinking"])["type"], "enabled")
					equal(t, obj(sent["output_config"])["effort"], level)
					equal(t, js(body), original)
				})
			}
		})
	}
	must(t, a.update("keys", "id", str(key["id"]), M{"default_level": "high"}, "default_level"))
	for _, protocol := range []string{"chat", "responses", "anthropic"} {
		t.Run(protocol+" priority", func(t *testing.T) {
			body := baseBody(protocol, false)
			sent := infer(t, protocol, body)
			equal(t, obj(sent["output_config"])["effort"], "high")
			switch protocol {
			case "chat":
				body["reasoning_effort"] = "low"
			case "responses":
				body["reasoning"] = M{"effort": "low"}
			case "anthropic":
				body["thinking"] = M{"type": "adaptive"}
				body["output_config"] = M{"effort": "low"}
			}
			sent = infer(t, protocol, body)
			equal(t, obj(sent["output_config"])["effort"], "low")
		})
	}
	// A second app reads the saved database settings, just as a restart does.
	reopened, err := New(a.root, a.data, fstest.MapFS{})
	must(t, err)
	defer reopened.Close()
	equal(t, reopened.config()["default_reasoning_level"], "max")
}

func TestDefaultReasoningDoesNotOverrideExplicitClientThinking(t *testing.T) {
	a := testApp(t)
	a.cfg["default_reasoning_level"] = "max"
	for _, protocol := range []string{"chat", "responses", "anthropic"} {
		for _, thinking := range []M{
			{"type": "disabled"},
			{"type": "enabled", "budget_tokens": 4000},
			{"type": "enabled", "budget_tokens": 12000},
			{"type": "adaptive"},
		} {
			t.Run(protocol+" "+js(thinking), func(t *testing.T) {
				body := baseBody(protocol, false)
				body["thinking"] = thinking
				level := a.effectiveEffort(body, M{"default_level": "max"})
				upstream, err := buildRequest(body, protocol, "m", level)
				must(t, err)
				equal(t, upstream["thinking"], thinking)
				if thinking["type"] == "disabled" {
					equal(t, obj(upstream["output_config"])["effort"], nil)
				} else {
					equal(t, obj(upstream["output_config"])["effort"], effort(body))
				}
			})
		}
	}
}
