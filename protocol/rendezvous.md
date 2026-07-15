# Rendezvous, Vetting & Anteriority (draft)

Status: draft, unpublished. Companion to `trace-provenance.md` and
`transport.md`. This document specifies how two people who have never met,
share no peer, and share no relay find each other because they quoted the same
text — and how the recipient decides, automatically, whether the other side is
a real person doing real work or a squatter with a copied quote.

It introduces three things the provenance and transport protocols do not have:

1. **Content-addressed rendezvous** — a coordinate shared by the *text* of a
   quote, independent of any node id, author, or relay.
2. **Distributed anteriority** — NIP-03/OTS timestamps carried on the frequent
   gesture (Step), not the rare one (Affirm), so that a trace's save history
   becomes a forgeable-in-theory-but-not-in-practice record of real process.
3. **Automated process-vetting** — the machine-readable "captcha" that rejects
   sybils by reading the timestamped save graph, a thing no human eyeballing
   prose can do.

**Reading guide.** Part I is normative where it commits the protocol to a
shape; several pieces here are sketches pending implementation, and say so.
Part II is rationale — why these shapes, argued once.

---

# Part I — Specification

## 0. Vocabulary in this document

- **Quote text** — a span of bytes an author selected from some source and
  cited into their own trace. May originate in a node, in an orphan document,
  or nowhere addressable.
- **`H`** — the content hash of a quote: `sha256(canonical(quoteText))`. The
  **rendezvous coordinate**. Not a node id; an addressable property of the text.
- **Content-hash cite** — a citation keyed on `H`, not on a cited node id.
  Lives alongside the existing `q` node-citation (§3.3); it is the only
  citation shape that works when the quoted text has no origin node in the
  system.
- **Rendezvous layer** — the network component that answers "who else
  published interest in `H`?" A Kademlia DHT (§3). Distinct from the
  access-policy mesh (`transport.md` §2), which answers "who may read *me*?"
- **Anteriority** — proof that a commitment existed *before* some time T.
  Carried by NIP-03/OTS timestamps anchored to Bitcoin.
- **Process signal** — the timestamped, internally-consistent shape of an
  author's save graph. The material the vet reads.
- **Vet / captcha** — the automated machine-read of a fetched trace's process
  signal. A proof-of-process, not a proof-of-prose.

## 1. The content-hash cite

A new citation role, distinct from the node-citing `q` edge and from the
`role: "tag"` discovery cite (`trace-provenance.md` §3.3). It is the cite
shape used when the quoted text has no node to dereference — orphan text,
print sources, oral quotation.

### 1.1 Delta (source of truth)

In the citing node's `deltas` array:

```json
{
  "type": "cite",
  "role": "content",
  "hash": "…H, 64-char hex…",
  "quote": "<the full quoted bytes>",
  "source": { "work": "optional", "edition": "optional", "locator": "optional" },
  "relayHint": "ws://…onion or super-peer URL"
}
```

- `hash` — `sha256(canonical(quoteText))` per §2. REQUIRED. This is the
  rendezvous key.
- `quote` — the verbatim bytes. REQUIRED. The hash is the index; the quote is
  verification *and* content. Splitting them would make co-citation
  unverifiable.
