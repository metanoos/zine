// Local-first relay for the zine trace protocol (see protocol/trace-provenance.md).
//
// Two deployment shapes share this binary:
//   - Desktop sidecar: bound to 127.0.0.1 only, sqlite-backed. In local mode
//     (no peers.json), nothing connects in and localhost is trusted. In
//     networked mode (peers.json has an owner), the relay accepts inbound from
//     peers over Tor and gates access via NIP-42 AUTH + a pubkey allowlist —
//     see protocol/transport.md §5.
//   - Hosted (docker-compose, Postgres-backed): a separate main package
//     will reuse the same khatru wiring with a Postgres eventstore; not
//     built yet, this binary is the local/desktop half.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/fiatjaf/eventstore/sqlite3"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
	"github.com/nbd-wtf/go-nostr"
)

func main() {
	host := flag.String("host", "127.0.0.1", "bind address — keep this 127.0.0.1 for the desktop sidecar")
	port := flag.Int("port", 4869, "port to listen on")
	dbPath := flag.String("db", defaultDbPath(), "sqlite database path")
	reset := flag.Bool("reset", false, "delete every local event and reset the desktop access policy, then exit")
	flag.Parse()
	if *reset {
		deleted, err := resetLocalState(*dbPath)
		if err != nil {
			log.Fatalf("factory reset failed: %v", err)
		}
		log.Printf("factory reset complete: deleted %d local events", deleted)
		return
	}

	relay := khatru.NewRelay()
	relay.Info.Name = "Zine Local Relay"
	relay.Info.Description = "Local-first relay for the zine trace protocol — file/folder provenance as composable Nostr events."
	relay.Info.Software = "https://github.com/zine/relay"
	relay.Info.Version = "0.1.0"
	relay.Info.SupportedNIPs = []any{1, 9, 11, 18, 33, 42}

	// Access policy — opt-in. When peers.json exists with an owner, the relay
	// requires NIP-42 AUTH and gates reads/writes by pubkey (owner = relay-policy
	// write, writers = own-key write, peers = read-only). When absent, local
	// mode trusts localhost and requires no AUTH. See protocol/transport.md §5
	// and access-policy.go.
	policy := NewAccessPolicy(DefaultPeersPath(*dbPath))
	if policy.Active() {
		log.Printf("networked mode active (owner=%s, peers=%d, writers=%d) — NIP-42 AUTH required",
			policy.owner, len(policy.peers), len(policy.writers))
		// Poll the file every 5s so add/remove-peer takes effect without a
		// restart. Zero-dep (no fsnotify) — just a stat on a small JSON file.
		go func() {
			t := time.NewTicker(5 * time.Second)
			defer t.Stop()
			for range t.C {
				policy.Poll()
			}
		}()
	}

	// Explicit policy set — the same protections ApplySaneDefaults bundles
	// (base64-media reject, event + filter IP rate limits, no-complex-filters),
	// plus the connection rate limiter that the sidecar previously dropped.
	//
	// The connection limiter's removal rationale (it was "pure friction" for a
	// 127.0.0.1-only sidecar) inverts in networked mode: the relay now accepts
	// inbound from peers over Tor, so limiting connections is load-bearing
	// again. In local mode the limiter stays too — it's a no-op in practice
	// (only localhost connects) and uniform policy is simpler than branching.
	relay.RejectConnection = append(relay.RejectConnection,
		policies.ConnectionRateLimiter(2, 5*time.Minute, 100),
	)
	relay.RejectEvent = append(relay.RejectEvent,
		// AUTH gate — prepended so it runs before rate-limit/media policies and
		// before a would-be writer consumes a rate-limit token. In local mode
		// (policy inactive) this is a no-op. In networked mode: unauthed or
		// unknown pubkeys get an AUTH challenge (the "auth-required:" prefix
		// triggers khatru to send it, handlers.go:309-311); the owner may write,
		// writers may publish only their own events, and peers are read-only. See
		// transport.md §5.
		func(ctx context.Context, ev *nostr.Event) (bool, string) {
			if !policy.Active() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if policy.IsOwner(authed) {
				return false, "" // owner may write
			}
			// Writer: may publish events signed as ITSELF, never impersonating
			// the owner. The ev.PubKey == authed guard is the security boundary
			// — khatru verifies the signature upstream, so a match proves the
			// writer authored this event. The canonical writer is a headless
			// press (zine-mcp) publishing traces as a distinct attributable
			// author on the chain (§3.6/§R5).
			if policy.IsWriter(authed) && ev.PubKey == authed {
				return false, ""
			}
			if policy.IsPeer(authed) {
				return true, "restricted: peers have read-only access"
			}
			return true, "auth-required: pubkey not in peer list"
		},
		policies.RejectEventsWithBase64Media,
		// Loopback-exempted 20 events/min, burst 100. On the desktop sidecar the
		// only loopback client is the owner (and a trusted headless MCP press),
		// so rate-limiting 127.0.0.1 just trips legitimate folder-step fan-out:
		// stepping a folder with nested subdirs (one genesis + file nodes +
		// membership steps + TraceHead caches per member) bursts past 100 in
		// seconds, which surfaced as "publish failed on every relay
		// (rate-limited: slow down, please)". The AUTH gate above runs first
		// and rejects peer writes before this limiter is reached, so in
		// networked mode the exemption still covers only the owner/writers,
		// never peers (and peers over Tor map to 127.0.0.1 but can't write
		// anyway). The sqlite store is the real protection; the publicly exposed
		// hosted relay keeps its un-exempted limiter. See relay/cmd/hosted.
		loopbackExempt(policies.EventIPRateLimiter(20, time.Minute, 100)),
	)
	relay.RejectFilter = append(relay.RejectFilter,
		// Read-side AUTH gate — same shape as the event gate. In networked mode,
		// unauthed readers get challenged; owner, writers, and peers may read.
		func(ctx context.Context, _ nostr.Filter) (bool, string) {
			if !policy.Active() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if !policy.AllowRead(authed) {
				return true, "restricted: pubkey not in peer list"
			}
			return false, ""
		},
		policies.NoComplexFilters,
		policies.FilterIPRateLimiter(20, time.Minute, 100),
	)
	relay.RejectCountFilter = append(relay.RejectCountFilter,
		// Count is a read op — gate it identically to filters so a caller can't
		// learn aggregate facts (e.g. "how many events on this relay") without
		// being authed as owner, writer, or peer.
		func(ctx context.Context, _ nostr.Filter) (bool, string) {
			if !policy.Active() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if !policy.AllowRead(authed) {
				return true, "restricted: pubkey not in peer list"
			}
			return false, ""
		},
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

	addr := fmt.Sprintf("%s:%d", *host, *port)
	log.Printf("zine relay listening on ws://%s  (db: %s)", addr, *dbPath)
	if err := http.ListenAndServe(addr, relay); err != nil {
		log.Fatal(err)
	}
}

func defaultDbPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "relay.sqlite3"
	}
	return filepath.Join(home, ".tracer", "relay.sqlite3")
}

