package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FriendACL is the access-policy layer for the desktop relay.
//
// The relay has two modes, gated by whether friends.json exists with an owner:
//
//   - Open mode (no friends.json, or owner empty): the old behavior — trust
//     localhost, no AUTH required. This is what every existing dev workflow
//     (harness, desktop app first run) expects. Breaking it would break every
//     test and every install that hasn't opted into friend-mode.
//
//   - Friend mode (friends.json has an owner): the relay requires NIP-42 AUTH.
//     The owner pubkey gets read+write; listed friends get read-only; everyone
//     else is challenged but rejected. This is the "actual server" posture —
//     see protocol/transport.md §5.
//
// Mode is chosen at startup and re-evaluated on file change (polled every 5s,
// zero-dep — matching the relay's simplicity). The ACL is a private local
// security boundary, never published as a Nostr event (transport.md §2).
type FriendACL struct {
	mu       sync.RWMutex
	path     string
	modTime  time.Time
	owner    string
	friends  map[string]bool
	hasOwner bool
}

// FriendsFile is the on-disk shape, stored as a sibling to the relay DB
// (~/.tracer/friends.json), mirroring the hosted binary's operator.json.
type FriendsFile struct {
	Owner   string   `json:"owner"`
	Friends []string `json:"friends"`
}

// NewFriendACL creates an ACL backed by the given JSON path. The file may not
// exist yet (open mode); it's loaded lazily and re-checked on poll.
func NewFriendACL(path string) *FriendACL {
	acl := &FriendACL{
		path:    path,
		friends: make(map[string]bool),
	}
	acl.reload()
	return acl
}

// reload reads the JSON file if it has changed (by mtime). Called once at
// construction and then every poll interval. Missing/corrupt file = open mode
// (hasOwner stays false). A file with an empty owner is also open mode — the
// owner field is what activates friend mode.
func (a *FriendACL) reload() {
	info, err := os.Stat(a.path)
	if err != nil {
		// File doesn't exist — open mode. Don't clobber a previously-loaded
		// ACL if the file was just deleted; transition to open mode cleanly.
		a.mu.Lock()
		defer a.mu.Unlock()
		a.hasOwner = false
		a.owner = ""
		a.friends = make(map[string]bool)
		return
	}

	a.mu.Lock()
	// Skip if unchanged since last load.
	if !a.modTime.IsZero() && !info.ModTime().After(a.modTime) {
		a.mu.Unlock()
		return
	}
	a.modTime = info.ModTime()
	a.mu.Unlock()

	// Read and parse outside the lock (file I/O).
	raw, err := os.ReadFile(a.path)
	if err != nil {
		return
	}
	var ff FriendsFile
	if err := json.Unmarshal(raw, &ff); err != nil {
		return
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	a.owner = ff.Owner
	a.hasOwner = isValidPubkey(ff.Owner)
	a.friends = make(map[string]bool, len(ff.Friends))
	for _, pk := range ff.Friends {
		if isValidPubkey(pk) {
			a.friends[pk] = true
		}
	}
}

// Poll checks the file mtime and reloads if changed. Intended to be called on
// a ticker. Zero-dep: no fsnotify, just a stat — cheap for a small JSON file.
func (a *FriendACL) Poll() {
	a.reload()
}

// Enabled reports whether friend mode is active (owner is set). When false,
// the relay operates in open mode and all AUTH-gate closures should be no-ops.
func (a *FriendACL) Enabled() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hasOwner
}

// IsOwner reports whether the given hex pubkey is the configured owner.
func (a *FriendACL) IsOwner(pubkey string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.hasOwner && pubkey == a.owner
}

// IsFriend reports whether the given hex pubkey is in the friend allowlist.
// The owner is NOT implicitly a friend (friends are read-only by design).
func (a *FriendACL) IsFriend(pubkey string) bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.friends[pubkey]
}

// AllowRead reports whether the pubkey may read (owner or friend). Caller is
// responsible for checking Enabled() first — in open mode this isn't called.
func (a *FriendACL) AllowRead(pubkey string) bool {
	return a.IsOwner(pubkey) || a.IsFriend(pubkey)
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

// DefaultFriendsPath returns ~/.tracer/friends.json, sibling to the relay DB.
func DefaultFriendsPath(dbPath string) string {
	return filepath.Join(filepath.Dir(dbPath), "friends.json")
}
