<!-- zine-about-copy:product:start -->
# Product

Zine records how a document was actually made — by people, by models, or both
— as signed, replayable history. This page explains the problem it solves,
who it serves, and where to start. For how the machinery works, read the
[Protocol](PROTOCOL.md) tour.

## The problem

Once an AI-assisted document leaves its editor, the process that produced it
collapses into a final file, a coarse version history, and scattered model
logs. Those records answer different questions and rarely compose:

- A final-text detector guesses from prose after the fact.
- Version history shows that bytes changed, but not which voice — person or
  model — produced each span, or what context an agent received.
- Model observability shows calls, but not an authoritative chain of the
  artifact versions those calls changed.
- A hosted editor asks the reviewer to trust the platform that stores the
  history.

Zine records signed process evidence at the point of writing. It does not
decide whether an author is human, whether a claim is true, or whether a work
deserves trust. It gives a reviewer inspectable evidence instead of a verdict.

## Who it serves

Three roles meet in every traced document:

- **The writer** — a person, an agent, or both interleaved — whose edits
  become signed checkpoints as the work happens.
- **The accountable team** — whoever answers for agent-written artifacts in a
  regulated or reputation-sensitive setting: an AI platform owner, a security
  lead, an editorial or compliance owner.
- **The reviewer** — often somewhere else, often later — who must understand
  how one result came to be.

The job Zine does for them:

> When a person or agent changes a durable file, preserve enough signed
> evidence for a reviewer to reconstruct what changed, which key acted, and
> which version the author chose to share or stand behind.

Reports, research, policies, and editorial artifacts are natural first cases,
because the file outlives the model session and review usually happens
somewhere else.

## Agents write through Zine

`zine-mcp` is a headless press that sits beneath any MCP-capable harness. It
gives the agent its own voice key and exposes provenance gestures instead of
generic file read and write.

```text
MCP harness
    |
    v
agent voice key
    |
    v
Step local versions ---> Send one version ---> optional Attest
    |                         |                      |
    v                         v                      v
signed history          review/discussion      commitment
```

The flow:

1. Configure the MCP client with a command and optional named profile. The
   press mints or reopens that profile's permanent Root; no folder or running
   relay is required. An existing source folder is an explicit, optional fork.
2. The press mints a distinct key for the agent and never imports yours. The
   key, Root, and current working state persist across runs.
3. The agent Steps file states under its own key. Each exact signed event lands
   in a durable local outbox before relay delivery, so an unavailable home
   relay does not lose or reject the Step.
4. It Sends one exact stepped file node when the work is ready for someone
   else to fetch; earlier private Steps need not leave the machine.
5. The handoff includes a portable locator. An LLM can consume the canonical
   raw signed node directly, while the desktop verifies and renders the
   nucleus plus any reachable history for a human.
6. The author may later Attest a sent version to stand behind it.

The desktop press is the human interpretation surface; the raw signed trace is
the headless machine interface. Its
native model operations also record each call's prompt, model configuration,
and cited context. The current [roadmap](ROADMAP.md) builds next toward a
multi-AI task and correspondence foundation. Carrying the same call metadata
on MCP-authored Steps and a no-install verifier remain Phase 1 work, but they
are no longer the only immediate priorities.

## Beyond one agent run

The same trace primitive supports people and models, files and folders,
citations and derivation. That breadth matters because useful work does not
stay inside one agent run:

- A person rewrites model output.
- An agent quotes a source passage.
- A collaborator forks a file and proposes changes.
- An owner selectively merges the proposal.
- A reviewer checks the exact version that was sent or endorsed.

Agent provenance delivers value to a single press on day one; team and
network layers grow out of the same records later. No global network is
required for the first user to benefit.

## Principles

- **Evidence, not verdicts.** Preserve checkable claims and state their limits.
- **Sovereign by default.** Local authoring works without a hosted account.
- **Protocol before platform lock-in.** Files and signed events remain usable
  outside one service.
- **One owner per trace.** Cross-author work joins through explicit fork and
  merge seams.
- **Private work stays private by default.** Step is local; Send changes
  reachability; Attest is a separate commitment.
- **Progressive disclosure.** Users should understand the action before they
  need to learn Nostr tags, key roles, or relay policy.

## Where Zine is today

The desktop press, the MCP press, the local relay, and the full gesture set —
Step, Send, Attest, Mint, Cite, fork, and merge — plus raw-file Reify export
work today.
The [evidence ledger](EVIDENCE.md) records exactly what is implemented, what has
been measured, and what remains unproven. Hosted services, a no-install public
verifier, and the network layer are sequenced behind evidence, not dates; the
[roadmap](ROADMAP.md) names the proof that unlocks each phase.

