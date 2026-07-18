# Rendezvous, Vetting & Anteriority (draft)

Status: draft, unpublished. This document specifies how strangers with no
shared peer or relay may discover each other through matching citations, then
evaluate process evidence before admitting the other signer's key.

It introduces three things the provenance and transport protocols do not have:

1. **Trace-derived content rendezvous** — a coordinate derived from a cited
   trace's verified content, without adding a second citation primitive.
2. **Optional distributed anteriority** — NIP-03/OTS timestamps attached to
   the frequent gesture (Step), not the rare one (Attest). When available,
   repeated proofs make a trace's save history impossible to backdate: a
   forger must plant a corpus in advance and wait, so anchors impose calendar
   delay rather than effort (§5.4). Their absence never invalidates the trace.
3. **Automated process-vetting** — cost-raising admission heuristics over the
   signed save graph and any available time anchors. They can reject cheap
   fabricated histories; they do not prove humanness.

**Reading guide.** Part I specifies current rules and labels unimplemented
sketches. Part II records the rationale.

**Product packaging and status.** Coins are the sole user-facing discovery
opt-in. Ordinary citation works without it. Enabling Coins covers Mint,
valid-Coin Send-side indexing, and mutual-peer plus global Coin rendezvous.
Kademlia is the routing component inside that package, not a separate feature
or setting, and remains under implementation. The normative rules below define
the intended interoperable behavior even where the reference package is
incomplete.

---

# Part I — Specification

## 0. Vocabulary in this document

- **Coin** — a selected or directly-authored span made into an immutable
  first-class TraceNode, published and attested by its minter in one compound
  Mint gesture. Mint gives the text a node id and `x` body hash; an extracted
  Coin also carries source lineage. The public Coin declares supply, but does
  not create a rendezvous pointer without a published trace citing it.
- **`H`** — the verified content hash of a cited Coin:
  `sha256(canonical(traceBody))`. The Coins package's **rendezvous coordinate**.
  It is an index key derived from a trace, not a citation and not a replacement
  for the trace's node id.
- **Trace citation** — the protocol's single citation primitive: lowercase
  `q` targeting a TraceNode (§3.3). An explicit body bracket and a tacit,
  bodyless tag are presentation roles over the same edge.
- **Rendezvous layer** — the network component inside the opt-in Coins package
  that answers "who else Sent a cite under `H`?" A Kademlia DHT (§2). Distinct
  from the access-policy mesh (`transport.md` §2), which answers "who may read
  *me*?"
- **Anteriority** — proof that a commitment existed *before* some time T.
  Optionally carried by NIP-03/OTS timestamps anchored to Bitcoin.
- **Process signal** — the internally consistent signed shape of an author's
  save graph, plus any available anteriority anchors. The material the vet
  reads.
- **Vet** — the automated machine-read of a fetched trace's process signal. A
  cost-raising admission heuristic, not a proof of author identity or humanity.

## 1. Neutral citation, Coin rendezvous

There is no orphan-text citation and no uppercase `Q` tag. Text must become a
trace before it can be cited:

1. `[[text]]` is local draft syntax and emits no citation or social signal.
2. A resolved inline bracket may cite any exact stepped source with ordinary
   lowercase `q`. This is neutral composition: a writer may quote a source they
   reject. A bodyless tag uses the same edge with `role: "tag"`.
3. **Mint** is optional affirmative curation. It creates a first-class Coin
   whose body is `text` and whose `x` tag is its content hash, Publishes that
   exact genesis, and Attests it under the same minter key. An extracted Coin's
   `extracted-from` edge names the source version. This public pair declares
   Coin supply but emits no rendezvous pointer by itself.
4. **Send** changes reachability. When the carrying trace is Sent, all of its
   `q` edges become observable on destination relays, but only targets that
   verify as Coins are eligible for Coins rendezvous indexing. Outside compound
   Mint, citation does not imply Attest; Attest remains a separate commitment
   to an already-Sent node.

This removes the ambiguous state in which bytes were socially cited without an
object to open or verify while keeping disagreement cheap: ordinary quotation
pins the source Step, and Mint is never an automatic consequence of copy or
paste. Printed, oral, and otherwise external text still needs a stepped import
before it can be cited; source/edition/locator may be ordinary provenance
metadata on that trace.

### 1.1 The derived rendezvous coordinate

