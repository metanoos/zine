// Operator layer for the hosted relay — bootstrap, curation team, moderation.
//
// The relay stays open: anyone can publish, exactly as before. This layer adds
// an opt-in operator role, bound once via an env-resident bootstrap token, with
// two powers that the open posture alone doesn't provide:
//
//   - moderation: ban a pubkey. Banned pubkeys' new events are rejected at the
//     RejectEvent gate (main.go) and their already-stored events are swept, so
//     a ban is effective immediately rather than "from now on".
//   - curation: the operator and a curation team they appoint are the pubkeys
//     whose signed TraceOpinion events shape every reader's Stacks page. That
//     wiring is client-side (alpha-config.ts merges /operator/state into
//     operatorPubkeys); the relay's only job here is to publish who the
//     operator and team are.
//
// The design deliberately refuses any "type your secret key" surface. The
// operator's signing key is fresh-generated in the browser (identity.ts); the
// bootstrap token is a one-purpose enrollment secret that authorizes the relay
// to trust a freshly-generated pubkey. Admin mutations (team/ban) are signed
// NIP-98 HTTP-auth events, so the relay never sees a secret key either — only
// a signature it can verify with the pubkey. Recovering from a lost browser key
// is "rotate the env token, rebind" rather than "restore a backed-up nsec".
//
// State lives at /data/operator.json (atomic temp+rename). The desktop sidecar
// never links this file — operator features are webapp-only, and the sidecar
// doesn't serve /operator/* at all.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// operatorState is the whole mutable surface. Persisted as operator.json.
// Empty file / missing → zero-value (no operator), and the relay behaves
// identically to a pre-operator build.
type operatorState struct {
	Operator     string   `json:"operator"`               // 64-hex pubkey, "" when unbound
	CurationTeam []string `json:"curation_team"`          // 64-hex pubkeys
	Banned       []string `json:"banned"`                 // 64-hex pubkeys
	UpdatedAt    int64    `json:"updated_at"`             // unix seconds
}

// OperatorStore owns the state file + the in-memory snapshot read by the
// RejectEvent gate on every incoming event. One process, one store, so a
// mutex is sufficient — no locking against external writers.
type OperatorStore struct {
	mu       sync.RWMutex
	path     string
	token    string // env-resident bootstrap token; "" → bind disabled
	state    operatorState
	sweeper  Sweeper // eventstore handle for ban sweeps (nil on desktop, but this file is webapp-only)
}

// Sweeper is the subset of the sqlite backend the ban path needs. Declared as
// an interface so the handler test can fake it and so operator.go doesn't
// import the sqlite3 backend directly (main.go wires the concrete store).
type Sweeper interface {
	QueryEvents(context.Context, nostr.Filter) (chan *nostr.Event, error)
	DeleteEvent(context.Context, *nostr.Event) error
}

// NewOperatorStore loads (or initializes) the state file. A missing/empty file
// is the legitimate "no operator yet" state, not an error.
func NewOperatorStore(path, token string, sweeper Sweeper) (*OperatorStore, error) {
	s := &OperatorStore{path: path, token: token, sweeper: sweeper}
	if err := s.load(); err != nil {
		return nil, fmt.Errorf("operator state: %w", err)
	}
	return s, nil
}

func (s *OperatorStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path)
	if err != nil {
		if os.IsNotExist(err) {
			s.state = operatorState{} // fresh install — no operator, empty lists
			return nil
		}
		return err
	}
	if len(b) == 0 {
		s.state = operatorState{}
		return nil
	}
	var st operatorState
	if err := json.Unmarshal(b, &st); err != nil {
		// A corrupt state file is fatal — better to refuse startup than to
		// silently reset banned/operator and lose the moderation surface.
		return fmt.Errorf("parse %s: %w", s.path, err)
	}
	if st.CurationTeam == nil {
		st.CurationTeam = []string{}
	}
	if st.Banned == nil {
		st.Banned = []string{}
	}
	s.state = st
	return nil
}

