// Local-first relay for the zine trace protocol (see protocol/trace-provenance.md).
//
// Two deployment shapes share this binary:
//   - Desktop sidecar: bound to 127.0.0.1 only, sqlite-backed, never
//     internet-reachable. The desktop client is what makes outbound
//     connections to publish selected events elsewhere — nothing ever
//     connects in.
//   - Hosted (docker-compose, Postgres-backed): a separate main package
//     will reuse the same khatru wiring with a Postgres eventstore; not
//     built yet, this binary is the local/desktop half.
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"

	"github.com/fiatjaf/eventstore/sqlite3"
	"github.com/fiatjaf/khatru"
	"github.com/fiatjaf/khatru/policies"
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
	relay.Info.SupportedNIPs = []any{1, 9, 11, 18, 33}

	policies.ApplySaneDefaults(relay)

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