// resetLocalState is the destructive half of the desktop app's explicit
// factory reset. It clears the local relay's event store and removes the
// access-policy files tied to the old browser keychain. The database file is
// kept in place so an already-running relay process continues using the same
// SQLite connection and immediately observes the empty table.
//
// Remote relays are deliberately out of scope: published Nostr events cannot
// be recalled from servers this process does not own.
func resetLocalState(dbPath string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return 0, fmt.Errorf("create relay data directory: %w", err)
	}

	db := sqlite3.SQLite3Backend{DatabaseURL: dbPath}
	if err := db.Init(); err != nil {
		return 0, fmt.Errorf("open relay database: %w", err)
	}
	defer db.Close()

	// A previous desktop launch can still own an idle connection to this same
	// database. Give its short reads time to finish, and overwrite deleted page
	// content instead of leaving old trace bodies recoverable on the freelist.
	if _, err := db.Exec("PRAGMA busy_timeout = 10000"); err != nil {
		return 0, fmt.Errorf("configure reset lock timeout: %w", err)
	}
	if _, err := db.Exec("PRAGMA secure_delete = ON"); err != nil {
		return 0, fmt.Errorf("enable secure deletion: %w", err)
	}
	result, err := db.Exec("DELETE FROM event")
	if err != nil {
		return 0, fmt.Errorf("delete relay events: %w", err)
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("count deleted relay events: %w", err)
	}

	// The ACL owner is one of the browser keys being erased. Leaving it behind
	// would make the running relay reject the fresh first-run key. The relay's
	// access-policy poll notices these removals and returns to local mode.
	dataDir := filepath.Dir(dbPath)
	for _, name := range []string{"peers.json", "friends.json"} {
		path := filepath.Join(dataDir, name)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return deleted, fmt.Errorf("remove %s: %w", path, err)
		}
	}

	// Reclaim disk after a large trace history when SQLite can take the lock.
	// The logical reset already succeeded, so a busy VACUUM is non-fatal.
	if deleted > 0 {
		if _, err := db.Exec("VACUUM"); err != nil {
			log.Printf("factory reset: database cleared but VACUUM skipped: %v", err)
		}
	}
	return deleted, nil
}

// loopbackExempt wraps an event/filter reject-fn so that connections from
// 127.0.0.1 / ::1 bypass it. On the desktop sidecar loopback is the owner
// (plus the trusted headless press), and their legitimate burst fan-out
// (folder stepping) is what we want to stop rate-limiting — not throttle.
// The real protections (AUTH gate, sqlite store) run independently; this
// just stops the owner from tripping a cap meant for untrusted remote IPs,
// which the sidecar never serves in local mode.
func loopbackExempt(fn func(context.Context, *nostr.Event) (bool, string)) func(context.Context, *nostr.Event) (bool, string) {
	return func(ctx context.Context, ev *nostr.Event) (bool, string) {
		if isLoopback(khatru.GetIP(ctx)) {
			return false, ""
		}
		return fn(ctx, ev)
	}
}

func isLoopback(ipStr string) bool {
	if ipStr == "" {
		return false
	}
	ip := net.ParseIP(ipStr)
	return ip != nil && ip.IsLoopback()
}
