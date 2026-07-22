# TODOS

This is the deferred-work register for work outside the current desktop
trace-aware writing loop. AI-assisted writing is the product center; one narrow
provider-neutral handoff follows the reliable single-provider desktop slice,
while a broad multi-AI platform, mobile, hosted authoring, and public
distribution remain later programs unless new evidence promotes a dependency.

## Hosted authoring

### Encrypted browser vault and hosted authoring

**What:** Add a browser-native encrypted persistent vault for signing keys and
provider credentials, with unlock, recovery, revocation, and lifecycle
semantics suitable for hosted authoring.

**Why:** Local/session memory is not an acceptable durable secret store for a
hosted commercial authoring surface, while plaintext browser storage cannot
satisfy the trust boundary required by signed provenance and provider access.

**Context:** The first commercial authoring pilot remains desktop-only. Until
this vault exists, hosted web is read-only and model-free: signing, Send,
Attest, and MODEL execution remain unavailable there.

**Pros:** Enables hosted authoring and MODEL onboarding without weakening the
desktop security contract; could reduce installation friction.

**Cons:** Substantial cryptographic and recovery design; browser compromise and
sync semantics remain difficult; expands security review and support burden.

**Effort:** XL
**Priority:** P3
**Deferred:** 2026-07-17
**Satisfied prerequisite:** The secure-store abstraction is proven on desktop
by the shipped Stronghold vault.
**Depends on:** Threat model, key-recovery product decision, browser security
review, and pilot evidence that installation, rather than reviewer value, is
the limiting factor.

## Review experience

### Composite folder replay stage

**What:** Render a focused folder's historical layout inside an isolated,
read-only replay stage instead of projecting historical child panels through
ordinary live workspace tabs.

**Why:** A dedicated stage may eventually make folder replay easier to reason
about and prevent historical projections from resembling editable live work.

**Context:** For now, the folder remains the singular focus while the current
replay engine renders virtual read-only historical child panels. Those
projections do not open live traces or acquire focus. Clicking a projected
child explicitly exits folder replay and focuses that live child.

**Pros:** Strong separation between live workspace and historical state;
clearer reviewer mental model; simpler rules for composite layout playback.

**Cons:** Replaces working replay presentation; large UI/state change before
validation; risks duplicating panel and tab machinery.

**Effort:** L
**Priority:** P3
**Deferred:** 2026-07-17
**Depends on:** Reviewer usability evidence from folder replay, stable singular
focus, and a decision that the existing virtual projection is insufficient.

## Discovery pilots

### Commercial 24-hour audition wrapper

**What:** Productize a 24-hour AI-permitted writing audition with assignment
provisioning, candidate consent, clock and deadline semantics, safe brief
packaging, reviewer access, retention/deletion controls, and outcome capture.

**Why:** An earlier review framed a paid take-home audition as the first
commercial pilot. It remains a candidate pilot for the discovery track, but
building a general administration layer before proving reviewer value would
outrun demand.

**Context:** If interviews support the use case, the first audition remains
concierge. Setup and MODEL onboarding happen before the 24-hour clock; Zine
evaluates process evidence and never emits an automated employment verdict.
This is a validation method, not the product center or a roadmap dependency.

**Pros:** Makes repeat pilots easier to administer; clarifies candidate rights
and deadlines; creates a coherent commercial workflow around Zine evidence.

**Cons:** Adds identity, policy, access, notification, and data-retention scope;
can distract from whether process replay changes hiring judgment.

**Effort:** XL
**Priority:** P3
**Deferred:** 2026-07-17
**Depends on:** Three qualified workflow interviews, one committed paid pilot,
candidate safeguards, secure desktop authoring, portable read-only replay, and
proof that the evidence changes a consequential reviewer question.

## Agent workspace

### General workspace shell

**What:** Add a separately permissioned terminal/shell surface for users who
deliberately want an agent to modify their Zine workspace or desktop
environment.

**Why:** A general shell could support arbitrary local tooling and workspace
maintenance that typed provider adapters cannot anticipate, without weakening
the typed adapter supervisor.

