package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

func TestNewOperatorStoreLoadsState(t *testing.T) {
	operator := testIdentityFor(t, "1").pubkey
	tests := []struct {
		name     string
		contents []byte
		create   bool
		want     operatorState
		wantErr  string
	}{
		{
			name: "missing state starts unbound",
			want: operatorState{CurationTeam: []string{}, Banned: []string{}},
		},
		{
			name:     "empty state starts unbound",
			create:   true,
			contents: []byte{},
			want:     operatorState{CurationTeam: []string{}, Banned: []string{}},
		},
		{
			name:     "valid state normalizes null lists",
			create:   true,
			contents: []byte(`{"operator":"` + operator + `","curation_team":null,"banned":null,"updated_at":42}`),
			want: operatorState{
				Operator:     operator,
				CurationTeam: []string{},
				Banned:       []string{},
				UpdatedAt:    42,
			},
		},
		{
			name:     "corrupt state refuses startup",
			create:   true,
			contents: []byte(`{"operator":`),
			wantErr:  "operator state: parse",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "operator.json")
			if test.create {
				if err := os.WriteFile(path, test.contents, 0o600); err != nil {
					t.Fatalf("write state: %v", err)
				}
			}

			store, err := NewOperatorStore(path, "token", nil)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("NewOperatorStore() error = %v, want containing %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("NewOperatorStore(): %v", err)
			}
			if got := store.Snapshot(); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("Snapshot() = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestOperatorStoreSnapshotIsDefensive(t *testing.T) {
	operator := testIdentityFor(t, "1").pubkey
	team := testIdentityFor(t, "2").pubkey
	banned := testIdentityFor(t, "3").pubkey
	store := newOperatorStoreWithState(t, operatorState{
		Operator:     operator,
		CurationTeam: []string{team},
		Banned:       []string{banned},
	}, nil)

	snapshot := store.Snapshot()
	snapshot.CurationTeam[0] = banned
	snapshot.Banned[0] = team
	snapshot.CurationTeam = append(snapshot.CurationTeam, operator)
	snapshot.Banned = append(snapshot.Banned, operator)

	got := store.Snapshot()
	want := operatorState{
		Operator:     operator,
		CurationTeam: []string{team},
		Banned:       []string{banned},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mutating Snapshot() changed store: got %#v, want %#v", got, want)
	}
}

func TestHandleBind(t *testing.T) {
	operator := testIdentityFor(t, "1").pubkey
	tests := []struct {
		name         string
		storeToken   string
		requestToken string
		pubkey       string
		wantStatus   int
		wantOperator string
	}{
		{
			name:         "disabled without bootstrap token",
			requestToken: "token",
			pubkey:       operator,
			wantStatus:   http.StatusServiceUnavailable,
		},
		{
			name:         "invalid token",
			storeToken:   "token",
			requestToken: "wrong",
			pubkey:       operator,
			wantStatus:   http.StatusUnauthorized,
		},
		{
			name:         "invalid pubkey",
			storeToken:   "token",
			requestToken: "token",
			pubkey:       "not-a-pubkey",
			wantStatus:   http.StatusBadRequest,
		},
		{
			name:         "successful bind persists",
			storeToken:   "token",
			requestToken: "token",
			pubkey:       operator,
			wantStatus:   http.StatusOK,
			wantOperator: operator,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "operator.json")
			store, err := NewOperatorStore(path, test.storeToken, nil)
			if err != nil {
				t.Fatalf("NewOperatorStore(): %v", err)
			}
			body := marshalJSONFor(t, bindRequest{Token: test.requestToken, Pubkey: test.pubkey})
			req := httptest.NewRequest(http.MethodPost, "http://relay.test/operator/bind", strings.NewReader(string(body)))
			res := httptest.NewRecorder()

			store.HandleBind(res, req)

			if res.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", res.Code, test.wantStatus, res.Body.String())
			}
			if got := store.Snapshot().Operator; got != test.wantOperator {
				t.Fatalf("operator = %q, want %q", got, test.wantOperator)
			}
			if test.wantStatus == http.StatusOK {
				reloaded, err := NewOperatorStore(path, test.storeToken, nil)
				if err != nil {
					t.Fatalf("reload persisted state: %v", err)
				}
				got := reloaded.Snapshot()
				if got.Operator != operator || got.UpdatedAt == 0 {
					t.Fatalf("persisted state = %#v, want operator and updated timestamp", got)
				}
			}
		})
	}
}