When Coins are enabled, a client may resolve each cited `q` target. Only after
the target verifies as a Coin — including its body, `x` tag, and same-minter
attestation — may the client derive `H = sha256(canonical(traceBody))`.
Independent people may mint the same bytes into different node ids; `H` lets the
index cluster those independently minted targets without changing what
a citation is. The carrying event remains the social statement; `H` is only a
lookup coordinate.

**`H` is not the `x` tag.** `x` hashes the exact bytes (`trace-provenance.md`
§2, no normalization); `H` hashes the canonicalized text (§1.2). Two mints
differing only in whitespace or Unicode normalization form share an `H` while
carrying different `x` values — `x` clusters are subsets of `H` clusters. The
consequences follow the keying, not intuition: `TraceOpinion` `x:` subjects key
on `x`, so an opinion on one mint does NOT cover a whitespace-variant mint even
though rendezvous would cluster the two. The coarser coordinate exists for
discovery; the exact one carries opinion and duplicate detection.

### 1.2 Canonicalization

`H` must be a single value for the "hash is the address of the room" property
to hold (§R1). Canonicalization is therefore exact, not fuzzy:

- Unicode NFC normalization.
- Collapse all whitespace runs (space, tab, newline, CR) to a single space.
- Trim leading/trailing whitespace.
- **Do not case-fold.** Case can carry meaning ("The" vs "the"); let
  near-identical quotes that differ only in case miss each other.
- No punctuation stripping, no stop-word removal.

Fuzzy clustering is a **client-side** layer above the coordinate (§R2), never
part of `H`.

## 2. The DHT rendezvous

The rendezvous layer answers one question: *which signed, Sent events cite a
valid Coin whose verified coordinate is `H`?* It returns `{eventId, relayUrl}`
pointers, never content, a private onion, or an asserted pubkey. The querier
fetches the carrying event, target, and minter attestation from a
stranger-readable relay, then verifies their ids, signatures, `q` edge, Coin
envelope, body, `x` hash, and same-minter relationship. Private contact
details are exchanged only after vetting. Returning an ACL-protected onion
first would make the evidence unreachable until after admission.

### 2.1 Why a DHT, not the mesh

The access-policy mesh is deliberately not a discovery graph. It answers
**who may read me?** Global rendezvous answers a different question:
**who cited the same content despite sharing no peer, relay, or trust?** That
requires nodes to route keys they do not hold in O(log N) hops, which is the
job of a Kademlia DHT.

The two layers compose cleanly because they carry different things:

| Layer | Carries | Question answered |
|---|---|---|
| Mesh (`transport.md`) | signed traces | "who may read *me*?" |
| DHT (this doc) | event pointers: `H → {eventId, relayUrl}` | "which Sent events cite content `H`?" |

The DHT never carries speech — only pointers to where speech lives. "Nobody
carries speech they did not sign" still holds: DHT routing tables hold
addresses, not content.

### 2.2 Wire (v1; implementation in progress)

The in-progress reference desktop uses Kademlia in the Rust Tauri backend
(`libp2p::kad`), alongside the Go relay sidecar. It runs only as part of the
enabled Coins package. The DHT protocol name is
`/zine/rendezvous/kad/1.0.0`; its replication factor is `k=8`. A record key is
the UTF-8 bytes `/zine/rendezvous/1/<H>`. Its value is bounded JSON:

```json
{
  "version": 1,
  "coordinate": "<64-lowercase-hex H>",
  "pointers": [{ "eventId": "<64-lowercase-hex>", "relayUrl": "wss://…" }]
}
```

Implementations MUST reject a non-canonical key, mismatched coordinate/version,
malformed event id, non-WebSocket URL, URL credentials, loopback/private IP
literal (including IPv4-mapped IPv6), `.onion`, or value larger than 12 KiB.
The reference server filters both local and remote inserts before storage; an
untrusted peer cannot use a raw Kademlia Put to bypass those checks. It retains
at most 64 distinct pointers per coordinate, keeps locally originated pointers
ahead of disposable remote values when truncating, and reserves storage for up
to 2,048 owned coordinates independently of its 1,024-record remote cache.
Remote-cache saturation therefore cannot evict or prevent an owned record.
These are index-availability limits, not supply claims: Kademlia results MUST
NOT be presented as global Coin supply, popularity, trust, or reputation.

