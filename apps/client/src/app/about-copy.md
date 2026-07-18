<!-- zine-about-copy:product:start -->
# Product

Zine records how a file or folder was actually made — by people, by AI, or
both — as signed, replayable history. A **zine** is that file or folder
together with its trace.
Zine uses the trace to help the next act of writing, not only the later audit.
This page explains the daily loop, the initial buyer, and the evidence still
required. The accepted migration direction is recorded in
[Trace-Native Zines](TRACE_NATIVE_ZINES.md); for implemented machinery, read
the [Protocol](PROTOCOL.md) tour.

## The problem

Current content is a lossy summary of writing. A file preserves the text that
survived; a folder preserves the current tree. Neither alone preserves
which direction was abandoned, which phrase was repeatedly repaired, what a
writer protected, what an AI proposed, or what the writer rejected. Giving an
AI only that final state asks it to collaborate without evidence of the
process that shaped the work across one file or a whole folder.

Once an AI-assisted document leaves its editor, the process also collapses into
a final file, coarse version history, and scattered model logs. Those records
answer different questions and rarely compose:

- A final-text detector guesses from prose after the fact.
- Version history shows that bytes changed, but not which voice — person or
  model — produced each span, or what context an agent received.
- Model observability shows calls, but not an authoritative chain of the
  artifact versions those calls changed.
- A hosted editor asks the reviewer to trust the platform that stores the
  history.

Zine records signed process evidence at the point of writing. During writing,
it can select bounded evidence for an AI and let the writer inspect or correct
that context. During review, it provides evidence instead of a verdict. It does
not decide whether an author is human, whether a claim is true, or whether a
work deserves trust.

The review side compresses to one line: **evaluate the writer, not just the
writing.** As AI assistance makes finished prose more uniform, the information
that distinguishes a writer migrates out of the final text and into the
process — what they asked for, rejected, protected, and rewrote. The trace is
where that signal survives, and it cannot be captured retroactively: from a
full trace any bounded view can be derived later, while no finished text
recovers the process that produced it.

## Who it serves

Three roles meet in every zine:

- **The writer** — a person, an agent, or both interleaved — who wants the AI
  to respond to the work's actual trajectory rather than its latest text alone.
- **The accountable team** — whoever answers for agent-written artifacts in a
  regulated or reputation-sensitive setting: an AI platform owner, a security
  lead, an editorial or compliance owner.
- **The reviewer** — often somewhere else, often later — who must understand
  how one result came to be.

The two-sided job Zine does for them:

> While a person or agent writes, use selected trace evidence to make AI help
> more relevant and controllable. When the artifact matters later, preserve
> enough signed evidence for another reader to reconstruct what changed, which
> key acted, and which version the author chose to share or stand behind.

Reports, research, policies, and editorial artifacts are natural first cases,
because the file outlives the model session and review usually happens
somewhere else.

## The trace-aware writing loop

The foundational product bet is straightforward: for at least some writing
tasks, models given the current scoped content plus relevant process evidence
will collaborate better than models given current content alone. At file scope
this is text plus trace; at folder scope — up to the Root, the topmost folder
— it is a content tree plus trace. “Better” must be measured through writer preference, editing required
before acceptance, time to an acceptable result, preservation of intent,
recurrence of rejected directions, and later reversion—not through a
persuasive demo.

The intended loop is:

1. Zine validates the current text and trace, then selects evidence for the
   operation: exact recent changes, explicit corrections, protected text, and
   applicable scoped preferences.
2. Prompt Inspector shows the literal request, each selected item, its source
   Step or span, its scope, and why it was included.
3. The writer may exclude evidence for this operation, correct it, forget
   durable memory, or explicitly promote an otherwise inert directive.
4. The AI answers against the approved snapshot. The response is accepted,
   revised, rejected, or held as stale without silently mutating newer work.
5. An accepted result binds to the approved context manifest and becomes part
   of the trace, so later assistance and review can distinguish proposal from
   acceptance.

Context is composed from explicit zine scopes: file, nearest folder zine,
ancestor folder zines, Root, and deliberate user-level context, with more
specific choices winning. Operation-only context is ephemeral. Nothing
promotes itself upward, and incompatible equal-scope preferences block
preparation instead of being resolved by the model.

