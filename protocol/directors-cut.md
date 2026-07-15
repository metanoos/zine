# Zine — Director's Cut

Seven pages. For the person about to run a press.

The pitch on page one is the thing as it feels. Pages two through seven are
the apparatus underneath — every load-bearing fact an adopter needs to build a
client, run a node, or extend the protocol, with the design history and the
research notes left out. Where the specs disagree, `trace-provenance.md` is the
source of truth; this is the guided tour.

---

## Page 1 — The pitch

Your AI text editor isn't a black box. It ships as source. `git clone`,
`npm run dev`, and you're cooking — a p2p node, running a trace editor.

A trace is a file or folder that keeps its edit history in high fidelity. You
can play a trace back like a record. The editor opens its panels and types,
like it's a piano in Westworld.

A human audience would be lovely, but an LLM audience should be quite
delightful as well.

How do you explain your taste in phrasing — for a sentence you keep taking
apart and putting back together — without actually telling it? You can't. So
you let it watch you rewrite the thing over and over, and it intuits
something, given the opportunity.

That's the thesis. Everything underneath is the apparatus that makes it
possible.

The LLM writes directly into the same files you do, so it's in the record too.
As different sources of writing interleave, each is distinguished by its own
font and color. You can see who wrote what, and how the thing actually came to
be.

Your friends and admirers can step through the research and development of
your writing — an animated experience, with rhythm measured by your deft
placement of step-markers into the log (`Ctrl/Cmd+S`).

It is simply a richer expression of thought than plain text.

Place text into `[[ double square brackets ]]` and it's durable — your LLM
co-authors respect it. These get coined into the elementary traces, called
tags. To use a tag in your text is to put yourself within a hop or two of
conversation with someone nearby in idea space.

Conversations happen in Zine in many ways at many paces. A Zine is a trace
you've signed with an attestation — a geo-hash, a Bitcoin-anchored timestamp,
a final note — and sent. You write Zines back and forth.

To fork a Zine is easy: you just edit the file, and it keeps accruing history.
To fork is to propose; to merge is to accept.

Everyone now runs their own press.

Under the hood, a variant of Nostr runs peer-to-peer instead of over
WebSockets — same signed-event model, SHA-256 ids, Schnorr signatures. NIP-01
if you want the seven fields.

---

## Page 2 — The model

One primitive: a **trace**. A trace is a body carried on an append-only chain
of signed checkpoints. The body is text (a file) or an ordered membership list
(a folder). That's the whole reified world — files and folders, both traces.

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

Two words for identity, kept distinct:

- **Trace identity** — the event id of the trace's *genesis* node, fixed for
  the trace's whole life. Globally unique, no namespace to manage. This is
  the trace's name.
- **Nucleus** — the trace's current head: the latest node on the `prev` chain.
  A citation pins a nucleus (a specific version); identity names the chain.

And one number that is *not* an identity: the **contentHash**. It's the
SHA-256 of the body (for folders, a canonical projection of its members). Two
traces with byte-identical text share a contentHash and remain *different
traces* — deliberately, so that two people independently writing the same
words can find each other (`#x`) without being mistaken for one citing the
other. The contentHash is addressing; the genesis id is identity. Never
confuse them.

A **minted span** is an immutable single-node file trace struck from a passage
of another trace. A **press** is the client interface — the editor, not a
server. A **relay** is the Nostr server a press seals to: local (every press
has one, bound to 127.0.0.1) or remote. A **zine** is a published trace, most
often a folder.

> Run your own press = write in your own copy of the interface. It is
> sovereign by default, because it already seals to a relay of its own.

The model is small on purpose. Everything that follows — the gestures, the
composition, the network — is built on this: self-sufficient nodes on
append-only chains, identified once at genesis.

---

## Page 3 — The gestures

Four words. Learn them and the protocol's author-facing surface is yours.

**Step.** The save gesture — `Cmd+S`. You are checkpointing your own work on
your own machine. A Step is frequent and local; it is the rhythm-layer unit.
The protocol retires the word "save" deliberately, so you never confuse a
step with a send.

**Seal.** The protocol word for the boundary act: sign the node (Schnorr) and
write it to the local relay. Every node is sealed the instant it exists. A
Step may seal a node, or it may batch quietly onto the next seal — the
protocol only ever sees checkpoints a human or agent *chose* to make. Nothing
fires per keystroke. That discrete, bounded frequency is what makes
unconditional snapshots affordable.

**Send.** Push an *already-sealed* node to an external relay — a super-peer, a
peer's relay, the wider network. Send is a destination act, not a signing act.
What it changes is reachability: the node leaves your machine and becomes
fetchable by others. Most Steps are never Sent. Drafts, experiments, dead
ends stay local. You curate what leaves your machine — that is the
sovereignty filter.