- **Put** — inspect every ordinary social `q` citation in the Sent carrying
  node, excluding structural `scope:llm` prompt dependencies. Implementations
  MAY divide relay reads and writes into bounded batches, but MUST NOT silently
  truncate a large anthology. For each target that resolves to a valid Coin,
  verify its body/`x`, derive `H`, and publish
  `{eventId, relayUrl}` under `H`. `eventId` is the Sent carrying node and
  `relayUrl` is at least one relay from which an unknown reader can fetch both
  it and its target. Fires as a side-effect of Send. A client MUST NOT publish
  a pointer to its private ACL relay or an onion location. Before Put, the
  reference press opens a fresh unauthenticated connection and verifies that
  both events are fetchable from `relayUrl`. Published toward the eight closest
  discovered nodes to `H` for redundancy (§R6). The Put requests quorum eight
  so libp2p attempts the complete discovered closest-peer set instead of
  returning after the first acknowledgment. If that full attempt finds fewer
  than eight responsive peers, one or more acknowledgments are a usable partial
  publication; the shortfall is recorded and the application-level republish
  cycle retries it. A node with no known peer retains the record locally. A
  small network therefore does not pretend to have eight remote replicas. A DHT
  failure does not roll back the already-successful Send. The reference press
  durably queues the signed carrying event before asynchronous indexing,
  retries incomplete events with bounded backoff plus startup and network
  recovery triggers, and retains pending events until completion.
- **Get** — query "who published under `H`?" Returns the value list. A querier
  computes `H` for a trace body they care about, asks the DHT, and receives
  candidate event pointers. Each carrying event, cited Coin, and same-minter
  attestation are fetched and verified before the signer's process enters the
  vet (§5.3); a failed fetch/signature/`q`/Coin/attestation/target-hash check is
  not a candidate.

Nostr remains the signed-event format. The DHT adds global query routing to
Nostr's existing "query relays you know" model; it does not replace Nostr.
Pointer sets have a seven-day record TTL. Each press persists only pointers it
originated; remote candidate values remain disposable cache state. At startup
and every twelve hours while online, the reference press Gets and merges every
valid replica it receives with its owned pointers before Put. libp2p's stale
value auto-publication is disabled: every application-level republish follows
the same merge-before-Put path, with a bounded work window.

Relay verification treats every dynamically discovered relay as hostile. The
reference press requests exact event ids, rejects unsolicited or malformed
events, caps event, content, tag, and total-sample sizes, and closes each
subscription on completion, timeout, bound violation, or cancellation. It
uses at most four relay-verification workers, four-second relay queries, and a
fifteen-second overall discovery deadline. Caller cancellation propagates to
active subscriptions, and a WebSocket handshake that finishes after timeout is
closed rather than cached. These are resource bounds, not a relaxation of the
signature/`q`/Coin-hash checks above.

### 2.3 Bootstrap

The DHT needs seed nodes to join. **The author's own super-peer(s)
(`transport.md` §2) serve as bootstrap.** This keeps the network's trust
character coherent: you join through the same infra that already holds a
replica of your published corpus. Public libp2p/IPFS bootstrap peers are rejected —
they bring a crowd and a trust posture incompatible with the protocol's
sovereignty stance. Until the network is dense enough to self-seed, early
users rely on operator-provided super-peers in this role.

The current desktop configuration path is transactional. A replacement
listen/bootstrap configuration is normalized, stopped-and-started, and
validated by the native runtime before it is persisted. If startup or
persistence fails, the candidate is stopped and the previously persisted
configuration and runtime are restored. Disabling Coins likewise stops the
runtime before committing the disabled setting.

## 3. Optional distributed anteriority — NIP-03 on Step

When anteriority anchoring is enabled, Step is the hook. One Attest-time proof
gives the vet a single point; repeated Step proofs can show commitments spread
over time. The overlay remains optional because NIP-03 is unrecommended and
calendar access can fail. Missing anchors mean "time unproven," never
"invalid Step."

### 3.1 The gesture reassignment

The anchor hook belongs to Step rather than Attest:

| Gesture | Job | Stamps? |
|---|---|---|
| **Step** (Cmd+S) | record process locally | optional, best-effort anchor attempt |
| **Send** | change reachability (fan out to seeds) | no |
| **Attest** | stand behind an exact Sent node with a `TraceAttestation` | inherits any target anchor evidence (§3.4) |

Anchoring runs in the background from the process-recording gesture. It is
neither required for Step nor part of the position-taking gesture.

### 3.2 The calendar (prototype and target)