Two textual forms make local intent legible:

- `[[ protected text ]]` is exact quoted data. It remains inert and must survive
  eligible transformations byte-for-byte.
- `(( author directive ))` is a one-shot instruction candidate. Only a complete
  directive manually authored—or explicitly promoted—by the acting local author
  may enter the instruction layer. It is removed only after accepted success;
  copied, imported, generated, malformed, historical, or unknown-origin forms
  remain inert.

The compiler and memory system are product interpretation, not protocol truth.
The signed trace remains portable evidence even when a reader uses a different
selector or no AI at all.

A deliberate Step applies to the selected zine. A file Step checkpoints that
file. A folder or Root Step first checkpoints dirty descendants and then pins
one exact recursive frontier. Automatic ancestor checkpoints remain verifiable
but appear beneath the originating gesture rather than as extra author Steps.

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
the portable machine evidence. Native model operations already gather file and
folder text plus structured process history and record prompt/model metadata.
They do not yet share a deterministic selector with MCP, support the complete
scope/correction model, or durably bind accepted results to an exact context
manifest. The [roadmap](ROADMAP.md) makes that shared runtime and its outcome
evaluation the immediate priorities.

## Initial buyer wedge

Trace-aware assistance is the daily-use loop. Accountable teams remain the
initial buyer wedge: organizations letting agents write durable reports,
research, policy, or editorial work have an immediate reason to care which
context and process produced a result. Availability, organization controls,
review workflows, and evidence exports are plausible paid value; willingness
to pay is not yet proven.

## Beyond one agent run

The same zine primitive supports people and models, files and folders,
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
- **Trace is useful during writing.** Process context is a collaboration input,
  not merely an audit attachment.
- **Files and folders are zines.** Replay and publication follow the selected
  recursive scope.
- **Inspectable AI context.** Writers see, correct, and approve what Zine sends.
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

The recursive file/folder ontology now runs through the shared protocol kernel
and the client. Existing child heads advance separately from membership adds;
folder and Root Step flush dirty descendants; one durable operation id groups
the originating event with derived ancestor checkpoints; and Replay collapses
those roll-ups without hiding their signed nodes. Fixed cross-runtime folder
vectors and explicit crash-boundary real-relay fixtures remain hardening work.

What matters most now is two linked proofs: trace-aware assistance improves real
writing outcomes under a preregistered comparison, and accountable teams value
the resulting evidence enough to change a durable workflow. Task and
correspondence remain operation surfaces rather than the product center.
Repeated writing use, consequential review value, and honest failure boundaries
determine whether the pivot should continue, narrow, or stop.
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

A **zine** is a file or folder together with its high-fidelity **trace**. You
can play a file zine or a whole folder subtree and see how the work changed,
not just where it ended. Each checkpoint is signed and self-contained,
so another reader can inspect the evidence without trusting one editor account.

That history gives human and LLM readers something plain text loses: process.
You cannot fully explain your taste in phrasing, especially when a sentence is
taken apart and rebuilt several times. You can let the model watch the changes.

### Trace as AI context

That product use is deliberately downstream of the protocol. A trace says what
was signed and whether its process record conforms. A context compiler may take
the current text, a validated trace, an operation, explicit corrections, and
scoped preferences; select bounded evidence; and render the exact request a
writer inspects and approves. Selection is not another claim made by the trace.

Current prose, deleted or inserted text, citations, pasted material, prior AI
output, and historical commands remain quoted data even when their bytes look
like instructions. Only the explicit current operation, approved prompt rules,
and deliberately authorized author directives may enter the instruction layer.
An implementation should preserve that classification across provider adapters
and bind an accepted result to the exact approved context when the required
private-storage and schema review is complete.

Preferences and corrections follow product scopes—operation, file,
folder-subtree, and explicit user—not protocol truth. They may remain private
and local. Another reader can verify the same signed trace while using a
different selector, different private memory, or no model at all.

The model writes into the same files you do, so its work enters the record as
well. Fonts and colors distinguish interleaved voices. The result shows who
wrote what and how the text came to be.

