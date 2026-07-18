# Trace-Native Zines

Status: accepted product and architecture direction, 2026-07-17. The recursive
file/folder ontology and folder-checkpoint causality are specified in
[`protocol/trace-provenance.md`](../protocol/trace-provenance.md). The remaining
items are the coordinated pre-product migration target until their owning
specifications, readers, writers, fixtures, and tests change together. No
legacy compatibility layer is required.

## Thesis

AI should assist a writer from the current zine **and the trace that produced
it**, not from isolated text alone. Final text or a current file tree has
discarded rejected paths, revisions, attention, source use, directives, model
calls, and decisions about proposed work.

The file case is text plus trace. The general case is:

> A zine is a stably identified file or folder together with its complete
> scoped trace.

The reference product is a **press** named **Zine**. It produces file zines,
folder zines, Root zines, editions, and coins. There is no separate project
object: Root is the topmost folder zine.

This is a founder-conviction pivot accompanied by evidence gathering, not a
claim already proved. The confirmatory comparison is the same writing task
under text-only, bounded-history, and selected-trace context while holding
other Zine-controlled variables constant.

## Vocabulary

| Term | Meaning |
|---|---|
| **Content** | A file's canonical UTF-8 Markdown, or a folder's ordered direct-child manifest. |
| **Trace** | The append-only, causally ordered provenance and process log belonging to one stable zine identity. |
| **Zine** | One file or folder body together with its complete scoped trace. |
| **File zine** | A Markdown leaf and the trace that produced it. |
| **Folder zine** | A recursively composed child manifest plus structural, descendant, and interaction trace. |
| **Root zine** | The topmost folder zine owned by a press profile. Root is a folder, not a project abstraction. |
| **Press** | An application that creates zines and mints coins. The reference press is named **Zine**. |
| **Checkpoint** | Any signed durable `TraceNode`, whether explicit or derived. |
| **Step** | A deliberate checkpoint gesture. “Signed checkpoint” is its explanatory gloss; the product term remains Step, not Save. |
| **Sign** | Cryptographic authentication of a record, not a user-facing publication gesture. |
| **Publish** | Accepted migration term for making an immutable edition and its complete trace prefix publicly reachable. It replaces **Send** at the coordinated schema cut. |
| **Edition** | One immutable publication pinned to an exact file, folder, or Root Step and recursive trace frontier. |
| **Attest** | Append a signed stance meaning “I stand behind this exact edition or coin.” It does not change the target. |
| **Withdraw** | Append a signed change of stance without erasing an earlier attestation. |
| **Coin** | One minter's immutable text instance, signed by one key, published, and attested. |
| **Coin type** | The exact-text category of which coins are instances, keyed by exact content hash `x`. |
| **Supply** | The collection/count of valid, non-withdrawn coins of one coin type. |
| **Mint** | The explicit atomic Step + Publish + Attest operation that creates one coin. |

## Recursive zines

```text
Root zine
├── Folder zine
│   ├── Markdown file zine
│   └── Folder zine
│       └── Markdown file zine
└── Markdown file zine
```

Identity belongs to the file or folder trace, never its current path. Rename
and move preserve identity. A folder snapshot names only immediate members and
their exact heads; recursive traversal supplies the subtree. Implementations
may share and deduplicate physical blocks, but the logical folder zine includes
the complete scoped history needed to replay its subtree.

A folder replay reconstructs:

- file and folder creation, removal, rename, move, restoration, fork, and merge;
- descendant file edits and exact child Step frontiers;
- cross-file attention, source use, searches, panels, and model operations; and
- the tree as it existed at every checkpoint, including historically removed
  material required by the replay.

A scoped trace is a projection over signed events, membership history, and
direct evidence references—not a duplicated log stored separately at every
ancestor. Events are physically stored once where possible.

## Checkpoint causality

The press distinguishes three user-relevant checkpoint causes:

- **explicit Step** — the writer deliberately checkpoints a file, folder, or
  Root;
- **structure change** — a direct child is added, removed, renamed, or moved;
  and
- **child advance** — an automatic roll-up because a direct child's head
  changed.

Stepping a leaf therefore advances its recursive frontier:

```text
explicit file Step
  └── derived containing-folder checkpoint
       └── derived ancestor checkpoint
            └── derived Root checkpoint
```

The derived checkpoints are verifiable but are not presented as independent
author gestures. They share an operation id with their cause and are collapsed
beneath that cause in ordinary replay.

An explicit folder or Root Step means “checkpoint this exact subtree now.” The
press first durably checkpoints dirty descendants, propagates their heads, and
then appends one explicit checkpoint to the selected folder even when its
frontier was already current. Failure must remain recoverable and visible; a
partial cascade must never be presented as one complete folder Step.