// persist writes state to a temp file in the same dir then renames over the
// target — atomic on POSIX, so a crash mid-write can't leave a half-file.
// Caller must hold s.mu (write).
func (s *OperatorStore) persist() error {
	s.state.UpdatedAt = time.Now().Unix()
	b, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), "operator.*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	// Best-effort cleanup if any step below fails — a leftover temp file is
	// harmless but untidy.
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.Write(b); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, s.path); err != nil {
		return err
	}
	return nil
}

// --- read accessors (used by the RejectEvent gate and by GET /operator/state) ---

// IsBanned is hot-path (called per incoming event). RLock + linear scan over a
// short list — the banned set is expected to stay small; a bloom filter or a
// map would be premature.
func (s *OperatorStore) IsBanned(pubkey string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, b := range s.state.Banned {
		if b == pubkey {
			return true
		}
	}
	return false
}

// Snapshot returns a deep-ish copy safe to hand to JSON. The slices are copied
// so a later mutation can't race the encoder.
func (s *OperatorStore) Snapshot() operatorState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	team := append([]string{}, s.state.CurationTeam...)
	banned := append([]string{}, s.state.Banned...)
	return operatorState{
		Operator:     s.state.Operator,
		CurationTeam: team,
		Banned:       banned,
		UpdatedAt:    s.state.UpdatedAt,
	}
}

// --- HTTP handlers ---------------------------------------------------------

type bindRequest struct {
	Token  string `json:"token"`
	Pubkey string `json:"pubkey"`
}

type teamRequest struct {
	Pubkey string `json:"pubkey"`
	Action string `json:"action"` // "add" | "remove"
}

// HandleState serves the public operator snapshot. All pubkeys are public by
// definition in Nostr (they're on every event), and surfacing the banned list
// doubles as a transparency log — there's no secrecy to protect here.
func (s *OperatorStore) HandleState(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Snapshot())
}

