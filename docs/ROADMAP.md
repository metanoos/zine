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
- Step, Publish (wire name Send), Attest, Mint, Cite, fork, merge, and replay;
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
real published citations produce organic co-citation matches, users ask to meet
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