**Affirm.** The publication act. You mark a *sent* node as your published
position. Affirm comes *after* Send, not as a side effect of it. The
Send→Affirm gap is where the work gets tested: you Send, a peer reads and
responds, and only then do you Affirm, "this is my stand." Affirming a node
that was never Sent would be claiming a public position for something no one
can fetch — a lie by construction.

```
Step (seal locally) → Send (push to a relay) → Affirm (stand behind it)
```

Each action consumes the prior's output. (An older combined "ZINE" gesture is
retired; Send and Affirm are separate now.)

**Distributed anteriority — Step stamps.** This is the load-bearing fact of
the gesture layer. Every Step mints a trustless third-party timestamp: a
NIP-03 attestation that stamps the node's event id against Bitcoin, via
OpenTimestamps. It is fire-and-forget — the Step seal returns instantly, and
the proof resolves in the background against a calendar the author
self-hosts, upgrading in place by a later sweep. The cost is effectively free
(OTS calendars aggregate thousands of digests per Bitcoin transaction), and
the sovereignty is intact (no third-party calendar sees the hash).

Why Step and not Affirm? Because anteriority's power is *density* — dozens of
checkpoints provably committed across weeks, showing real work happening over
time. Density requires the frequent gesture to stamp. A single anchor at
publish time gives you nothing. So Step stamps; Affirm inherits its
anteriority transitively from the cited node, and may keep its own stamp only
to prove *when endorsed*, a separate claim from *when the content existed*.

This is what makes the whole network knowable: a trace's save history becomes
a forgeable-in-theory-but-not-in-practice record of real process. Page seven
turns that record into a filter.

---

## Page 4 — Composition

A trace has exactly one owner — the key that signs its nodes. Five moves let
traces reach across to each other. Four of them are one edge.

**Minting.** You select a passage of text and strike it into its own trace.
`[[ a phrase ]]` is rewrite protection, not yet a trace — it shields the span
from silent drift across LLM rounds. The minting pass seals a new file trace
whose snapshot *is* that text, and rewrites the bracket to
`[[ a phrase | nodeId ]]`. Now it's addressable forever. Minting captures
what's there now; it doesn't invent a pre-mint history. Nothing cites without
first being minted.

**Citing.** Once minted, a trace can be cited. A cite is one delta type with
five roles:

| role | what it is |
|---|---|
| `inline` | a frozen quote, pinned to a version; body changes |
| `live` | a transclusion that tracks its source's head (reserved) |
| `tag` | a zine tagged onto this trace; body untouched |
| `reply` | this whole document replies to another trace |
| `content` | a quote of *orphan text* — print, oral, sourceless — keyed on its content hash, not on any node |

Every cite (except `content`) is carried as a `q` tag — the single composition
edge, NIP-18 quote shape, pointing from your nucleus to the cited one. A
citation pins the source's nucleus *at the moment of citing*, even if the
source's chain moves on. Citing has never needed the source's cooperation.

**Tagging.** A tag and a resolved bracket are the same `q` edge, differing
only in manifestation: a bracket is rendered into the body; a tag is real and
discoverable but never touches the body. Tagging emits both a `q` (the pinned
edge) and a `t` (a plain lexical mirror, free `#t` discoverability for any
Nostr client). Browsing a tag is a three-way union: the literal label, every
body-identical trace, and one hop through the tagged zine's own edges.

**Forking.** To work on someone else's trace, seed a new trace under *your*
key from the source's current node. `snapshot` verbatim (so it collides on
contentHash — deliberately), `forked-from` the exact source version, and
**no `q` to the source**. A fork is derivation, not composition. It diverges
freely; the source owes it nothing. Fork is to propose.

**Merging.** To accept, the owner of the receiving chain seals one node with
a `merge-parent` edge naming the foreign head, and a `snapshot` that is
whatever the owner chooses to publish. Merge is **unilateral** — the
parent's author neither co-signs, nor is notified, nor needs to be. The
parent chain persists untouched; selective acceptance is the ordinary
snapshot, not a special case; either direction is the same shape. Merge is
to accept.

> To fork is to propose; to merge is to accept. Both are one owner, one seal,
> no waiting on anyone.

A document that is nothing but a sequence of citations is already a
**composite trace** — an anthology, ordered by its author, addressable like
anything else. Its snapshot inlines what it quotes, so rendering needs no
fetches. Adding a quote next year is just an edit. Parallel, unrelated
anthologies under the same informal name are expected, not a conflict.

---

## Page 5 — Attribution & verification

Who wrote what. Two layers, in priority order.