`Ctrl/Cmd+S` places a **Step** in the selected zine's trace. A file Step batches
the editor-action log into one signed checkpoint. A folder Step — up to the
topmost Root — pins an exact recursive frontier after dirty descendants are
durably checkpointed.
Automatic child-head roll-ups are signed derived checkpoints, not extra author
Steps. No event fires per keystroke. Send later publishes one exact
checkpoint, including its high-resolution action log, for playback and
process vetting.

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
An authorized `(( double-parenthesis directive ))` is intended as a one-shot
instruction to a prepared AI operation. That directive grammar and its local
manual-origin authority are press behavior, not new wire semantics.

**Zine** is the reference press; a **zine** is any file or folder together with
its trace, whether local or reachable. Sending changes reachability and
attestation records a separate signed commitment; neither creates the zine.
Step history may also carry completed Bitcoin time anchors.

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

One primitive: a **zine**, whose file or folder body is carried with an
append-only trace of signed checkpoints. A file body is Markdown text. A folder body
is an ordered direct-membership list whose pinned child heads recursively
define the exact subtree frontier. **Root**, the topmost folder, is an
ordinary folder zine; there is no separate project object.

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

A **coin** is an immutable, single-node file zine struck from a passage. It
can be exported as plain text. Editing it creates a mutable fork and leaves the
coin untouched. A **press** is the editor, not a server. A **relay** stores the
press's Nostr events, locally on `127.0.0.1` or remotely.

> Run your own press = write in your own copy of the interface. It is
> sovereign by default, because it already steps to a relay of its own.

The model is deliberately small. Gestures, composition, and networking all
build on self-sufficient nodes, append-only chains, and identity fixed at
genesis.

---

## Gestures

Three words define the author-facing protocol.

**Step.** `Cmd+S` deliberately checkpoints the selected zine and writes the
result to the local relay. A file Step creates one explicit checkpoint, even
when its body is unchanged. A folder or Root Step checkpoints dirty descendants
and then creates exactly one explicit checkpoint on the selected folder.
Signed `child-advance` checkpoints propagate changed child heads through
ancestors, but Replay collapses those derived nodes beneath the one originating
gesture. Background observations may join a checkpoint, but no event fires per
keystroke. This bounded cadence makes full snapshots affordable. The protocol
uses *Step*, not *save*, to keep it distinct from Send.

Direct membership changes are structural checkpoints. An existing child's new
head is an `advance`, never another `add`. Cross-parent moves share one operation
id across source removal, target addition, and ancestor propagation so readers
can recognize and recover an incomplete multi-event gesture.

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

**Process replay.** Every file Step carries a `kedits` array whose atomic
transactions replay the previous snapshot to the current signed snapshot.
Genesis replays from the empty string; a metadata-only checkpoint carries an
explicit `[]`. Interactive writing preserves the captured editor transactions,
including undo and redo. A discrete import, fork, scan, AI file creation, or
headless tool write is recorded as one atomic transition rather than being
misrepresented as physical typing.

