package main

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var (
	testOwnerA       = strings.Repeat("a", 64)
	testOwnerB       = strings.Repeat("b", 64)
	testPeerA        = strings.Repeat("c", 64)
	testPeerB        = strings.Repeat("d", 64)
	testWriterA      = strings.Repeat("e", 64)
	testWriterB      = strings.Repeat("f", 64)
	testInvalidUpper = strings.Repeat("A", 64)
	testInvalidChar  = strings.Repeat("g", 64)
)

func TestAccessPolicyInitialState(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, path string)
	}{
		{
			name: "missing file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
			},
		},
		{
			name: "empty file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
				writePolicyBytesAt(t, path, nil, policyTestTime(1))
			},
		},
		{
			name: "malformed file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
				writePolicyBytesAt(t, path, []byte(`{"owner":`), policyTestTime(1))
			},
		},
		{
			name: "empty owner",
			prepare: func(t *testing.T, path string) {
				t.Helper()
				writePolicyAt(t, path, PeersFile{}, policyTestTime(1))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "peers.json")
			test.prepare(t, path)

			policy := NewAccessPolicy(path)
			assertPolicyState(t, policy, policyState{})
		})
	}
}

func TestAccessPolicyInitialMissingOrInvalidFileCanActivate(t *testing.T) {
	tests := []struct {
		name    string
		prepare func(t *testing.T, path string)
	}{
		{
			name: "missing file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
			},
		},
		{
			name: "empty file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
				writePolicyBytesAt(t, path, nil, policyTestTime(1))
			},
		},
		{
			name: "malformed file",
			prepare: func(t *testing.T, path string) {
				t.Helper()
				writePolicyBytesAt(t, path, []byte(`{"owner":`), policyTestTime(1))
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "peers.json")
			test.prepare(t, path)
			policy := NewAccessPolicy(path)
			assertPolicyState(t, policy, policyState{})

			writePolicyAt(t, path, PeersFile{
				Owner:   testOwnerA,
				Peers:   []string{testPeerA},
				Writers: []string{testWriterA},
			}, policyTestTime(1))
			policy.Poll()

			assertPolicyState(t, policy, policyState{
				active:  true,
				owner:   testOwnerA,
				peers:   stringSet(testPeerA),
				writers: stringSet(testWriterA),
			})
		})
	}
}

func TestAccessPolicyFiltersInvalidMembersAndToleratesDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	writePolicyAt(t, path, PeersFile{
		Owner: testOwnerA,
		Peers: []string{
			testPeerA,
			testPeerA,
			"",
			"short",
			testInvalidUpper,
			testInvalidChar,
		},
		Writers: []string{
			testWriterA,
			testWriterA,
			"",
			"short",
			testInvalidUpper,
			testInvalidChar,
		},
	}, policyTestTime(1))

	policy := NewAccessPolicy(path)
	assertPolicyState(t, policy, policyState{
		active:  true,
		owner:   testOwnerA,
		peers:   stringSet(testPeerA),
		writers: stringSet(testWriterA),
	})
	for _, invalid := range []string{"", "short", testInvalidUpper, testInvalidChar} {
		if policy.IsOwner(invalid) || policy.IsPeer(invalid) || policy.IsWriter(invalid) || policy.AllowRead(invalid) {
			t.Fatalf("invalid pubkey %q received a policy role", invalid)
		}
	}
}

func TestAccessPolicyToleratesLegacyFileWithoutWriters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	legacy := struct {
		Owner string   `json:"owner"`
		Peers []string `json:"peers"`
	}{
		Owner: testOwnerA,
		Peers: []string{testPeerA},
	}
	raw, err := json.Marshal(legacy)
	if err != nil {
		t.Fatalf("encode legacy policy: %v", err)
	}
	writePolicyBytesAt(t, path, raw, policyTestTime(1))

	policy := NewAccessPolicy(path)
	assertPolicyState(t, policy, policyState{
		active: true,
		owner:  testOwnerA,
		peers:  stringSet(testPeerA),
	})
	if policy.IsWriter(testPeerA) {
		t.Fatal("legacy peer was promoted to writer")
	}
}

func TestAccessPolicyRejectsInvalidOwners(t *testing.T) {
	tests := []struct {
		name  string
		owner string
	}{
		{name: "empty", owner: ""},
		{name: "short", owner: "short"},
		{name: "uppercase", owner: testInvalidUpper},
		{name: "non-hex", owner: testInvalidChar},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "peers.json")
			writePolicyAt(t, path, PeersFile{
				Owner:   test.owner,
				Peers:   []string{"invalid-peer"},
				Writers: []string{"invalid-writer"},
			}, policyTestTime(1))

			policy := NewAccessPolicy(path)
			if policy.Active() {
				t.Fatalf("invalid owner %q activated networked mode", test.owner)
			}
			if policy.IsOwner(test.owner) || policy.IsPeer("invalid-peer") || policy.IsWriter("invalid-writer") {
				t.Fatalf("invalid owner %q activated owner access", test.owner)
			}
		})
	}
}

