package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDownloadServerScanIsDeterministic(t *testing.T) {
	root := t.TempDir()
	modTime := time.Date(2026, time.July, 17, 12, 34, 56, 789, time.FixedZone("test", -7*60*60))
	files := []struct {
		name    string
		content string
	}{
		{name: "zine_0.1.0_x64.msi", content: "windows"},
		{name: "zine_0.1.0_aarch64.dmg", content: "mac"},
		{name: "zine_0.1.0_x86_64.appimage", content: "appimage"},
		{name: "zine_0.1.0_amd64.deb", content: "deb"},
		{name: ".hidden.dmg", content: "hidden"},
		{name: "zine_0.1.0.tar.gz", content: "source"},
	}
	for _, file := range files {
		writeFileAtTime(t, filepath.Join(root, file.name), file.content, modTime)
	}
	if err := os.Mkdir(filepath.Join(root, "nested.AppImage"), 0o755); err != nil {
		t.Fatalf("create ignored directory: %v", err)
	}

	server := &downloadServer{root: root}
	got, err := server.scan()
	if err != nil {
		t.Fatalf("scan(): %v", err)
	}
	wantModTime := "2026-07-17T19:34:56Z"
	want := []downloadEntry{
		{Filename: "zine_0.1.0_amd64.deb", URL: "/downloads/zine_0.1.0_amd64.deb", Platform: "linux", Arch: "x64", Size: 3, ModTime: wantModTime},
		{Filename: "zine_0.1.0_x86_64.appimage", URL: "/downloads/zine_0.1.0_x86_64.appimage", Platform: "linux", Arch: "x64", Size: 8, ModTime: wantModTime},
		{Filename: "zine_0.1.0_aarch64.dmg", URL: "/downloads/zine_0.1.0_aarch64.dmg", Platform: "macos", Arch: "arm64", Size: 3, ModTime: wantModTime},
		{Filename: "zine_0.1.0_x64.msi", URL: "/downloads/zine_0.1.0_x64.msi", Platform: "windows", Arch: "x64", Size: 7, ModTime: wantModTime},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scan() = %#v, want %#v", got, want)
	}

	again, err := server.scan()
	if err != nil {
		t.Fatalf("second scan(): %v", err)
	}
	if !reflect.DeepEqual(again, got) {
		t.Fatalf("second scan changed order: first=%#v second=%#v", got, again)
	}
}

func TestDownloadServerScanMissingRootIsEmpty(t *testing.T) {
	server := &downloadServer{root: filepath.Join(t.TempDir(), "missing")}
	got, err := server.scan()
	if err != nil {
		t.Fatalf("scan(): %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("scan() = %#v, want non-nil empty slice", got)
	}
}

func TestDownloadManifestRoutes(t *testing.T) {
	root := t.TempDir()
	writeFileAtTime(t, filepath.Join(root, "zine_0.1.0_arm64.dmg"), "bundle", time.Unix(1_700_000_000, 0))
	server := &downloadServer{root: root}
	tests := []struct {
		name string
		path string
	}{
		{name: "canonical mounted path", path: "/downloads/manifest.json"},
		{name: "strip-prefix path", path: "manifest.json"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://relay.test/downloads/manifest.json", nil)
			req.URL.Path = test.path
			res := httptest.NewRecorder()

			server.ServeHTTP(res, req)

			if res.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d; body=%q", res.Code, http.StatusOK, res.Body.String())
			}
			if got := res.Header().Get("Content-Type"); got != "application/json" {
				t.Fatalf("Content-Type = %q, want application/json", got)
			}
			if got := res.Header().Get("Cache-Control"); got != "no-cache" {
				t.Fatalf("Cache-Control = %q, want no-cache", got)
			}
			var entries []downloadEntry
			if err := json.Unmarshal(res.Body.Bytes(), &entries); err != nil {
				t.Fatalf("decode manifest: %v", err)
			}
			if len(entries) != 1 || entries[0].Filename != "zine_0.1.0_arm64.dmg" {
				t.Fatalf("manifest entries = %#v, want installer", entries)
			}
		})
	}
}