The snapshot remains the self-contained materialized body, so a node can still
be read in one fetch. But a missing, malformed, or replay-mismatched KEdit log
is not a valid Full Trace: readers may show the signed body only with the
process record marked nonconforming. A Step keeps this record local; Send
publishes it, including intermediate text and timing that may be identifying.

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
| Signed, self-contained file and folder checkpoints | Implemented | Client provenance tests and real-relay smoke; folder heads carry direct manifests and propagate recursively toward Root |
| Normative folder checkpoint cause and `advance` semantics | Implemented | The shared kernel verifies folder cause, membership transition, hash, lineage, and operation id; client tests exercise add versus advance, explicit folder/Root Step plumbing, durable retry ids, nested AI context, and Replay roll-up collapse. Fixed cross-runtime folder vectors and explicit crash-boundary real-relay fixtures remain hardening work |
| Mandatory replay-valid KEdit process log on every file Step | Implemented | Publisher rejects mismatches; editor, AI, import/fork, MCP, replay, and real-relay regression coverage exercise the invariant |
| Step, Send, Attest, Mint, and Cite | Implemented | `npm run verify:relay` exercises temporary ACL-protected relays |
| Desktop press with local relay sidecar | Implemented | React/Tauri client, Rust sidecar lifecycle, Go relay |
| Desktop Stronghold storage for signing and provider secrets | Implemented on desktop; browser remains read-only | `secret-store.test.ts`, `secret-migration.test.ts`, key/model store tests, and the Tauri Stronghold shell |
| Headless MCP press with its own voice key and permanent profile Root | Implemented | Offline stdio smoke proves zero-folder cold start, exact signed-event outbox, raw node reads, and Root/key reuse; isolated real-relay integration flushes a queued event unchanged, preserves optional source forks, and exercises external Send |
| Prepared desktop MODEL operations and approval gating | Implemented for direct single-shot gestures; not yet enforced on every live model call | `prepared-operation.test.ts`, `context-snapshot.test.ts`, `model-operation-executor.test.ts`, and `llm-prepared.test.ts`; the separate agent loop still uses its own transport, and `preparedRequestHash` is not yet stored in Step metadata |
| Current text plus structured trace context in desktop prompts | Implemented as a client-local compatibility baseline | Direct operations gather current file/folder text and a chronological process log through `context-block.ts`, `context-snapshot.ts`, and `prepared-operation.ts`; there is no shared task-specific selector, scoped memory, cross-press fixture contract, or durable context binding yet |
| Shared authoring-syntax kernel and a desktop adapter for the Extend (continuation) and Settle (revision) operations | Initial deterministic slice implemented; authority is current-editor-session-only | `packages/trace-context` pins UTF-16 parsing, protected precedence, exact operation clipping, authority failures, directive markers, local excerpts, malformed syntax, and generated 0/100/1,000/10,000-candidate scale fixtures. Desktop tests cover manual versus paste/drop/MODEL/undo/reload authority, exact prepared identity, protected-output rejection, atomic accepted-success cleanup, and inert legacy behavior. Persisted authority, promotion, durable consumption receipts, crash recovery, other operations, and MCP parity remain deferred |
| Per-delta human/model attribution | Implemented | Attribution regression suite; trust status remains asserted unless corroborated through a signed seam |
| Fork and merge | Implemented for owned recursive destinations and current top-level foreign flows | Nested Scan/adoption/fork tests plus merge and ownership tests; recursive fork-on-write through an already-foreign folder remains deferred |
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

## Foundational product bet

Zine is pivoting around this thesis:

> For at least some writing tasks, an AI given current scoped content plus
> relevant, inspectable trace evidence will help the writer better than an AI
> given the current content alone.

At file scope, current content is Markdown text. At folder or Root scope, it is
the recursive content tree pinned by that zine's exact child frontier.

This is a founder-conviction product decision and an unproven empirical claim.
“Better” means outcomes such as counterbalanced writer preference, less editing
and time before acceptance, stronger preservation of declared intent, fewer
recurrences of rejected directions, and less later reversion. It does not mean
that a model can produce a convincing explanation of the trace.

The planned writing study compares text-only, bounded chronological history,
and selected trace under equal byte budgets. A separate longitudinal comparison
isolates file memory from selected trace. The preregistration lives at
[`research/trace-writing-preregistration.md`](../research/trace-writing-preregistration.md)
and its operational scoring rubric at
[`research/trace-writing-rubric.md`](../research/trace-writing-rubric.md).

Until those results exist, documentation must describe trace-aware assistance
as a bet being built and tested, never as a demonstrated writing advantage.

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

This study supports one narrow technical claim: in these fixtures, structured
process evidence made machine narration of an artifact more faithful. It does
not establish better writing assistance, causal value from the full trace,
market demand, longitudinal memory value, or a general model-independent effect.

## What the evidence can and cannot establish