Moving across parents produces source removal, target addition, and ancestor
advances under one transaction identity. Adding a new child and advancing an
existing child are different facts; an existing child head must never be
encoded as another `add`.

## Privacy and publication

The working zine and its trace remain private until Publish. The two explicit
pre-publication disclosure boundaries are:

- a writer-approved provider dispatch, whose exact context goes to the named
  provider and enters the trace; and
- Mint, which atomically publishes the selected text as a coin.

There is no private AI-operation mode and no selective omission from a
published trace. The writer learns this during onboarding, sees an ambient
reminder near AI and publication controls, inspects the exact prepared context
before dispatch, and reviews the complete local bundle before publication.

Publication scope follows zine scope:

- publishing a file edition exposes that file's complete trace and direct
  evidence closure, not unrelated siblings;
- publishing a folder edition exposes the recursive subtree and trace frontier
  pinned by its Step; and
- publishing Root exposes the entire Root frontier.

Complete folder history may require historical children that are no longer in
the current tree. The disclosure manifest must enumerate current and historical
closure before confirmation. Deleting text or moving a child does not delete
its prior trace. If an unpublished lineage contains material that cannot be
disclosed, the writer may abandon it and begin a new lineage; the press must
never present a selectively cleaned history as complete.

Credentials, authorization headers, signing or encryption keys, and unrelated
application internals are never trace content. Diagnostics are content-free by
default; content-bearing support export requires separate confirmation.

## Markdown and inline grammar

File zines use versioned CommonMark with an explicit supported GFM profile.
Markdown bytes remain authoritative; rendered views are projections under a
versioned renderer. Folder zines compose Markdown file zines through their
manifest rather than concatenating their text into one synthetic document.

An intentional highlight is authored as protected data:

```text
[[important passage]]
```

The brackets survive storage, copying, replay, and interchange. Model
operations preserve the protected bytes. Bracketing, quoting, copying,
pasting, selecting, and including text in model context never mint
automatically. Only explicit Mint resolves the span:

```text
[[important passage | coinId]]
```

`((…))` is a one-shot instruction candidate for the interpreting AI. An
authorized directive is removed from quoted data, placed in the author
directive section, and carries its exact source position and structural
Markdown neighborhood. The operation's explicit target remains the only
editable scope.

`[[…]]` regions are opaque. Directives cannot nest inside them, and crossing or
nested delimiters are malformed in V1. Every directive has an inspectable
lifecycle: active, inert with reason, reserved, spent, consumed,
cleanup-needed, malformed, or revoked. A writing directive is consumed only
after the writer accepts some result.

## Full Trace V1

“Complete trace” means complete under a declared capture profile, zine scope,
and lineage. It does not mean the press observed private thought, activity in
other applications, or an abandoned lineage.

`FULL TRACE V1` includes:

- every text mutation and transaction boundary, including undo and redo;
- timing sufficient to replay editing cadence;
- paste, import, external writes, and known internal-copy provenance;
- file and folder structure, identity-preserving move, fork, and merge;
- explicit Steps, structural checkpoints, derived child advances, and their
  operation transactions;
- panel/tab and mounted context, coarse visible-block dwell, source openings,
  searches, and replay positions;
- selections that persist meaningfully or scope an action, not every drag;
- protected-span and directive lifecycles;
- every approved model/tool request, response, effect, failure, cancellation,
  retry, proposal disposition, and accepted span;
- Publish, Attest, Withdraw, and re-attestation;
- compiler, selector, grammar, renderer, model, adapter, and capture-profile
  versions; and
- crash and recovery boundaries that affect observable work.

The profile excludes raw pointer coordinates, hover telemetry, unused
clipboard contents, activity in other applications, and hardware-level key
events. Color is never the only carrier of origin or state.

The logical trace is complete; physical encoding should use content-addressed
blocks, shared folder manifests, compressed event streams, coalesced attention
intervals, and bundle compression. Model payloads and repeated snapshots are
the likely storage drivers, not mutation or focus records.

## AI operations and failure evidence

Every approved provider dispatch enters the trace whether its proposal is
accepted, partly accepted, rejected, abandoned, or fails. Writing results are
proposals; only explicit acceptance changes a file zine.

```text
OperationAttempt
    ↓
ModelDispatch
    ↓
ModelResponse / ProviderRejected / DeliveryUnknown / PartialResponse
    ↓
ProposalDisposition
    ↓
Document Step, when accepted content changes a file
```

