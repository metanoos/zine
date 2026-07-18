# Zine

**Trace-native writing for people and AI.**

AI usually receives the text as it stands. A collaborator would also want to
know how the text got there: what was attempted, removed, restored, protected,
accepted, or repeatedly revised. Final text is a lossy summary of writing.

Zine's foundational bet is that an AI can help you write better when it receives
the current text plus a bounded, inspectable account of its trace—not text
alone. That is a product thesis under active evaluation, not a proven claim.

Zine records the process at the point of writing. Each deliberate checkpoint
is a signed, self-contained **trace** that can be replayed, cited, forked, and
verified without trusting one editor or hosted account. Human and model voices
remain visible. Draft checkpoints stay local until their author sends them.

The same trace serves two jobs. During writing, it can give an AI relevant
process context that the finished prose no longer contains. Later, it can give
people inspectable evidence of what the AI saw, changed, and contributed.

Zine is to authorship provenance what Git is to source history: the open
protocol and local press are the commons; durable remotes, team controls,
verification, and research can be services around them. Self-hosting remains
first-class.

The reference press is open source and BYOK. Model calls use provider
credentials the operator controls; local authoring does not require a Zine
account or hosted service.

## Write with the trace

The daily loop Zine is building is:

```text
current text + selected trace evidence
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

Context must remain bounded, task-specific, and visible before dispatch. A
writer should be able to see which Step, edit, preference, or correction was
selected, exclude it for one operation, and correct durable memory. Derived
preferences are never protocol truth.

Zine's document grammar makes intent explicit. `[[ protected words ]]` are
verbatim, inert text that an eligible transformation must preserve.
`(( author directive ))` is intended as a one-shot instruction to the selected
AI operation: it is removed only after accepted success and cannot grant tools
or access outside that operation's approved scope. The initial shared syntax
kernel and desktop Extend/Settle adapter now enforce exact operation ranges,
protected bytes, and current-editor-session manual-author authority. This is a
deliberately partial slice: Stir still uses its earlier grammar, other
operations are not generalized, and explicit promotion, persisted authority,
durable consumption receipts, shared evidence selection, scoped memory, and
result-to-context binding remain roadmap work.

## Start with accountable agents

The first product wedge is teams that let AI agents edit durable files such as
reports, research, policies, and editorial work. When the result matters, a
reviewer should be able to answer:

- Which agent key made each change?
- Which exact file states and changes did that key sign?
- Which version was opened for discussion, and which version was endorsed?
- Can another party inspect the evidence without access to the original app?

That remains the initial buyer wedge: accountability gives a team a concrete
reason to adopt the trace while the trace-aware writing loop supplies daily
value. Customer discovery and writing-outcome evaluation run alongside the
pivot. Managed services and network layers remain evidence-gated.

Native model operations in the desktop press can also record the prompt,
model configuration, and cited context. Threading equivalent harness-supplied
metadata through MCP Steps is roadmap work.

The [headless MCP press](apps/mcp/README.md) lets an MCP-capable agent write
through Zine under its own key. The [desktop press](apps/client/README.md) is
the reference authoring and review experience.

Each named headless profile owns one permanent Root; no source folder or live
relay is required. Offline Steps persist as exact signed events and synchronize
to the loopback home later. LLMs consume the raw trace directly, while a Send
can return a locator for the desktop to verify and render for a human.

Read the [documentation hub](docs/README.md), or go directly to the
[product](docs/PRODUCT.md), [protocol tour](docs/PROTOCOL.md),
[evidence ledger](docs/EVIDENCE.md), [product roadmap](docs/ROADMAP.md), and
[protocol/company boundary](docs/COMPANY.md).

## Three author gestures

**Step** signs a deliberate checkpoint and keeps it on the home relay. Most
Steps remain private working history.

**Send** makes one exact stepped version reachable for discussion.

**Attest** is an optional, later endorsement of one sent version. Discussion
is common; commitment is rare.

Copied passages can be minted as immutable **coins** and cited by exact node
id. Forking starts a proposal under a new owner's key; merging accepts chosen
work into the receiving owner's chain.

## What exists today

| Capability | Status |
|---|---|
| Desktop press with a local relay sidecar | Implemented |
| Headless MCP press with a distinct agent voice | Implemented |
| Mandatory replay-valid KEdit process log on every file Step | Implemented for editor, AI, import/fork, and MCP write paths |
| Shared `FULL TRACE` / `SNAPSHOT ONLY` / `INVALID` reader verdict | Implemented in Replay, Analyze, handoff, Reify, and MCP inspection |
| Step, Send, Attest, Mint, Cite, fork, merge, and replay | Implemented and covered by tests; the core gestures also have a real-relay smoke |
| Top-level foreign-file fork-on-write | Implemented; recursive nested-folder fork-on-write is deferred |
| Mutual-peer co-citation and process-evidence vet | Implemented and tested; calibration needs real corpora |
| Raw-file Reify export with an optional signed-event bundle | Implemented on desktop |
| Stronghold storage for signing and provider secrets | Implemented on desktop; the browser remains read-only |
| Shared trace-context authoring-syntax kernel | Initial deterministic `[[…]]` / `((…))` scanner and compiler implemented with golden and generated scale corpora; task-specific evidence selection and cross-press rendering are not yet implemented |
| Prepared desktop MODEL operations with explicit approval | Implemented for direct single-shot gestures; Extend and Settle now use the shared syntax kernel, exact current-session authority spans, protected-output validation, and accepted-success directive cleanup, while the other operations, durable receipts, and context binding remain deferred |
| Hosted relay | Implemented; an operator ACL equivalent to the local relay policy remains a gap |
| Global content-hash rendezvous over Kademlia | Specified as a sketch, not implemented |
| Managed remote, organization control plane, and no-install public verifier | Commercial product hypotheses, not shipping services |

The complete evidence and limitation record lives in
[docs/EVIDENCE.md](docs/EVIDENCE.md). Protocol status words have exact meanings
in the [protocol index](protocol/README.md).

## Quickstart

```sh
git clone https://github.com/metanoos/zine.git && cd zine
npm run dev
```

The script checks prerequisites, builds the relay sidecar, synchronizes client
dependencies when the npm manifests change, and launches the Tauri app. Later
runs skip current dependencies and relay builds.

**Prerequisites:** [Go](https://go.dev/dl/) >= 1.25,
[Node 24 LTS](https://nodejs.org/), and [Rust](https://rustup.rs/) stable. On
macOS run `xcode-select --install` first; for other platforms see the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

**Tor is optional.** It is needed only for inbound peer reachability over onion
services. Local authoring and clearnet publishing work without it. Install it
later with `brew install tor` on macOS or `apt install tor` on Linux.

For production bundles, see the
[client release guide](apps/client/README.md#release-builds). There is no
cross-platform release matrix yet.

## How the system is divided

A **press** is an authoring interface, not a server. Every press writes to its
own relay, including the quiet relay on an author's machine. A shared or
managed relay is optional.

The wire format uses Nostr events over local and configured remote WebSocket
relays. Checkpoints use SHA-256 ids and Schnorr signatures. Tor can expose a
private relay. The protocol is draft and unpublished; kind and tag numbers are
still provisional.

```text
human or agent
      |
      v