| Evidence | Supports | Does not establish |
|---|---|---|
| Valid TraceNode signature | The named pubkey signed this exact event | Legal identity, humanness, truth, or exclusive authorship |
| Snapshot hash and replay-valid KEdit transition | The stored body is internally consistent with the signed process record | That the press observed activity outside its own editor/tool boundaries, or that a signer did not deliberately fabricate a trace |
| Per-delta voice index | The node signer asserted that voice for the changed span | Independent proof that the attributed person or model produced it |
| Cross-author seam plus signed source node | The attributed text is corroborated by a node under the source key | Consent, originality, or copyright ownership |
| Completed OpenTimestamps proof | The committed event id existed no later than the Bitcoin attestation | The truth of `created_at`, author identity, or uninterrupted human work |
| Timing and revision-graph signals | A declared admission policy found the process more or less consistent with its reference model | Proof of a human author; a patient generator can reproduce the signals |
| Content-hash co-citation | Two reachable traces cite identical or canonical-equivalent content | Shared intent, agreement, or a meaningful social relationship |

The normative trust posture is in
[`protocol/trace-provenance.md`](../protocol/trace-provenance.md) and
[`protocol/rendezvous.md`](../protocol/rendezvous.md).

## What we have not proven yet

- Trace-aware assistance beating text-only assistance on real writing outcomes.
- Folder- or Root-level content plus trace improving cross-file work over an
  equal-budget collection of current file text alone.
- Selected trace beating an equal-budget bounded chronological history.
- File-local memory adding longitudinal value beyond selected trace alone.
- Writers reliably understanding, correcting, and trusting selected context.
- The benefit surviving multiple writing operations and model families without
  unacceptable latency, token cost, privacy burden, or over-personalization.
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
- Independently minting the same distinctive coin type predicting broader
  corpus affinity after controlling for topic and popularity.
- Longitudinal coherence or conditional-compression features adding calibrated
  vetting value without being mistaken for proof of humanity or identity.
- Organic co-citation density sufficient to justify global rendezvous work.
- Clean-machine release installation on every supported desktop platform.

These gaps are roadmap gates, not details to hide. A claim moves off this
list only when its evidence is linked here.
<!-- zine-about-copy:evidence:end -->
<!-- zine-about-copy:roadmap:start -->
# Roadmap

Zine is pivoting around one foundational bet: an AI can assist a writer better
when it receives current text plus relevant, inspectable trace evidence—not
current text alone. Evidence determines how broadly that claim may be made and
where it fails; it does not postpone building the system required to test it.

The execution posture is therefore conviction with gates. Build the complete
trace-aware loop, keep text-only and bounded-history comparisons inside the
architecture, and promote claims only when measured outcomes support them.
Individual writers remain the first audience; accountable teams remain the
initial paid wedge. Managed services and global network work remain downstream
of actual retained use.

## Sequencing rule

```text
declare thesis + preregister outcomes
                 |
                 v
shared deterministic trace-context runtime
                 |
                 v
one complete desktop writing loop <----> text-only comparison
                 |
                 v
durable binding + writing outcomes + accountable-team use
          |                              |
          v                              v
supported operation breadth        optional paid team layer
          |
          v
scoped longitudinal memory, only if independently beneficial
          |
          v
calibration or network layers, only when real density requires them
```

## Current foundation

Already built:

- desktop and MCP presses;
- signed file and folder trace chains;
- Step, Send, Attest, Mint, Cite, fork, merge, and replay;
- mandatory replay-valid KEdit process logs and shared `FULL TRACE` /
  `SNAPSHOT ONLY` / `INVALID` reader verdicts;
- distinct human, model, and agent voice keys with per-delta attribution;
- local and hosted relay implementations, with a remaining hosted ACL gap;
- raw-file Reify with an optional signed-event bundle and report;
- Stronghold-backed desktop signing and provider secrets;
- verified recursive folder/Root checkpoint causes, distinct child `advance`,
  durable operation grouping, explicit folder/Root Step, and derived Replay
  collapse;
- prepared direct MODEL operations with approval, stale-result protection,
  current file/folder text, and structured process history;
- the initial shared `@zine/trace-context` authoring-syntax kernel, compatibility
  fixtures, golden parser/compiler cases, and generated scale corpus;
- a desktop adapter for the Extend (continuation) and Settle (revision)
  operations with exact current-session manual-origin authority,
  protected-output validation, and accepted-success cleanup;
- a read-only trace-context Inspector presentation for prepared operations;
- a preregistered writing-outcome study and operational scoring rubric; and
- a preregistered narration study showing a narrow process-description effect.

