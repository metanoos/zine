// Hosted zine relay + website + download server — the single-process image
// entry point. This is the "hosted" half promised in ../../main.go's header:
// the same khatru+sqlite wiring, but bound to 0.0.0.0 and fronted by an
// http.ServeMux that also serves the built webapp and the desktop installer
// downloads. The desktop sidecar (../../main.go) stays localhost-only; this
// one is the internet-reachable sibling.
//
// One port, one process:
//
//	GET /relay            → khatru Nostr relay (websocket upgrade + NIP-11)
//	GET /downloads/...    → desktop installers (dmg/msi/AppImage/...)
//	GET /downloads/manifest.json → auto-generated index of installers
//	GET /healthz          → liveness probe
//	GET /*                → apps/client/dist SPA (history fallback to index.html)
//
// TLS is intentionally not terminated here — run it behind Caddy/nginx/
// Cloudflare for prod (an https page must reach the relay over wss://, which
// the webapp derives from location.origin, so no code change is needed for
// that cutover).
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/fiatjaf/eventstore/sqlite3"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/nbd-wtf/go-nostr"
)

func main() {
	host := flag.String("host", getenv("HOST", "0.0.0.0"), "bind address")
	port := flag.Int("port", getenvInt("PORT", 8080), "port to listen on")
	dbPath := flag.String("db", getenv("DB", "/data/relay.sqlite3"), "sqlite database path")
	distDir := flag.String("dist", getenv("DIST", "/app/dist"), "built webapp directory")
	downloadsDir := flag.String("downloads", getenv("DOWNLOADS", "/app/downloads"), "desktop installer directory")
	flag.Parse()

	relay := khatru.NewRelay()
	relay.Info.Name = "Zine Relay"
	relay.Info.Description = "Hosted relay for the zine trace protocol — file/folder provenance as composable Nostr events."
	relay.Info.Software = "https://github.com/zine/relay"
	relay.Info.Version = "0.1.0"
	relay.Info.SupportedNIPs = []any{1, 9, 11, 18, 33}

	// Explicit policy set — the same protections ApplySaneDefaults bundles
	// (base64-media reject, event + filter IP rate limits, no-complex-filters),
	// minus the connection rate limiter. That limiter (1 token / 5 min, 100-
	// token bucket, IP-keyed, no localhost exemption in khatru v0.19.1) 429s
	// a single browser client once normal connect churn empties the bucket,
	// then recovers too slowly to be usable (~8h to refill). This image is
	// single-tenant and the webapp legitimately opens multiple WS connections,
	// so limiting *connections* is pure friction; the event/filter limits —
	// which protect the sqlite store — stay.
	relay.RejectEvent = append(relay.RejectEvent,
		policies.RejectEventsWithBase64Media,
		// 20 events/min, burst 100 — matches the sidecar (relay/main.go) and the
		// filter limiter below. The prior 2/3min burst-10 setting was too tight
		// for an authoring client: stepping a folder with nested subdirs (genesis
		// + file nodes + membership steps + TraceHead caches) bursts well past 10
		// events in seconds, and the 2/3min refill never recovers within a
		// session. The sqlite store and the operator ban gate are the real
		// protections; the burst here is bounded by step frequency.
		policies.EventIPRateLimiter(20, time.Minute, 100),
	)
	relay.RejectFilter = append(relay.RejectFilter,
		policies.NoComplexFilters,
		policies.FilterIPRateLimiter(20, time.Minute, 100),
	)

	if err := os.MkdirAll(filepath.Dir(*dbPath), 0o755); err != nil {
		log.Fatalf("could not create db directory: %v", err)
	}
	db := sqlite3.SQLite3Backend{DatabaseURL: *dbPath}
	if err := db.Init(); err != nil {
		log.Fatalf("could not init sqlite backend: %v", err)
	}
	defer db.Close()

	relay.StoreEvent = append(relay.StoreEvent, db.SaveEvent)
	relay.QueryEvents = append(relay.QueryEvents, db.QueryEvents)
	relay.CountEvents = append(relay.CountEvents, db.CountEvents)
	relay.DeleteEvent = append(relay.DeleteEvent, db.DeleteEvent)
	relay.ReplaceEvent = append(relay.ReplaceEvent, db.ReplaceEvent)

	// Operator layer — bootstrap token, curation team, moderation. Fully opt-in:
	// with OPERATOR_BOOTSTRAP_TOKEN unset, the store still loads (empty state),
	// /operator/bind returns 503, and the ban gate is a no-op (empty banned list).
	// The store holds the sqlite backend so a ban can sweep stored events.
	opStatePath := filepath.Join(filepath.Dir(*dbPath), "operator.json")
	ops, err := NewOperatorStore(opStatePath, os.Getenv("OPERATOR_BOOTSTRAP_TOKEN"), &db)
	if err != nil {
		log.Fatalf("could not init operator store: %v", err)
	}
	// Ban gate — reject events from banned pubkeys BEFORE the rate-limit/media
	// policies, so an abuser can't even consume a rate-limit token. Prepended
	// (not appended) so it runs first; khatru short-circuits on the first reject.
	relay.RejectEvent = append(
		[]func(ctx context.Context, event *nostr.Event) (bool, string){
			func(_ context.Context, ev *nostr.Event) (bool, string) {
				if ops.IsBanned(ev.PubKey) {
					return true, "banned: this pubkey is banned from this relay"
				}
				return false, ""
			},
		},
		relay.RejectEvent...,
	)

	// khatru implements http.Handler and dispatches purely on request headers
	// (Upgrade: websocket → WS, Accept: application/nostr+json → NIP-11), so
	// mounting it at a subpath is path-agnostic — /relay behaves identically
	// to /.
	mux := http.NewServeMux()
	mux.Handle("GET /relay", relay)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	dl := &downloadServer{root: *downloadsDir}
	mux.Handle("GET /downloads/manifest.json", dl)
	mux.Handle("GET /downloads/", http.StripPrefix("/downloads/", dl))

	// Operator/admin routes. GET /operator/state is public (pubkeys are public
	// in Nostr by definition); the three mutations are auth-gated inside the
	// handlers (NIP-98 for team/ban, bootstrap token for bind).
	mux.HandleFunc("GET /operator/state", ops.HandleState)
	mux.HandleFunc("POST /operator/bind", ops.HandleBind)
	mux.HandleFunc("POST /operator/team", ops.HandleTeam)
	mux.HandleFunc("POST /operator/ban", ops.HandleBan)

	mux.Handle("/", newSPAHandler(*distDir))

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("zine hosted listening on http://%s  (db: %s, dist: %s, downloads: %s)",
		addr, *dbPath, *distDir, *downloadsDir)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}

