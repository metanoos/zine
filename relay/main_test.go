package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/fiatjaf/eventstore/sqlite3"
	"github.com/nbd-wtf/go-nostr"
)

func TestAccessPolicyPollerActivatesAfterOwnerIsCreated(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	policy := NewAccessPolicy(path)
	if policy.Active() {
		t.Fatal("policy unexpectedly active before peers.json exists")
	}

	ticks := make(chan time.Time)
	done := make(chan struct{})
	go func() {
		pollAccessPolicy(policy, ticks)
		close(done)
	}()

	owner := strings.Repeat("a", 64)
	raw, err := json.Marshal(PeersFile{Owner: owner})
	if err != nil {
		t.Fatalf("encode peers file: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write peers file: %v", err)
	}
	ticks <- time.Now()
	close(ticks)
	<-done

	if !policy.Active() {
		t.Fatal("policy did not activate after peers.json owner appeared")
	}
	if !policy.IsOwner(owner) {
		t.Fatal("policy did not load the new owner")
	}
}

func TestReadyFileProvesTheRelayOwnsItsListener(t *testing.T) {
	path := filepath.Join(t.TempDir(), "relay.ready")
	if err := writeReadyFile(path, "owned-child-token"); err != nil {
		t.Fatalf("write readiness file: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read readiness file: %v", err)
	}
	if string(raw) != "owned-child-token" {
		t.Fatalf("readiness token = %q", raw)
	}
	if err := writeReadyFile(path, "competitor"); err == nil {
		t.Fatal("readiness file must not overwrite an existing owner token")
	}
	if err := writeReadyFile("", "token"); err == nil {
		t.Fatal("partial readiness configuration must fail")
	}
}

func TestFirstRemoteConnectionRefreshesNewlyActivatedPolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	policy := NewAccessPolicy(path)
	if policy.Active() {
		t.Fatal("policy unexpectedly active before owner write")
	}
	owner := strings.Repeat("a", 64)
	raw, err := json.Marshal(PeersFile{Owner: owner})
	if err != nil {
		t.Fatalf("encode owner policy: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write owner policy: %v", err)
	}
	if rejected := refreshPolicyOnConnection(policy)(nil); rejected {
		t.Fatal("policy refresh must not itself reject the connection")
	}
	if !policy.Active() || !policy.IsOwner(owner) {
		t.Fatal("first connection did not observe the newly activated owner ACL")
	}
}

func TestResetLocalStateClearsEventsAndAccessPolicy(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "relay.sqlite3")

	db := sqlite3.SQLite3Backend{DatabaseURL: dbPath}
	if err := db.Init(); err != nil {
		t.Fatalf("initialize relay database: %v", err)
	}
	event := &nostr.Event{
		ID:        strings.Repeat("a", 64),
		PubKey:    strings.Repeat("b", 64),
		CreatedAt: nostr.Now(),
		Kind:      4290,
		Tags:      nostr.Tags{},
		Content:   `{"snapshot":"old root"}`,
		Sig:       strings.Repeat("c", 128),
	}
	if err := db.SaveEvent(context.Background(), event); err != nil {
		db.Close()
		t.Fatalf("seed relay event: %v", err)
	}
	db.Close()

	if err := os.WriteFile(filepath.Join(dir, "peers.json"), []byte(`{"owner":"old"}`), 0o600); err != nil {
		t.Fatalf("seed peers.json: %v", err)
	}
	unrelated := filepath.Join(dir, "keep.json")
	if err := os.WriteFile(unrelated, []byte("keep"), 0o600); err != nil {
		t.Fatalf("seed unrelated file: %v", err)
	}

	deleted, err := resetLocalState(dbPath)
	if err != nil {
		t.Fatalf("reset local state: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("deleted events = %d, want 1", deleted)
	}

	check := sqlite3.SQLite3Backend{DatabaseURL: dbPath}
	if err := check.Init(); err != nil {
		t.Fatalf("reopen relay database: %v", err)
	}
	defer check.Close()
	count, err := check.CountEvents(context.Background(), nostr.Filter{})
	if err != nil {
		t.Fatalf("count events after reset: %v", err)
	}
	if count != 0 {
		t.Fatalf("events after reset = %d, want 0", count)
	}

	if _, err := os.Stat(filepath.Join(dir, "peers.json")); !os.IsNotExist(err) {
		t.Fatalf("peers.json still exists after reset (err=%v)", err)
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated file was removed: %v", err)
	}
}

func TestLoopbackFilterRateLimitIsBypassedWithoutConsumingAToken(t *testing.T) {
	called := false
	reject, message := applyLoopbackExemption("127.0.0.1", func() (bool, string) {
		called = true
		return true, "rate-limited"
	})
	if called {
		t.Fatal("loopback request reached the rate limiter")
	}
	if reject || message != "" {
		t.Fatalf("loopback decision = (%v, %q), want (false, empty)", reject, message)
	}

	reject, message = applyLoopbackExemption("203.0.113.4", func() (bool, string) {
		called = true
		return true, "rate-limited"
	})
	if !called {
		t.Fatal("remote request did not reach the rate limiter")
	}
	if !reject || message != "rate-limited" {
		t.Fatalf("remote decision = (%v, %q), want (true, rate-limited)", reject, message)
	}
}