Not yet built as one system: task-specific evidence selection and rendering,
cross-press manifest parity, Inspector exclusions/corrections/promotion,
persisted directive authority and durable consumption receipts, scoped memory,
durable result-to-context binding, writing-outcome evaluation, or complete
desktop/MCP operation coverage. Fixed cross-runtime folder vectors and explicit
crash-boundary real-relay recovery fixtures remain hardening work for the
recursive checkpoint cut.

## Phase 0: declare and preregister

The declaration, preregistration, and scoring artifacts are present. Keep them
aligned as implementation evidence changes; writing-outcome results do not yet
exist.

1. Make the product hierarchy explicit in README, Product, Design, Roadmap,
   Evidence, and Company: trace-aware writing is the daily loop; accountable
   teams are the first buyer wedge; signed portable trace is the substrate.
2. Record the thesis as foundational but unproven. Keep the existing narration
   result inside its narrow boundary.
3. Preregister text-only, bounded-chronological, and selected-trace writing
   conditions under equal byte budgets, including exclusions, missingness,
   privacy, stopping rules, harm gates, and claim-promotion criteria.
4. Preserve the completed recursive-zine schema cut as the foundation for
   durable context commitments. Readers, writers, recovery, fixtures, and
   Replay must continue to change together whenever that schema evolves.

Phase 0 succeeds when the documents, implementation plan, and research design
describe the same claim without presenting conviction as evidence.

## Phase 1: shared deterministic context runtime

This phase is in progress. The authoring-syntax kernel, compatibility baseline,
golden cases, and scale corpus exist; the task-specific evidence selector,
rendered manifest contract, correction/preference stores, cancellation and
quota boundaries, and desktop/MCP parity do not.

Harden the landed recursive-zine cut while building the shared runtime:

- add fixed cross-runtime folder-chain vectors to the conformance corpus;
- exercise interrupted and retried recursive checkpoints against a real relay;
- keep desktop and MCP writers on the same operation-id and `advance` rules;
  and
- keep derived roll-ups inspectable even when Replay groups them beneath their
  originating gesture.

Build a non-normative package used by every press and provider adapter:

- closed operation, evidence, correction, preference, directive, error, and
  Inspector contracts;
- deterministic validation, selection, byte budgeting, rendering, and hashes;
- a compatibility condition reproducing today's text-plus-structured-history
  behavior before selection changes it;
- exact process-fact mappings with no uncalibrated confidence scores;
- position-aware `[[…]]` protection and universal `((…))` directive grammar;
- generic authority-span input so the compiler does not invent provenance;
- golden cross-runtime fixtures and deterministic scaling corpora; and
- a null/read-only private-store capability while real encrypted stores remain
  separately reviewed.

The protocol package must not import the context package. Derived evidence,
preferences, and selector output are product interpretation, never signed
protocol truth.

Phase 1 succeeds when recursive checkpoints pass protocol and real-relay
fixtures, and desktop and MCP readers produce identical selected claims and
rendered bytes from the same context fixtures, including nil, empty, malformed,
oversized, Unicode, cancelled, and invalid-trace cases.

## Phase 2: one complete desktop vertical slice

This phase has an initial read-only dogfood slice: Extend and Settle prepare
through the shared syntax kernel, and Prompt Inspector can present the frozen
boundary. Exclusion, correction, explicit promotion, persisted authority,
durable receipts, and crash recovery are still required before the vertical
slice is complete.

Integrate Extend and Settle first because continuation and revision expose
different ways trace may help. Preserve today's Stir behavior through the new
grammar, but gate its generalized adapter separately.

- Prompt Inspector shows the exact request and, for every selected item, its
  source Step/span, scope, classification, reason, and byte cost.
- Writers can exclude evidence for one operation, correct it, explicitly
  promote an inert directive, and inspect conflicts before dispatch.
- `[[…]]` is absolute protected data. `((…))` is one-shot, local-author
  instruction authority that disappears only after accepted success.
- A local origin sidecar distinguishes manual typing and explicit promotion
  from paste, import, filesystem, MODEL, other-author, mixed, or unknown bytes
  without changing the wire format.