OTS uses a calendar server to aggregate commitments and eventually anchor them
in Bitcoin. The current prototype submits node ids to a hard-coded public
calendar, so that calendar sees the digest. Configurable calendar URLs and a
self-hosted calendar on the author's super-peer are the target deployment for
stronger sovereignty, not current behavior (`transport.md` §2).

### 3.3 Frequency and cost

The reference desktop attempts each newly created Step, fire-and-forget. Other
deployments MAY disable or throttle submission. The proof resolves in the
background; Step never blocks on a Bitcoin block, and submission failure never
changes Step validity.

- **Marginal client cost can be low.** Calendars aggregate many digests per
  Bitcoin transaction, but operators still bear infrastructure/transaction
  cost; the protocol does not promise free service or a proof-size bound.
- **A blocking round-trip on Cmd+S would destroy the gesture** (§R3). The step
  returns immediately. The pending OTS receipt remains local and a background
  sweep retries it. Once it contains a Bitcoin attestation, the press publishes
  a new kind-1040 event containing the full proof. Pending receipts MUST NOT be
  published as NIP-03, and regular Nostr events never upgrade in place.
- **Frequency is policy.** One attempt per N-minute window can still provide a
  time-distributed signal. Deployments SHOULD expose frequency/calendar policy
  rather than assume an external service will accept every Step indefinitely.

### 3.4 Attest inherits anteriority transitively

A `TraceAttestation` targets a Sent node via its `e … target` tag
(`trace-provenance.md` §5A/§8). The target node was produced by a Step and may
have one or more completed NIP-03 proofs. Attest inherits whatever anteriority
evidence that exact target has. If it has none, the endorsement remains valid
and its target's time is simply unproven.

Attest MAY still carry its own stamp, for a different purpose: proving *when
the author endorsed* (a distinct claim from *when the content existed*). Both
can coexist. Process anchors, when present, belong to Steps.

## 4. Mutual-peer co-citation (v1 rendezvous)

The first rendezvous mechanism is client-side set intersection over chains
the introducer is already authorized to read — no DHT required. The DHT (§2)
is the global path; mutual-peer co-citation is the trust-bounded v1 that
works the moment two peers share a mutual, before any DHT density exists.

### 4.1 The introducer algorithm

For each pair of peers (A, B) that you — the introducer C — mutually trust:

```
T_A = ⋃ valid Coin q targets across A's readable Sent file traces
T_B = ⋃ valid Coin q targets across B's readable Sent file traces
shared = T_A ∩ T_B
if shared ≠ ∅:
    surface intro(A, B, shared, sample traces, A↔B reachability hints)
```

C sees the coincidence because C is the one node already authorized to read
both chains. **C brokers the introduction** — surfaces it to a human, who
nods — and hands A's onion+pubkey to B and vice versa. C does **not** write
to either `peers.json`. Each of them opts to add the other. That is how real
introductions work, and it is the only shape that respects "peers.json is a
private local ACL, never a published event" (`transport.md` §2).

### 4.2 Rarity weighting (open)

Surface at ≥1 shared Coin target, weight by rarity. A distinctive Coin is
signal; a ubiquitous target is noise. Tuning the threshold
(≥1 and let humans filter, vs ≥2/≥3 to suppress intro spam) is open —
hard to answer without watching real co-citations. Default: surface at 1,
bias toward recall, let the vet (§5) filter precision.

## 5. The vet — process-evidence admission policy

The vet does not answer "is this a real person?" It asks whether the candidate
presents enough accrued, internally consistent process evidence for local
admission policy.

### 5.1 The reframe: process, not content

Fluent prose is easy to imitate, so it is weak admission evidence. The vet
instead evaluates the timestamped revision graph, the timing of edits, and
the shape of revision. Some of that evidence is machine-verifiable; the
statistical interpretation is policy- and population-dependent. It can show
that a process accrued over time, not who or what performed it.

### 5.2 The two-stage admission filter

- **Machine vet.** Fetch and verify the matched event/trace, run anteriority,
  timing, and revision-graph checks (§5.3), and produce evidence plus a score.
  It can cheaply reject an instant fabricated history. No rejection-rate claim
  is valid until measured against a declared dataset and threshold.
- **Human vet.** Candidates that satisfy local policy are shown to a human,
  who reads for compatibility and decides whether to add the key to the ACL.
  The machine has not settled humanness.

The machine filters on "is this process evidence sufficient under my policy";
the human filters on "do I want to admit this signer." Keeping those questions
separate is the design.

