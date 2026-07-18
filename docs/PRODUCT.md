# Product

Zine records how a file or folder was actually made—by people, by models, or
both—as signed, replayable history. A **zine** is that stably identified file or
folder together with its trace; the **Root zine** is the topmost folder. Zine
uses the trace to help the next act of writing, not only the later audit. This
page explains the daily loop, initial buyer, and evidence still required. The
accepted migration is collected in
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

## Who it serves

Three roles meet in every zine:

- **The writer**—a person, an agent, or both interleaved—who wants the AI to
  respond to the work's actual trajectory rather than its latest text alone.
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
this is text plus trace; at folder or Root scope it is a content tree plus
trace. “Better” must be measured through writer preference, editing required
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
- **Files and folders are zines.** Root is the topmost folder zine; replay and
  publication follow the selected recursive scope.
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