- `source` — OPTIONAL. Work + edition + locator (page, offset, chapter). When
  present, partially verifiable ("does that edition contain that text at that
  offset?"). Distinguishes readers from scrapers (§R4). Not required; absent
  on oral quotation or sourceless text.
- `relayHint` — where a co-citer can reach the citer. Mirrors the 3rd-slot
  hint on `e`/`q` tags.

### 1.2 Top-level tag (derived index)

Emitted alongside the delta. The tag name is **`Q`** (single uppercase letter),
not `cite-content`, because NIP-01 generic tag queries (`#Q=H`) are defined
only for single-letter-or-digit tag names — a multi-char name would not be
relay-filterable, and filterability is what the DHT rendezvous path depends
on. `q` (lowercase) is already taken for node-citation; `Q` is mnemonic
(**Q**uote / rendezvous) and reads as a natural pair with `q` — lowercase
cites a node, uppercase cites by content. The human-readable label
"cite-content" lives in docs/code comments, not on the wire.

```
["Q", H, relayHint, "implicit" | "attested"]
```

The 4th slot is the **trust-radius marker**, the one bit separating free
serendipity from opted-in global reachability:

- `"implicit"` — carried because the author quoted the text. Reachable only
  within the author's existing peer graph (mutual-peer co-citation, §4).
- `"attested"` — the author took the explicit "attest interest" gesture
  (§5.2). Published to the global DHT (§3). Reachable by strangers.

A reader scanning for "does this chain contain `H`?" reads top-level tags
only — no body parsing. The delta is the source of truth; the tag is the
cheap index. Same derivation pattern the protocol already runs for `t`.

### 1.3 Canonicalization

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

The rendezvous layer answers exactly one question: *"who else published
interest in `H`?"* It returns a list of contact pointers — onion address +
pubkey — never content. Content stays in the author's signed chain, fetched
on demand by anyone the DHT routed to them.

### 2.1 Why a DHT, not the mesh

The access-policy mesh (`transport.md` §2) is deliberately not a discovery
graph: peers are an explicit private ACL, "amplification is citation, not
replication," and "nobody carries speech they did not sign." That model solves
**controlled access** — who may read me. Global rendezvous — "the whole
network cooperates so any two people with the same quote find each other" —
solves a structurally different problem: **content-addressed discovery of
people who share no peer, no relay, no trust.** That property requires every
node to route for every key regardless of whether it holds that key, in
O(log N) hops. That property has a name: a Kademlia DHT.

The two layers compose cleanly because they carry different things:

| Layer | Carries | Question answered |
|---|---|---|
| Mesh (`transport.md`) | signed traces | "who may read *me*?" |
| DHT (this doc) | pointers: `H → {onion, pubkey}` | "who else cares about `H`?" |

The DHT never carries speech — only pointers to where speech lives. "Nobody
carries speech they did not sign" still holds: DHT routing tables hold
addresses, not content.

### 2.2 Wire (sketch — pending libp2p integration)

Implemented as a Kademlia DHT in the Rust Tauri backend (`libp2p::kad`),
alongside the existing Go relay sidecar. Inbound reachability reuses the
owner-key-derived `.onion` (`transport.md` §3) — the DHT node advertises the
same onion the mesh already serves, so the laptop joins the DHT via bootstrap
nodes, advertises its onion for inbound, and routes for others while online.

- **Put** — publish `{onion, pubkey}` under key `H`. Fires when the author
  takes the "attest interest" gesture (§5.2) on a content-hash cite. Published
  to the k closest nodes to `H` (default k=8) for redundancy (§R6).
- **Get** — query "who published under `H`?" Returns the value list. A querier
  computes `H` for a quote they care about, asks the DHT, and receives
  candidate contacts. Each candidate is verified by fetching the cited trace
  (§5.3) before trust.

Nostr stays the signed-event format. The DHT is not a Nostr replacement; it
is the discovery index Nostr deliberately lacks (Nostr's model is "query
relays you know," with no global query routing — which is exactly the gap
this closes).

### 2.3 Bootstrap

The DHT needs seed nodes to join. **The author's own super-peer(s)
(`transport.md` §2) serve as bootstrap.** This keeps the network's trust
character coherent: you join through the same infra that already holds a
replica of your archive. Public libp2p/IPFS bootstrap peers are rejected —
they bring a crowd and a trust posture incompatible with the protocol's
sovereignty stance. Until the network is dense enough to self-seed, early
users rely on operator-provided super-peers in this role.

## 3. Distributed anteriority — NIP-03 on Step

This is the load-bearing change, and it reverses a decision in the current
spec. Today anteriority is layered on **Affirm** alone
(`trace-provenance.md` §8 AFFIRM, §R11.20): one stamp, at the publish moment.
That gives the vetting layer (§5) one anchor — which is to say, nothing. The
whole power of anteriority as a sybil filter is **density**: dozens of
checkpoints provably committed across weeks at human rhythms, showing real
work happening over time. Density requires the *frequent* gesture to stamp.
Step is frequent and time-distributed; Affirm is rare and deliberate. **Step
must stamp.**

### 3.1 The gesture reassignment

Stamping moves from Affirm to Step, and each gesture ends up doing exactly
one job:

| Gesture | Job | Stamps? |
|---|---|---|
| **Step** (Cmd+S) | record process: seal locally **and** anchor in time | **yes — every seal** |
| **Send** | change reachability (fan out to seeds) | no |
| **Affirm** | take a position: cite + geohash + "this is my published node" | inherited transitively from the cited node (§3.4) |

Stamping is now a property of the *process-recording* gesture, accruing
continuously in the background — not a special act bolted onto the
*position-taking* gesture.

### 3.2 The calendar (self-hosted)

OTS requires a calendar server to land digests in Bitcoin blocks. To preserve
Step's sovereignty semantics ("stays on my machine"), **the calendar is
self-hosted on the author's super-peer** (`transport.md` §2 — the super-peer
already holds a replica of the author's archive). Saves stamp through the
author's own infra; no third-party calendar sees the hash. An OTS calendar is
a small service (aggregate digests, one Bitcoin tx per batch, serve proofs);
this is a modest addition to the super-peer role, not a new trust boundary.

### 3.3 Frequency and cost

Stamp **every Step**, fire-and-forget. The proof resolves in the background;
the save never blocks on a Bitcoin block.

- **Cost is effectively free.** OTS calendars aggregate thousands of digests
  per Bitcoin transaction; per-stamp cost is ~zero, proofs are sub-KB.
- **A blocking round-trip on Cmd+S would destroy the gesture** (§R3). The
  seal returns immediately; the OTS proof upgrades in place by a later sweep
  — exactly the partial-proof workflow the current Affirm path already
  describes (`trace-provenance.md` §R11.20).
- **Throttle only if load demands.** One stamp per N-minute window still
  gives a time-distributed process signal. Don't pre-optimize; stamp every
  Step until there is a reason not to.

### 3.4 Affirm inherits anteriority transitively

An Affirm cites a sent node via `q` (`trace-provenance.md` §8). The cited
node was sealed by a Step — which now stamps. So the affirmed node's
anteriority is already anchored by the save that produced it; Affirm does not
need to be the timestamping gesture to give the vet material.

Affirm MAY still carry its own stamp, for a different purpose: proving *when
the author endorsed* (a distinct claim from *when the content existed*). Both
can coexist. The load-bearing stamps for vetting are the saves.

## 4. Mutual-peer co-citation (v1 rendezvous)

The first rendezvous mechanism is client-side set intersection over chains
the introducer is already authorized to read — no DHT required. The DHT (§2)
is the global path; mutual-peer co-citation is the trust-bounded v1 that
works the moment two peers share a mutual, before any DHT density exists.

### 4.1 The introducer algorithm

For each pair of peers (A, B) that you — the introducer C — mutually trust:

```
H_A = ⋃ top-level Q tags across A's readable chain
H_B = ⋃ top-level Q tags across B's readable chain
shared = H_A ∩ H_B
if shared ≠ ∅:
    surface intro(A, B, shared, sample quotes, A↔B reachability hints)
```

C sees the coincidence because C is the one node already authorized to read
both chains. **C brokers the introduction** — surfaces it to a human, who
nods — and hands A's onion+pubkey to B and vice versa. C does **not** write
to either `peers.json`. Each of them opts to add the other. That is how real
introductions work, and it is the only shape that respects "peers.json is a
private local ACL, never a published event" (`transport.md` §2).

### 4.2 Rarity weighting (open)

Surface at ≥1 shared quote, weight by rarity. A distinctive paragraph is
signal; a three-word common phrase is noise. Tuning the threshold
(≥1 and let humans filter, vs ≥2/≥3 to suppress intro spam) is open —
hard to answer without watching real co-citations. Default: surface at 1,
bias toward recall, let the vet (§5) filter precision.

## 5. The vet — automated process-vetting as captcha

This is the answer to "how do we know the matched peer is a real person?"
and the reason the word "captcha" is earned.

### 5.1 The reframe: process, not content

The thing a human reader checks by eyeballing prose — "does this feel human"
— is exactly what modern LLMs are best at faking. **Prose is the attacked
surface, not the defense.** Proof-of-human must live where a human eyeballing
cannot reach: in the *process* — the timestamped revision graph, the timing
of edits, the things anchored to reality at real moments. Process signals are
by construction machine-verifiable and human-illegible. A human cannot look
at a corpus and tell you "the inter-edit timing distribution is too uniform
to be real" — that's a computation. That is the captcha: an automated
proof-of-process no human could perform by reading.

### 5.2 The two-stage admission filter

- **Machine vet (the captcha).** Fetch the matched peer's trace, run
  anteriority verification + timing tests + revision-graph analysis (§5.3),
  produce a score. Rejects the 99% case — instant sybils, unstamped
  histories, AI-generated corpora with no process backing — *automatically*,
  no human attention spent. A human literally cannot do this step; that is
  why it exists.
- **Human vet (the borderline).** Only candidates that *pass* the machine vet
  are shown to a human, who reads for **compatibility**, not humanness (the
  machine settled humanness) — *do I want to talk to this person*. Different
  question, correctly reserved for the human.

The machine filters on "could a real process have produced this"; the human
filters on "do I want this real process's author in my life." That separation
is the whole design.

### 5.3 The signals (machine vet)

Three layers, weakest to strongest, each doing a different job:

1. **Anteriority chain (cryptographic, unfakeable for the past).** Walk the
   chain; verify every claimed past checkpoint carries a valid OTS proof
   anchored to a Bitcoin block at the claimed time; check internal
   consistency and monotonicity. A sybil materializing a fake six-month
   history *today* cannot back-date commits into Bitcoin's history without
   re-mining Bitcoin. Its "past" is unstamped, or stamped only from today
   forward. **Instant, machine-checkable, human-impossible-to-eyeball fail.**
   This is the floor, and it is the reason §3 (Step stamps) is load-bearing.

2. **Timing distribution (statistical, arms-race).** Compute the inter-event
   distribution; test against a human-typical model. Real human writing is
   bursty, circadian, weekly-gapped, with revision clusters. A generator
   asked to "produce a six-month corpus" yields a uniform or weirdly-regular
   distribution unless the attacker specifically models human rhythms.
   Defeats the naive patient sybil; loses to a careful one.

3. **Revision-graph entropy (statistical).** Real traces have real diffs —
   content moved, deleted, restructured — not just appended polished
   paragraphs. A generator that only ever appends fluent text doesn't match.

### 5.4 The honest limit

Anteriority defeats the cheap attack (instant deep history) but not the
*patient* attack: someone who runs a fake corpus over six months, stamping
faithfully, hits all three signals. No automated check can distinguish "a
human who writes heavily with an LLM" from "an LLM with a patient operator,"
because in principle the latter can mimic all process signals given enough
commitment. So this is **cost-raising, not a hard proof** — but that is
exactly what a captcha is too. The point is to make "forge a vettable
corpus" cost *months of real process* instead of *an afternoon of
generation*. That asymmetry is the goal, and it is achievable.

## 6. The escalating attest verb

Across the whole pipeline, one verb escalates in commitment, same "put it on
the record" semantics throughout:

| Stage | Gesture | What you attest |
|---|---|---|
| Author publish | **attest a node** (was: Affirm) | "this is my published position" |
| Match opt-in | **attest interest** in a quote | "I'll be findable on `H`" — publishes to the DHT |
| Admission | **attest a peer** | "I vetted and trust this person" — adds to `peers.json` |

The same verb at three escalating commitments. This is also the home of the
copy change from the first turn of this design: **the publish gesture should
read "attest" not "affirm."** A zine is an attested trace; the noun state and
the verb line up. The semantic case: *affirm* connotes inward stance;
*attest* connotes outward bearing-witness, putting something on the record —
which is what the gesture does (cite + geohash + declare, with an optional
anteriority stamp that is now inherited transitively from Step).

See §R7 for the collision this rename creates ("attestation" already names
the NIP-03 sub-thing) and the recommended resolution.

---

# Part II — Rationale

Nothing in this part is normative. Each argument appears once.

## R1. The coordinate must be content-addressed, and it must be exact

Two people quoting the same passage from different editions, or one quoting a
sentence and the other the surrounding paragraph, produce different event ids
and (without a content hash) no shared coordinate at all. The only thing they
genuinely share is the *text*. So the rendezvous coordinate must be
`hash(text)`, not a node id.

Why exact, not fuzzy, at the coordinate layer: a DHT routes on exact keys. A
"similar" key is not addressable — similarity means scanning the whole
network, which is no cooperation at all. So `H` must be one value per quote,
and the canonicalization (§1.3) must be deterministic. Fuzzy matching is a
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

## R3. Why Step stamps, not Affirm — the dependency this whole layer rests on

The vet (§5) needs *distributed* anteriority. A proof-of-process that says
"this existed by time T" is useless as a single point; its power is density
— dozens of checkpoints provably committed across weeks. Distributed
anteriority requires the *frequent* gesture to stamp. Saves are frequent and
time-distributed; attest/publish is rare and deliberate. If the stamp lives
only on publish, the vet gets one anchor and collapses to nothing. The
captcha designed in §5 is *impossible against the current codebase* until
Step stamps.

This decouples stamping from Affirm and recouples it to where it belongs:
- Step = record process. Seal + anchor in time. *Builds* the captcha material.
- Send = change reachability. Touches nothing about time.
- Affirm = take a position. Its anteriority is now *inherited transitively*
  from the cited node (which was a Step, which stamps).

Cleaner than the current coupling. Stamping is a property of the
process-recording gesture, accruing continuously — not a special act bolted
onto the position-taking gesture.

This **reverses `trace-provenance.md` §R11.20(b)**, which argued "Why Affirm
and not Step?" on the grounds that (i) Step is local and has no anteriority
claim to make, and (ii) OTS's round-trip cannot hang off Cmd+S without
destroying the gesture's frequency. Both arguments are addressed: (i) is
reversed by this layer — Step's anteriority is what *makes* the vet possible,
so Step now has the strongest possible anteriority claim; (ii) is solved by
the fire-and-forget, proof-upgrades-in-background workflow (§3.3), which is
exactly the partial-proof workflow §R11.20 already specifies for Affirm.
Where §R11.20 argued the OTS round-trip was incompatible with Cmd+S's
frequency, the fire-and-forget model dissolves the incompatibility: the
*seal* is instant, the *proof* is async. The two can coexist at save
frequency precisely because they are decoupled in time.

## R4. Source citation distinguishes readers from scrapers

The strongest "captcha-style" move available is not analyzing the quote (the
quote is shared, signal-free) but analyzing the *source*. A real reader
selected the passage from a specific edition, on a specific page or offset. A
sybil squatter copied the bytes from the DHT and has no source. So the
content-hash cite carries an OPTIONAL `source: { work, edition, locator }`
(§1.1), partially verifiable (does that edition contain that text at that
offset? is the URI real?). Co-quoters that cite `quote + source` rank above
those citing `quote` alone.

This is domain-specific (it only works for quotable material that has
sources), cannot be faked cheaply, and maps onto a real distinction: someone
who read it vs. someone who scraped it. It connects to something true about
the domain — an attestation of interest in a quote is stronger when it
attests to *reading the source*.

## R5. The mesh and the DHT carry different things; sovereignty holds

The honest framing: global findability is global visibility of your
interests. You cannot have "the whole network can find anyone who quoted `H`"
without "anyone can find that you quoted `H`." That is the cost of the
property requested; it is not a flaw to engineer away, it is the trade.

What you *can* do: the DHT value is an onion address + ephemeral pubkey, not
your identity. You reveal "someone at this onion cares about `H`," not "you,
specifically, care about `H`." And it can be **per-quote opt-in** — which is
where "attest interest" (§6) lands: attesting interest in a quote = publishing
it to the DHT. Default quotes stay local+peer-only (the hash exists but is
not published globally; reachable only via mutual-peer co-citation §4);
attested quotes go global.

The counter-pressure is bootstrapping: a DHT with nobody publishing is dead.
Defaults determine whether the network has enough density to be useful at
all. Resolution: the *local* path (mutual-peer co-citation, §4) works from
day one with zero DHT density; the global DHT path is the opt-in accelerator.
The network is alive at launch via the mesh; the DHT is what lets it outgrow
the mesh.

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

## R7. The attest/affirm rename and the "attestation" collision

Renaming the publish gesture from "affirm" to "attest" creates a collision:
"attestation" already names the NIP-03/OTS timestamp artifact
(`stampAndPublishAttestation`, "anteriority attestation" in §R11.20).

Recommended resolution — **lean into the noun/verb split, and rename the
sub-thing:** `attest` = the gesture (verb); the NIP-03 artifact = the
`timestamp stamp` / `OTS anchor` / `anteriority proof` (noun). The gesture is
the concept users should feel, so it owns the clean word; the cryptographic
sub-mechanism can afford a technical name. `stampAndPublishAttestation` →
e.g. `stampAndPublishAnchor`.

The rename is bounded: `trace-provenance.md` §3.4/§8/§R11.19–20, the wire
`action: "affirm"` tag value, `OpKind`/`affirmNode`/`canAffirm`/`affirmAsVoice`
in the client, `AffirmModal.tsx` → `AttestModal.tsx`, the `.op-affirm` CSS,
and `zine_affirm` in the MCP tools. The codebase is pre-1.0 on a feature
branch, so the wire-format change is cheap now and expensive later.

The semantic case for the rename itself: *attest* connotes outward
bearing-witness, putting something on the record — which is what the gesture
does (cite + geohash + declare, anchored in time). *Affirm* connotes inward
agreement / standing behind a position. The geohash + timestamp weight that
the gesture carries is *attesting* in the notary-stamp sense; "affirm" never
quite carried it. And "attest" clears the same negative bar the original
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

A single matching quote proves almost nothing — even a real human might have
copied it. The vet has to be the *surrounding work*: does the author cite
sources, is the chain deep, does it reference real things at real times. The
admission UX is not "show me the matching quote" (useless — you already know
it); it is "show me who this person is" — recent traces, other quotes,
attested positions, the timestamped save graph. The match gets them to your
door; their body of work gets them in.

This is why §3 (distributed anteriority on Step) is the foundation, not a
feature: the save graph is the body of work. Without saves stamping, there is
no body of work to read — only a single published node, which proves
nothing.

---

# Open questions (deferred)

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
- **LSH band parameters.** Shingle size (word vs char), signature length,
  band count, similarity threshold — all tuneable. Need real corpora to
  calibrate. Default conservative; revisit after observing co-citation
  density.
- **Timing-distribution model.** The human-typical inter-event distribution
  (burstiness, circadian, weekly gaps) needs empirical calibration from real
  traces. Until then the test is a coarse outlier-rejection ("too uniform")
  rather than a fitted model.
- **The attest/affirm rename sweep.** Bounded (§R7) but real. Decide
  whether to land the rename in the same change as this layer or separately.
- **Calcarda routing-layer sybil defenses.** Redundant publish/get (publish
  to k closest, query several, intersect) is the floor and should ship with
  the DHT. PoW on node identity is held in reserve — turn on if spam becomes
  real at scale, do not pay for it up front.
- **Mutual vet gesture.** The one-way vs mutual vet fork (§R8) is a taste
  call. Recommended: one-way default, mutual as explicit second gesture.
  Defer the exact wire shape until the one-way path is exercised.
- **Calendar self-hosting spec.** The super-peer-as-calendar role
  (`transport.md` §2) needs a concrete spec: digest aggregation batch size,
  Bitcoin tx cadence, proof-serving endpoint, proof upgrade sweep. Modest
  service, not yet specified.
- **Affirm's own stamp.** Whether Affirm keeps its own anteriority stamp
  (§3.4, for proving *when endorsed* as distinct from *when content existed*)
  or drops it entirely as redundant once Step stamps. Likely: keep, different
  purpose, both coexist. Decide at implementation.