What matters most right now remains deliberately narrow: teams tracing real
agent-written artifacts every week, and a proof record that answers a review
or dispute question ordinary file history could not. The broader task and
correspondence build now proceeds in parallel, but repeated real use and
consequential review value remain the evidence that determines whether it
should continue, narrow, or stop.
<!-- zine-about-copy:product:end -->
<!-- zine-about-copy:protocol:start -->
# Protocol

Seven sections for anyone about to run a press.

The Pitch describes how Zine feels to use. The remaining sections explain the
machinery needed to build a client, run a node, or extend the protocol. This
is the tour, not the law: design history and normative rules live in the full
specifications, which win wherever the two disagree. The
[trace specification](../protocol/trace-provenance.md) owns trace events and
gestures, the [transport specification](../protocol/transport.md) owns network
identity, access, and reachability, and the
[rendezvous specification](../protocol/rendezvous.md) owns quote discovery and
process vetting.

---

## Pitch

AI can rewrite a document in seconds, then leave behind a polished file whose
process is gone. Ordinary version history does not reliably say what a model
saw, which passages it produced, what a person accepted, or where copied
material came from. Looking only at the final text is too late.

A **trace** is a file or folder that keeps a high-fidelity edit history. You
can play it back and see how the work changed, not just where it ended. Each
deliberate checkpoint is signed and self-contained, so another reader can
inspect the evidence without trusting one editor account.

That history gives human and LLM readers something plain text loses: process.
You cannot fully explain your taste in phrasing, especially when a sentence is
taken apart and rebuilt several times. You can let the model watch the changes.

The model writes into the same files you do, so its work enters the record as
well. Fonts and colors distinguish interleaved voices. The result shows who
wrote what and how the text came to be.

`Ctrl/Cmd+S` places a **Step** in the trace. Each Step batches the editor-action
log into a signed checkpoint; no event fires per keystroke. Send later
publishes that exact checkpoint, including its high-resolution action log, for
playback and process vetting.

Zine is to authorship provenance what Git is to source history. The protocol
and local press are open; each author can keep a private home relay, add a
remote for reachability, and verify the signed history without depending on a
single host.

The desktop app is the reference press. The headless MCP press lets an agent
write through the same protocol under its own voice key. That makes agent
authorship useful before any social network exists: a reviewer can inspect the
artifact's history, not merely the model-call log.

Text inside `[[ double square brackets ]]` is protected from silent LLM
rewrites. Minting turns that text into an immutable trace called a **coin**.
Citing a coin can place you near other people who preserved the same words.

**Zine** is the press; a **zine** is a published trace whose exact sent
version you have attested. The attestation is a separate, signed commitment
and may include a note or location. Step history may also carry completed
Bitcoin time anchors.

Forking begins a proposal under your key. Merging accepts chosen work into
your chain. To fork is to propose; to merge is to accept.

Everyone runs their own press. Presses may meet through optional remotes and
peers, but local authoring never requires them.

Underneath, Zine uses Nostr events over local and configured remote WebSocket
relays: SHA-256 ids, Schnorr signatures, and the seven NIP-01 fields. Tor can
expose a private relay. Global peer discovery remains planned and is dormant
until real usage produces enough citation density to justify it.

---

## Model

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

## Gestures

Three words define the author-facing protocol.

**Step.** `Cmd+S` signs one checkpoint and writes it to the local relay. A Step
is frequent, deliberate, and local. Every explicit Step creates exactly one
checkpoint, even when the body is unchanged. Background observations may join
it, but no event fires per keystroke. This bounded cadence makes full snapshots
affordable. The protocol uses *Step*, not *save*, to keep it distinct from Send.

**Send.** Open the current state for discussion. If the buffer has changed,
Send first Steps it; otherwise it reuses the latest Step. It then fans that
node out to write-enabled external relays. Most Steps are never Sent, so
drafts, experiments, and dead ends remain local. Send publishes everything the
checkpoint carries, including its high-resolution editor-action log when
present. That log enables typo-level playback and process vetting, while its
timing rhythm can also fingerprint an author. Send is therefore a content and
identity disclosure.

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
process evidence. The final section, Rendezvous & vetting, uses available
evidence as one input to an admission filter, without treating it as proof of
author identity or humanity.

---

## Composition

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

## Attribution & verification

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

## Transport

