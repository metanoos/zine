# Zine — Director's Cut

Seven pages for anyone about to run a press.

Page one describes how Zine feels to use. Pages two through seven explain the
machinery needed to build a client, run a node, or extend the protocol. Design
history and research notes stay in the full specs. `trace-provenance.md` owns
trace events and gestures, `transport.md` owns network identity, access, and
reachability, and `rendezvous.md` owns quote discovery and process vetting.
The app's About view renders these seven page sections directly.

---

## Page 1 — Pitch

An AI text editor need not be a black box. Zine ships as source. Run
`git clone` and `npm run dev`, and you have a trace editor backed by your own
peer-to-peer node.

A **trace** is a file or folder that keeps a high-fidelity edit history. You
can play it back and see how the work changed, not just where it ended.

That history gives human and LLM readers something plain text loses: process.
You cannot fully explain your taste in phrasing, especially when a sentence is
taken apart and rebuilt several times. You can let the model watch the changes.

The model writes into the same files you do, so its work enters the record as
well. Fonts and colors distinguish interleaved voices. The result shows who
wrote what and how the text came to be.

`Ctrl/Cmd+S` places a **Step** in the log. Those deliberate checkpoints give
playback its rhythm while leaving keystrokes private.

Text inside `[[ double square brackets ]]` is protected from silent LLM
rewrites. Minting turns that text into an immutable trace called a **coin**.
Citing a coin can place you near other people who preserved the same words.

A **Zine** is a published trace whose exact sent version you have attested.
The attestation is a separate, signed commitment and may include a note or
location. Step history may also carry completed Bitcoin time anchors.

Forking begins a proposal under your key. Merging accepts chosen work into
your chain. To fork is to propose; to merge is to accept.

Everyone runs their own press.

Underneath, Zine uses Nostr events over local and configured remote WebSocket
relays: SHA-256 ids, Schnorr signatures, and the seven NIP-01 fields. Tor can
expose a private relay. Global peer discovery remains planned.

---

## Page 2 — Model

One primitive: a **trace**, a body carried on an append-only chain of signed
checkpoints. Its body is either file text or an ordered folder membership
list. Files and folders are both traces.

Each checkpoint is a **node** (Nostr kind `4290`, a signed event). Two things
make a node unlike an ordinary revision:

- **Every node carries its full snapshot.** Not a diff against the last
  version — the complete current body, inline. This is unconditional. It is
  what lets a cited node resolve as *one fetch* against a self-contained
  object, never a replay through the whole chain. Citing a trace is like
  quoting a book: you don't need the author's drafts, you need the page.
- **Ordering comes from the `prev` chain, never from timestamps.** NIP-01's
  second-resolution clock is too coarse — two publishes in the same
  wall-clock second leave a relay holding the older one. The chain is the
  clock.

Keep two identity terms distinct:

- **Trace identity** — the event id of the trace's *genesis* node, fixed for
  the trace's whole life. Globally unique, no namespace to manage. This is
  the trace's name.
- **Nucleus** — the trace's current head: the latest node on the `prev` chain.
  A citation pins a nucleus (a specific version); identity names the chain.

One number is explicitly *not* an identity: **contentHash**, the
SHA-256 of the body (for folders, a canonical projection of its members). Two
traces with byte-identical text share a contentHash and remain *different
traces* — deliberately, so that two people independently writing the same
words can find each other (`#x`) without being mistaken for one citing the
other. The contentHash is addressing; the genesis id is identity. Never
confuse them.

A **coin** is an immutable, single-node file trace struck from a passage. It
can be exported as plain text. Editing it creates a mutable fork and leaves the
coin untouched. A **press** is the editor, not a server. A **relay** stores the
press's Nostr events, locally on `127.0.0.1` or remotely. A **zine** is a
published trace, usually a folder.

> Run your own press = write in your own copy of the interface. It is
> sovereign by default, because it already steps to a relay of its own.

The model is deliberately small. Gestures, composition, and networking all
build on self-sufficient nodes, append-only chains, and identity fixed at
genesis.

---

## Page 3 — Gestures

Three words define the author-facing protocol.