- File-local memory may dogfood only with explicit creation, correction,
  forgetting, conflict blocking, and a text/trace condition that can disable it.
- Preparation, approval, provider dispatch, result review, compare-and-set
  application, consumption receipts, and cleanup are idempotent and recoverable.

Disposable local envelopes are allowed for dogfood. They must not be described
as final protocol binding or generally released private storage.

## Phase 3: durable binding and outcome evidence

After the trust/schema review:

- bind every accepted MODEL Step to the exact approved context manifest,
  prepared request, provider configuration, attempt, and result;
- keep private payloads local by default behind fresh salted
  selective-disclosure commitments and profile-keyed local deduplication;
- add consented, local-first outcome capture with export and redaction;
- run the preregistered text-only, bounded-history, and selected-trace study
  across multiple model families and real writing tasks; and
- require representative low-end-device latency budgets before general release.

Promotion requires a preregistered benefit for at least one initial operation,
no material-harm boundary crossed for the other, inspectable correction, and no
critical privacy or recovery gap. Evidence may narrow the thesis by operation,
trace age, model, task, or selector—not retroactively redefine the outcome.

## Phase 4: generalize operations and presses

Extend the universal grammar only through operation-specific adapters and
fixtures:

- Stir, Reply, Analyze, cumulative Continue, and Run each define target/source
  range, prompt placement, result shape, one-shot consumption, capability
  ceiling, Inspector representation, and crash recovery;
- Reply and Analyze use journaled source/result commit groups;
- Run directives never grant filesystem, network, or tool authority outside
  the separately approved Run policy;
- provider adapters pass the same context-manifest contract suite; and
- MCP consumes the shared package, with retention and encrypted profile stores
  blocked on their own key-management review.

Multi-AI task and correspondence work belongs here as a family of trace-aware
operations and handoffs, not as a product center separate from writing.

## Phase 5: longitudinal scoped learning

File-local memory must first beat selected trace without memory in a separate
preregistered longitudinal comparison. Observational use is insufficient.

Only then add:

- folder-subtree and user scopes;
- explicit upward promotion and no automatic scope widening;
- conflict display, expiry/review, revocation, and tombstones;
- copy, move, restore, reparenting, and orphan semantics; and
- proposals derived from repeated evidence, always requiring approval.

Enter only when memory improves later writing without unacceptable
over-personalization, correction burden, latency, or privacy cost.

## Phase 6: operate the paid team layer

Built when accountable teams repeatedly use the writing and evidence loop and
ask to pay for operational outcomes:

- managed always-on remotes with backup, retention, and a declared SLA;
- organization keys, writers, peers, and ACL administration;
- reviewer access, verification links, and evidence-export workflows;
- managed anchoring and proof retention; and
- reliability instrumentation for the hosted service.

Self-hosted presses and compatible relays remain complete alternatives.

## Phase 7: calibration and network, only on evidence

Interpretation may use an explicit opt-in corpus with declared population,
sampling, retention, false-positive, and false-negative behavior. The protocol
continues to carry evidence and never promotes a model score into proof of
humanness.

Global rendezvous remains frozen beyond maintenance and security fixes until
real sent citations produce organic co-citation matches, users ask to meet
unknown co-citers, and the value outweighs privacy and abuse costs.

## Not on the roadmap

- Claims that trace-aware context improves writing before the outcome study.
- Hidden personalization or automatic promotion from file to folder/user scope.
- More protocol fields merely to encode product inference.
- New tool authority granted by document text.
- More DHT design before real co-citation density.
- A proprietary relay requirement or mandatory account for local writing.
- Claims that timing or revision shape proves a human author.

## How we measure progress

- blind or counterbalanced writer preference;
- edits and time required to reach an acceptable result;
- preservation of declared intent, protected text, and structure;
- recurrence of explicitly rejected directions and later reversion;
- successful inspection, exclusion, correction, and forgetting;
- latency, token use, provider cost, and privacy burden;
- repeated real writing across operations and model families;
- named teams tracing durable artifacts and returning over four weeks;
- proof reports opened by external reviewers; and
- review questions answered with trace evidence that ordinary files plus
  provider logs could not supply.