The press uses one keychain with **separate roles**. A fresh install assigns
different secrets so a stable network address is not coupled to a pen the
author may switch. The user may intentionally assign one key to several roles.

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

## Rendezvous & vetting

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
history; a patient forger can still pre-plant a corpus, so what they impose on
that forger is calendar delay, not effort. They are admission heuristics, not
proof that a human authored the work.

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

For the wire, use the
[trace specification](../protocol/trace-provenance.md); for the key, mesh, and
onion, use the [transport specification](../protocol/transport.md); for the
room and vet, use the
[rendezvous specification](../protocol/rendezvous.md). This was the tour.
<!-- zine-about-copy:protocol:end -->
<!-- zine-about-copy:evidence:start -->
# Evidence

Zine asks readers to check claims, not to trust them. This page separates
exercised implementation, measured research, protocol assertions, and open
hypotheses. Last updated 2026-07-17.

## What works today

| Capability | State | How to check |
|---|---|---|
| Signed, self-contained file and folder checkpoints | Implemented | Client provenance tests and real-relay smoke |
| Step, Send, Attest, Mint, and Cite | Implemented | `npm run verify:relay` exercises temporary ACL-protected relays |
| Desktop press with local relay sidecar | Implemented | React/Tauri client, Rust sidecar lifecycle, Go relay |
| Desktop Stronghold storage for signing and provider secrets | Implemented on desktop; browser remains read-only | `secret-store.test.ts`, `secret-migration.test.ts`, key/model store tests, and the Tauri Stronghold shell |
| Headless MCP press with its own voice key and permanent profile Root | Implemented | Offline stdio smoke proves zero-folder cold start, exact signed-event outbox, raw node reads, and Root/key reuse; isolated real-relay integration flushes a queued event unchanged, preserves optional source forks, and exercises external Send |
| Prepared desktop MODEL operations and approval gating | Implemented for direct single-shot gestures; not yet enforced on every live model call | `prepared-operation.test.ts`, `context-snapshot.test.ts`, `model-operation-executor.test.ts`, and `llm-prepared.test.ts`; the separate agent loop still uses its own transport, and `preparedRequestHash` is not yet stored in Step metadata |
| Per-delta human/model attribution | Implemented | Attribution regression suite; trust status remains asserted unless corroborated through a signed seam |
| Fork and merge | Implemented for current top-level flows | Merge and ownership tests; recursive nested-folder fork-on-write remains deferred |
| Mutual-peer co-citation and process vet | Implemented and tested | `co-citation.ts`, `vet.ts`, `vet-walker.ts`, and their tests |
| Exact and fuzzy quote matching | Implemented with uncalibrated defaults | SHA-256 coordinate plus MinHash/LSH client layer |
| Raw-file Reify with optional trace bundle and report | Implemented on desktop | `reify.ts` materializes signed snapshots and keeps raw events under `.zine/` |
| Global Kademlia rendezvous | Not implemented | Design sketch in the [rendezvous specification](../protocol/rendezvous.md) |
| No-install public verifier | Not implemented | On the [roadmap](ROADMAP.md) |
| Managed organization service | Not implemented | Hosted relay code exists; no paid service or SLA is claimed |

Desktop vault caveat: Stronghold's password and snapshot KDFs are
intentionally expensive. A fully unoptimized development build can appear to
stall for minutes; the current development profile optimizes only the
cryptographic hot paths. Release KDF parameters and the application security
contract are unchanged.

Reify writes each chosen Step's authoritative `snapshot` to its ordinary file
path. It never substitutes the live unstepped editor buffer and never embeds
provenance in the file. “Include trace” is explicit and off by default; when
enabled it adds raw signed events at `.zine/trace.json` and a derived readable
projection at `.zine/report.md`. The JSON, not the report, preserves the fields
needed to verify event ids and signatures.

Nothing above needs to be taken on faith. From a repository checkout:

```sh
npm run check          # client, MCP, relay, and Rust tests
npm run verify         # check + client build + isolated relay smoke
npm run verify:relay   # real Step/Send/Attest/Mint/Cite flow
```

## What we have measured

The pre-registered narration study asked whether structured edit evidence
changes how an LLM describes the creation of a document.

For the bulk-insert failure class, bound narration fell from 5/5 with
character-magnitude labels and span payloads, to 2/5 with spans only, to 0/5
with neither. On the second trace, all five bare-log draws invented content
that was not in the file. The exact results and raw draws are preserved in
[`research/results.md`](../research/results.md).