### 5.3 The signals (machine vet)

Three layers, weakest to strongest, each doing a different job:

1. **Anteriority chain (cryptographic).** Walk the chain and verify each
   available completed OTS proof against Bitcoin. A valid proof establishes
   that the committed event id existed no later than its Bitcoin attestation;
   it does not validate the event's `created_at`, author identity, or
   humanness. Missing anchors lower evidence rather than invalidating nodes.

2. **Timing distribution (statistical, arms-race).** Compute the inter-event
   distribution and compare it with a declared reference model. Bursts and
   gaps may distinguish an instant dump from an accrued process, but a careful
   adversary can reproduce them and different people have different rhythms.

3. **Revision-graph shape (statistical).** Deletes, moves, and restructuring
   provide more evidence of revision than an append-only polished corpus. Do
   not call this "entropy" until a concrete metric is specified; a patient
   generator can reproduce the shape.

### 5.4 The honest limit

Anteriority defeats the cheap attack (instant deep history) but not the
*patient* attack — and the patient attack is cheaper than "patient" suggests.
The attacker does not write for six months; they generate the whole corpus
today and let a script replay it as Steps over weeks, stamping faithfully,
with jittered timing and synthetic restructuring noise. That clears all three
signals at a marginal cost of one cron job, and the waiting parallelizes: the
same script plants ten thousand corpora at once. What anchors actually impose
is **calendar delay, not effort** — a vettable sybil must be planted a season
before it knocks and cannot be minted on demand. No automated check can
distinguish "a human who writes heavily with an LLM" from "an LLM with a
patient operator." The machine vet's floor is therefore exactly this: it
rejects histories fabricated *after* the decision to attack, and nothing
stronger. Against pre-planted corpora the remaining defense is §R6's admission
framing — the human vet, and the fact that `peers.json` admits individuals,
not populations. How much the planting delay deters in practice is an
empirical question.

### 5.5 The vintage asymmetry (non-normative rationale)

Anchoring changes which side time favors. In an ordinary detection arms race
the forger moves last: they generate against today's detectors, and today's
detectors lose to tomorrow's generators. A completed anchor removes that last
move. A pre-planted corpus is frozen at the capability of the models that
generated it — its anchor date is cryptographically bound — while the
reviewer's forensics are never frozen. A corpus planted this year must
therefore survive not today's analysis but every future analysis, using only
generation-time tools; any synthetic tells committed at planting are
permanent. A genuine process has nothing to fear from better detectors.

Combined with longitudinal coherence, the planted corpus must also simulate a
believable *trajectory* — gradual drift in style and process across anchored
commitments made in real time, before knowing what future scrutiny will look
for. This raises the patient attack's cost along three multiplying axes:
calendar delay (§5.4), vintage lock, and trajectory coherence.

The claim boundary is unchanged. This asymmetry is probabilistic, not proof:
a generator whose output is indistinguishable in principle leaves nothing for
any future detector, and improving forensics will also flag eccentric-but-real
human processes, so false-positive behavior must be calibrated and published
before any threshold is enforced. What the vet establishes at best is
continuity of one invested process over anchored time — never the species,
identity, or intent of whoever operates it.

## 6. Attestation and admission

The pipeline has two attest-like commitments:

| Stage | Gesture | What you attest |
|---|---|---|
| Author publish | **attest a node** | "this is my published position" — commitment stance |
| Admission | **attest a peer** | "I vetted and trust this person" — adds to `peers.json` |

Send sits between them as the **discussion stance**. It Steps pending changes,
or reuses the current Step, then changes reachability. Its `q` edges become
visible through Send; there is no separate "attest interest" gesture. The
match, vet, and admit path runs on Sent content. Attest remains the rarer claim
that a specific sent node is a position worth standing behind.

---

# Part II — Rationale

Nothing in this part is normative. Each argument appears once.

## R1. The coordinate must be content-addressed, and it must be exact

Two people quoting the same passage from different editions, or one quoting a
sentence and the other the surrounding paragraph, produce different event ids
and (without a content hash) no shared coordinate at all. The only thing they
genuinely share is the *text*. So the rendezvous coordinate must be
`hash(text)`, not a node id. This coordinate clusters independently minted
targets; the citation itself still names a concrete node id with `q`.