func TestAccessPolicyReloadReplacesRoles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	writePolicyAt(t, path, PeersFile{
		Owner:   testOwnerA,
		Peers:   []string{testPeerA, testPeerB},
		Writers: []string{testWriterA, testWriterB},
	}, policyTestTime(1))
	policy := NewAccessPolicy(path)

	writePolicyAt(t, path, PeersFile{
		Owner:   testOwnerB,
		Peers:   []string{testWriterB, "invalid-peer"},
		Writers: []string{testPeerB, "invalid-writer"},
	}, policyTestTime(2))
	policy.Poll()

	assertPolicyState(t, policy, policyState{
		active:  true,
		owner:   testOwnerB,
		peers:   stringSet(testWriterB),
		writers: stringSet(testPeerB),
	})
	for _, removed := range []string{testOwnerA, testPeerA, testWriterA} {
		if policy.IsOwner(removed) || policy.IsPeer(removed) || policy.IsWriter(removed) {
			t.Fatalf("removed pubkey %s retained a role after reload", removed)
		}
	}
	if policy.IsPeer(testPeerB) || !policy.IsWriter(testPeerB) {
		t.Fatal("peer-to-writer role replacement was not exact")
	}
	if policy.IsWriter(testWriterB) || !policy.IsPeer(testWriterB) {
		t.Fatal("writer-to-peer role replacement was not exact")
	}
}

func TestAccessPolicyDeletionReturnsToLocalModeAndAllowsRecreation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	stamp := policyTestTime(1)
	writePolicyAt(t, path, PeersFile{
		Owner:   testOwnerA,
		Peers:   []string{testPeerA},
		Writers: []string{testWriterA},
	}, stamp)
	policy := NewAccessPolicy(path)

	if err := os.Remove(path); err != nil {
		t.Fatalf("delete policy: %v", err)
	}
	policy.Poll()
	assertPolicyState(t, policy, policyState{})

	writePolicyAt(t, path, PeersFile{
		Owner:   testOwnerB,
		Peers:   []string{testPeerB},
		Writers: []string{testWriterB},
	}, stamp)
	policy.Poll()
	assertPolicyState(t, policy, policyState{
		active:  true,
		owner:   testOwnerB,
		peers:   stringSet(testPeerB),
		writers: stringSet(testWriterB),
	})
}

func TestAccessPolicyPreservesLastKnownGoodAcrossTransientInvalidUpdates(t *testing.T) {
	tests := []struct {
		name         string
		makeInvalid  func(t *testing.T, path string, stamp time.Time)
		beforeRepair func(t *testing.T, path string)
	}{
		{
			name: "malformed",
			makeInvalid: func(t *testing.T, path string, stamp time.Time) {
				t.Helper()
				writePolicyBytesAt(t, path, []byte(`{"owner":`), stamp)
			},
			beforeRepair: func(t *testing.T, path string) {
				t.Helper()
			},
		},
		{
			name: "unreadable",
			makeInvalid: func(t *testing.T, path string, stamp time.Time) {
				t.Helper()
				if err := os.Remove(path); err != nil {
					t.Fatalf("remove valid policy: %v", err)
				}
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatalf("replace policy with unreadable directory: %v", err)
				}
				if err := os.Chtimes(path, stamp, stamp); err != nil {
					t.Fatalf("set unreadable policy timestamp: %v", err)
				}
			},
			beforeRepair: func(t *testing.T, path string) {
				t.Helper()
				if err := os.Remove(path); err != nil {
					t.Fatalf("remove unreadable policy directory: %v", err)
				}
			},
		},
		{
			name: "temporarily unresolvable path",
			makeInvalid: func(t *testing.T, path string, _ time.Time) {
				t.Helper()
				if err := os.Remove(path); err != nil {
					t.Fatalf("remove valid policy: %v", err)
				}
				if err := os.Symlink(filepath.Base(path), path); err != nil {
					t.Fatalf("replace policy with symlink loop: %v", err)
				}
			},
			beforeRepair: func(t *testing.T, path string) {
				t.Helper()
				if err := os.Remove(path); err != nil {
					t.Fatalf("remove policy symlink loop: %v", err)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "peers.json")
			initial := PeersFile{
				Owner:   testOwnerA,
				Peers:   []string{testPeerA},
				Writers: []string{testWriterA},
			}
			initialState := policyState{
				active:  true,
				owner:   testOwnerA,
				peers:   stringSet(testPeerA),
				writers: stringSet(testWriterA),
			}
			writePolicyAt(t, path, initial, policyTestTime(1))
			policy := NewAccessPolicy(path)

			invalidStamp := policyTestTime(2)
			test.makeInvalid(t, path, invalidStamp)
			policy.Poll()
			assertPolicyState(t, policy, initialState)

			test.beforeRepair(t, path)
			writePolicyAt(t, path, PeersFile{
				Owner:   testOwnerB,
				Peers:   []string{testPeerB},
				Writers: []string{testWriterB},
			}, invalidStamp)
			policy.Poll()
			assertPolicyState(t, policy, policyState{
				active:  true,
				owner:   testOwnerB,
				peers:   stringSet(testPeerB),
				writers: stringSet(testWriterB),
			})
		})
	}
}