The strongest comparison is labels-plus-spans versus bare log, 5/5 versus 0/5
bound. The repository records an approximate one-tailed Fisher exact
`p ~= 0.004`. The marginal contribution of the summary label over span content
alone is directional but not statistically separable at five draws.

Limits:

- one model (`glm-5.2`);
- five draws per condition;
- one hand scorer who was not blind to condition;
- two source traces; and
- no customer outcome measured.

This study supports one technical claim: structured process evidence can make
machine narration of an artifact more faithful. It does not demonstrate
market demand or a general model-independent effect.

## What the evidence can and cannot establish

| Evidence | Supports | Does not establish |
|---|---|---|
| Valid TraceNode signature | The named pubkey signed this exact event | Legal identity, humanness, truth, or exclusive authorship |
| Snapshot hash and valid delta replay | The stored body is internally consistent with the signed record | That every real-world edit was captured |
| Per-delta voice index | The node signer asserted that voice for the changed span | Independent proof that the attributed person or model produced it |
| Cross-author seam plus signed source node | The attributed text is corroborated by a node under the source key | Consent, originality, or copyright ownership |
| Completed OpenTimestamps proof | The committed event id existed no later than the Bitcoin attestation | The truth of `created_at`, author identity, or uninterrupted human work |
| Timing and revision-graph signals | A declared admission policy found the process more or less consistent with its reference model | Proof of a human author; a patient generator can reproduce the signals |
| Content-hash co-citation | Two reachable traces cite identical or canonical-equivalent content | Shared intent, agreement, or a meaningful social relationship |

The normative trust posture is in
[`protocol/trace-provenance.md`](../protocol/trace-provenance.md) and
[`protocol/rendezvous.md`](../protocol/rendezvous.md).

## What we have not proven yet

- Named teams returning week after week to multi-AI task and correspondence
  work on real artifacts.
- A cross-model handoff whose trace answers a consequential question that
  ordinary files plus provider logs could not.
- Willingness to pay for a hosted or organization layer.
- A no-install verifier used outside the authoring environment.
- Kind and tag registration in the Nostr ecosystem.
- A second independent implementation of the wire format.
- A consented corpus large enough to calibrate timing, revision-shape, and
  fuzzy-match models.
- Organic co-citation density sufficient to justify global rendezvous work.
- Clean-machine release installation on every supported desktop platform.

These gaps are roadmap gates, not details to hide. A claim moves off this
list only when its evidence is linked here.
<!-- zine-about-copy:evidence:end -->
<!-- zine-about-copy:roadmap:start -->
# Roadmap

Evidence, not dates, unlocks phases, with the one named exception below. Each
phase names the proof that opens the next one. The thesis stays constant
throughout: signed process provenance for human-AI authorship, sovereign by
default, evidence instead of verdicts.

One explicit founder-conviction decision changes what is built before demand
evidence arrives. As of 2026-07-17, Zine is building the local-first multi-AI
task and correspondence platform while customer discovery runs in parallel.
That is a sequencing choice, not evidence that demand already exists.

## Sequencing rule

Task and correspondence implementation now runs alongside customer discovery.
Managed services and global network work remain evidence-gated:

```text
multi-AI task + correspondence <----> customer discovery
               |
               v
shareable verification + retained team use
               |
               v
managed team layer
               |
               v
consented calibration corpus
               |
               v
network rendezvous, only if density exists
```

## Current foundation

Already built:

- desktop and MCP presses;
- signed file and folder trace chains;
- Step, Send, Attest, Mint, Cite, fork, merge, and replay;
- distinct human, model, and agent voice keys;
- per-delta attribution and, for native desktop model operations, exact LLM
  metadata and context references;
- a local relay implementation with NIP-42 owner/peer/writer policy, plus a
  hosted relay implementation whose equivalent operator ACL is still a gap;
- mutual-peer co-citation, process vetting, and fuzzy quote matching;
- raw-file Reify with an opt-in signed-event bundle and readable report;
- desktop signing and provider secrets stored behind a Stronghold vault;
- prepared direct MODEL operations with explicit approval and stale-result
  protection, though that path is not yet universal or durably bound to Steps;
- a pre-registered narration study.

Known gaps include authoritative relation and task metadata, durable attempt
journaling, universal exact-context preflight, declarative model rows, native
harness adapters, nested folder fork-on-write, public release packaging,
no-install verification, organization administration, calibration, kind and
tag registration, and a second independent implementation.

## Phase 1: multi-AI correspondence anyone can adopt

Priority work:

