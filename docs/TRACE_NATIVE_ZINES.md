# Trace-Native Zines

Status: accepted product and architecture direction, 2026-07-17. This is the
non-normative migration target for the pre-product pivot. The specifications
under [`protocol/`](../protocol/README.md) remain authoritative until their
wire model, readers, writers, fixtures, and tests migrate together. No legacy
compatibility layer is required.

## Thesis

AI should assist a writer from the current text **and the trace that produced
it**, not from text alone. The trace contains information the final draft has
discarded: rejected paths, revisions, attention, source use, directives,
model calls, and the writer's decisions about proposed text.

Zine therefore treats process as part of the work:

> A zine is canonical Markdown text together with its complete signed trace.

The reference product is a **press** named **Zine**. It produces zines, Steps,
editions, and coins. Folders and the user's Root organize work and contribute
context; they are not themselves zines, though their structural and attention
events may participate in trace construction.

This is a founder-conviction pivot accompanied by evidence gathering, not a
claim already proved. The central confirmatory comparison is the same writing
task under text-only, bounded-history, and selected-trace context, holding all
other Zine-controlled variables constant.

## Vocabulary

| Term | Meaning |
|---|---|
| **Text** | The canonical UTF-8 Markdown at a trace head. |
| **Trace** | The append-only, causally ordered provenance and process log that produced the text. |
| **Zine** | One evolving Markdown work, its complete trace, and a stable work identity. |
| **Press** | An application that creates zines and mints coins. The reference press is named **Zine**. |
| **Step** | A deliberate signed checkpoint that advances a zine's trace head. “Signed checkpoint” is its explanatory gloss; the product term remains **Step**, not Save. |
| **Sign** | Cryptographic authentication of a record, not a user-facing publication gesture. |
| **Publish** | Make an immutable edition and its complete trace prefix publicly reachable. This replaces the protocol and product gesture **Send**. |
| **Edition** | One immutable publication pinned to an exact Step and trace prefix. Later work produces a linked edition. |
| **Attest** | Append a signed stance meaning “I stand behind this exact edition or coin.” It does not change the target. |
| **Withdraw** | Append a signed change of stance without erasing the earlier attestation. Re-attestation is another append-only transition. |
| **Coin** | One minter's immutable text instance, signed by one key, published, and attested. |
| **Coin type** | The exact-text category of which coins are instances, keyed by exact content hash `x`. |
| **Supply** | The collection/count of valid, non-withdrawn coins of one coin type. |
| **Mint** | The explicit atomic Step + Publish + Attest operation that creates one coin. |
| **Cluster** | Canonical-equivalent coin types grouped by normalized coordinate `H`; useful for discovery, never exact identity or supply. |

The short lifecycle is:

```text
Press ──creates──> Zine ──Step──> trace head ──Publish──> Edition
                                                    └──> Attest

Press ──Mint (Step + Publish + Attest)──────────────> Coin
```

## Step, Publish, Attest, and withdrawal

Editing is persisted locally without turning every keystroke into a signed
network event. **Step** remains the deliberate rhythm-layer gesture: it folds
the lossless event buffer into a signed checkpoint. Save is not the protocol
term because persistence and checkpointing are different operations.

**Publish** replaces **Send**. It is the disclosure and reachability boundary,
not an endorsement:

1. If the buffer has changed, create a final Step.
2. Prepare the exact edition bundle locally.
3. Show the complete disclosure manifest and replay.
4. Invalidate confirmation if any bundle byte changes.
5. Publish the immutable edition atomically and idempotently.

A published edition may remain unattested and available for discussion.
**Attest** is a later, optional commitment by its author or another key.
Attestation state is append-only:

```text
Attest → Withdraw → Re-attest
```

Withdrawal never edits the edition, coin, or historical attestation. For a
coin, withdrawal removes that key's coin from active supply. Relay deletion is
a separate best-effort retention request and cannot serve as semantic
withdrawal.

Publication freezes an exact edition. A moving “latest” locator may point to a
new edition, but an edition locator never changes silently.

## Privacy and disclosure

The working zine and its trace remain private until Publish. The two explicit
pre-publication disclosure boundaries are:

- a writer-approved provider dispatch, whose exact context goes to the named
  provider and enters the trace; and
- Mint, which is itself an atomic publication of the selected text as a coin.