func TestHandleBindSupportsRecoveryByRebinding(t *testing.T) {
	oldOperator := testIdentityFor(t, "1").pubkey
	newOperator := testIdentityFor(t, "2").pubkey
	path := filepath.Join(t.TempDir(), "operator.json")

	oldStore, err := NewOperatorStore(path, "old-token", nil)
	if err != nil {
		t.Fatalf("NewOperatorStore(): %v", err)
	}
	bindOperator(t, oldStore, "old-token", oldOperator, http.StatusOK)

	recoveredStore, err := NewOperatorStore(path, "rotated-token", nil)
	if err != nil {
		t.Fatalf("reload for recovery: %v", err)
	}
	bindOperator(t, recoveredStore, "old-token", newOperator, http.StatusUnauthorized)
	bindOperator(t, recoveredStore, "rotated-token", newOperator, http.StatusOK)

	reloaded, err := NewOperatorStore(path, "rotated-token", nil)
	if err != nil {
		t.Fatalf("reload rebound state: %v", err)
	}
	if got := reloaded.Snapshot().Operator; got != newOperator {
		t.Fatalf("operator after recovery = %q, want %q", got, newOperator)
	}
}

func TestAuthNIP98Validation(t *testing.T) {
	signer := testIdentityFor(t, "1")
	body := []byte(`{"pubkey":"target","action":"add"}`)
	tests := []struct {
		name    string
		mode    nip98Mode
		wantErr string
	}{
		{name: "valid base64", mode: nip98Valid},
		{name: "valid hex fallback", mode: nip98Hex},
		{name: "missing header", mode: nip98Missing, wantErr: "missing 'Nostr' authorization scheme"},
		{name: "malformed token", mode: nip98Malformed, wantErr: "not valid base64 or hex"},
		{name: "wrong event kind", mode: nip98WrongKind, wantErr: "expected kind"},
		{name: "invalid signature", mode: nip98InvalidSignature, wantErr: "invalid signature"},
		{name: "stale event", mode: nip98Stale, wantErr: "outside time window"},
		{name: "future event", mode: nip98Future, wantErr: "outside time window"},
		{name: "wrong URL", mode: nip98WrongURL, wantErr: "u tag mismatch"},
		{name: "wrong method", mode: nip98WrongMethod, wantErr: "method tag mismatch"},
		{name: "wrong payload", mode: nip98WrongPayload, wantErr: "payload hash mismatch"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "https://relay.test/operator/team", strings.NewReader(string(body)))
			setNIP98Authorization(t, req, body, signer.secret, test.mode)

			got, err := authNIP98(req)
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("authNIP98() error = %v, want containing %q", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("authNIP98(): %v", err)
			}
			if got != signer.pubkey {
				t.Fatalf("signer = %q, want %q", got, signer.pubkey)
			}
			restored, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatalf("read restored request body: %v", err)
			}
			if !reflect.DeepEqual(restored, body) {
				t.Fatalf("restored body = %q, want %q", restored, body)
			}
		})
	}
}