Why exact, not fuzzy, at the coordinate layer: a DHT routes on exact keys. A
"similar" key is not addressable — similarity means scanning the whole
network, which is no cooperation at all. So `H` must be one value per quote,
and the canonicalization (§1.2) must be deterministic. Fuzzy matching is a
*client-side* layer above the coordinate (§R2): the protocol promises a
single room per exact text; the client decides which rooms to walk into.

Why no case-folding in canonicalization: case can be signal ("The" the
proper noun vs "the" the article). Let near-identical quotes that differ only
in case miss each other; the cost of a missed match is low, the cost of a
false merge is confusion. The asymmetry favors precision at the coordinate
layer and recall at the client layer.

## R2. Fuzzy matching is a client-side layer, not a coordinate property

MinHash + LSH banding is the standard technique for turning near-duplicate
text into colliding keys: shingle the quote, compute a MinHash signature,
band it, and publish the contact under each band-prefix as a separate lookup.
The pigeonhole theorem guarantees any two quotes above a similarity threshold
collide on at least one band-prefix.

This belongs above the coordinate, not in it, for one reason: if `H` is not
single-valued, the "hash is the address of the room" property for the
doors-on-`H` endpoint (a future, §Open) breaks. So the protocol coordinate is
exact; clients may run MinHash to compute *additional* lookup keys for
recall. The two layers compose; conflating them destroys both.

Verification closes the loop: every DHT hit returns a chain pointer; you
fetch the chain, read the *actual* quote, and a human (or threshold check)
confirms "yes, same passage." Fuzzy matching is recall; the signed chain +
human is precision. Never make the DHT do precision; it cannot.

## R3. Why optional anchors attach to Step, not Attest

The vet (§5) benefits from *distributed* anteriority. A single proof says only
"this existed by time T"; repeated proofs can show checkpoints committed over
weeks. If a deployment enables anchoring, the frequent Step gesture therefore
provides a stronger signal than the rare Attest gesture.

This placement does not make anchoring a validity requirement:

- Step records process and MAY submit an anchor. Available proofs build time
  evidence; missing proofs leave time unproven.
- Send changes reachability and touches nothing about time.
- Attest takes a position and inherits any anteriority evidence attached to
  its exact target.

This reverses the placement recorded in `trace-provenance.md` §R11.20(b),
which put the proof on Attest. The local pending-receipt workflow keeps the OTS
round trip off Cmd+S's critical path: Step is instant, proof completion is
asynchronous, and any failure degrades only the optional evidence layer.

## R4. Source provenance distinguishes readers from scrapers

The strongest "captcha-style" move available is not analyzing the quote (the
quote is shared, signal-free) but analyzing the *source*. A real reader
selected the passage from a specific edition, on a specific page or offset. A
sybil squatter copied the bytes from the DHT and has no source. Under the
single-citation model, source information belongs on or beside the minted
trace—not in a second citation tag. A press may import a source/edition as its
own trace and cite it with `q`, or record a locator in the minted trace's body
metadata. A vet may rank verifiable source lineage above an unlocated mint.

This is domain-specific (it only works for quotable material that has
sources), cannot be faked cheaply, and maps onto a real distinction: someone
who read it vs. someone who scraped it. It connects to something true about
the domain — an attesting of interest in a quote is stronger when it
attests to *reading the source*.

## R5. The mesh and the DHT carry different things; Send is the sovereignty filter

Global findability makes interests globally visible. If anyone can find Sent
events citing `H`, anyone can learn that their signers cited `H`. That privacy
cost is inherent in enabling Coins and must be presented at that product
boundary.

The DHT limits its value to `{eventId, relayUrl}` rather than an
asserted contact identity, but fetching and verifying the event still reveals
the signer. Within an enabled Coins package, Send is the publication boundary.
Step stays local; Send fans out and, once the in-progress Kademlia component is
available, publishes the carrying pointer under each verified Coin target's `H`.
Mint publishes the Coin and declares supply, but creates no DHT pointer on its
own; citing stays local until the carrying trace is Sent.
**Publishing the carrying citation signals rendezvous interest.**

The counter-pressure is bootstrapping: a DHT with nobody publishing is dead.
Resolution: the *local* path (mutual-peer co-citation, §4) works from day one
with zero DHT density — any Sent citation to a valid Coin is visible to peers
who share your seeds. The global DHT path is the accelerator for non-mutual
discovery. The network is alive at launch via the mesh (every Sent Coin `q`
feeds co-citation); the DHT is what lets it outgrow the mesh.