**Step.** `Cmd+S` signs one checkpoint and writes it to the local relay. A Step
is frequent, deliberate, and local. Every explicit Step creates exactly one
checkpoint, even when the body is unchanged. Background observations may join
it, but no event fires per keystroke. This bounded cadence makes full snapshots
affordable. The protocol uses *Step*, not *save*, to keep it distinct from Send.

**Send.** Open the current state for discussion. If the buffer has changed,
Send first Steps it; otherwise it reuses the latest Step. It then fans that
node out to write-enabled external relays. Most Steps are never Sent, so
drafts, experiments, and dead ends remain local.

**Attest.** Mark one *sent* node as a position you stand behind. Attestation is
optional and later: discussion is common; commitment is rare. A local-only
node cannot be attested because readers could not fetch the claimed position.
On the wire, Attest creates an append-only `TraceAttestation`. It targets the
exact node without advancing that node's chain.

```
Step → local checkpoint
Send → Step the present state + make it reachable for discussion
Sent node ── optional, later ──→ Attest (stand behind this version)
```

Send may create a Step; Attest targets a previously Sent node. This is a
partial order, not a funnel where every Step becomes Sent and every Send
becomes Attested.

**Distributed anteriority: experimental Step anchors.** A Step may submit its
node id to OpenTimestamps without blocking. The pending receipt stays local.
If it later gains a Bitcoin attestation, the press publishes a new NIP-03
kind-1040 event carrying the complete proof. Pending proofs are not published,
and immutable events never upgrade in place. Because NIP-03 is currently
unrecommended, a missing anchor means "time unproven," not "invalid Step."

Why Step rather than Attest? Repeated commitments provide more process evidence
than one publication-time anchor. Attest inherits the target's evidence and may
carry its own completed proof only to show *when it was endorsed*, a different
claim from *when the content existed*.

Completed anchors can turn parts of a trace's save history into time-bounded
process evidence. Page seven uses available evidence as one input to an
admission filter, without treating it as proof of author identity or humanity.

---

## Page 4 — Composition

A trace has one owner: the key that signs its nodes. Five moves connect traces:
mint, cite, tag, fork, and merge.

**Minting.** You select a passage of text and strike it into its own trace.
`[[ a phrase ]]` is rewrite protection, not yet a trace — it shields the span
from silent drift across LLM rounds. The minting pass steps a new file trace
whose snapshot *is* that text, and rewrites the bracket to
`[[ a phrase | nodeId ]]`. Now it's addressable forever. Minting captures
what's there now; it doesn't invent a pre-mint history. Nothing cites without
first being minted.

**Citing.** Once minted, a trace can be cited through one delta type with four
roles:

| role | what it is |
|---|---|
| `inline` | a frozen quote, pinned to a version; body changes |
| `live` | a transclusion that tracks its source's head (reserved) |
| `tag` | a zine tagged onto this trace; body untouched |
| `reply` | this whole document replies to another trace |

Every cite uses a lowercase `q` tag, the NIP-18-shaped composition edge from
your nucleus to the cited one. It pins the source version at the moment of
citing, even if that trace later changes. Citation needs no cooperation from
the source.

**Tagging.** A tag and a resolved bracket are the same `q` edge with different
presentation. A bracket appears in the body; a tag is discoverable but
bodyless. Tagging emits the pinned `q` plus a lexical `t` mirror for generic
`#t` discovery. Browsing combines the literal label, body-identical traces,
and one hop through the tagged zine's edges.

**Forking.** To work on someone else's trace, seed a new trace under *your*
key from the source's current node. `snapshot` verbatim (so it collides on
contentHash — deliberately), `forked-from` the exact source version, and
**no `q` to the source**. A fork is derivation, not composition. It diverges
freely; the source owes it nothing. Fork is to propose.

**Merging.** To accept, the owner of the receiving chain steps one node with
a `merge-parent` edge naming the foreign head, and a `snapshot` that is
whatever the owner chooses to publish. Merge is **unilateral** — the
parent's author neither co-signs, nor is notified, nor needs to be. The
parent chain persists untouched; selective acceptance is the ordinary
snapshot, not a special case; either direction is the same shape. Merge is
to accept.

> To fork is to propose; to merge is to accept. Both are one owner, one step,
> no waiting on anyone.