desktop press or MCP press
      |
      v
signed trace checkpoints  ---> optional remote relay
      |
      +--------------------> replay, citation, verification
```

For normative mechanics, use the [protocol documentation](protocol/README.md).
Its index assigns authority by domain; if a product document disagrees with an
owning specification, the specification wins.

## Repository layout

```text
/
├── packages/protocol/              shared TypeScript protocol kernel and fixed conformance corpus
├── packages/trace-context/         non-normative trace-context syntax kernel and deterministic corpora
├── docs/                          reader-facing product, protocol, evidence, roadmap, and company
├── protocol/                      trace, transport, and rendezvous specifications
├── relay/                         Go relay, local sidecar, and hosted peer
├── scripts/                       development, diagnostics, and verification orchestration
├── Dockerfile, docker-compose.yml hosted relay plus browser client
├── research/                      narration study and raw outputs
└── apps/
    ├── client/                    React/Tauri desktop press and read-only browser build
    └── mcp/                       headless MCP press
```

## Documentation map

- [Documentation hub](docs/README.md): the five reader-facing documents shared
  by the repository and the app's About view.
- [Product](docs/PRODUCT.md): initial buyer, workflow, and product boundary.
- [Protocol](docs/PROTOCOL.md): readable tour of traces, gestures,
  attribution, transport, and vetting.
- [Evidence](docs/EVIDENCE.md): what is implemented, measured, asserted, and
  still unknown.
- [Roadmap](docs/ROADMAP.md): the trace-context runtime, complete desktop loop,
  outcome evidence, and later team/network gates.
- [Company](docs/COMPANY.md): how an open sovereign protocol can support a
  commercial service without making the press dependent on it.
- [Protocol specifications](protocol/README.md): normative authority and status
  language for trace provenance, transport, and rendezvous.
- [Client development and releases](apps/client/README.md): frontend, Tauri,
  and per-platform bundle commands.
- [Headless MCP press](apps/mcp/README.md): tools, installation, and client
  configuration.
- [Deferred fork-on-write work](apps/client/FORK-ON-WRITE.md): the known nested
  ownership gap and implementation plan.
- Narration study: [pre-registration](research/narration-rubric.md) and
  [results](research/results.md), with raw model outputs preserved alongside
  them. The broader writing-outcome preregistration lives at
  [research/trace-writing-preregistration.md](research/trace-writing-preregistration.md).

## Working in this codebase

Verify behavior against the real system: run the relay, sign events, inspect
the SQLite rows, and exercise the client. Compilation and mocked tests are not
enough for provenance, storage, or networking changes.

```sh
npm run doctor         # prerequisites and local artifact diagnostics
npm run check          # dev scripts, client types/tests, MCP, relay, and Rust
npm run verify         # check + client build + isolated real-relay smoke
npm run verify:relay   # Step/Send/Attest/Mint/Cite against temporary relays
```

`verify:relay` uses temporary ACL-protected relay databases and random ports.
It does not touch `~/.tracer`, checked-in `data/`, or a running desktop
sidecar.