1. Make one clean pre-production schema cut for durable relation roles, task
   turns, operation metadata, and ordered prompt-rule references; update the
   specifications, readers, writers, fixtures, indexes, and tests together.
2. Bind every live model action to exact context preflight and disclosure,
   durable attempt journaling, per-target locking, compare-and-set application,
   and idempotent recovery.
3. Replace the hard-coded model row with a declarative registry and prove the
   shared runtime first with GLM, including cumulative Continue, generic Reply,
   `Analyze · Process`, and explicit trace-preserving compaction.
4. Add pinned Codex, Claude, and local-model adapters that preserve native
   approvals, use minimal authority, and cross providers only through reviewed
   handoff manifests. Keep MCP as outside-in interoperability with bounded
   metadata claims.
5. Make correspondence and replay role-aware, including provenance-preserving
   quotation without Coin, an honest EXTERNAL origin, and context relationships
   that do not become citation or social signals.
6. Build consent-gated full-chain transfer and a separately owned reviewer
   analysis trace, without silently publishing linked private context.
7. Package `zine-mcp`, finish an installable macOS dogfood bundle on the current
   development machine, serve exported bundles through a no-install verifier,
   and run first-team discovery and dogfood in parallel with the implementation.
   Signed and notarized public releases and the clean-machine Windows/Linux
   matrix remain deferred in [`TODOS.md`](../TODOS.md).
8. Register the provisional protocol surface and support a second independent
   implementation, even a deliberately small one.

Phase 1 has succeeded when:

- the new schema, attempt journal, action runtime, and adapters pass their
  regression suites and a real-relay verification;
- one press can Continue, Reply, Analyze, compact, and hand off a readable task
  across multiple model rows without losing exact provenance or local control;
- named teams trace real agent-written artifacts;
- they repeat the workflow weekly, for weeks in a row;
- at least one proof is read by someone outside the team that created it;
- the evidence answers a review, dispute, or postmortem question that
  ordinary file history could not; and
- a team asks to pay for availability, organization controls, or
  verification.

Founder conviction does not make this phase irreversible. Narrow or stop the
broader build if teams do not return to multi-AI task or correspondence work,
if the trace does not answer consequential handoff or review questions better
than ordinary files plus provider logs, or if integrated adapters cannot keep
their authority and evidence claims bounded enough to preserve Zine's
local-first trust model.

## Phase 2: operate the paid team layer

Built only when Phase 1's evidence arrives:

- managed always-on remotes with backup, retention, and a declared SLA;
- organization keys, writers, peers, and ACL administration;
- hosted anchoring with explicit cadence and proof-retention policy;
- verification links, evidence exports, and reviewer access controls; and
- usage and reliability instrumentation for the hosted service.

Self-hosted presses and compatible relays remain complete alternatives.

## Phase 3: calibrate interpretation

A research program, not a hidden classifier:

- explicit opt-in contribution of redacted or consented process traces;
- declared population, sampling, and retention policies;
- multi-model replication of the narration study;
- calibrated timing, revision-shape, and fuzzy-match models;
- published false-positive and false-negative behavior; and
- versioned admission policies that a reviewer can inspect.

The paid layer may sell calibrated interpretation. The protocol continues to
carry evidence and never promotes a model score into proof of humanness.

## Phase 4: network rendezvous, only on evidence

The mutual-peer discovery path remains available today. New global rendezvous
work stays frozen beyond maintenance and security fixes, and resumes only
when all of the following are true:

- real presses have produced a meaningful corpus of sent citations;
- organic co-citation matches occur in the existing trust-bounded path;
- users repeatedly ask to meet unknown co-citers;
- the matching and admission models can be evaluated on real data; and
- the value of global discovery outweighs its privacy, abuse, and operational
  costs.

Until then, the rendezvous specification is dormant upside. More argument or
simulation does not open this gate; only usage does.

## Not on the roadmap

- New social or model gestures beyond the accepted task/correspondence set
  without observed user demand.
- More DHT wire design before real co-citation density.
- Claims that timing or revision shape proves a human author.
- A proprietary relay requirement.
- Mandatory accounts or telemetry for local authoring.
- Non-text artifacts before the agent-to-file workflow retains real teams.

## How we measure progress

Progress is counted in evidence, not features:

- named teams tracing real work;
- weekly active traced workspaces and four-week retention;
- agent-written artifacts stepped and sent;
- proof reports opened by an external reviewer;
- review questions resolved with trace evidence;
- hosted conversions and reliability; and
- consented corpus size and calibration coverage.

