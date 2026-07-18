# Product

**Trace-native writing for people and AI.**

AI usually receives the text as it stands. A collaborator would also want to
know how the text got there: what was attempted, removed, restored, protected,
accepted, or repeatedly revised. Zine is built around the simple asymmetry
underneath that loss: a complete trace can always be narrowed later, but
finished text can never recover the process that produced it.

A **zine** is a file or folder together with its signed **trace**. The trace
serves two jobs. During writing, it can give an AI relevant process context
that the current draft no longer contains. Later, it can give another person
inspectable evidence of what the AI saw, changed, and contributed. Zine
records the process once so it can improve the next act of writing and remain
useful when the work leaves the editor.

## The missing half of writing

Current content is a lossy summary of writing. A file preserves the text that
survived; a folder preserves the current tree. Neither alone preserves the
direction that was abandoned, the phrase repeatedly repaired, the passage a
writer protected, the source an agent used, or the proposal the writer
rejected.

Version history is the closest substitute, and the kinship is deliberate:
Zine is to authorship provenance what Git is to source history. But a commit
is the wrong resolution for writing. It records that bytes changed between
two chosen moments; everything between them collapses into one diff, and the
diff cannot say which voice — person or model — produced each span, what
context an agent received, or what was tried and rejected along the way. Git
answers *what changed*. Evaluating AI-assisted writing needs *how it was
written*.

The other substitutes answer still narrower questions. Model observability
records calls, not the artifact versions those calls changed. Final-text
detectors guess from prose after the fact. A hosted editor may retain more,
but asks the reviewer to trust the platform holding the history. None joins
the artifact, the process that changed it, and the exact version later shared
or endorsed into one portable record.

Zine captures signed process evidence at the point of writing. It offers
evidence, not a verdict: it does not prove that a writer is human, that a
claim is true, that an attribution is independent, or that a work deserves
trust. It lets a reader inspect what the available record actually supports.

The review side compresses to one line: **evaluate the writer, not just the
writing.** As AI makes polished prose easier to produce, more of what
distinguishes a writer moves into the process — what they asked for, rejected,
protected, sourced, and rewrote.

## Write with the trace

Zine's foundational bet is that an AI given current scoped content plus
relevant process evidence will collaborate better than an AI given current
content alone. At file scope that is text plus trace; at folder or Root scope
it is the recursive content tree plus trace. The bet is under active
evaluation, not a demonstrated claim: success means better writer preference,
less editing and time before acceptance, stronger preservation of intent, and
fewer repeated rejected directions — not a persuasive demo. The
[Evidence](EVIDENCE.md) ledger keeps that line honest.

```text
current scoped content + selected trace evidence
                  |
                  v
        inspect and correct context
                  |
                  v
             ask the AI
                  |
                  v
       accept, revise, or reject in-text
                  |
                  v
          extend the signed trace
```

The loop's rules are strict. Context stays bounded, task-specific, and
visible before dispatch: the writer sees the literal request and each
selected Step, edit, correction, or preference with its source and scope, can
exclude any of it for one operation, and can correct durable memory. A stale
result never silently overwrites newer work. Selection and memory are product
interpretation, never protocol truth — the signed trace stays useful to a
reader who chooses a different interpretation, or no AI at all.

Two textual forms make intent explicit inside the draft. `[[ protected
words ]]` are inert, verbatim text that an eligible transformation must
preserve. `(( author directive ))` is a one-shot instruction to the selected
operation: it is removed only after accepted success and cannot grant tools
or access outside that operation's approved scope. A shared syntax kernel and
the first desktop operations already enforce exact operation ranges,
protected bytes, and current-session author authority; the complete selector,
exclusion and correction surface, scoped memory, and durable context binding
are sequenced in the [Roadmap](ROADMAP.md).

## Three deliberate gestures

**Step** checkpoints the selected file, folder, or Root under its owner's key
and keeps it on the home relay. Most Steps remain private working history. A
folder Step pins one exact recursive frontier; automatic ancestor roll-ups
stay signed, derived, and beneath the deliberate gesture.

**Publish** makes one exact stepped version reachable for discussion. (The
wire and today's implementation still spell this gesture `Send` until the
coordinated schema cut.)

**Attest** is an optional, later endorsement of one published version.
Discussion is common; commitment is rare.

Keeping the gestures separate keeps intent legible: editing is not
publishing, and publishing is not endorsement. Forking begins a proposal
under a new owner's key; merging accepts chosen work into the receiving
owner's trace. The same seams serve a person revising model output, an agent
quoting a source, and a collaborator proposing changes across a folder.

Citation is neutral composition. Provenance-aware copy may cite any exact
stepped source without minting or endorsing it, including a source the writer
disagrees with. Mint is a separate compound gesture — genesis Step, Publish,
and same-minter Attest — that creates a Coin and says the passage carries
salience for the minter.

## Every writer gets a press

A **press** is an authoring interface, not a server. Every press holds its
own keys and writes to its own relay, including the quiet relay on an
author's machine; self-hosting is the default, not a fallback. Separate keys
own the relay, sign the writing, and mark AI edits, so rotating a pen never
changes who owns the node. The relay's key can derive a stable `.onion`
address, so a laptop can serve its published work without a server, and a
private, never-published ACL decides who may connect, read, or write.
Reachability degrades before identity ever does: lose Tor and you lose
metadata privacy, never your name.

```text
person or agent
      |
      v
sovereign press + distinct voice key
      |
      v
signed file and folder trace
      |
      +-----------------> local replay and later AI context
      |
      +-----------------> optional publication and review
```

The desktop press is the human writing, replay, and interpretation surface.
The headless MCP press lets an MCP-capable agent make the same gestures under
its own voice key: each named profile owns one permanent Root, Steps offline
as exact signed events, synchronizes them later, and hands off a portable
locator that an LLM can consume raw and the desktop can verify and render for
a person.

