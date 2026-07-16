package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fiatjaf/eventstore/sqlite3"
	"github.com/nbd-wtf/go-nostr"
)

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

	for _, name := range []string{"peers.json", "friends.json"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(`{"owner":"old"}`), 0o600); err != nil {
			t.Fatalf("seed %s: %v", name, err)
		}
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

	for _, name := range []string{"peers.json", "friends.json"} {
		if _, err := os.Stat(filepath.Join(dir, name)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists after reset (err=%v)", name, err)
		}
	}
	if _, err := os.Stat(unrelated); err != nil {
		t.Fatalf("unrelated file was removed: %v", err)
	}
}