There is no private AI-operation mode and no selective omission from a
published trace. The writer learns this invariant during onboarding, sees an
ambient reminder near AI and publication controls, reviews the exact prepared
context before dispatch, and reviews the complete local bundle before
publication.

Credentials, authorization headers, signing keys, encryption keys, and
unrelated application internals are never trace content. Diagnostics are
content-free by default; a content-bearing support export requires a separate
confirmation.

Deleting text does not delete its history. If an unpublished trace contains
material that cannot be disclosed, the writer may abandon that zine and start
a new lineage; the press must never present a selectively cleaned history as
complete.

## Markdown and inline grammar

Zine source is Markdown: portable, human-readable, diffable, signable, and
usable outside the press. The source profile is versioned CommonMark with an
explicit list of supported GFM features plus the Zine constructs below. The
Markdown bytes remain authoritative; rendered views are projections under a
versioned renderer profile.

### Protected highlights and coins

An intentional highlight is authored in the text:

```text
[[important passage]]
```

The brackets are not sidecar selection metadata. They are preserved in
storage, copying, replay, and interchange; preview may render them as an
accessible highlight. The trace selector treats them as a strong attention
signal, and model operations must preserve them byte-for-byte.

Bracketing never mints automatically. Quoting, copying, pasting, highlighting,
and including text in model context also never mint automatically. Only an
explicit Mint resolves a protected span into a coin reference:

```text
[[important passage | coinId]]
```

Copying an already resolved coin may preserve its reference. Copying ordinary
text remains ordinary copying.

### One-shot directives

`((…))` is a one-shot instruction to the interpreting AI. The compiler removes
an active directive from the data body, places it in the trusted author
directive section, and carries its exact source position and structural
Markdown neighborhood. The operation's explicit target range remains the
only editable scope.

`[[…]]` regions are opaque. Active directives cannot nest inside them, and
crossing or nested delimiters are malformed in V1. Marker-looking text inside
a protected region is inert.

Every directive has an inspectable lifecycle: active, inert with reason,
reserved, spent, consumed, cleanup-needed, malformed, or revoked. Writing
operations consume directives only when the writer explicitly accepts some
result. Run operations become spent at the first irreversible effect and
retain partial-effect receipts after failure.

## Full Trace V1

“Complete trace” means complete under a declared, versioned capture profile
and lineage. It does not mean that the press observed activity in other apps,
private thoughts, or work recreated from an abandoned lineage.

`FULL TRACE V1` should include:

- every text mutation and transaction boundary, including undo and redo;
- timing sufficient to replay editing cadence;
- paste, import, external writes, and known copy provenance without automatic
  coining;
- file and folder creation, rename, movement, deletion, restoration, fork,
  and merge;
- active panel/tab and mounted context;
- coarse visible-block or viewport dwell;
- searches and the results opened;
- citations, source openings, and replay positions visited;
- selections that persist meaningfully or scope an action, not every mouse
  drag;
- `[[…]]` creation, removal, and Mint resolution;
- the complete `((…))` directive lifecycle;
- every model or tool request, response, approval, effect, failure,
  cancellation, and retry;
- proposal edits, partial acceptance, rejection, feedback, and stale states;
- Publish, Attest, Withdraw, and re-attestation;
- compiler, selector, grammar, renderer, model, and adapter versions; and
- crash and recovery boundaries when they affect observable work.

The profile excludes raw mouse coordinates, hover telemetry, unused clipboard
contents, activity in other applications, and hardware-level key events.
Color is never the only carrier of origin or state.

The logical trace is complete; the physical encoding need not duplicate
content. Implementations should use content-addressed blocks, exact references,
compressed event streams, coalesced attention intervals, and bundle-level
compression. Model payloads and repeated snapshots are the likely storage
drivers, not mutation or focus records. Binary attachments are hashed and
linked rather than copied into every event.

## AI operations and proposals

Every explicitly approved provider dispatch enters the trace, whether its
proposal is accepted, partially accepted, rejected, abandoned, or fails.
Writing results are proposals; only explicit acceptance changes the document.
The proposal opens in a transient Proposal tab in the existing panel system,
persists across restart, remains outside the file tree, and becomes stale
rather than rebasing if its source revision changes.

The operation lifecycle requires first-class immutable events rather than one
overloaded document checkpoint:

```text
OperationAttempt
    ↓
ModelDispatch
    ↓
ModelResponse / ProviderRejected / DeliveryUnknown / PartialResponse
    ↓
ProposalDisposition
    ↓
Document Step, when accepted content changes the text
```