**Context:** Current and planned provider adapters are typed, bounded, and
explicitly approved. A future shell must be a visibly separate dangerous
capability, never an escape hatch inside those adapters. Its design must
distinguish authored changes, observed agent tool use, and ambient filesystem
mutations in provenance and consent UI.

**Pros:** Supports advanced local-agent workflows, workspace maintenance, and
user-installed tools beyond Zine's registered model actions.

**Cons:** Greatly enlarges the security and consent surface and risks confusing
provenance if arbitrary processes can mutate workspace state.

**Effort:** XL
**Priority:** P4
**Deferred:** 2026-07-17
**Depends on:** Stable typed adapters, operation provenance, permission UX,
environment redaction, executable policy, and a dedicated threat model.

## Distribution

### Public desktop release pipeline

**What:** Add signed and notarized macOS releases, an explicit update-channel
policy, reproducible bundled sidecars, and a tested Windows/Linux release
matrix.

**Why:** Business users need trustworthy installation and updates beyond the
first current-machine macOS dogfood bundle.

**Context:** The current desktop program intentionally targets a reliable
installable bundle on the current macOS development machine. Public
distribution remains outside that slice so platform packaging and certificate
operations do not destabilize the core writing and provenance runtime, but it
must be completed before broad external distribution.

**Pros:** Makes open-source commercial distribution credible, lowers
installation friction, and verifies that native adapter and storage assumptions
are portable.

**Cons:** Adds CI secrets, certificate management, platform-specific packaging,
update security, and three-platform support responsibilities.

**Effort:** XL
**Priority:** P2
**Deferred:** 2026-07-17
**Depends on:** Stable macOS dogfood bundle, versioning and update policy,
reproducible relay and adapter sidecars, security review, and release ownership.

## Mobile and private sync

### Multi-device mobile press RFC and security program

**What:** Design and separately review a native phone press with device-local
signing and encryption keys, stable logical ownership, enrollment/revocation,
offline branch reconciliation, independent recovery authorities, and P2P-first
encrypted private sync.

**Why:** Phone note capture is valuable, but safely unifying work owned across
devices requires a trust and recovery model far beyond the single-owner,
single-signer desktop proof. Moving desktop keys to the phone would create the
wrong security boundary; inventing the multi-device wire model inside the
desktop slice would make it difficult to revise.

**Context:** Mobile is explicitly postponed until the desktop writing,
provenance, AI-operation, durability, and recovery loops are reliable. The
desktop schema keeps an extension seam: the current proof requires
`ownerId === signerPubkey`, while a later unequal relation must carry exact
authorization evidence understood by the reader. A later mobile program owns
root manifests, device grants, separate signing/encryption capabilities,
revocation, recovery epochs, contested offline siblings, native phone storage,
direct/LAN/hole-punched/circuit-relayed delivery, and encrypted
store-and-forward fallback. The detailed RFC remains in the project planning
archive until desktop gates are met and that program is separately promoted
into repository scope.

**Pros:** Preserves mobile note-taking and local-first ownership without moving
private keys between devices; gives the high-risk trust model an explicit
security gate and independent test program.

**Cons:** Mobile capture remains unavailable until the desktop lifecycle is
proven; the full program adds cryptography, recovery UX, networking, native
storage, conflict review, and substantial support burden.

**Effort:** XL
**Priority:** P3 after desktop reliability gates
**Deferred:** 2026-07-17
**Depends on:** Stable schema-2 desktop events, `press.sqlite3`, purpose-specific
native capabilities, fixed cross-language conformance corpus, real demand
evidence, and a dedicated threat-model/protocol review.

## Storage durability

### Transparent event-body compression and deduplication

**What:** Add content-addressed snapshot chunks, transparent compression,
garbage collection, backup, integrity audit, corruption recovery, and exact
signed-event reconstruction for local and hosted event stores.

**Why:** Every conforming trace Step carries a complete snapshot, so cumulative
task storage grows quadratically. Storing each immutable event once avoids
accidental duplication but does not remove the protocol's inherent physical
history cost.