// --- SPA file server with history fallback --------------------------------

// newSPAHandler serves static assets from distDir; for paths that don't map to
// a real file and look like a client route (no file extension), it falls back
// to index.html so the SPA router can handle them. Requests with an extension
// that don't resolve still 404, so a genuinely missing asset stays visible.
func newSPAHandler(distDir string) http.Handler {
	fs := http.FileServer(http.Dir(distDir))
	index := filepath.Join(distDir, "index.html")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		full := filepath.Join(distDir, filepath.Clean(r.URL.Path))
		if _, err := os.Stat(full); err == nil {
			fs.ServeHTTP(w, r)
			return
		}
		// No file on disk. Route-like paths (no extension) fall back to the
		// SPA shell; anything else (a broken asset reference) 404s.
		if _, err := os.Stat(index); err != nil {
			http.NotFound(w, r)
			return
		}
		ext := filepath.Ext(r.URL.Path)
		if ext == "" {
			http.ServeFile(w, r, index)
			return
		}
		http.NotFound(w, r)
	})
}

// --- downloads: static files + generated manifest -------------------------

type downloadServer struct {
	root string
}

type downloadEntry struct {
	Filename string `json:"filename"`
	URL      string `json:"url"`
	Platform string `json:"platform"`
	Arch     string `json:"arch,omitempty"`
	Size     int64  `json:"size"`
	ModTime  string `json:"mtime"`
}

