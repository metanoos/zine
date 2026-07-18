# `@zine/trace-context`

Pure, runtime-dependency-free authoring-syntax and evidence-selection
foundation for Zine's trace-aware prompt compiler. This package deliberately
does not read files, derive edit provenance, call models, store secrets, sign
events, or define protocol wire fields.

## Contract

`scanAuthoringSyntax(text)` is a single linear pass over JavaScript UTF-16 code
units. It recognizes protected `[[...]]` spans before directive `((...))`
candidates. Delimiter-looking text inside a complete protected span is inert.
Nested directives, active cross-nesting, stray closers, empty directives, and
unterminated active syntax produce typed errors.

Syntax errors block preparation only when their malformed construct intersects
or crosses the prepared operation range. Errors wholly outside that range stay
visible in the lexical scan but are ordinary document data for that operation.

`compileAuthoringSyntax(input)` then applies an exact operation range and an
ordered, non-overlapping authority-span map supplied by an adapter. The whole
directive run—including delimiters—must have contiguous, uniform, eligible
coverage from the acting author. Missing, pasted, mixed-origin, other-author,
and out-of-operation candidates remain quoted text. The kernel never guesses
their origin.

Authorized directives receive deterministic revision-scoped IDs and visible
markers. Their records retain the exact instruction string, source range,
authority references, source-revision metadata supplied by the caller, and a
pending one-shot lifecycle. The original target text is otherwise unchanged.

Each directive also points to a deduplicated, quoted-data local excerpt. The
primary excerpt is its blank-line-delimited block clipped to the operation
range. A directive-only block prefers the nearest preceding non-empty block,
then the following one. Oversized containing blocks use a deterministic,
balanced UTF-8 window around the marker; windows never split a Unicode scalar
value.

`validateProtectedOutput` is an app-neutral final-result check that requires
every protected fragment to occur exactly and in source order. Adapters that
replace protected spans with identity-bearing placeholders should also verify
that stronger placeholder map; this helper cannot distinguish two naturally
identical fragments beyond count and order.

## Evidence selection V1

`selectTraceContextV1(input, { signal })` consumes closed, versioned candidates
that an adapter has already materialized from validated sources. V1 candidates
are explicit or mechanical only; there is no confidence, inferred preference,
psychology, or latent-intent field. The supported kinds have fixed priority:
operation instruction, protected range, correction, explicit preference,
prepared-head process fact, prior process fact, then direct citation.

Successful V1 policies are `text-only-v1` and `selected-trace-v1` only.
`bounded-trace-v1` returns the typed `UNSUPPORTED_POLICY` failure. This package
does not claim bounded-history behavior until it can construct the newest
complete conforming Step suffix, commit to an omitted prefix, and prove the
window under one reviewed contract.

The selector validates every policy-projected input field, rejects unpaired
UTF-16 surrogates, sorts strings by raw UTF-8 bytes, collapses identical
duplicate references while retaining every reason, and budgets exact UTF-8
bytes of its canonical rendered segment array. Operation instructions and
protected ranges are
mandatory, as is one package-owned current-target segment containing the exact
current text. Optional overflow produces deterministic exclusion counts and a
first rejected reference. Mandatory overflow, cancellation, total/per-candidate
input limits, candidate limits, manifest limits, and conflicting duplicates
return typed failures rather than an apparently complete result.

Source ranges remain exact half-open UTF-16 coordinates and are never remapped
or normalized. The validating adapter must reject a boundary that splits a
surrogate pair in its named source revision; the selector intentionally does
not receive or duplicate every historical source body just to re-derive that
validation.

`process-fact` has no caller-authored text field. It carries one closed
`step-summary`, `transaction`, or `change` shape; the package validates its
numeric/range relationships and owns the only prompt rendering. Transaction
intent is limited to explicit `undo` or `redo`. No V1 fact can name motive,
retention, rejection, influence, inferred preference, or psychology.

Selected-trace process evidence must be `full-trace`, belong to the operation's
exact target trace and prepared-head chain, and use the target head itself at
distance zero. Invalid process returns `INVALID_PROCESS_EVIDENCE` and
snapshot-only process returns `CONTEXT_INCOMPLETE`; neither produces a result
containing `selectionComplete`. A snapshot or cross-trace body may still enter
as an explicitly approved citation because quoted content is not a claim about
its process.