**Context:** The desktop proof uses ordinary single-copy SQLite with measured
event/task warning budgets, database/WAL instrumentation, and explicit
compaction/reply choices. The storage design must be chosen from a real dogfood
corpus and must reconstruct byte-identical signed events. It cannot reduce the
size of an individual Nostr event or websocket message; wire limits remain a
separate product constraint.

**Pros:** Reduces local and hosted-relay physical storage while preserving
immutable event identity and self-contained wire semantics.

**Cons:** Creates a custom storage layer with migration, reference counting,
garbage-collection, corruption, backup, and recovery risks; implementing it
before corpus measurements would lock in speculative chunk boundaries.

**Effort:** XL
**Priority:** P1 before public release
**Deferred:** 2026-07-17
**Depends on:** Stable schema-2 encoding, measured dogfood database growth,
event-size budgets, exact reconstruction/signature tests, corruption fixtures,
and the public-release decision.

## Provenance / Rendezvous

### Kademlia republish-deadline sweep test seam

**What:** Add a regression test that exercises `sweep_republish_deadlines` in
`apps/client/src-tauri/src/kademlia.rs` — the structural backstop that forces
`query.finish()` on a republish query whose 30 s deadline expired without a
terminal `OutboundQueryProgressed` event.

**Why:** This is the load-bearing defense against a libp2p bug that leaves an
orphan Kad query alive when the terminal event never arrives. The fix landed in
the co-mint hardening PR (commit `cc4942d`) but has no test coverage today. A
regression that dropped the `query.finish()` call or changed the `matches!`
arms so a non-Republish pending got its slot decremented twice would not be
caught.

**Context:** `sweep_republish_deadlines` is a private method on `EventLoop`,
which wraps a libp2p `Swarm` with dozens of private fields. No test seam
exists. Existing tests use real wall-clock time (no `tokio::time::pause`), so
driving the 30 s deadline costs unacceptable CI time. The fix requires either
(a) extracting the deadline-sweep logic into a pure helper plus `#[cfg(test)]`
accessors on `EventLoop`, or (b) introducing a virtual-clock test runtime.

**Pros:** Locks the republish-deadline backstop against silent regression;
documents the libp2p query-lifetime contract.

**Cons:** Touches the kademlia event-loop internals; the test seam is non-trivial.

**Effort:** M
**Priority:** P2
**Deferred:** 2026-07-19
**Depends on:** A decision on the test-seam shape (pure helper vs. virtual
clock) and confirmation that the libp2p `QueryId` lifetime matches the
application deadline across versions.

### Bind Mint completion attestation to coin pubkey at the IDB-load boundary

**What:** Extend `validateCompletionAttestation` in
`apps/client/src/provenance/rendezvous-outbox.ts` to require the caller pass
the expected coin pubkey, and reject any attestation whose `pubkey` does not
match — closing the persistence-layer gap that today relies on the drain path's
`isValidMinterAttestation` check.

**Why:** A tampered IDB row pairing a foreign-minter attestation to a Coin
passes `validateCompletionAttestation` on load today (it only checks the
attestation's self-consistency: signature valid, `p` tag matches
`attestation.pubkey`, kind/tag shape correct). The drain path catches it later
via `isValidMinterAttestation(coin, completionAttestation)` after re-fetching
the real Coin event, and terminal-abandons the row. Impact is bounded to DoS
on that Coin's indexing, not forgery — but the persistence-layer gap means a
tampered row stays in the outbox consuming bytes until the drain runs.

**Context:** The coin `Event` is not stored in the IDB row (only `eventId`).
Binding the pubkey at load would require either (a) an IDB schema change to
store the coin's pubkey in the row, or (b) re-fetching the coin event at
validation time (expensive). The drain-boundary check is authoritative today;
this entry exists to document why the gap is acceptable and what would close it.

**Pros:** Defense-in-depth: a tampered row never even loads, instead of loading
and being abandoned at the drain boundary.

**Cons:** Schema change or eager fetch adds complexity for marginal benefit
given the drain-boundary check already prevents forgery.

**Effort:** M
**Priority:** P3
**Deferred:** 2026-07-19
**Depends on:** A decision to widen the IDB schema (v2 -> v3 migration) or
accept the eager fetch cost; currently the drain boundary is authoritative.