// HandleBind is the one token-authenticated endpoint. Binding overwrites any
// existing operator — that overwrite is the recovery path for a lost browser
// key (rotate the env token, rebind to a fresh-generated pubkey). The token
// comparison is constant-time even though the threat model (token in env, TLS
// in front) doesn't strictly require it; it costs nothing.
func (s *OperatorStore) HandleBind(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.token == "" {
		// Operator layer not configured on this relay — distinct from "wrong
		// token" so the webapp can show the right message.
		http.Error(w, "bootstrap not configured on this relay", http.StatusServiceUnavailable)
		return
	}
	var req bindRequest
	if err := decodeJSON(r, &req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	if req.Pubkey == "" || !isValidPubkey(req.Pubkey) {
		http.Error(w, "invalid pubkey", http.StatusBadRequest)
		return
	}
	if subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.token)) != 1 {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	s.mu.Lock()
	s.state.Operator = req.Pubkey
	err := s.persist()
	s.mu.Unlock()
	if err != nil {
		http.Error(w, "persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("operator bound: %s", shortPub(req.Pubkey))
	writeJSON(w, http.StatusOK, s.Snapshot())
}

// HandleTeam mutates the curation team. Operator-only.
func (s *OperatorStore) HandleTeam(w http.ResponseWriter, r *http.Request) {
	s.mutateAsOperator(w, r, func(req teamRequest) (string, error) {
		if !isValidPubkey(req.Pubkey) {
			return "", fmt.Errorf("invalid pubkey")
		}
		switch req.Action {
		case "add":
			s.state.CurationTeam = addUnique(s.state.CurationTeam, req.Pubkey)
		case "remove":
			s.state.CurationTeam = removeAll(s.state.CurationTeam, req.Pubkey)
		default:
			return "", fmt.Errorf("action must be add or remove")
		}
		return "curation team", nil
	})
}

// HandleBan mutates the banned list and, on add, sweeps stored events. Operator
// or curation-team — moderation is delegated, not centralized.
func (s *OperatorStore) HandleBan(w http.ResponseWriter, r *http.Request) {
	s.mutateAsStaff(w, r, func(req teamRequest) (string, error) {
		if !isValidPubkey(req.Pubkey) {
			return "", fmt.Errorf("invalid pubkey")
		}
		switch req.Action {
		case "add":
			s.state.Banned = addUnique(s.state.Banned, req.Pubkey)
			s.sweepBanned(req.Pubkey)
		case "remove":
			s.state.Banned = removeAll(s.state.Banned, req.Pubkey)
		default:
			return "", fmt.Errorf("action must be add or remove")
		}
		return "ban list", nil
	})
}

// mutateAsOperator / mutateAsStaff share the parse→auth→mutate→persist shape.
// They differ only in who's allowed: team mutations are operator-only, bans are
// operator-or-team. Both run under s.mu so the persist sees a consistent view.
func (s *OperatorStore) mutateAsOperator(w http.ResponseWriter, r *http.Request, fn func(teamRequest) (string, error)) {
	s.mutate(w, r, fn, func(authPub string) bool {
		st := s.Snapshot()
		return authPub != "" && authPub == st.Operator
	})
}

func (s *OperatorStore) mutateAsStaff(w http.ResponseWriter, r *http.Request, fn func(teamRequest) (string, error)) {
	s.mutate(w, r, fn, func(authPub string) bool {
		st := s.Snapshot()
		if authPub == "" {
			return false
		}
		if authPub == st.Operator {
			return true
		}
		for _, t := range st.CurationTeam {
			if t == authPub {
				return true
			}
		}
		return false
	})
}

// mutate is the shared pipeline. allowed is called under no lock (it calls
// Snapshot, which takes RLock) so that fn can then take the write lock without
// a lock-ordering hazard.
func (s *OperatorStore) mutate(w http.ResponseWriter, r *http.Request, fn func(teamRequest) (string, error), allowed func(string) bool) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.token == "" {
		// No token → no operator was ever bound → admin surface is inert.
		http.Error(w, "operator not configured on this relay", http.StatusServiceUnavailable)
		return
	}
	authPub, err := authNIP98(r)
	if err != nil {
		http.Error(w, "auth: "+err.Error(), http.StatusUnauthorized)
		return
	}
	if !allowed(authPub) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var req teamRequest
	if err := decodeJSON(r, &req); err != nil {
		http.Error(w, "bad request: "+err.Error(), http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	what, err := fn(req)
	if err != nil {
		s.mu.Unlock()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	err = s.persist()
	s.mu.Unlock()
	if err != nil {
		http.Error(w, "persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	log.Printf("%s %s by %s", what, req.Action, shortPub(authPub))
	writeJSON(w, http.StatusOK, s.Snapshot())
}

// sweepBanned deletes every stored event from a freshly-banned pubkey. Called
// under s.mu (write) by HandleBan's fn, which is acceptable because the sweep
// is bounded by how much the abuser published — not a hot path.
func (s *OperatorStore) sweepBanned(pubkey string) {
	if s.sweeper == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ch, err := s.sweeper.QueryEvents(ctx, nostr.Filter{Authors: []string{pubkey}, Limit: 5000})
	if err != nil {
		log.Printf("ban sweep query %s: %v", shortPub(pubkey), err)
		return
	}
	n := 0
	for ev := range ch {
		if err := s.sweeper.DeleteEvent(ctx, ev); err != nil {
			log.Printf("ban sweep delete %s: %v", ev.ID, err)
			continue
		}
		n++
	}
	if n > 0 {
		log.Printf("ban sweep: removed %d events from %s", n, shortPub(pubkey))
	}
}

// --- NIP-98 HTTP auth ------------------------------------------------------

// authNIP98 parses an `Authorization: Nostr <token>` header, verifies the
// signature, and checks that the event matches this request (method, URL,
// payload hash). Returns the signer's pubkey on success.
//
// The token is base64 of the JSON-encoded kind-27235 event (the canonical
// NIP-98 wire format produced by nostr-tools/nip98.getToken). Hex is also
// accepted as a fallback for hand-built clients. go-nostr v0.52.1 ships
// KindHTTPAuth (= 27235) but no nip98 helper package, so the spec checks are
// inline: kind 27235, created_at within a 60s window, a `u` tag equal to the
// full request URL, a `method` tag equal to the HTTP method, and — when the
// body is non-empty — a `payload` tag with the sha256 of the body.
// Event.CheckSignature does the crypto.
func authNIP98(r *http.Request) (string, error) {
	h := r.Header.Get("Authorization")
	const prefix = "Nostr "
	if len(h) <= len(prefix) || h[:len(prefix)] != prefix {
		return "", fmt.Errorf("missing 'Nostr' authorization scheme")
	}
	raw := h[len(prefix):]
	// Canonical NIP-98 is base64. Fall back to hex for ad-hoc/CLI clients.
	evBytes, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		evBytes, err = hex.DecodeString(raw)
		if err != nil {
			return "", fmt.Errorf("authorization token is not valid base64 or hex")
		}
	}
	var ev nostr.Event
	if err := json.Unmarshal(evBytes, &ev); err != nil {
		return "", fmt.Errorf("authorization event is not valid JSON")
	}
	if ev.Kind != nostr.KindHTTPAuth {
		return "", fmt.Errorf("expected kind %d, got %d", nostr.KindHTTPAuth, ev.Kind)
	}
	ok, err := ev.CheckSignature()
	if err != nil || !ok {
		return "", fmt.Errorf("invalid signature")
	}
	// Freshness — a captured NIP-98 event is useless for replay only if we
	// bound its window. 60s is the conventional NIP-98 slack.
	now := time.Now().Unix()
	if ev.CreatedAt.Time().Unix() < now-60 || ev.CreatedAt.Time().Unix() > now+60 {
		return "", fmt.Errorf("authorization event outside time window")
	}
	// Build the canonical URL the way the client would have, so the tag match
	// is scheme/host/path/query-stable. We use the request's host so a proxy
	// rewrite (e.g. Caddy in front) doesn't break verification.
	wantURL := r.URL.String()
	if r.Host != "" && !stringHasScheme(wantURL) {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		wantURL = scheme + "://" + r.Host + wantURL
	}
	if uTag := ev.Tags.GetFirst([]string{"u"}); uTag == nil || uTag.Value() != wantURL {
		return "", fmt.Errorf("u tag mismatch")
	}
	if mTag := ev.Tags.GetFirst([]string{"method"}); mTag == nil || mTag.Value() != r.Method {
		return "", fmt.Errorf("method tag mismatch")
	}
	// Payload hash is required when there's a body. We read the body once here
	// and restore it for the downstream handler via NopCloser.
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return "", fmt.Errorf("read body: %w", err)
	}
	r.Body = io.NopCloser(bytesReader(body))
	if len(body) > 0 {
		sum := sha256Hex(body)
		if pTag := ev.Tags.GetFirst([]string{"payload"}); pTag == nil || pTag.Value() != sum {
			return "", fmt.Errorf("payload hash mismatch")
		}
	}
	return ev.PubKey, nil
}

// --- small helpers ---------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decodeJSON(r *http.Request, v any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func isValidPubkey(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func addUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

func removeAll(list []string, v string) []string {
	out := list[:0]
	for _, x := range list {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func shortPub(pk string) string {
	if len(pk) < 8 {
		return pk
	}
	return pk[:8]
}

// bytesReader wraps a []byte as an io.Reader for restoring r.Body after we've
// already read it for the payload-hash check. (io.NopCloser wants a Reader.)
func bytesReader(b []byte) io.Reader {
	return bytes.NewReader(b)
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// stringHasScheme reports whether s already starts with a scheme like "http://".
// Used to decide whether to prepend scheme+host when reconstructing the request
// URL for NIP-98 verification.
func stringHasScheme(s string) bool {
	return strings.HasPrefix(s, "http://") || strings.HasPrefix(s, "https://")
}
