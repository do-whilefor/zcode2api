package server

import (
	"context"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCaptchaRuntimeStatusMissingNodeAndInvalidPaths(t *testing.T) {
	a := networkTestApp(t)
	status := a.captchaRuntimeStatus(context.Background(), M{"node_path": filepath.Join(a.root, "missing-node")})
	equal(t, status["ready"], false)
	equal(t, obj(status["node"])["installed"], false)
	equal(t, obj(status["jsdom"])["available"], false)
	response := request(a.AdminHandler(), "GET", "/api/settings/captcha/runtime", "", nil)
	equal(t, response.Code, 401)
	for _, query := range []string{"node_path=", "jsdom_path=" + url.QueryEscape("bad\x00path"), "node_path=" + strings.Repeat("x", 4097)} {
		_, status, err := a.adminRoute(httptest.NewRequest("GET", "/api/settings/captcha/runtime?"+query, nil), nil)
		must(t, err)
		equal(t, status, 400)
	}
}

func TestCaptchaRuntimeStatusUsesConfiguredModuleWithoutChangingSettings(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the runtime integration test")
	}
	a := networkTestApp(t)
	status := a.captchaRuntimeStatus(context.Background(), M{"node_path": node})
	equal(t, obj(status["node"])["available"], true)
	equal(t, obj(status["jsdom"])["installed"], false)
	// Use the actual installed library in a private module directory. A working
	// global/project dependency must not mask an empty or broken configured path.
	library, err := filepath.Abs(filepath.Join("..", "..", "captcha_node", "node_modules", "jsdom"))
	must(t, err)
	if _, err = os.Stat(library); err != nil {
		t.Skip("install captcha_node dependencies to test jsdom loading")
	}
	moduleRoot := filepath.Join(a.root, "custom directory")
	module := filepath.Join(moduleRoot, "node_modules", "jsdom")
	must(t, os.MkdirAll(module, 0700))
	must(t, os.WriteFile(filepath.Join(module, "index.js"), []byte("module.exports = require("+js(library)+");"), 0600))
	must(t, os.WriteFile(filepath.Join(module, "package.json"), []byte(`{"name":"jsdom","version":"26.1.0","main":"index.js"}`), 0600))
	query := url.Values{"node_path": {node}, "jsdom_path": {"custom directory"}}.Encode()
	value, code, err := a.adminRoute(httptest.NewRequest("GET", "/api/settings/captcha/runtime?"+query, nil), nil)
	must(t, err)
	equal(t, code, 200)
	equal(t, obj(value)["ready"], true)
	equal(t, obj(obj(value)["jsdom"])["version"], "26.1.0")
	equal(t, obj(obj(value)["jsdom"])["path"], module)
	equal(t, obj(obj(a.config()["http"])["captcha"])["jsdom_path"], "")
	if _, err := os.Stat(filepath.Join(a.data, "runtime")); !os.IsNotExist(err) {
		t.Fatal("runtime detection created SDK/helper files")
	}
	must(t, os.WriteFile(filepath.Join(module, "index.js"), []byte(`throw new Error('private dependency details');`), 0600))
	status = a.captchaRuntimeStatus(context.Background(), M{"node_path": node, "jsdom_path": moduleRoot})
	equal(t, status["ready"], false)
	equal(t, obj(status["jsdom"])["installed"], true)
	equal(t, obj(status["jsdom"])["available"], false)
	if strings.Contains(js(status), "private dependency details") {
		t.Fatal("dependency failure leaked process output")
	}
}

func TestCaptchaRuntimeStatusStopsHangingModule(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is required for the runtime cancellation test")
	}
	a := networkTestApp(t)
	module := filepath.Join(a.root, "captcha_node", "node_modules", "jsdom")
	must(t, os.MkdirAll(module, 0700))
	must(t, os.WriteFile(filepath.Join(module, "index.js"), []byte(`while (true) {}`), 0600))
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	status := a.captchaRuntimeStatus(ctx, M{"node_path": node})
	equal(t, status["ready"], false)
	if time.Since(start) > 2*time.Second {
		t.Fatal("runtime detection did not stop its child process")
	}
}