The invariant is exact logical reconstructability, not inline duplication. A
dispatch binds its source zine frontier, ordered segment/range references,
compiler/selector/adapter versions, directives, parameters, and exact outbound
request hash. Verification must prove reconstructed bytes equal the recorded
request. A bare hash is insufficient; if exact reconstruction from retained
nodes is impossible, the canonical outbound payload is stored once as a
content-addressed block.

Preparation failure records an attempt and stage but no dispatch claim.
Definite pre-send failure records that no provider disclosure occurred.
Delivery-unknown, provider-rejected, and partial outcomes retain the fully
reconstructable request because the provider may have received it. Observable
partial response bytes remain evidence. Retries are linked new dispatches, not
overwrites.

## Coins and supply

Mint is manual and atomic: Step the coin's genesis, Publish it, and Attest it.
An ordinary quote is not a coin, and copying never mints. Minting signals that
the exact text carries salience or currency for the minter; it does not imply
agreement with every proposition or establish truth.

Coins may be direct or extracted. An extracted coin may cite an unpublished
source file Step by exact snapshot hash and range. The coin text and opaque
source commitment become public while the source zine remains private. A later
publication of that same source lineage can make the extraction independently
verifiable without changing the coin.

One key may mint one coin of an exact coin type. Re-minting after withdrawal
re-attests the existing coin rather than inflating supply. A key is not proof
of one legal or biological person.

Exact hash `x` defines a coin type and supply. Canonical-equivalent formatting
may define a discovery cluster, but fuzzy or semantic similarity never changes
exact identity or supply. Useful views are total non-withdrawn supply, active
supply from recently reachable keys, and vetted supply whose keys pass the
reader's declared local corpus policy.

Popular coin matches carry little information; several independently shared,
moderately rare coins among vetted keys are more discriminating. Kademlia may
return candidate pointers, but it does not provide trust, reputation, or global
popularity.

Corpus vetting may examine internal coherence, longitudinal change, AUTHOR-only
versus AI-attributed spans, process patterns, and conditional compression.
Compression can estimate shared reusable pattern; it is not proof of
intelligence or humanity because repetitive spam also compresses well.
Stylometry entangles style, topic, medium, and tool use and can re-identify
pseudonymous writers. Scores remain inspectable local heuristics.

## Publication and portable analysis

An edition bundle contains the pinned file/folder content, complete canonical
first-party trace through the edition Step, direct evidence closure, operation
evidence, capture profile, manifests, hashes, versions, and signatures. A
folder edition also carries the recursive manifest and exact descendant heads.

Publication uses shallow evidence closure: it does not recursively embed every
external source's complete history. Missing external citations degrade
explicitly rather than invalidating an otherwise complete first-party trace.

Publication opens on current Markdown or the folder tree. A reader may press
Play for replay or give the provider-neutral content-plus-trace bundle to an
LLM. Derived selected views are non-canonical and record their source edition,
selector version, and exact events used.

An analysis or long-form reply is another file or folder zine with its own
complete trace. It pins the analyzed edition or coin and may additionally use
`replies_to`; it never mutates the source zine.

## Evidence program and claim boundary

The confirmatory study uses isolated stateless provider requests, disables
configurable provider memory and retrieval, captures exact outbound requests,
and compares text-only, bounded-history, and selected-trace conditions.
Primary outcomes cover context adherence, writing quality, unsupported
inference, correction burden, and blinded reviewer preference where feasible.

Coin matching and corpus vetting are separate hypotheses: distinctive
co-minting may predict broader corpus affinity; longitudinal process may expose
calibrated compatibility or change; compression features may add predictive
value beyond lexical overlap and topic.

None may be promoted to proof of humanity, legal identity, intelligence,
truth, or agreement. Complete means complete under the declared Zine capture
profile and published lineage. It cannot prove that the writer never used
another editor, model, device, or abandoned lineage.

## Migration sequence

The pre-product cut proceeds in dependency order:

1. Land the recursive zine ontology, folder checkpoint causes, operation ids,
   `advance` delta, and conformance fixtures.
2. Update protocol kernel, desktop/MCP writers, readers, replay, and recovery.
3. Add explicit folder/Root Step and transactional descendant flushing.
4. Introduce first-class AI attempt, dispatch, response/effect, and disposition
   records with exact reconstructability.
5. Preserve `[[…]]`, implement versioned `((…))`, and remove automatic Copy
   coining.
6. Replace Send with Publish, add append-only Withdraw/re-attest, and publish
   complete file or recursive folder trace prefixes.
7. Make Mint manual, public, attested, and one-per-key-per-coin-type.
8. Update indexes, portable bundles, conformance/recovery tests, UI language,
   and reader-facing documentation together.

Until each coordinated cut lands, [`EVIDENCE.md`](EVIDENCE.md) describes the
implemented behavior and the owning protocol specification wins on wire
behavior.