func TestAccessPolicyConcurrentPollAndSnapshot(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peers.json")
	states := []struct {
		file  PeersFile
		state policyState
	}{
		{
			file: PeersFile{Owner: testOwnerA, Peers: []string{testPeerA}, Writers: []string{testWriterA}},
			state: policyState{
				active:  true,
				owner:   testOwnerA,
				peers:   stringSet(testPeerA),
				writers: stringSet(testWriterA),
			},
		},
		{
			file: PeersFile{Owner: testOwnerB, Peers: []string{testPeerB}, Writers: []string{testWriterB}},
			state: policyState{
				active:  true,
				owner:   testOwnerB,
				peers:   stringSet(testPeerB),
				writers: stringSet(testWriterB),
			},
		},
	}

	writePolicyAt(t, path, states[0].file, policyTestTime(1))
	policy := NewAccessPolicy(path)
	previous := states[0].state

	for iteration := 0; iteration < 128; iteration++ {
		next := states[(iteration+1)%len(states)]
		writePolicyAt(t, path, next.file, policyTestTime(iteration+2))

		start := make(chan struct{})
		polled := make(chan struct{})
		observed := make(chan policyState, 1)
		go func() {
			<-start
			policy.Poll()
			close(polled)
		}()
		go func() {
			<-start
			observed <- snapshotPolicyState(policy)
		}()
		close(start)

		concurrent := <-observed
		<-polled
		if !policyStatesEqual(concurrent, previous) && !policyStatesEqual(concurrent, next.state) {
			t.Fatalf("iteration %d observed a partial policy state: %#v", iteration, concurrent)
		}
		assertPolicyState(t, policy, next.state)
		previous = next.state
	}
}

func TestDefaultPeersPath(t *testing.T) {
	tests := []struct {
		name   string
		dbPath string
		want   string
	}{
		{name: "absolute database", dbPath: filepath.Join(string(filepath.Separator), "tmp", "zine", "relay.sqlite3"), want: filepath.Join(string(filepath.Separator), "tmp", "zine", "peers.json")},
		{name: "relative database", dbPath: "relay.sqlite3", want: "peers.json"},
		{name: "nested relative database", dbPath: filepath.Join("data", "relay.sqlite3"), want: filepath.Join("data", "peers.json")},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := DefaultPeersPath(test.dbPath); got != test.want {
				t.Fatalf("DefaultPeersPath(%q) = %q, want %q", test.dbPath, got, test.want)
			}
		})
	}
}

type policyState struct {
	active  bool
	owner   string
	peers   map[string]bool
	writers map[string]bool
}

func snapshotPolicyState(policy *AccessPolicy) policyState {
	policy.mu.RLock()
	defer policy.mu.RUnlock()

	return policyState{
		active:  policy.hasOwner,
		owner:   policy.owner,
		peers:   maps.Clone(policy.peers),
		writers: maps.Clone(policy.writers),
	}
}

func assertPolicyState(t *testing.T, policy *AccessPolicy, want policyState) {
	t.Helper()
	got := snapshotPolicyState(policy)
	if !policyStatesEqual(got, want) {
		t.Fatalf("policy state = %#v, want %#v", got, want)
	}
}

func policyStatesEqual(left, right policyState) bool {
	return left.active == right.active &&
		left.owner == right.owner &&
		maps.Equal(left.peers, right.peers) &&
		maps.Equal(left.writers, right.writers)
}

func stringSet(values ...string) map[string]bool {
	result := make(map[string]bool, len(values))
	for _, value := range values {
		result[value] = true
	}
	return result
}

func writePolicyAt(t *testing.T, path string, policy PeersFile, stamp time.Time) {
	t.Helper()
	raw, err := json.Marshal(policy)
	if err != nil {
		t.Fatalf("encode policy: %v", err)
	}
	writePolicyBytesAt(t, path, raw, stamp)
}

func writePolicyBytesAt(t *testing.T, path string, raw []byte, stamp time.Time) {
	t.Helper()
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write policy: %v", err)
	}
	if err := os.Chtimes(path, stamp, stamp); err != nil {
		t.Fatalf("set policy timestamp: %v", err)
	}
}

func policyTestTime(step int) time.Time {
	return time.Unix(1_700_000_000+int64(step), 0)
}
