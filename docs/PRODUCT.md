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

1. Connect the MCP press to a folder trace and relay.
2. The press mints a distinct key for the agent; it never imports yours.
3. The agent Steps file states under its own key, preserving full snapshots
   and trace lineage.
4. It Sends an exact stepped version when the work is ready for someone else
   to fetch.
5. The author may later Attest a sent version to stand behind it.
6. Anyone with access fetches nodes or history to inspect the record.

The desktop press is the reference interface for authoring and review. Its
native model operations also record each call's prompt, model configuration,
and cited context. Two pieces come next on the [roadmap](ROADMAP.md): carrying
that same call metadata on MCP-authored steps, and a no-install verification
report a reviewer can open in a browser.

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
Step, Send, Attest, Mint, Cite, fork, and merge — work today, and the
[evidence ledger](EVIDENCE.md) records exactly what is implemented, what has
been measured, and what remains unproven. Hosted services, proof reports, and
the network layer are sequenced behind evidence, not dates; the
[roadmap](ROADMAP.md) names the proof that unlocks each phase.

What matters most right now is deliberately narrow: teams tracing real
agent-written artifacts every week, and a proof record that answers a review
or dispute question ordinary file history could not. If Zine cannot earn
that, nothing later on the roadmap deserves to be built.
