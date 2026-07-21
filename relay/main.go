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
	readyFile := flag.String("ready-file", "", "optional desktop parent readiness file")
	readyToken := flag.String("ready-token", "", "token written after the listener is owned")
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
	}
	// Poll whether or not networked mode is active yet. The owner is normally
	// written after the desktop sidecar starts, so gating this loop on Active
	// would leave a first-run relay permissive until its next restart.
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		pollAccessPolicy(policy, t.C)
	}()

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
		// The desktop may activate networked mode immediately before exposing
		// an onion. Refresh synchronously so the first remote connection sees
		// the owner ACL instead of the prior local-mode snapshot.
		refreshPolicyOnConnection(policy),
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
			return authorizeEvent(policy, khatru.GetAuthed(ctx), ev.PubKey)
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
			return authorizeRead(policy, khatru.GetAuthed(ctx))
		},
		policies.NoComplexFilters,
		// Folder reads fan out across membership, TraceHead, and immutable-node
		// filters. Keep the non-loopback limit, but do not let the desktop's own
		// loopback client exhaust the shared bucket and turn present history into
		// an empty query result. This mirrors the event-publish exemption above.
		loopbackExemptFilter(policy, policies.FilterIPRateLimiter(20, time.Minute, 100)),
	)
	relay.RejectCountFilter = append(relay.RejectCountFilter,
		// Count is a read op — gate it identically to filters so a caller can't
		// learn aggregate facts (e.g. "how many events on this relay") without
		// being authed as owner, writer, or peer.
		func(ctx context.Context, _ nostr.Filter) (bool, string) {
			return authorizeRead(policy, khatru.GetAuthed(ctx))
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
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatalf("could not bind zine relay on %s: %v", addr, err)
	}
	defer listener.Close()
	if err := writeReadyFile(*readyFile, *readyToken); err != nil {
		log.Fatalf("could not publish relay readiness: %v", err)
	}
	if *readyFile != "" {
		defer os.Remove(*readyFile)
	}
	log.Printf("zine relay listening on ws://%s  (db: %s)", addr, *dbPath)
	if err := http.Serve(listener, relay); err != nil {
		log.Fatal(err)
	}
}

func refreshPolicyOnConnection(policy *AccessPolicy) func(*http.Request) bool {
	return func(_ *http.Request) bool {
		policy.Poll()
		return false
	}
}

func writeReadyFile(path, token string) error {
	if path == "" && token == "" {
		return nil
	}
	if path == "" || token == "" {
		return fmt.Errorf("ready-file and ready-token must be provided together")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.WriteString(token); err != nil {
		file.Close()
		os.Remove(path)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(path)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return err
	}
	return nil
}

// authorizeEvent contains the local relay's NIP-42 write decision independently
// of khatru's request context so the complete role matrix can be regression
// tested. Khatru verifies the event signature before this policy runs.
func authorizeEvent(policy *AccessPolicy, authed, eventPubkey string) (bool, string) {
	if !policy.Active() {
		return false, ""
	}
	if authed == "" {
		return true, "auth-required: this relay requires NIP-42 authentication"
	}
	if policy.IsOwner(authed) {
		return false, ""
	}
	if policy.IsWriter(authed) && eventPubkey == authed {
		return false, ""
	}
	if policy.IsPeer(authed) {
		return true, "restricted: peers have read-only access"
	}
	return true, "auth-required: pubkey not in peer list"
}

// authorizeRead applies identically to subscriptions and count queries.
func authorizeRead(policy *AccessPolicy, authed string) (bool, string) {
	if !policy.Active() {
		return false, ""
	}
	if authed == "" {
		return true, "auth-required: this relay requires NIP-42 authentication"
	}
	if !policy.AllowRead(authed) {
		return true, "restricted: pubkey not in peer list"
	}
	return false, ""
}

func pollAccessPolicy(policy *AccessPolicy, ticks <-chan time.Time) {
	for range ticks {
		policy.Poll()
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
	path := filepath.Join(dataDir, "peers.json")
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return deleted, fmt.Errorf("remove %s: %w", path, err)
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
		return applyLoopbackExemption(khatru.GetIP(ctx), func() (bool, string) {
			return fn(ctx, ev)
		})
	}
}

func loopbackExemptFilter(policy *AccessPolicy, fn func(context.Context, nostr.Filter) (bool, string)) func(context.Context, nostr.Filter) (bool, string) {
	return func(ctx context.Context, filter nostr.Filter) (bool, string) {
		return applyTrustedFilterExemption(
			khatru.GetIP(ctx),
			khatru.GetAuthed(ctx),
			policy,
			func() (bool, string) {
				return fn(ctx, filter)
			},
		)
	}
}

// Tor forwards peer queries from loopback too, so IP alone cannot distinguish
// the desktop owner from a remote read-only peer. In local mode loopback is
// trusted; once an ACL is active only the authenticated owner and writers get
// the burst exemption. Peers still pass the AUTH gate but consume limiter
// tokens like other remote readers.
//
// The exemption keys off the authenticated identity, not the source IP: an
// owner or writer may legitimately connect from the machine's non-loopback
// LAN address (e.g. a headless press whose `--publish-relay` is its own eth0
// IP, or a desktop on a dual-stack host), and AUTH is the trust boundary that
// distinguishes them from anonymous peers. Loopback without an owner/writer
// identity still gets the local-mode pass so an unauthed first-run desktop
// keeps working before peers.json is written.
func applyTrustedFilterExemption(
	ip string,
	authed string,
	policy *AccessPolicy,
	reject func() (bool, string),
) (bool, string) {
	if !policy.Active() {
		if isLoopback(ip) {
			return false, ""
		}
		return reject()
	}
	if policy.IsOwner(authed) || policy.IsWriter(authed) {
		return false, ""
	}
	return reject()
}

// Keep the bypass decision separate so tests can prove that a loopback request
// does not even consume a token from the wrapped limiter.
func applyLoopbackExemption(ip string, reject func() (bool, string)) (bool, string) {
	if isLoopback(ip) {
		return false, ""
	}
	return reject()
}

func isLoopback(ipStr string) bool {
	if ipStr == "" {
		return false
	}
	ip := net.ParseIP(ipStr)
	return ip != nil && ip.IsLoopback()
}
