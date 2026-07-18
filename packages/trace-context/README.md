# `@zine/trace-context`

Pure, runtime-dependency-free authoring-syntax kernel for Zine's trace-aware
prompt compiler. This Wave 0 package deliberately does not read files, derive
edit provenance, call models, store secrets, sign events, or define protocol
wire fields.

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

The fixed corpus at `corpus/authoring-syntax-v1.json` pins UTF-16 offsets,
Unicode behavior, authority failures, operation clipping, protected precedence,
markers, excerpts, deduplication, and malformed-syntax errors. The generated
scale corpus at `corpus/authoring-scale-v1.json` pins hashes, counts, ranges,
and observable work-set/output size for deterministic 0, 100, 1,000, and
10,000-candidate inputs. Its generator also exercises Unicode, protected fake
directives, eligible and inert authority, exact operation clipping, oversized
anchors, and malformed syntax both inside and outside the prepared range.

These scale fixtures are authoring-syntax workloads, not trace-manifest
transactions. The current compiler is synchronous and has no candidate store,
cache, quota, context envelope, or cancellation boundary. Cancellation,
cache-cold/cache-warm behavior, incomplete candidate ceilings, and rendered
manifest limits belong to the future manifest compiler and are not simulated by
this package.

## Development

```sh
npm test
npm run typecheck
npm run benchmark
```

The benchmark reports first-run and repeated-run local timings plus byte/count
diagnostics. It is opt-in and deliberately has no wall-clock CI gate: results
from a shared runner are neither product latency claims nor published p95
budgets. Use `npm run benchmark -- --iterations=1 --sizes=0,100` for a quick
smoke, or `npm run benchmark -- --manifest` to reproduce the pinned summaries.