## R6. Sybil at the network layer is unsolvable; the vet is the filter

Douceur (2002): in any open network, a sybil attacker can always outvote
honest nodes, full stop. Every DHT-defense scheme raises the cost; none close
the hole. There are two sybil modes:

- **Routing-level** — thousands of nodes occupy the neighborhood around a
  famous quote's hash and refuse to store/route your entry. Happens at the
  network layer, below where content exists. *No content analysis can touch
  it.* Defenses: redundant publish (publish to k closest, get from several,
  intersect) and PoW on node identity. This is where most real DHT sybil harm
  lives.
- **Content-level** — flooding the value list with garbage "I also quoted H"
  entries. Here content analysis could help, but the *quote* gives nothing
  (it's shared). The signal is in the *corpus* (§R4, §5.3).

The vet (§5) is not a DHT defense; it is an **admission** defense. The
network can be full of sybils; your `peers.json` isn't. You don't need to
prevent fake nodes from existing — you need each person to not *admit* fake
ones, and that's a much lower bar. This is how every real social layer works:
email is 90% spam and it's fine, because your address book isn't.

## R7. The attest/affirm rename and the "attestation" collision — landed

Renaming the publish gesture from "affirm" to "attest" created a collision:
"attestation" already names the NIP-03/OTS timestamp artifact
(`stampAndPublishAttestation`, "anteriority attestation" in §R11.20).

Resolution landed — **the noun/verb split, with the sub-thing renamed:**
`attest` = the gesture (verb); the NIP-03 artifact = the `anchor` (noun).
The gesture is the concept users should feel, so it owns the clean word; the
cryptographic sub-mechanism took the technical name. `stampAndPublishAttestation`
→ `submitAnchor`; `attestation.ts` → `anchor.ts`;
`OTS_ATTESTATION_KIND` → `OTS_ANCHOR_KIND`; `upgradePendingAttestations` →
`upgradePendingAnchors`. The gesture owns `attest`; the OTS sub-mechanism
owns `anchor`.

The naming sweep landed across `trace-provenance.md`, the client, and the MCP
tools. The first wire encoding renamed a kind-4290 action; the later protocol
audit corrected Attest to the dedicated, append-only `TraceAttestation` kind
4294 because an endorsement has no truthful revision snapshot or `prev` edge.
See `trace-provenance.md` §5A and §R11.23/§R11.25.

The semantic case for the rename itself: *attest* connotes outward
being on the record — which is what the gesture does (target + optional
geohash/note + declaration). *Affirm* connotes inward agreement / standing
behind a position. "Attest" also clears the same negative bar the original
rationale (`§R11.19`) used to reject `sign` — no collision with
crypto-signing.

## R8. Fetching leaks; accept it, don't over-engineer it

The moment you reach out to a matched peer's onion to vet, you reveal that
*someone* at your onion is interested in them — and specifically right after
a match on `H`. Tor-onion makes this cheaply anonymous-ish (they see an
onion, not your name), but vetting is not free of information leakage. An
attacker who publishes a hot quote specifically to see who comes sniffing is
a real pattern.

Default: vet over Tor, accept that the fetch is a weak signal, do not try to
hide it harder than onion-routing already does. The alternative — a
"mutual vet" gesture that pings back so they can vet you reciprocally — is
attractive for actual introductions but adds a round of leakage. Recommended:
one-way default (you fetch, they never know unless you attest-a-peer), mutual
as an explicit second gesture. One-way is safer and more sovereign; mutual
is how introductions become conversations. Both have a place; neither is the
default.

## R9. The corpus, not the trace, is the vet unit

A single matching target proves almost nothing — even a real human might have
copied it. The vet has to be the *surrounding work*: does the author cite
sources, is the chain deep, does it reference real things at real times. The
admission UX is not "show me the matching trace" (useless — you already know
it); it is "show me who this person is" — recent traces, other citations,
attested positions, the timestamped save graph. The match gets them to your
door; their body of work gets them in.

This is why §3 attaches optional anteriority to Step: the signed save graph is
the body of work, and completed anchors add external time bounds to that graph.
Without anchors the graph remains valid but its timing is self-asserted. A vet
may treat that as missing evidence, never as an invalid trace.

---

# Open questions (deferred)

**Implementation status.** The trust-bounded mutual-peer path and vet are built
and tested. The Kademlia component remains under implementation inside the
Coins package; its existing exercised slices include:
- `provenance.ts` — `canonicalQuoteText`, `quoteHash` (the exact coordinate H)
- `quote-fuzzy.ts` — MinHash signature + LSH banding (the fuzzy recall layer, §R2)
- `co-citation.ts` — ordinary-`q` exact-target intersection + relay fetch glue;
  valid-Coin verification remains a conformance gap (§4)
- `rendezvous.ts` — batched Send-side public-relay proof and bounded/cancellable read-side candidate verification (§2.2)
- `rendezvous-outbox.ts` — durable retry queue for Send-side indexing (§2.2)
- `networking/kademlia.ts` — desktop configuration and Tauri command boundary
- `src-tauri/src/kademlia.rs` — filtered bounded storage, persistent owned pointers, k=8 routing, and merge-before-Put/Get/republish
- `vet.ts` — anteriority + timing + revision signals composed into a verdict (§5)
- `vet-walker.ts` — extracts `CheckpointMeta` from trace events (wire → vet data)
Current writers emit only lowercase `q` trace citations. The former
`role:"content"`/uppercase-`Q` writer and command-palette action are retired;
readers ignore uppercase `Q` tags.

- **Doors-on-`H` (the ambitious endpoint).** `H` → HKDF → an onion address,
  reusing the `doors` primitive (`doors-store.ts`, `transport.md` §3 — doors
  derive extra onions from keychain keys). One adopter of the topic hosts a
  door at `onion(H)` serving a tiny directory of quoters; anyone who quoted
  the text computes `onion(H)` and dials it. Fully content-addressed, no
  shared relay needed — the address *is* the content. Sybil caveat: a door
  hosted by "whoever quoted `H`" is squat-able without a trust bound. The
  honest version is trust-bounded — the door is hosted by co-quoters *in
  your trust graph*, not a censorship-resistant public square. Defer; do not
  let the beautiful framing ("the hash is the address of the room")
  oversell what it is.
- **LSH band parameters — initial implementation in `quote-fuzzy.ts`, needs calibration.**
  Defaults shipped: word tringles (SHINGLE_K=3), 128-hash signatures
  (SIGNATURE_LEN=128), 32 bands (BANDS=32), yielding a ~42% Jaccard threshold.
  These are reasoned defaults, not empirically tuned — need real corpora to
  calibrate shingle size, band count, and the recall/precision tradeoff. The
  module's parameters are exported and adjustable without protocol changes.
- **Timing-distribution model — initial implementation in `vet.ts`, needs calibration.**
  The timing signal uses coefficient-of-variation of inter-event intervals (a
  coarse "too uniform → sybil" test). The human-typical distribution (burstiness,
  circadian, weekly gaps) needs empirical calibration from real traces to fit a
  proper model. Until then the CV-based outlier rejection is the floor.
- **Kademlia routing-layer sybil defenses.** Redundant k=8 publication,
  filtered bounded storage, owned-capacity reservation, and multi-replica
  Get/merge-before-republish are exercised parts of the in-progress floor. PoW
  on node identity is held in reserve — turn on if spam becomes real at scale,
  do not pay for it up front.
- **Mutual vet gesture.** The one-way vs mutual vet fork (§R8) is a taste
  call. Recommended: one-way default, mutual as explicit second gesture.
  Defer the exact wire shape until the one-way path is exercised.
- **Calendar self-hosting spec.** The super-peer-as-calendar role
  (`transport.md` §2) needs a concrete spec: digest aggregation batch size,
  Bitcoin tx cadence, proof-serving endpoint, proof upgrade sweep. Modest
  service, not yet specified.
- **Attest's own stamp.** Whether Attest keeps its own anteriority stamp
  (§3.4, for proving *when endorsed* as distinct from *when content existed*)
  or drops it as redundant when the target already has Step anchors. Likely:
  keep, different purpose, both coexist. Decide at implementation.
- **Co-citation density — the existential empirical question.** Every
  calibration above (LSH bands, timing models, rarity thresholds) presumes
  co-citation events occur at reachable network sizes. That is untested. The
  v1 mutual-peer path (§4) needs an introducer who already reads both chains;
  at small scale that graph may produce no matches at all, and a perfectly
  tuned vet over a rendezvous layer that never fires is dead weight. Unlike
  the other open questions this one cannot be settled by argument or another
  design reversal — only by usage — and it should discipline how much further
  design investment the questions above receive before real corpora exist.