func TestOperatorMutationsEnforceNIP98Roles(t *testing.T) {
	operator := testIdentityFor(t, "1")
	team := testIdentityFor(t, "2")
	outsider := testIdentityFor(t, "3")
	target := testIdentityFor(t, "4")
	tests := []struct {
		name         string
		endpoint     string
		signer       testIdentity
		authMode     nip98Mode
		wantStatus   int
		wantMutation string
	}{
		{name: "operator may add team member", endpoint: "/operator/team", signer: operator, authMode: nip98Valid, wantStatus: http.StatusOK, wantMutation: "team"},
		{name: "team member may not mutate team", endpoint: "/operator/team", signer: team, authMode: nip98Valid, wantStatus: http.StatusForbidden},
		{name: "outsider may not mutate team", endpoint: "/operator/team", signer: outsider, authMode: nip98Valid, wantStatus: http.StatusForbidden},
		{name: "team rejects malformed authorization", endpoint: "/operator/team", signer: operator, authMode: nip98Malformed, wantStatus: http.StatusUnauthorized},
		{name: "team rejects stale authorization", endpoint: "/operator/team", signer: operator, authMode: nip98Stale, wantStatus: http.StatusUnauthorized},
		{name: "operator may ban", endpoint: "/operator/ban", signer: operator, authMode: nip98Valid, wantStatus: http.StatusOK, wantMutation: "ban"},
		{name: "team member may ban", endpoint: "/operator/ban", signer: team, authMode: nip98Valid, wantStatus: http.StatusOK, wantMutation: "ban"},
		{name: "outsider may not ban", endpoint: "/operator/ban", signer: outsider, authMode: nip98Valid, wantStatus: http.StatusForbidden},
		{name: "ban rejects malformed authorization", endpoint: "/operator/ban", signer: team, authMode: nip98Malformed, wantStatus: http.StatusUnauthorized},
		{name: "ban rejects stale authorization", endpoint: "/operator/ban", signer: team, authMode: nip98Stale, wantStatus: http.StatusUnauthorized},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newOperatorStoreWithState(t, operatorState{
				Operator:     operator.pubkey,
				CurationTeam: []string{team.pubkey},
				Banned:       []string{},
			}, nil)
			body := marshalJSONFor(t, teamRequest{Pubkey: target.pubkey, Action: "add"})
			req := httptest.NewRequest(http.MethodPost, "https://relay.test"+test.endpoint, strings.NewReader(string(body)))
			setNIP98Authorization(t, req, body, test.signer.secret, test.authMode)
			res := httptest.NewRecorder()

			switch test.endpoint {
			case "/operator/team":
				store.HandleTeam(res, req)
			case "/operator/ban":
				store.HandleBan(res, req)
			default:
				t.Fatalf("unknown endpoint %q", test.endpoint)
			}

			if res.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", res.Code, test.wantStatus, res.Body.String())
			}
			state := store.Snapshot()
			if got := containsString(state.CurationTeam, target.pubkey); got != (test.wantMutation == "team") {
				t.Fatalf("target team membership = %v, want %v; state=%#v", got, test.wantMutation == "team", state)
			}
			if got := containsString(state.Banned, target.pubkey); got != (test.wantMutation == "ban") {
				t.Fatalf("target ban membership = %v, want %v; state=%#v", got, test.wantMutation == "ban", state)
			}
		})
	}
}

func TestBanPersistsAndSweepsStoredEvents(t *testing.T) {
	operator := testIdentityFor(t, "1")
	target := testIdentityFor(t, "2")
	events := []*nostr.Event{
		{ID: strings.Repeat("a", 64), PubKey: target.pubkey},
		{ID: strings.Repeat("b", 64), PubKey: target.pubkey},
	}
	sweeper := &fakeSweeper{events: events}
	store := newOperatorStoreWithState(t, operatorState{Operator: operator.pubkey}, sweeper)
	body := marshalJSONFor(t, teamRequest{Pubkey: target.pubkey, Action: "add"})
	req := httptest.NewRequest(http.MethodPost, "https://relay.test/operator/ban", strings.NewReader(string(body)))
	setNIP98Authorization(t, req, body, operator.secret, nip98Valid)
	res := httptest.NewRecorder()

	store.HandleBan(res, req)

	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%q", res.Code, http.StatusOK, res.Body.String())
	}
	if !store.IsBanned(target.pubkey) {
		t.Fatal("freshly banned pubkey is not rejected by the in-memory store")
	}
	reloaded, err := NewOperatorStore(store.path, "token", nil)
	if err != nil {
		t.Fatalf("reload persisted ban: %v", err)
	}
	if !reloaded.IsBanned(target.pubkey) {
		t.Fatal("ban was not persisted")
	}
	if !reflect.DeepEqual(sweeper.filter.Authors, []string{target.pubkey}) || sweeper.filter.Limit != 5000 {
		t.Fatalf("sweep filter = %#v, want target author with limit 5000", sweeper.filter)
	}
	wantDeleted := []string{events[0].ID, events[1].ID}
	if !reflect.DeepEqual(sweeper.deleted, wantDeleted) {
		t.Fatalf("deleted event IDs = %v, want %v", sweeper.deleted, wantDeleted)
	}
}

func TestRejectBannedEventDecision(t *testing.T) {
	banned := testIdentityFor(t, "1").pubkey
	allowed := testIdentityFor(t, "2").pubkey
	store := newOperatorStoreWithState(t, operatorState{Banned: []string{banned}}, nil)
	tests := []struct {
		name        string
		pubkey      string
		wantReject  bool
		wantMessage string
	}{
		{
			name:        "banned publisher is rejected",
			pubkey:      banned,
			wantReject:  true,
			wantMessage: "banned: this pubkey is banned from this relay",
		},
		{name: "all other publishers remain allowed", pubkey: allowed},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			reject, message := rejectBannedEvent(store, &nostr.Event{PubKey: test.pubkey})
			if reject != test.wantReject || message != test.wantMessage {
				t.Fatalf("rejectBannedEvent() = (%v, %q), want (%v, %q)", reject, message, test.wantReject, test.wantMessage)
			}
		})
	}
}