None of these numbers are claimed yet. The current state of every claim lives
in the [evidence ledger](EVIDENCE.md).
<!-- zine-about-copy:roadmap:end -->
<!-- zine-about-copy:company:start -->
# Company

Zine's protocol and presses are open source, and self-hosting is a complete
path, not a trial. This page explains how an optional paid layer can exist
without compromising that — and what stays free no matter what. No paid
service is shipping today.

## The framing

Zine separates local history from hosted coordination the way Git separates a
repository from a remote. The protocol is the commons. A company can sell the
operational layer that teams want but the wire deliberately does not require.

In that analogy Zine is the Git, and an optional managed service can play the
GitHub role: durable coordination, organization controls, review, and
distribution around a portable open format.

> Everyone runs their own press. The company is where presses meet.

This is compatible with sovereignty because the paid layer is optional. A
press can write to its local relay, self-host a remote, and verify events
without phoning home.

## What is open, what is paid

| Always open | Optional paid layer |
|---|---|
| Signed trace events and verification rules | Managed always-on remote with backups and SLA |
| Local desktop and MCP presses | Organization onboarding, support, and policy controls |
| Self-hosted compatible relays | Team key, writer, peer, and ACL management |
| Step, Send, Attest, Mint, Cite, fork, and merge | Hosted anchoring cadence and proof retention |
| Reader-side verification algorithms | No-install verification portal and exportable reports |
| Self-hosted process evidence | Opt-in calibration service over a consented corpus |
| Future open rendezvous wire | Operated bootstrap infrastructure, if usage justifies it |

The protocol deliberately says that any compatible NIP-01 and NIP-33 relay
can store published traces. The commercial value is not a special relay
class. It is reliable operation, organization controls, verification
workflow, and calibrated interpretation around commodity storage.

## Where a paid layer could grow

| Open need | Product opportunity | Today |
|---|---|---|
| A super-peer keeps a published corpus reachable | Managed remote, backup, retention policy, and SLA | Hosted relay code exists; no paid service or SLA is claimed |
| Self-hosted OTS calendar is the target, not current behavior | Managed anchoring with declared cadence and proof availability | Current prototype can use a public calendar |
| Peer-list portability across devices is unsettled | Organization key and ACL control plane | Not implemented |
| DHT bootstrap needs operator-provided super-peers | Operated bootstrap | Deferred with the global DHT |
| Verification is bounded and reader-side | Public verifier and exportable evidence report | Local bundle/report implemented; public verifier is not |
| Timing and graph models need real calibration | Opt-in research corpus and calibrated policy models | Defaults exist; calibration does not |

## How pricing would work

The free product includes everything required to author, self-host, and
verify a trace. Paid plans charge for operational outcomes:

- availability and durable retention;
- organization identity and access administration;
- policy, review, and evidence-export workflows;
- managed anchoring and proof maintenance;
- support and deployment assurance; and
- calibrated interpretation built from an opt-in, consented corpus.

The first paid conversion should come from a team asking for reliable remote
operation, organization control, or review evidence. Charging for the local
press, or making verification depend on a proprietary endpoint, would weaken
the thesis rather than strengthen the business.

## Why openness is the strategy

Cryptographic primitives and relay storage are not what makes this durable.
If the company earns a lasting position, it compounds in this order:

1. Integration into real agent-to-artifact workflows.
2. A growing corpus of portable, independently verifiable traces.
3. Review and organization workflows that make the evidence useful.
4. A consented dataset for calibrated process interpretation.
5. A network of authors, reviewers, and citations, if density emerges.

Open verification strengthens each step: every shared proof can bring a new
reviewer into the product without asking anyone to trust a sales claim.

## Commitments

These hold regardless of business model:

- BYOK remains supported.
- Local-first remains the default.
- The open specification remains open.
- Self-hosting remains a complete path, not a crippled community tier.
- Attribution remains asserted or verified according to available evidence.
- Zine never claims to prove humanness, truth, or copyright ownership.
- Contribution to calibration datasets is explicit and opt-in.
- The press does not require a company account to create or verify core
  trace events.

## What would prove us wrong

The strategy fails if teams do not care enough about agent-written artifacts
to change their workflow, if ordinary version control plus model logs answer
the review question well enough, or if reviewers will not open a shared
proof. The network thesis fails if real corpora do not produce useful
co-citations.

The [roadmap](ROADMAP.md) sequences the work so those questions are answered
before the expensive layers are built.
<!-- zine-about-copy:company:end -->