A sequence of citations is already a **composite trace**: an anthology ordered
by its author and addressable like any other trace. Its snapshot inlines each
quote, so rendering needs no fetches. Adding a quote later is an ordinary edit.
Parallel anthologies with the same informal name are not a conflict.

---

## Page 5 — Attribution & verification

Who wrote what. Two layers, in priority order.

**Per-delta attribution (primary).** A body-edit delta may carry an `author`
index into the node's local `voices` table. Without it, the delta belongs to
the node signer. A reader can therefore recover attribution in one forward
pass over the node, independent of chain depth. Single-author Steps omit the
extra fields; overhead appears only when voices mix within one checkpoint.

This is the right layer for the human–AI loop — you type, you invoke the
model, its output is spliced into the buffer and stepped on the *same* chain
under keys you control. There is no merge seam to walk, so there is nothing
to "verify" in the cross-author sense; there is only the signer's honest
claim about which voice produced each span.

**`authors` map (secondary).** This ordered run list attributes snapshot slices
to pubkeys. An optional `src` points to a node signed by that author where the
text appears. A cross-author run is **verifiable** when that node is reachable
through `merge-parent`, `extracted-from`, `forked-from`, or `q`. Verifiable
cross-authorship therefore uses distinct chains joined by merge.

**Trust posture.** Every attribution signal is a claim by the node signer. A
run corroborated through a seam edge and `src` is **verified**; otherwise it is
**asserted**. Clients should render those states differently. In-session
co-authorship has no seam, so it remains asserted.

**Citation verification** follows the same bounded posture. Because the cited
node carries its snapshot, checking a quote costs one source fetch, never a
chain replay. `sourceContentHash` adds a fast span check. This is verifiable,
not trustless: a liar can still misuse a real hash, but the lie is cheap to
expose. Missing events degrade rather than break. The citing document remains
readable from its inlined snapshot; only verification is lost.

---

## Page 6 — Transport

The press uses one keychain with **separate roles**. A fresh install assigns
different secrets so a stable network address is not coupled to a pen the
author may switch. A migrated single-key install may assign one key to several
roles for continuity.

| role | what it is |
|---|---|
| **NODE** | owns the relay, signs NIP-42 AUTH, derives the primary `.onion` |
| **AUTHOR** | signs trace checkpoints and attestations |
| **MODEL** | identifies model-produced edits; may rotate independently |
| **DOOR** | optional extra key deriving another `.onion` into the same relay |

Each onion address is a deterministic, one-way projection of its assigned
Nostr key, not a separate Tor credential. The press re-derives and registers it
on launch. NODE remains stable so AUTHOR or MODEL rotation cannot silently
change the relay owner or address.

**The mesh enforces access policy; it does not gossip.** Each relay serves
events authorized by its NODE owner. The owner may submit valid events for the
press's author keys. A listed writer may submit only events signed by that
writer. Peers are read-only. Nothing arrives through transitive forwarding.
To amplify a peer, publish an opinion, cite the work, or tag it. Do not
replicate their content.

The NODE owner, writers, and peers live in a **private local ACL**
(`peers.json`), never published as a Nostr event. A security boundary must not
be a public artifact.

| who | connect | read | write |
|---|---|---|---|
| owner (the NODE key) | always | yes | valid events accepted by relay policy |
| writer (in the ACL) | allowed | yes | only events signed by that writer key |
| peer (in the ACL) | allowed | read-only | no |
| unknown | challenged (NIP-42) | no, until authed | no |

Because Tor forwards inbound peers to the relay and they appear to originate
from localhost, access control **must** be pubkey-based (NIP-42), not
IP-based. Everyone authenticates — including the owner.

**The degradation ladder.** Identity (the npub) is *invariant across all
rungs* — the load-bearing fact.

| rung | transport | reachability | privacy |
|---|---|---|---|
| 1 (default) | clearnet relay | needs IP/URL known | none |
| 2 | Tor onion service | stable `.onion`, inbound | metadata privacy |
| 3 | super-peer replica | durable, always online | none (clearnet) |

If a firewall drops Tor, the press falls back to rung 1 or 3 and *keeps its
identity*; it loses metadata privacy or durability, never sovereignty. The
trade is always reachability or privacy, never identity.