type testIdentity struct {
	secret string
	pubkey string
}

func testIdentityFor(t *testing.T, digit string) testIdentity {
	t.Helper()
	secret := strings.Repeat(digit, 64)
	pubkey, err := nostr.GetPublicKey(secret)
	if err != nil {
		t.Fatalf("derive public key: %v", err)
	}
	return testIdentity{secret: secret, pubkey: pubkey}
}

func newOperatorStoreWithState(t *testing.T, state operatorState, sweeper Sweeper) *OperatorStore {
	t.Helper()
	path := filepath.Join(t.TempDir(), "operator.json")
	raw := marshalJSONFor(t, state)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write operator state: %v", err)
	}
	store, err := NewOperatorStore(path, "token", sweeper)
	if err != nil {
		t.Fatalf("NewOperatorStore(): %v", err)
	}
	return store
}

func bindOperator(t *testing.T, store *OperatorStore, token, pubkey string, wantStatus int) {
	t.Helper()
	body := marshalJSONFor(t, bindRequest{Token: token, Pubkey: pubkey})
	req := httptest.NewRequest(http.MethodPost, "http://relay.test/operator/bind", strings.NewReader(string(body)))
	res := httptest.NewRecorder()
	store.HandleBind(res, req)
	if res.Code != wantStatus {
		t.Fatalf("bind status = %d, want %d; body=%q", res.Code, wantStatus, res.Body.String())
	}
}

func marshalJSONFor(t *testing.T, value any) []byte {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	return raw
}

type nip98Mode string

const (
	nip98Valid            nip98Mode = "valid"
	nip98Hex              nip98Mode = "hex"
	nip98Missing          nip98Mode = "missing"
	nip98Malformed        nip98Mode = "malformed"
	nip98WrongKind        nip98Mode = "wrong-kind"
	nip98InvalidSignature nip98Mode = "invalid-signature"
	nip98Stale            nip98Mode = "stale"
	nip98Future           nip98Mode = "future"
	nip98WrongURL         nip98Mode = "wrong-url"
	nip98WrongMethod      nip98Mode = "wrong-method"
	nip98WrongPayload     nip98Mode = "wrong-payload"
)

func setNIP98Authorization(t *testing.T, req *http.Request, body []byte, secret string, mode nip98Mode) {
	t.Helper()
	if mode == nip98Missing {
		return
	}
	if mode == nip98Malformed {
		req.Header.Set("Authorization", "Nostr %%%")
		return
	}

	event := nostr.Event{
		CreatedAt: nostr.Now(),
		Kind:      nostr.KindHTTPAuth,
		Tags: nostr.Tags{
			{"u", req.URL.String()},
			{"method", req.Method},
			{"payload", sha256Hex(body)},
		},
	}
	switch mode {
	case nip98WrongKind:
		event.Kind = nostr.KindTextNote
	case nip98Stale:
		event.CreatedAt = nostr.Timestamp(time.Now().Add(-2 * time.Minute).Unix())
	case nip98Future:
		event.CreatedAt = nostr.Timestamp(time.Now().Add(2 * time.Minute).Unix())
	case nip98WrongURL:
		event.Tags[0][1] = "https://relay.test/operator/other"
	case nip98WrongMethod:
		event.Tags[1][1] = http.MethodDelete
	case nip98WrongPayload:
		event.Tags[2][1] = strings.Repeat("0", 64)
	}
	if err := event.Sign(secret); err != nil {
		t.Fatalf("sign NIP-98 event: %v", err)
	}
	if mode == nip98InvalidSignature {
		event.Content = "tampered after signing"
	}
	raw := marshalJSONFor(t, event)
	token := base64.StdEncoding.EncodeToString(raw)
	if mode == nip98Hex {
		token = hex.EncodeToString(raw)
	}
	req.Header.Set("Authorization", "Nostr "+token)
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

type fakeSweeper struct {
	events  []*nostr.Event
	filter  nostr.Filter
	deleted []string
}

func (f *fakeSweeper) QueryEvents(_ context.Context, filter nostr.Filter) (chan *nostr.Event, error) {
	f.filter = filter
	ch := make(chan *nostr.Event, len(f.events))
	for _, event := range f.events {
		ch <- event
	}
	close(ch)
	return ch, nil
}

func (f *fakeSweeper) DeleteEvent(_ context.Context, event *nostr.Event) error {
	f.deleted = append(f.deleted, event.ID)
	return nil
}

var _ Sweeper = (*fakeSweeper)(nil)
