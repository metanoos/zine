package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AccessPolicy is the access-policy layer for the desktop relay.
//
// The relay has two modes, gated by whether peers.json exists with an owner:
//
//   - Local mode (no peers.json, or owner empty): the old behavior — trust
//     localhost, no AUTH required. This is what every existing dev workflow
//     (harness, desktop app first run) expects. Breaking it would break every
//     test and every install that hasn't opted into networked mode.
//
//   - Networked mode (peers.json has an owner): the relay requires NIP-42 AUTH.
//     The owner pubkey gets read+write; listed writers get read+write but only
//     for events they sign as themselves (a writer publishes under its own key,
//     never impersonating the owner — the canonical case is a headless press
//     like zine-mcp); listed peers get read-only; everyone else is challenged
//     but rejected. This is the "actual server" posture — see
//     protocol/transport.md §5.
//
// Mode is chosen at startup and re-evaluated on file change before every new
// connection as well as on a 5s background poll. The policy is a private local
// security boundary, never published as a Nostr event (transport.md §2).
type AccessPolicy struct {
	mu       sync.RWMutex
	path     string
	modTime  time.Time
	owner    string
	peers    map[string]bool
	writers  map[string]bool
	hasOwner bool
}

// PeersFile is the on-disk shape, stored as a sibling to the relay DB
// (~/.tracer/peers.json), mirroring the hosted binary's operator.json.
type PeersFile struct {
	Owner string   `json:"owner"`
	Peers []string `json:"peers"`
	// Writers may publish events they sign as themselves (read+write, but only
	// their own pubkey's events). The canonical writer is a headless press
	// (zine-mcp) — a key you authorize to publish traces on your relay while
	// remaining a distinct, attributable author on the chain. Distinct from
	// owner (admin) and peers (read-only). Absent on older peers.json files
	// → empty (no writers); readers tolerate it.
	Writers []string `json:"writers,omitempty"`
}

// NewAccessPolicy creates a policy backed by the given JSON path. The file may
// not exist yet (local mode); it's loaded lazily and re-checked on poll.
func NewAccessPolicy(path string) *AccessPolicy {
	policy := &AccessPolicy{
		path:    path,
		peers:   make(map[string]bool),
		writers: make(map[string]bool),
	}
	policy.reload()
	return policy
}

// reload reads the JSON file if it has changed (by mtime). Called once at
// construction and then on connection/poll refresh. A missing file transitions
// to local mode. An unreadable or corrupt update preserves the last known-good
// policy and is retried on the next refresh. A file with an empty owner is
// local mode — the owner field is what activates networked mode.
func (a *AccessPolicy) reload() {
	info, err := os.Stat(a.path)
	if err != nil {
		if !os.IsNotExist(err) {
			return
		}
		// File doesn't exist — transition to local mode cleanly and forget the
		// accepted mtime so a recreated policy is always considered.
		a.mu.Lock()
		defer a.mu.Unlock()
		a.modTime = time.Time{}
		a.hasOwner = false
		a.owner = ""
		a.peers = make(map[string]bool)
		a.writers = make(map[string]bool)
		return
	}

	a.mu.RLock()
	// Skip if unchanged since last load.
	if !a.modTime.IsZero() && !info.ModTime().After(a.modTime) {
		a.mu.RUnlock()
		return
	}
	a.mu.RUnlock()

	// Read and parse outside the lock (file I/O).
	raw, err := os.ReadFile(a.path)
	if err != nil {
		return
	}
	var pf PeersFile
	if err := json.Unmarshal(raw, &pf); err != nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.modTime = info.ModTime()
	a.owner = pf.Owner
	a.hasOwner = isValidPubkey(pf.Owner)
	a.peers = make(map[string]bool, len(pf.Peers))
	for _, pk := range pf.Peers {
		if isValidPubkey(pk) {
			a.peers[pk] = true
		}
	}
	a.writers = make(map[string]bool, len(pf.Writers))
	for _, pk := range pf.Writers {
		if isValidPubkey(pk) {
			a.writers[pk] = true
		}
	}
}

// Poll checks the file mtime and reloads if changed. Intended to be called on
// a ticker. Zero-dep: no fsnotify, just a stat — cheap for a small JSON file.
func (a *AccessPolicy) Poll() {
	a.reload()
}

// Active reports whether networked mode is active (owner is set). When false,
// the relay operates in local mode and all AUTH-gate closures should be no-ops.
func (a *AccessPolicy) Active() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hasOwner
}

// IsOwner reports whether the given hex pubkey is the configured owner.
func (a *AccessPolicy) IsOwner(pubkey string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hasOwner && pubkey == a.owner
}

// IsPeer reports whether the given hex pubkey is in the read-only peer allowlist.
// The owner is NOT implicitly a peer (peers are read-only by design).
func (a *AccessPolicy) IsPeer(pubkey string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.peers[pubkey]
}

// IsWriter reports whether the given hex pubkey may publish its own events.
// Writers differ from peers (read-only) and from the owner (admin): a writer
// publishes events signed as itself, never impersonating the owner. The write
// gate enforces ev.PubKey == authed for writer events.
func (a *AccessPolicy) IsWriter(pubkey string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.writers[pubkey]
}

// AllowRead reports whether the pubkey may read (owner, writer, or peer). A
// writer that can publish but not query its own folder is useless, so writers
// are read-enabled too. Caller checks Active() first — local mode doesn't call.
func (a *AccessPolicy) AllowRead(pubkey string) bool {
	return a.IsOwner(pubkey) || a.IsPeer(pubkey) || a.IsWriter(pubkey)
}

// isValidPubkey checks for a 64-char lowercase hex string (32-byte Nostr
// pubkey). Mirrors operator.go's validation.
func isValidPubkey(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		switch {
		case c >= '0' && c <= '9':
		case c >= 'a' && c <= 'f':
		default:
			return false
		}
	}
	return true
}

// DefaultPeersPath returns ~/.tracer/peers.json, sibling to the relay DB.
func DefaultPeersPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "peers.json")
}