A **super-peer** is an always-online relay holding a replica of *your published corpus*.
It keeps cited traces reachable while your laptop is closed; it is not a
discovery platform. Any NIP-01+NIP-33 relay suffices. OTS calendar hosting and
DHT bootstrap remain planned extensions.

Any NIP-01 relay that also implements parameterized-replaceable handling
(NIP-33) is sufficient. There is no special relay class. For removal, the
event author publishes a standard NIP-09 kind-5 request. Compatible relays
SHOULD delete or stop publishing matching events, but deletion is not
guaranteed and NIP-09 does not require tombstones or permanent refusal of an
event id. The chain is untouched; the request changes relay *retention*, which
the spec keeps non-normative on purpose.

---

## Page 7 — Rendezvous & vetting

Two people who have never met, share no peer, and share no relay may find each
other because their Sent traces cite coins with the same content. The
recipient then evaluates the other signer's process evidence before deciding
whether to admit that key.

**A citation is always a trace edge.** `[[text]]` is local draft syntax. Mint
first creates a trace; lowercase `q` then cites it. Inline brackets are
explicit and bodyless tags are tacit, but both use the same edge. Planned
global discovery derives `H = sha256(canonical(targetBody))` from a verified
target. `H` clusters independent mints; it is an index coordinate, not another
citation type.

**The planned DHT carries event pointers, not content or private addresses.** A
Kademlia DHT would answer one question: *which Sent events cite content `H`?*
Each value is `{eventId, relayUrl}` for a signed carrying node on a
stranger-readable relay. A querier fetches and verifies the carrying event,
its `q`, and the target's `x` or body hash before evaluating the candidate.
Private admission details are exchanged only after vetting. The DHT is
designed but not implemented.

Two paths can produce a match. In the trust-bounded v1, a mutual peer who can
read both chains sees the co-citation and brokers an introduction. The planned
global DHT is an accelerator: Sending a carrying node to a stranger-readable
relay would publish its pointer under each verified target's `H`. Citation
records the relation; Send controls its reachability.

**The vet — process, not prose.** Fluent prose is easy to imitate, so the vet
looks instead at the timestamped revision graph: anchors, edit timing, and the
shape of revision. These signals can cheaply reject an instantly fabricated
history and raise the cost of patient fabrication. They are admission
heuristics, not proof that a human authored the work.

Three layers, weakest to strongest:

1. **Anteriority chain** (cryptographic). Verify completed OTS anchors and
   their Bitcoin block times. This can show that checkpoints existed no later
   than those blocks; it cannot prove the node's own `created_at`, authorship,
   or humanness.
2. **Timing distribution** (statistical). Bursts, gaps, and revision clusters
   may distinguish an instant dump from an accrued process, but any threshold
   is model- and population-dependent.
3. **Revision-graph shape** (statistical). Deletes, moves, and restructuring
   provide more process evidence than an append-only polished corpus, while
   remaining reproducible by a sufficiently patient adversary.

The machine ranks or rejects candidates whose process evidence fails an
operator's policy; it does not "settle humanness." A human then reads for
compatibility and decides whether to admit the candidate. No rejection rate
is claimed without measured data. Sybil resistance at the routing layer is a
separate problem; this is a cost-raising *admission* defense for `peers.json`.

The pipeline uses distinct verbs because the commitments are distinct:

| stage | gesture | claim |
|---|---|---|
| cite | mint if needed, then cite a trace | "this trace is in relation to mine" |
| discuss | send the carrying node | "make this fetchable" |
| publish | attest a sent node | "this is my position" |
| admission | add a peer locally | "this key may read my relay" |

---

Everyone now runs their own press.

The apparatus is now visible: high-fidelity traces, separate key roles, a mesh
that stores only NODE-authorized events, a content coordinate that can connect
readers of the same passage, and a process-evidence filter that raises the cost
of admission spam without pretending to prove humanity.

`git clone`, `npm run dev`, and the press is running.

For the wire, the field-by-field spec is `trace-provenance.md`; for the key,
the mesh, and the onion, `transport.md`; for the room and the vet,
`rendezvous.md`. This was the tour.