Model calls use provider credentials the operator controls. Local authoring
requires no Zine account, source folder, live remote, or company key custody.

## Sovereign by key, connected by citation

Zine is peer-to-peer in the plainest sense: no platform sits between writers.
A **coin** is how strangers find each other. When a phrase strikes you as
worth keeping, you mint it: one deliberate gesture that Steps an immutable,
single-checkpoint zine under your key, Publishes it, and Attests it. Minting
claims salience, not authorship or agreement: *these words carry currency for
me.* When Coins are enabled, Zine indexes published citations to valid Coins
to answer one question — *which published traces cite these words?* — so two
writers who share no platform, relay, or peer can surface each other, even
when their coin bytes differ only in Unicode normalization or whitespace. The
same valid-Coin match also works, more slowly, through a mutual peer who can
read both chains.

The economics are deliberately spam-resistant. A coin everyone holds carries
no signal, so there is no payoff in squatting the popular phrase; the signal
is several independently shared, moderately rare coins, and raw supply never
becomes reputation. A match is only an introduction, never a connection or a
reputation score: you and your AI read the stranger's published zines — the
writing and the trace behind it — and decide whether the resonance is real.
If it isn't, swipe left. The vet reads process, not prose: fluent text is
easy to imitate, while a timestamped revision history is costlier to fake.
Nothing enters your peer list without that vet and your explicit choice.

Coins are the single user-facing discovery opt-in: enabling them covers Mint,
valid-Coin Publish-side indexing, and both mutual-peer and global Coin
rendezvous. Ordinary citation remains available without Coins. Mint and the
process vet work today. Publish-side indexing is being implemented, mutual-peer
matching must still be narrowed to valid Coins, the Kademlia routing component
for global rendezvous remains under implementation, and no public bootstrap
network is operated. The [Protocol](PROTOCOL.md#rendezvous--vetting) carries
the exact mechanics and limits.

## One trace, three readers

Three roles meet in the same record:

| Role | What the trace makes possible |
|---|---|
| **Writer** — a person, an agent, or both interleaved | Give the AI the work's relevant trajectory, while keeping context inspectable and correctable |
| **Accountable team** — the people responsible for durable AI-written work | See which key acted, what context was used, which file states changed, and which version entered review |
| **Reviewer** — often elsewhere and later | Inspect portable evidence without the original model session, authoring app, or Zine service |

Zine is individual-first. One writer with a sovereign press gets the complete
product — trace-aware assistance, replay, and portable proof — with no hosted
account, organization, or managed service. If adoption compounds, it should
compound the way Git's did: writers first, organizations following the
writers.

AI-assisted writing is the product center, and the lasting advantage lives at
the boundaries. Inside a single editor, any platform can eventually log enough
to imitate trace-aware context. The moment work crosses a boundary — from one
model provider to another, from writer to reviewer, from this session to a
postmortem months later — a proprietary log stops traveling, and a signed,
portable, provider-neutral record is the only context that survives. That is
why multi-AI correspondence stays a writing workflow inside Zine rather than
becoming a separate chat product.

Accountable teams are the initial buyer wedge. Organizations letting agents
edit durable reports, research, policy, or editorial work have an immediate
reason to care how a result was produced, and those artifacts are natural
first cases because they outlive the model session and are reviewed somewhere
else. Reliable remotes, organization controls, review workflows, and evidence
exports are the candidate paid layer around the open press; the
[Company](COMPANY.md) page draws that line.

## The product boundary

- **Evidence, not verdicts.** Preserve checkable claims and state their limits.
- **Trace is useful during writing.** Process context is a collaboration input,
  not merely an audit attachment.
- **Files and folders are zines.** The product follows the scope of the work,
  not a separate project abstraction.
- **Inspectable AI context.** Writers see, correct, and approve what Zine sends.
- **Private by default.** Step is local; Publish changes reachability; Attest is
  a separate commitment.
- **One owner per trace.** Cross-author work joins through explicit fork and
  merge seams.
- **Protocol before platform lock-in.** Files, keys, and signed events remain
  usable outside one service.
- **Progressive disclosure.** A writer can understand the gesture before
  learning tags, relay policy, or transport details.

These are constraints, not positioning garnish. A hidden selector, mandatory
account, proprietary verifier, organization-owned author key, or claim to
prove humanness would weaken the product even if it made one workflow easier
to sell.

## What exists, and what remains to prove

The desktop press, headless MCP press, local relay, recursive file and folder
traces, and the complete gesture set — Step, Publish, Attest, Mint, Cite,
fork, merge, replay, and Reify export — work today. The first shared
authoring-syntax kernel and prepared desktop model operations also exist, but
the task-specific selector, correction and memory model, durable context
binding, and cross-press rendering contract do not yet operate as one system.

Three proofs govern what comes next:

1. **Daily-use proof:** selected, inspectable trace improves real writing over
   text-only and equal-budget history controls.
2. **Buyer proof:** accountable teams use the evidence to answer consequential
   questions, return to the workflow, and show willingness to pay for the
   operational layer.
3. **Network proof:** real published citations create enough useful
   co-citation density to justify operating and expanding discovery.

The first two are the immediate product gates; the third stays downstream of
real use.

For the machinery, read the [Protocol](PROTOCOL.md) tour. The
[Evidence](EVIDENCE.md) ledger separates working software from demonstrated
outcomes, the [Roadmap](ROADMAP.md) sequences the open work, and
[Company](COMPANY.md) draws the line between the open press and a possible
paid service. The complete accepted direction lives in
[Trace-Native Zines](TRACE_NATIVE_ZINES.md).