**Per-delta attribution (primary).** Each body-edit delta may carry an
`author` field — an index into the node's local `voices` table (an array of
pubkeys; the signer should be `voices[0]`). Omit it and the delta defaults to
the node's signer. This makes per-character attribution recoverable in one
forward pass over a single node's deltas — O(content), independent of chain
depth — with no reconstruction. On a mono-author seal (the common case: an
auto-save, an all-LLM edit) every delta is the signer's, so `author` is
omitted and the wire stays as compact as the legacy form. Overhead appears
only when voices mix within one checkpoint.

This is the right layer for the human–AI loop — you type, you invoke the
model, its output is spliced into the buffer and sealed on the *same* chain
under keys you control. There is no merge seam to walk, so there is nothing
to "verify" in the cross-author sense; there is only the signer's honest
claim about which voice produced each span.

**`authors` map (secondary).** An ordered run list covering the snapshot,
each run attributing a slice to a pubkey. It carries an optional `src` — the
event id of a node *signed by that author* in which this run's text appears.
That pointer is what makes a cross-author run **verifiable**: text attributed
to P is confirmed when it's derivable from a node P signed, reachable via a
seam edge (`merge-parent`, `extracted-from`, `forked-from`, or `q`). This is
the layer for verified cross-authorship — which, to be verifiable, means
multi-chain, joined by merge.

**The trust posture, stated honestly.** Every attribution signal on a node —
signer, per-delta `author`, `authors`, `contributors` — is a *claim by the
node's signer*. A run that corroborates via a seam edge plus `src` is
**verified**; otherwise it is **asserted**. Clients should render the two
states distinguishably. The protocol never required the attributed author's
cooperation to seal, and never pretended in-session co-authorship was
seam-verifiable when it isn't.

**Verifying a citation** is the same posture, bounded. A cited node carries
its own snapshot, so confirming a quote is real is O(source snapshot), never
O(source chain). A `sourceContentHash` sharpens it: hash the citing span (no
fetch), check it against the source (one fetch). It is not trustless — a
determined liar can cite a real hash for text not really at that position,
and full verification reads the citing document too. The protocol optimizes
the honest path and makes the dishonest one cheap to expose, not impossible.
And missing events **degrade rather than break**: the citing document renders
from its own snapshot (the quote is already inlined); only verification
fails. A missing npm dependency breaks a build; a missing cited event leaves
an unverifiable but perfectly readable document.

---

## Page 6 — Transport

Every cryptographic fact about your press derives from **one secret**: your
Nostr secp256k1 private key. Three roles, one key.

| role | what it is |
|---|---|
| **Identity** | your npub — the secp256k1 public key |
| **Relay access** | NIP-42 AUTH challenge response — the same key signs kind-22242 |
| **Reachability** | your `.onion` address (Tor v3) — HKDF-SHA256 → ed25519 seed |

There is no second credential. Lose the secret, lose the onion. Have the
secret, reproduce identity *and* reachability on any machine. The onion
address is *derived* from the Nostr key — a deterministic, one-way function
(HKDF with versioned domain-separation strings) — not an independent
credential. It never touches disk: the press derives the seed, expands it to
the 64-byte form Tor expects, and hands it to the sidecar via the control
port; on next launch it is re-derived and re-registered. Your sovereignty is
one key, not three. That is load-bearing.

**The mesh is an access-policy mesh, not gossip.** Each press's relay serves
only that press owner's authored traces. Peers are who may *connect and
read* — never what you *cache or forward*. You host your words; your peers
host theirs; nobody carries speech they did not sign. This is not SSB-style
epidemic replication, and not a shared data plane. Amplification is
*citation*, not replication — to boost a peer's work you publish an opinion
with a high visibility weight, or cite it in a composite, or tag it. You do
not re-broadcast their content.

Peers live in a **private local ACL** (`peers.json`), never published as a
Nostr event. A security boundary must not be a public artifact.

| who | connect | read | write |
|---|---|---|---|
| owner (your pen key) | always | own authored traces | yes |
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

A **super-peer** is a durable, always-online relay holding a replica of *your*
archive — your second copy for offline readability. Any NIP-01+NIP-33 relay
suffices, including a hosted docker-compose one. It is not a discovery
platform; it is where your cited traces stay reachable when your laptop is
closed. It also hosts your self-hosted OTS calendar (so save hashes never
leave your own infra) and bootstraps you into the DHT.

Any NIP-01 relay that also implements parameterized-replaceable handling
(NIP-33) is sufficient. There is no special relay class. Revocation is
standard NIP-09: the owner publishes a signed kind-5 deletion request,
conforming relays delete and tombstone. The chain is untouched (nodes are
immutable, history retained); revocation changes relay *retention*, which is
the layer the spec keeps non-normative on purpose.