func TestDownloadServerRoutesAndTraversal(t *testing.T) {
	parent := t.TempDir()
	root := filepath.Join(parent, "downloads")
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatalf("create downloads directory: %v", err)
	}
	writeFileAtTime(t, filepath.Join(root, "zine.dmg"), "installer", time.Unix(1_700_000_000, 0))
	writeFileAtTime(t, filepath.Join(root, "release..dmg"), "safe-dotdot-name", time.Unix(1_700_000_000, 0))
	writeFileAtTime(t, filepath.Join(parent, "outside.dmg"), "outside-secret", time.Unix(1_700_000_000, 0))
	server := &downloadServer{root: root}
	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{name: "serves installer", path: "/zine.dmg", wantStatus: http.StatusOK, wantBody: "installer"},
		{name: "serves safe filename containing two dots", path: "/release..dmg", wantStatus: http.StatusOK, wantBody: "safe-dotdot-name"},
		{name: "missing installer", path: "/missing.dmg", wantStatus: http.StatusNotFound},
		{name: "rejects parent traversal", path: "/../outside.dmg", wantStatus: http.StatusNotFound},
		{name: "rejects nested parent traversal", path: "/nested/../../outside.dmg", wantStatus: http.StatusNotFound},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://relay.test/download", nil)
			req.URL.Path = test.path
			res := httptest.NewRecorder()

			server.ServeHTTP(res, req)

			if res.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", res.Code, test.wantStatus, res.Body.String())
			}
			if test.wantBody != "" && res.Body.String() != test.wantBody {
				t.Fatalf("body = %q, want %q", res.Body.String(), test.wantBody)
			}
			if strings.Contains(res.Body.String(), "outside-secret") {
				t.Fatal("traversal exposed a file outside the download root")
			}
		})
	}
}

func TestInstallerClassification(t *testing.T) {
	tests := []struct {
		name          string
		wantInstaller bool
		wantPlatform  string
		wantArch      string
	}{
		{name: "zine_aarch64.dmg", wantInstaller: true, wantPlatform: "macos", wantArch: "arm64"},
		{name: "zine_arm64.app.tar.gz", wantInstaller: true, wantPlatform: "macos", wantArch: "arm64"},
		{name: "zine_x64.msi", wantInstaller: true, wantPlatform: "windows", wantArch: "x64"},
		{name: "zine_x64-setup.exe", wantInstaller: true, wantPlatform: "windows", wantArch: "x64"},
		{name: "zine_x86_64.AppImage", wantInstaller: true, wantPlatform: "linux", wantArch: "x64"},
		{name: "zine_amd64.deb", wantInstaller: true, wantPlatform: "linux", wantArch: "x64"},
		{name: "zine_x86_64.rpm", wantInstaller: true, wantPlatform: "linux", wantArch: "x64"},
		{name: "zine-source.tar.gz"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isInstaller(test.name); got != test.wantInstaller {
				t.Fatalf("isInstaller(%q) = %v, want %v", test.name, got, test.wantInstaller)
			}
			if !test.wantInstaller {
				return
			}
			platform, arch := classify(test.name)
			if platform != test.wantPlatform || arch != test.wantArch {
				t.Fatalf("classify(%q) = (%q, %q), want (%q, %q)", test.name, platform, arch, test.wantPlatform, test.wantArch)
			}
		})
	}
}

func TestSPAHandlerRoutes(t *testing.T) {
	parent := t.TempDir()
	dist := filepath.Join(parent, "dist")
	if err := os.Mkdir(dist, 0o755); err != nil {
		t.Fatalf("create dist directory: %v", err)
	}
	writeFileAtTime(t, filepath.Join(dist, "index.html"), "spa-shell", time.Unix(1_700_000_000, 0))
	writeFileAtTime(t, filepath.Join(dist, "app.js"), "asset", time.Unix(1_700_000_000, 0))
	writeFileAtTime(t, filepath.Join(parent, "outside.js"), "outside-secret", time.Unix(1_700_000_000, 0))
	handler := newSPAHandler(dist)
	tests := []struct {
		name       string
		path       string
		wantStatus int
		wantBody   string
	}{
		{name: "serves real asset", path: "/app.js", wantStatus: http.StatusOK, wantBody: "asset"},
		{name: "falls back for client route", path: "/stacks/curated", wantStatus: http.StatusOK, wantBody: "spa-shell"},
		{name: "missing asset stays visible", path: "/missing.js", wantStatus: http.StatusNotFound},
		{name: "traversal does not expose parent file", path: "/../outside.js", wantStatus: http.StatusNotFound},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "http://relay.test/", nil)
			req.URL.Path = test.path
			res := httptest.NewRecorder()

			handler.ServeHTTP(res, req)

			if res.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", res.Code, test.wantStatus, res.Body.String())
			}
			if test.wantBody != "" && res.Body.String() != test.wantBody {
				t.Fatalf("body = %q, want %q", res.Body.String(), test.wantBody)
			}
			if strings.Contains(res.Body.String(), "outside-secret") {
				t.Fatal("SPA traversal exposed a file outside the dist root")
			}
		})
	}
}

func writeFileAtTime(t *testing.T, path, content string, modTime time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("set mtime for %s: %v", path, err)
	}
}