An accepted result binds the exact source revision, request, response,
proposal, writer review edits, accepted spans, MODEL/AUTHOR attribution, and
directive disposition. Rejected and failed operations remain visible even
when no document Step results. Tool operations additionally bind approvals,
capability ceilings, effects, partial outcomes, and idempotent recovery.

The invariant is exact logical reconstructability, not inline duplication.
A dispatch record carries the source head, ordered segment/range references,
compiler/selector/adapter versions, directive and operation references,
provider parameters, and the exact outbound-request hash. Verification must
prove:

```text
reconstruct(dispatch descriptor) == exact outbound request bytes
sha256(reconstructed bytes) == recorded request hash
```

A bare hash is insufficient: every referenced node, range, canonicalization
rule, and versioned algorithm required for reconstruction must remain in the
edition bundle. If exact reconstruction is impossible, store the canonical
outbound request once as a content-addressed payload.

Failure records are proportional but honest:

- preparation failure records an `OperationAttempt`, structured stage, and
  available commitments, but no dispatch claim;
- definite pre-send failure records that no provider disclosure occurred;
- delivery-unknown and provider-rejected outcomes retain a fully
  reconstructable request because the provider may have received it;
- partial streams retain the exact bytes the writer could observe; and
- retries create linked dispatches rather than overwriting prior attempts.

Successful and rejected responses must be stored because they cannot be
reconstructed and may have influenced the writer. Native provider attribution
is a press-signed assertion unless the provider supplies a verifiable
signature. An autonomous agent with its own durable key signs its own Steps
and enters another zine through fork and merge.

## Coins

A coin is one immutable text instance minted by one key. Mint is manual and
atomic: Step the coin's single genesis, Publish it, and Attest it. A local
prepared Mint that has not completed is a proposal, not a private coin.

Two origin forms remain useful:

- **direct** — signer-authored text with no source claim; and
- **extracted** — exact text, source Step id, source snapshot hash, and range.

An extracted coin may cite an unpublished source Step. The coin text and
opaque source commitment become public, while the source zine remains private.
Readers label the origin asserted and unavailable. Publishing a later edition
on that same source lineage publishes the complete prefix including the source
Step, making the old extraction independently verifiable without changing the
coin. Publishing a separate fork does not necessarily publish the source Step.

One key may mint a given exact coin type once. If its attestation was
withdrawn, minting again re-attests the existing coin rather than inflating
supply. A key is not proof of one legal or biological person.

The relationships remain distinct:

- **cite** reuses frozen text without implying agreement;
- **extract/Mint** creates a new frozen text instance from an exact source;
- **fork** promotes a coin into an editable zine with a new identity; and
- editing a coin means forking it to a zine, editing, and optionally minting
  another coin.

An ordinary quote is not a coin. Minting signals that the text carries
currency or salience for the minter, not necessarily that every proposition
is true. Attestation stands behind the exact coin and its stated provenance;
critical framing belongs in the citing or replying zine.

## Supply, rendezvous, and corpus vetting

Exact hash `x` defines a coin type and its supply. Normalized coordinate `H`
groups canonical-equivalent formatting variants for rendezvous; fuzzy or
semantic similarity may suggest additional candidates but never determines
exact identity or supply.

Three views are useful:

- **supply** — all valid, non-withdrawn coins of a type;
- **active supply** — supply from keys with recent reachable activity; and
- **vetted supply** — active supply whose keys pass the reader's declared
  local corpus-vetting policy.

These are counts of observable keys under a network view and policy, never a
claim about globally unique people. Kademlia supplies candidate pointers, not
trust or global popularity. Results should be capped and diversified, then
verified and vetted from each candidate key's published zine corpus.

The product hypothesis is that independently minting the same distinctive
text predicts shared salience, “currency sense,” and potentially broader
corpus affinity. Popular coins carry little matching information. A useful
starting weight is inverse active frequency:

```text
coin match weight ≈ log(total active keys / active supply of coin type)
```

One unique coin offers no match; one extremely popular coin offers little
discrimination; several independently shared, moderately rare coins among
vetted keys provide a stronger signal. Raw supply must never become reputation
or consensus.

Vetting may analyze:

- integrity and declared Full Trace profile;
- longitudinal internal coherence within a key's zines;
- gradual style and process evolution or abrupt change points;
- AUTHOR-only text separately from MODEL-attributed spans;
- revision, attention, search, source, and proposal-decision patterns; and
- symmetric or conditional compression between corpora and trace-event
  sequences.