---

## Page 7 — Rendezvous & the vet

Two people who have never met, share no peer, and share no relay find each
other because they quoted the same text. Then the recipient decides,
automatically, whether the other side is a real person doing real work or a
squatter with a copied quote.

**The coordinate is content-addressed.** When you quote orphan text — a
printed source, something oral, text with no origin node in the system — you
emit a `cite role: "content"` whose key is `H = sha256(canonical(text))`, not
a node id. `H` is the rendezvous coordinate: the address of a room defined by
the *text itself*, independent of any author, node, or relay. Canonicalization
is exact (Unicode NFC, whitespace collapsed, no case-folding); fuzzy
matching, if you want it, is a client-side layer above the coordinate, never
part of `H`.

**The DHT carries pointers, not content.** A Kademlia DHT (libp2p in the Rust
backend, bootstrapped off your own super-peer) answers one question: *who
else published interest in `H`?* It returns a list of contact pointers —
onion address plus pubkey — never content. Content stays in the author's
signed chain, fetched on demand. The DHT is the discovery index Nostr
deliberately lacks; it composes cleanly with the access-policy mesh because
the two carry different things (the mesh: signed traces; the DHT: pointers).
"Nobody carries speech they did not sign" still holds.

Two paths to a match. The **mutual-peer co-citation** path is the trust-bounded
v1: a peer you both trust sees the coincidence because it's the one node
authorized to read both your chains, brokers the introduction, and hands each
of you the other's address. It works from day one, with zero DHT density. The
**global DHT** path is the opt-in accelerator: you take the explicit "attest
interest" gesture on a quote, and your pointer publishes under `H` for any
stranger to find. The network is alive at launch via the mesh; the DHT is
what lets it outgrow the mesh.

**The vet — process, not prose.** Here is the captcha, and the reason the
word is earned. The thing a human checks by eyeballing prose — "does this
feel human" — is exactly what modern LLMs are best at faking. Prose is the
attacked surface, not the defense. Proof-of-human lives where a human
eyeballing cannot reach: in the *process* — the timestamped revision graph,
the timing of edits, the things anchored to reality at real moments. Process
signals are by construction machine-verifiable and human-illegible. A human
cannot look at a corpus and tell you "the inter-edit timing distribution is
too uniform to be real." That is a computation. That is the captcha: an
automated proof-of-process no human could perform by reading.

Three layers, weakest to strongest:

1. **Anteriority chain** (cryptographic, unfakeable for the past). Walk the
   chain; verify every claimed checkpoint carries a valid OTS proof anchored
   to a Bitcoin block at the claimed time. A sybil materializing a fake
   six-month history *today* cannot back-date commits into Bitcoin's history
   without re-mining Bitcoin. This is the floor — and it is why Step stamps
   (page three) are load-bearing. Without saves stamping, there is no body of
   work to read.
2. **Timing distribution** (statistical). Real human writing is bursty,
   circadian, weekly-gapped, with revision clusters. A generator yields a
   uniform or weirdly-regular distribution. Defeats the naive patient sybil.
3. **Revision-graph entropy** (statistical). Real traces have real diffs —
   content moved, deleted, restructured — not just appended polished
   paragraphs.

The machine filters on *could a real process have produced this* and rejects
the 99% — instant sybils, unstamped histories, generated corpora with no
process backing — automatically, no human attention spent. Only the
candidates that *pass* reach a human, who reads for *compatibility* (do I
want to talk to this person), a different question correctly reserved for
the human. Sybil at the network layer is unsolvable and the vet doesn't try;
it is an *admission* defense. The network can be full of sybils; your
`peers.json` isn't. Email is 90% spam and it's fine, because your address
book isn't.

Across the whole pipeline, one verb escalates in commitment, the same "put
it on the record" semantics throughout:

| stage | gesture | what you attest |
|---|---|---|
| publish | attest a node | "this is my published position" |
| match opt-in | attest interest in a quote | "I'll be findable on `H`" |
| admission | attest a peer | "I vetted and trust this person" |

---

Everyone now runs their own press.

This is the apparatus under the thesis: traces that keep their history in
high fidelity; a single key that is your identity, your access, and your
reachability; a mesh that carries only the speech you signed; a coordinate
that is the text itself, so two readers of the same passage find each other;
and a filter that reads the timestamped save graph — the rhythm of your real
work — to tell a person from a squatter.

`git clone`, `npm run dev`, and the press is running.

For the wire, the field-by-field spec is `trace-provenance.md`; for the key,
the mesh, and the onion, `transport.md`; for the room and the vet,
`rendezvous.md`. This was the tour.
