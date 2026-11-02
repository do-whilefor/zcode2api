package server

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type mihomoTestTransport func(*http.Request) (*http.Response, error)

func (transport mihomoTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestMihomoInstallVerifiedArchive(t *testing.T) {
	for _, format := range []string{".gz", ".zip"} {
		t.Run(format, func(t *testing.T) {
			var compressed bytes.Buffer
			if format == ".gz" {
				writer := gzip.NewWriter(&compressed)
				io.WriteString(writer, "verified executable")
				writer.Close()
			} else {
				writer := zip.NewWriter(&compressed)
				file, err := writer.Create("subdir/mihomo.exe")
				if err != nil {
					t.Fatal(err)
				}
				io.WriteString(file, "verified executable")
				other, _ := writer.Create("../must-not-write")
				io.WriteString(other, "must stay inside archive")
				writer.Close()
			}
			digest := sha256.Sum256(compressed.Bytes())
			asset := mihomoAsset{"test" + format, hex.EncodeToString(digest[:])}
			client := &http.Client{Transport: mihomoTestTransport(func(request *http.Request) (*http.Response, error) {
				if request.URL.String() != mihomoReleaseURL+asset.name || request.Header.Get("Authorization") != "" {
					t.Fatal("installer contacted an unexpected source or sent credentials")
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(compressed.Bytes())), Header: http.Header{}}, nil
			})}
			directory := t.TempDir()
			binary := filepath.Join(directory, "install", "mihomo")
			if err := installMihomoAsset(context.Background(), client, asset, binary); err != nil {
				t.Fatal(err)
			}
			body, err := os.ReadFile(binary)
			if err != nil || string(body) != "verified executable" {
				t.Fatal("verified executable was not installed", err)
			}
			entries, _ := os.ReadDir(filepath.Dir(binary))
			if len(entries) != 1 {
				t.Fatal("staging files were left behind")
			}
			if _, err := os.Stat(filepath.Join(directory, "must-not-write")); !os.IsNotExist(err) {
				t.Fatal("an extra archive member escaped extraction")
			}
		})
	}
}

func TestMihomoChecksumFailurePreservesExistingFile(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "mihomo")
	if err := os.WriteFile(binary, []byte("existing executable"), 0700); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: mihomoTestTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("corrupt download")), Header: http.Header{}}, nil
	})}
	err := installMihomoAsset(context.Background(), client, mihomoAsset{"test.gz", strings.Repeat("0", 64)}, binary)
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatal("unverified download was accepted")
	}
	body, _ := os.ReadFile(binary)
	entries, _ := os.ReadDir(directory)
	if string(body) != "existing executable" || len(entries) != 1 {
		t.Fatal("failed installation modified the executable or left temporary files")
	}
}

func TestMihomoInstallRequiresAuthenticationAndStatusDoesNotInstall(t *testing.T) {
	a := networkTestApp(t)
	for _, method := range []string{"GET", "POST"} {
		endpoint := "/api/settings/proxy/mihomo"
		if method == "POST" {
			endpoint += "/install"
		}
		request := httptest.NewRequest(method, endpoint, strings.NewReader("{}"))
		response := httptest.NewRecorder()
		a.AdminHandler().ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatal("installer endpoint did not require admin authentication")
		}
	}
	status := a.mihomoStatus()
	if status["version"] != mihomoVersion {
		t.Fatal("status did not expose the pinned version")
	}
	if _, err := os.Stat(filepath.Join(a.data, "tools")); !os.IsNotExist(err) {
		t.Fatal("reading status unexpectedly installed software")
	}
}

func TestMihomoAutoDetectionAndDraftPathStatus(t *testing.T) {
	a := networkTestApp(t)
	pathDir := t.TempDir()
	t.Setenv("PATH", pathDir)
	name := "mihomo"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	equal(t, a.mihomoStatus()["installed"], false)
	portable := filepath.Join(a.root, name)
	must(t, os.WriteFile(portable, []byte("existence check must not execute this file"), 0700))
	equal(t, a.mihomoStatus()["path"], portable)
	managed := a.managedMihomoPath()
	must(t, os.MkdirAll(filepath.Dir(managed), 0700))
	must(t, os.WriteFile(managed, []byte("managed fixture"), 0700))
	equal(t, a.mihomoStatus()["path"], managed)
	fromPath := filepath.Join(pathDir, name)
	must(t, os.WriteFile(fromPath, []byte("PATH fixture"), 0700))
	equal(t, a.mihomoStatus()["path"], fromPath)
	custom := filepath.Join(a.root, "custom directory", name)
	must(t, os.MkdirAll(filepath.Dir(custom), 0700))
	must(t, os.WriteFile(custom, []byte("custom fixture"), 0700))
	value, status, err := a.adminRoute(httptest.NewRequest("GET", "/api/settings/proxy/mihomo?path="+url.QueryEscape(custom), nil), nil)
	must(t, err)
	equal(t, status, 200)
	equal(t, obj(value)["installed"], true)
	equal(t, obj(value)["path"], custom)
	equal(t, obj(a.config()["outbound_proxy"])["mihomo_path"], "mihomo")
	equal(t, a.mihomoStatusForPath(filepath.Join(a.root, "missing", name))["installed"], false)
	for _, invalid := range []string{"", "bad\npath", strings.Repeat("x", 4097)} {
		_, status, err = a.adminRoute(httptest.NewRequest("GET", "/api/settings/proxy/mihomo?path="+url.QueryEscape(invalid), nil), nil)
		must(t, err)
		equal(t, status, 400)
	}
}

func TestMihomoDownloadsOnlyRedirectToOfficialHTTPSHosts(t *testing.T) {
	for _, address := range []string{"http://github.com/file", "https://evil.example/file", "https://github.com.evil.example/file", "https://user:pass@github.com/file"} {
		parsed, _ := url.Parse(address)
		if err := mihomoRedirect(&http.Request{URL: parsed}, nil); err == nil {
			t.Fatalf("accepted untrusted redirect %s", address)
		}
	}
	for _, host := range []string{"github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"} {
		parsed, _ := url.Parse("https://" + host + "/file")
		if err := mihomoRedirect(&http.Request{URL: parsed}, nil); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMihomoRejectsOversizedDownloadAndConcurrentInstall(t *testing.T) {
	directory := t.TempDir()
	binary := filepath.Join(directory, "mihomo")
	client := &http.Client{Transport: mihomoTestTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, ContentLength: mihomoArchiveLimit + 1, Body: io.NopCloser(strings.NewReader("")), Header: http.Header{}}, nil
	})}
	if err := installMihomoAsset(context.Background(), client, mihomoAsset{"test.gz", "unused"}, binary); err == nil {
		t.Fatal("oversized download was accepted")
	}
	if _, err := os.Stat(binary); !os.IsNotExist(err) {
		t.Fatal("oversized download created an executable")
	}
	a := networkTestApp(t)
	a.mihomoInstallMu.Lock()
	defer a.mihomoInstallMu.Unlock()
	if _, err := a.installMihomo(context.Background()); err == nil || !strings.Contains(err.Error(), "正在安装") {
		t.Fatal("concurrent installation was not rejected")
	}
}