Compression can estimate shared reusable pattern, but high compressibility is
not itself intelligence: repetitive spam also compresses well. The useful
measure is conditional compression gain against calibrated baselines, combined
with novelty and process evidence. Stylometry also entangles style, topic,
medium, and tool use. Scores are inspectable, versioned, local admission
heuristics—not CAPTCHAs, proof of humanity, identity, agreement, or truth.

Research grounding includes
[normalized compression distance](https://www.math.ucdavis.edu/~saito/data/acha.read.w17/cilibrasi-vitanyi_clustering-by-compression.pdf),
the prediction/compression relationship in
[Language Modeling Is Compression](https://proceedings.iclr.cc/paper_files/paper/2024/file/3cbf627fa24fb6cb576e04e689b9428b-Paper-Conference.pdf),
documented
[mode effects on measured author style](https://aclanthology.org/2021.eacl-main.97/),
and the difficulty of
[separating style from topic and other latent variables](https://aclanthology.org/2023.tacl-1.80/).

Published trace also enables longitudinal stylometry and potential
re-identification. Disclosure and verifier UX must state that risk rather than
presenting public trace as anonymous behavioral data.

## Publication and portable analysis

An edition bundle contains:

- final Markdown;
- the complete canonical first-party trace through the edition Step;
- exact directly used coins and source nuclei when available;
- operation evidence and dispositions;
- a manifest, capture profile, renderer/compiler versions, hashes, and
  signatures; and
- structural indexes and versioned bounded-history or selected-trace views.

The bundle uses a shallow evidence closure. It does not recursively embed the
complete history and citations of every external source. Missing or
unverifiable external citations degrade explicitly; they do not invalidate an
otherwise complete first-party trace.

Publication opens on the final text. A reader may press Play for the complete
replay or give the provider-neutral text-plus-trace bundle to an LLM. The full
canonical bundle is never truncated; derived summaries and selected views are
non-canonical and record the edition, selector version, and exact events used.

An analysis or long-form reply is another zine with its own complete trace. It
uses `cites` to pin the analyzed edition or coin and may additionally use
`replies_to` when it is rhetorically a response. It never extends or mutates
the source zine.

## Evidence program and claim boundary

The confirmatory trace-context study should use isolated stateless provider
requests, disable configurable provider memory and retrieval, capture the
exact outbound request, and compare text-only, bounded-history, and selected-
trace conditions. The primary outcomes should cover context adherence,
writing quality, unsupported inference, correction burden, and human reviewer
preference on a preregistered corpus with blinded scoring where feasible.

Coin matching and corpus vetting are separate hypotheses:

- co-minting distinctive coin types predicts corpus affinity better than
  chance;
- longitudinal text and process features provide calibrated compatibility and
  change signals; and
- compression-based features add predictive value beyond lexical overlap and
  topic alone.

None may be promoted to proof of humanity, legal identity, intelligence,
truth, or agreement. “Complete trace” means complete under the declared Zine
capture profile on the published lineage. It cannot prove that the writer
never used another editor, model, device, or abandoned lineage.

## Required migration from the current draft

The accepted direction intentionally conflicts with parts of the current
draft protocol and reader-facing docs. The migration must be made as one
pre-product schema cut:

- redefine **trace** as the provenance/event log and **zine** as Markdown plus
  trace;
- stop calling folders zines;
- replace **Send** with **Publish** while retaining Publish ≠ Attest;
- add append-only Attest/Withdraw/re-attest stance transitions;
- make Mint manual, public, attested, and one-per-key-per-coin-type;
- remove automatic coining from Copy;
- preserve unresolved `[[…]]` as protected attention syntax;
- add versioned `((…))` directives and their lifecycle;
- publish the complete trace prefix rather than only a polished current node;
- add first-class immutable operation attempt, dispatch, response/effect, and
  disposition records;
- bind accepted AI spans and failed/rejected operations to their exact
  evidence;
- add Full Trace capture-profile declarations and portable edition manifests;
  and
- update canonical readers, writers, fixtures, indexes, conformance tests,
  recovery tests, docs, and UI language together.

Until that cut lands, current implementation claims remain in
[`EVIDENCE.md`](EVIDENCE.md), and the owning protocol specifications win on
wire behavior.