None of these product outcomes is claimed yet. Their state lives in the
[evidence ledger](EVIDENCE.md).
<!-- zine-about-copy:roadmap:end -->
<!-- zine-about-copy:company:start -->
# Company

Zine's protocol and presses are open source, and self-hosting is a complete
path, not a trial. This page explains how an optional paid layer can exist
without compromising that — and what stays free no matter what. No paid
service is shipping today.

The product has two coupled value layers. Trace-aware assistance should give a
writer a reason to use Zine every day. Portable accountability gives teams a
reason to standardize, administer, retain, and potentially pay. Neither demand
nor willingness to pay has been demonstrated yet.

## The framing

Zine separates local writing intelligence and history from hosted coordination
the way Git separates a repository from a remote. The protocol and local
trace-aware press are the commons. A company can sell the operational layer
that teams want, but neither the wire nor the daily writing loop requires it.

In that analogy Zine is the Git, and an optional managed service can play the
GitHub role: durable coordination, organization controls, review, and
distribution around a portable open format.

> Everyone runs their own press. The company is where presses meet.

This is compatible with sovereignty because the paid layer is optional. A
press can write to its local relay, self-host a remote, and verify events
without phoning home.

There is one service sovereignty structurally cannot self-provide:
**independent witness**. A sovereign press can author, sign, store, and verify
its own work, but a press-signed record of a model call is still the
operator's assertion. A neutral party can witness request/response commitments
in a transparency log, sign open-weight inference it actually executed, or
host the no-install verifier where a shared proof opens in a reader's browser.
The protocol makes writing sovereign; the company makes reading trustworthy.

For organizations, the same boundary separates what is sold from what is
never taken: record custody, not key custody. An organization gets relay
custody of everything published to it, its own countersigning attestation
over work it stands behind, and ACL-based offboarding. Author keys remain
personal and are never escrowed.

## What is open, what is paid

| Always open | Optional paid layer |
|---|---|
| Signed trace events and verification rules | Managed always-on remote with backups and SLA |
| Local trace-context compiler, inspection, and BYOK model use | Organization context policy, retention, and review administration |
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
| Press-signed model-call records are operator assertions | Independent witness: transparency-log inclusion proofs and attested open-weight inference | Not implemented; the operation records reserve the countersignature seam |

## How pricing would work

The free product includes everything required to author with local trace
context, self-host, and verify a trace. Paid plans charge for operational
outcomes:

- availability and durable retention;
- organization identity and access administration;
- policy, review, and evidence-export workflows;
- managed anchoring and proof maintenance;
- support and deployment assurance; and
- calibrated interpretation built from an opt-in, consented corpus.

The first paid conversion should come from a team already receiving daily value
from the writing loop and asking for reliable remote operation, organization
control, context-policy administration, or review evidence. Charging for the
local compiler/press, hiding selection behind a service, or making verification
depend on a proprietary endpoint would weaken the thesis rather than strengthen
the business.

## Why openness is the strategy

Cryptographic primitives and relay storage are not what makes this durable.
If the company earns a lasting position, it compounds in this order:

1. Repeated use because trace-aware AI collaboration improves real writing.
2. Integration into durable agent-to-artifact workflows.
3. A growing corpus of portable, independently verifiable traces.
4. Review and organization workflows that make the evidence useful.
5. A consented dataset for calibrated process interpretation.
6. A network of authors, reviewers, and citations, if density emerges.

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
- Author keys are never escrowed or organization-owned; organizations receive
  record custody and countersignature, never key custody.
- The press does not require a company account to create or verify core
  trace events.

## What would prove us wrong

The strategy fails if teams do not care enough about agent-written artifacts
to change their workflow, if ordinary version control plus model logs answer
the review question well enough, or if reviewers will not open a shared
proof. The daily-use thesis also fails or narrows if selected trace does not
improve measured writing outcomes over text-only and bounded-history controls,
or if privacy, correction burden, latency, and over-personalization outweigh
the benefit. The network thesis fails if real corpora do not produce useful
co-citations.

The [roadmap](ROADMAP.md) sequences the work so those questions are answered
before the expensive layers are built.
<!-- zine-about-copy:company:end -->