func (d *downloadServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Emit the manifest for the canonical path. The handler is registered both
	// at the exact route (GET /downloads/manifest.json, no StripPrefix) and
	// under the prefix (GET /downloads/, StripPrefix'd), so accept either form
	// of the trailing path.
	if r.URL.Path == "manifest.json" || r.URL.Path == "/downloads/manifest.json" {
		d.writeManifest(w, r)
		return
	}
	// Guard against traversal: http.FileServer already cleans, but we're
	// mounted via StripPrefix so re-confirm the cleaned path stays in root.
	cleaned := filepath.Clean(r.URL.Path)
	if strings.Contains(cleaned, "..") {
		http.NotFound(w, r)
		return
	}
	http.FileServer(http.Dir(d.root)).ServeHTTP(w, r)
}

func (d *downloadServer) writeManifest(w http.ResponseWriter, r *http.Request) {
	entries, err := d.scan()
	if err != nil {
		http.Error(w, "scan error: "+err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	// Installers get dropped in at runtime; don't let a CDN cache a stale list.
	w.Header().Set("Cache-Control", "no-cache")
	// Always emit an array (nil slice → JSON null, which is awkward for clients).
	if entries == nil {
		entries = []downloadEntry{}
	}
	_ = json.NewEncoder(w).Encode(entries)
}

func (d *downloadServer) scan() ([]downloadEntry, error) {
	infos, err := os.ReadDir(d.root)
	if err != nil {
		if os.IsNotExist(err) {
			return []downloadEntry{}, nil
		}
		return nil, err
	}
	var out []downloadEntry
	for _, info := range infos {
		if info.IsDir() {
			continue
		}
		name := info.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if !isInstaller(name) {
			continue
		}
		fi, err := info.Info()
		if err != nil {
			continue
		}
		platform, arch := classify(name)
		out = append(out, downloadEntry{
			Filename: name,
			URL:      "/downloads/" + name,
			Platform: platform,
			Arch:     arch,
			Size:     fi.Size(),
			ModTime:  fi.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Platform != out[j].Platform {
			return out[i].Platform < out[j].Platform
		}
		return out[i].Filename < out[j].Filename
	})
	return out, nil
}

// isInstaller keeps the manifest to genuine desktop bundles. Tauri produces
// .dmg/.app.tar.gz (mac), .msi/.exe (windows, nsis), .AppImage/.deb/.rpm
// (linux). We intentionally exclude the source tarball etc.
func isInstaller(name string) bool {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".dmg"),
		strings.HasSuffix(n, ".msi"),
		strings.HasSuffix(n, ".exe"),
		strings.HasSuffix(n, ".app.tar.gz"),
		strings.HasSuffix(n, ".appimage"),
		strings.HasSuffix(n, ".deb"),
		strings.HasSuffix(n, ".rpm"):
		return true
	}
	return false
}

// classify infers platform + arch from the Tauri/standard filename convention.
// Examples: "zine_0.1.0_aarch64.dmg", "zine_0.1.0_x64.appimage",
// "zine_0.1.0_amd64.deb", "client_0.1.0_x64-setup.exe".
func classify(name string) (platform, arch string) {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".dmg"), strings.HasSuffix(n, ".app.tar.gz"):
		platform = "macos"
	case strings.HasSuffix(n, ".msi"), strings.HasSuffix(n, ".exe"):
		platform = "windows"
	case strings.HasSuffix(n, ".appimage"), strings.HasSuffix(n, ".deb"), strings.HasSuffix(n, ".rpm"):
		platform = "linux"
	default:
		platform = "unknown"
	}
	switch {
	case strings.Contains(n, "aarch64"), strings.Contains(n, "arm64"):
		arch = "arm64"
	case strings.Contains(n, "x86_64"), strings.Contains(n, "x64"), strings.Contains(n, "amd64"):
		arch = "x64"
	}
	return platform, arch
}

// --- env helpers ----------------------------------------------------------

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getenvInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil {
			return n
		}
	}
	return def
}