func TestTorPeerDoesNotBypassFilterRateLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "peers.json")
	owner := strings.Repeat("a", 64)
	writer := strings.Repeat("b", 64)
	peer := strings.Repeat("c", 64)
	raw, err := json.Marshal(PeersFile{Owner: owner, Writers: []string{writer}, Peers: []string{peer}})
	if err != nil {
		t.Fatalf("encode peers file: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write peers file: %v", err)
	}
	policy := NewAccessPolicy(path)

	for name, pubkey := range map[string]string{
		"owner":  owner,
		"writer": writer,
	} {
		t.Run(name, func(t *testing.T) {
			called := false
			reject, _ := applyTrustedFilterExemption("127.0.0.1", pubkey, policy, func() (bool, string) {
				called = true
				return true, "rate-limited"
			})
			if called || reject {
				t.Fatalf("trusted %s did not receive the loopback exemption", name)
			}
		})
	}

	called := false
	reject, message := applyTrustedFilterExemption("127.0.0.1", peer, policy, func() (bool, string) {
		called = true
		return true, "rate-limited"
	})
	if !called || !reject || message != "rate-limited" {
		t.Fatalf("Tor peer decision = (called=%v, reject=%v, message=%q), want limiter rejection", called, reject, message)
	}
}

func TestAuthorizeEventMatrix(t *testing.T) {
	local, networked, owner, writer, peer, unknown := authorizationTestPolicies(t)

	tests := []struct {
		name        string
		policy      *AccessPolicy
		authed      string
		eventPubkey string
		wantReject  bool
		wantMessage string
	}{
		{
			name:        "local mode does not require auth",
			policy:      local,
			eventPubkey: unknown,
		},
		{
			name:        "networked mode challenges unauthenticated writer",
			policy:      networked,
			eventPubkey: unknown,
			wantReject:  true,
			wantMessage: "auth-required: this relay requires NIP-42 authentication",
		},
		{
			name:        "owner may publish any valid event",
			policy:      networked,
			authed:      owner,
			eventPubkey: unknown,
		},
		{
			name:        "writer may publish own event",
			policy:      networked,
			authed:      writer,
			eventPubkey: writer,
		},
		{
			name:        "writer may not publish another authors event",
			policy:      networked,
			authed:      writer,
			eventPubkey: owner,
			wantReject:  true,
			wantMessage: "auth-required: pubkey not in peer list",
		},
		{
			name:        "peer has read-only access",
			policy:      networked,
			authed:      peer,
			eventPubkey: peer,
			wantReject:  true,
			wantMessage: "restricted: peers have read-only access",
		},
		{
			name:        "unknown authenticated key is rejected",
			policy:      networked,
			authed:      unknown,
			eventPubkey: unknown,
			wantReject:  true,
			wantMessage: "auth-required: pubkey not in peer list",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reject, message := authorizeEvent(test.policy, test.authed, test.eventPubkey)
			if reject != test.wantReject || message != test.wantMessage {
				t.Fatalf("authorizeEvent() = (%v, %q), want (%v, %q)",
					reject, message, test.wantReject, test.wantMessage)
			}
		})
	}
}

func TestAuthorizeReadMatrix(t *testing.T) {
	local, networked, owner, writer, peer, unknown := authorizationTestPolicies(t)

	tests := []struct {
		name        string
		policy      *AccessPolicy
		authed      string
		wantReject  bool
		wantMessage string
	}{
		{name: "local mode does not require auth", policy: local},
		{
			name:        "networked mode challenges unauthenticated reader",
			policy:      networked,
			wantReject:  true,
			wantMessage: "auth-required: this relay requires NIP-42 authentication",
		},
		{name: "owner may read", policy: networked, authed: owner},
		{name: "writer may read", policy: networked, authed: writer},
		{name: "peer may read", policy: networked, authed: peer},
		{
			name:        "unknown authenticated key is rejected",
			policy:      networked,
			authed:      unknown,
			wantReject:  true,
			wantMessage: "restricted: pubkey not in peer list",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reject, message := authorizeRead(test.policy, test.authed)
			if reject != test.wantReject || message != test.wantMessage {
				t.Fatalf("authorizeRead() = (%v, %q), want (%v, %q)",
					reject, message, test.wantReject, test.wantMessage)
			}
		})
	}
}

func authorizationTestPolicies(t *testing.T) (
	local *AccessPolicy,
	networked *AccessPolicy,
	owner string,
	writer string,
	peer string,
	unknown string,
) {
	t.Helper()
	dir := t.TempDir()
	local = NewAccessPolicy(filepath.Join(dir, "missing.json"))
	owner = strings.Repeat("a", 64)
	writer = strings.Repeat("b", 64)
	peer = strings.Repeat("c", 64)
	unknown = strings.Repeat("d", 64)

	raw, err := json.Marshal(PeersFile{
		Owner:   owner,
		Writers: []string{writer},
		Peers:   []string{peer},
	})
	if err != nil {
		t.Fatalf("encode authorization test policy: %v", err)
	}
	path := filepath.Join(dir, "peers.json")
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write authorization test policy: %v", err)
	}
	networked = NewAccessPolicy(path)
	return local, networked, owner, writer, peer, unknown
}
