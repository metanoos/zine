// Local-first relay for the zine trace protocol (see protocol/trace-provenance.md).
//
// Two deployment shapes share this binary:
//   - Desktop sidecar: bound to 127.0.0.1 only, sqlite-backed. In open mode
//     (no friends.json), nothing connects in and localhost is trusted. In
//     friend mode (friends.json has an owner), the relay accepts inbound from
//     friends over Tor and gates access via NIP-42 AUTH + a pubkey allowlist —
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
	flag.Parse()

	relay := khatru.NewRelay()
	relay.Info.Name = "Zine Local Relay"
	relay.Info.Description = "Local-first relay for the zine trace protocol — file/folder provenance as composable Nostr events."
	relay.Info.Software = "https://github.com/zine/relay"
	relay.Info.Version = "0.1.0"
	relay.Info.SupportedNIPs = []any{1, 9, 11, 18, 33, 42}

	// Friend ACL — opt-in access policy. When friends.json exists with an owner,
	// the relay requires NIP-42 AUTH and gates reads/writes by pubkey (owner =
	// read+write, friends = read-only). When absent, open mode: localhost is
	// trusted, no AUTH required. See protocol/transport.md §5 and friends.go.
	acl := NewFriendACL(DefaultFriendsPath(*dbPath))
	if acl.Enabled() {
		log.Printf("friend ACL active (owner=%s, friends=%d) — NIP-42 AUTH required",
			acl.owner, len(acl.friends))
		// Poll the file every 5s so add/remove-friend takes effect without a
		// restart. Zero-dep (no fsnotify) — just a stat on a small JSON file.
		go func() {
			t := time.NewTicker(5 * time.Second)
			defer t.Stop()
			for range t.C {
				acl.Poll()
			}
		}()
	}

	// Explicit policy set — the same protections ApplySaneDefaults bundles
	// (base64-media reject, event + filter IP rate limits, no-complex-filters),
	// plus the connection rate limiter that the sidecar previously dropped.
	//
	// The connection limiter's removal rationale (it was "pure friction" for a
	// 127.0.0.1-only sidecar) inverts in friend mode: the relay now accepts
	// inbound from friends over Tor, so limiting connections is load-bearing
	// again. In open mode the limiter stays too — it's a no-op in practice
	// (only localhost connects) and uniform policy is simpler than branching.
	relay.RejectConnection = append(relay.RejectConnection,
		policies.ConnectionRateLimiter(2, 5*time.Minute, 100),
	)
	relay.RejectEvent = append(relay.RejectEvent,
		// AUTH gate — prepended so it runs before rate-limit/media policies and
		// before a would-be writer consumes a rate-limit token. In open mode
		// (ACL disabled) this is a no-op. In friend mode: unauthed or unknown
		// pubkeys get an AUTH challenge (the "auth-required:" prefix triggers
		// khatru to send it, handlers.go:309-311); the owner may write, friends
		// may not (read-only). See transport.md §5.
		func(ctx context.Context, ev *nostr.Event) (bool, string) {
			if !acl.Enabled() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if acl.IsOwner(authed) {
				return false, "" // owner may write
			}
			if acl.IsFriend(authed) {
				return true, "restricted: friends have read-only access"
			}
			return true, "auth-required: pubkey not in friends list"
		},
		policies.RejectEventsWithBase64Media,
		// 20 events/min, burst 100 — matches the filter limiter's generosity.
		// The prior 2/3min burst-10 setting was too tight for an authoring
		// sidecar: sealing a folder with nested subdirs (one genesis + file
		// nodes + membership seals + TraceHead caches per member) bursts well
		// past 10 events in seconds, and the 2/3min refill never recovers
		// within a session. The sqlite store is the real protection, and the
		// burst is bounded by seal frequency (§8).
		policies.EventIPRateLimiter(20, time.Minute, 100),
	)
	relay.RejectFilter = append(relay.RejectFilter,
		// Read-side AUTH gate — same shape as the event gate. In friend mode,
		// unauthed readers get challenged; owner+friends may read.
		func(ctx context.Context, _ nostr.Filter) (bool, string) {
			if !acl.Enabled() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if !acl.AllowRead(authed) {
				return true, "restricted: pubkey not in friends list"
			}
			return false, ""
		},
		policies.NoComplexFilters,
		policies.FilterIPRateLimiter(20, time.Minute, 100),
	)
	relay.RejectCountFilter = append(relay.RejectCountFilter,
		// Count is a read op — gate it identically to filters so a caller can't
		// learn aggregate facts (e.g. "how many events on this relay") without
		// being authed as owner/friend.
		func(ctx context.Context, _ nostr.Filter) (bool, string) {
			if !acl.Enabled() {
				return false, ""
			}
			authed := khatru.GetAuthed(ctx)
			if authed == "" {
				return true, "auth-required: this relay requires NIP-42 authentication"
			}
			if !acl.AllowRead(authed) {
				return true, "restricted: pubkey not in friends list"
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