Text-only selection projects out corrections, preferences, and process facts
before candidate validation, duplicate handling, input-byte limits, hashing,
or rendering. Those excluded values and conflicts cannot change a successful
baseline identity. Target and citation sources are projected to trace-free
render shapes; exact-byte tests prohibit node, trace, process-status, and
excluded-value leakage into the rendered context. The separate fixed raw-slot
scan ceiling remains a resource guard for hostile arrays.

The effective rendered-context ceiling is exactly
`min(operation.maxContextBytes, 256 KiB, operation.preparedRequestMaxBytes -
operation.reservedPromptBytes)`, clamped at zero. Reserved prompt bytes are not
also subtracted from the context ceiling. Exact rendered target and evidence
bytes count once. The manifest reports raw target-text bytes, rendered target
bytes, request remainder, effective ceiling, and final rendered bytes so the
arithmetic can be independently checked.

The hard projected-input ceiling is 4 MiB and the hard per-candidate ceiling is
128 KiB; callers may lower either. Validation and selection yield at bounded
intervals when an abort signal is supplied. Hitting any ceiling or cancellation
returns a typed failure instead of a false completeness claim.

Successful results contain an exact rendered byte string,
per-projected-candidate Inspector decisions, a compact frozen
`SelectedTraceContextManifestV1`, and
domain-separated SHA-256 identities for normalized frozen inputs, rendered
context, and the package manifest. The manifest labels itself
`package-local-non-normative-v1`. It is not the final
`TraceContextManifestV1`, a protocol commitment, or a durable private record.

Still deferred behind their own schema, trust, storage, or integration review:

- RFC 8785/JCS durable envelopes and fresh-salted commitments;
- encrypted payload references and `TraceContextPrivateStoreV1`;
- complete-Step bounded-history suffix commitments;
- persisted corrections, scoped memory, and preference conflict resolution;
- durable MODEL Step binding and provider-specific prompt rendering; and
- desktop/MCP adapters and cross-press integration.

The fixed corpus at `corpus/authoring-syntax-v1.json` pins UTF-16 offsets,
Unicode behavior, authority failures, operation clipping, protected precedence,
markers, excerpts, deduplication, and malformed-syntax errors. The generated
scale corpus at `corpus/authoring-scale-v1.json` pins hashes, counts, ranges,
and observable work-set/output size for deterministic 0, 100, 1,000, and
10,000-candidate inputs. Its generator also exercises Unicode, protected fake
directives, eligible and inert authority, exact operation clipping, oversized
anchors, and malformed syntax both inside and outside the prepared range.

These scale fixtures are authoring-syntax workloads, not evidence-selection
transactions. The authoring compiler remains synchronous and has no candidate
store or cache. The evidence selector has cancellation and hard package-local
candidate, rendered-context, and manifest ceilings; cache-cold/cache-warm
selection benchmarks and the future durable envelope remain deferred.

The fixed selector corpus at `corpus/evidence-selection-v1.json` pins exact
rendered bytes and contract invariants for nil, unsupported policy, current
target, portable lone-surrogate construction, closed mechanical facts,
invalid/snapshot process, cross-trace binding, strict text-only projection,
budget arithmetic, and input ceilings. Existing syntax callers and the
`./corpus` export remain unchanged; the selector corpus is available at
`./selection-corpus`.

`benchmark/selection.ts` exercises deterministic 0, 100, 1,000, and 10,000
candidate structures and reports byte/count/hash results. It is a relative
correctness/resource harness, not a product wall-clock latency claim.

## Development

```sh
npm test
npm run typecheck
npm run benchmark
npm run benchmark:selector
```

The benchmark reports first-run and repeated-run local timings plus byte/count
diagnostics. It is opt-in and deliberately has no wall-clock CI gate: results
from a shared runner are neither product latency claims nor published p95
budgets. Use `npm run benchmark -- --iterations=1 --sizes=0,100` for a quick
smoke, or `npm run benchmark -- --manifest` to reproduce the pinned summaries.
