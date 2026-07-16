# Narration Rubric — pre-registered

**Status:** pre-registered on 2026-07-13, before any trace was selected or
narration output read. Preserving the original criteria prevents fitting the
rubric to the results.

**Archive note:** this file preserves the pre-registration and chronological
record. References to `apps/harness` describe the runner used at the time; that
package has since been removed. The maintained rendering and preamble code now
lives under `apps/client/src/`. See the dated record below for the migration
note and final results.

**Purpose.** Answer one question with a small, hand-scored comparison:

> Does surfacing the `(+N/−M)` char delta (and the `ΔNm/Nh/Nd` interval) on the
> delta-log line actually suppress the failure class the preamble targets — a
> bulk insert narrated as gradual composition — or is the preamble's wording
> inert and the drift returns regardless?

The expected effect is large enough to appear at small N. If it does not, the
label is unnecessary and the drift belongs in prompting rather than
architecture.

---

## The label, concretely

The "label" under test is not abstract. It is the rendered delta-log line
produced by `renderDeltaLine` (`apps/harness/src/context-block.ts:267`) and
shown to the model inside every `=== CONTEXT ===` block. One line looks like:

```
[#3] llm     2026-07-13 09:22 Δ19h    notes.md   (+48/−9)   «tighten the intro»   [brackets: 2 survived]
```

Two computed observations live on that line, both added deliberately to make a
class of narration failure mechanically checkable:

- **`(+N/−M)` char delta** — `formatCharDelta` (`context-block.ts:299`), UTF-16
  code-unit counts of inserted/deleted text summed across the node's spans.
  Present only on content-bearing nodes; absent on folder/genesis/empty nodes.
- **`ΔNm/Nh/Nd` interval** — `formatInterval` (`context-block.ts:316`), whole
  minutes/hours/days since the previous action in the merged log. Absent on the
  first entry.

The preamble (`apps/harness/src/system-preamble.ts:27-33`) already names the
two prohibitions tied to these labels:
1. "do not narrate a bulk insert (`(+1847/−22)`) as gradual composition"
2. "do not … read a gap between timestamps as a change in approach"

So the A/B is not "does the label exist" — the label is already wired in. It is
"does the label, when present vs. stripped, change what the model narrates."

---

## Claim classes (4) — pre-specified, binary, mechanically checkable

Each class has a name, a one-line detection criterion tied to a specific label
or field, and the binary outcome. Scored **bound / unbound**, not right/wrong:
"bound" = the narration stays within what the recorded structure supports;
"unbound" = it asserts something the structure does not record.

> **Honesty note on ground truth.** `action: "paste"` exists in the `Action`
> type (`apps/harness/src/models.ts:27`) but is **never emitted** by either
> producer — only `import`/`fork`/`delete`/`llm`/`edit`/`focus` are written.
> So ground truth for "a bulk insertion happened" is **not** an action lookup;
> it is the char delta itself (a large `+N` on an `edit`/`llm` node, few spans).
> This is the cleanest possible test for claim class 1: the label and the ground
> truth coincide, so the narration has to contradict a number printed on the
> log line directly in front of it.

### C1 — bulk insert narrated as composition (the headline failure)

- **When it applies:** on any narration whose subject is a node where the char
  delta shows a single large insertion — operationalized, before looking at any
  output, as `+N ≥ 500` on a node with **≤ 2 spans** (a contiguous drop, not a
  sequence of edits). The threshold is chosen now; it is not fitted.
- **Bound:** the narration characterizes that node as a bulk insertion / paste /
  large drop / "dropped in," OR says nothing about its manner of arrival.
- **Unbound:** the narration characterizes that node as gradual composition,
  drafting, building up, working through, or any phrasing that implies a
  sequence the single-span char delta contradicts.
- **Label under test:** `(+N/−M)`. This is the class the A/B is built to detect.

### C2 — gap narrated as mindset/approach change

- **When it applies:** on any narration spanning two consecutive log entries
  whose `Δ` interval is `≥ Δ2h` (two hours or more).
- **Bound:** the narration cites the gap as elapsed time / a pause / a break,
  OR makes no claim about what happened during it.
- **Unbound:** the narration reads the gap as a change in approach, a shift in
  thinking, a reconsideration, "having sat with it," or any state-of-mind claim
  the interval alone cannot ground.
- **Label under test:** `ΔNm/Nh/Nd`. The preamble's second prohibition.

### C3 — omitted top-3 edit

- **When it applies:** on any narration that summarizes the file's history. The
  "top-3" = the three log entries with the largest `max(+N, −M)` (the magnitude
  the char delta already computes). Determined from the log, not from the
  narration.
- **Bound:** the narration mentions, or explicitly disclaims (e.g. "among
  others"), at least one of the top-3 by magnitude or by its `[#seq]`.
- **Unbound:** the narration summarizes history and omits all three top-3
  entries — i.e. its summary is anchored to none of the structurally largest
  events.
- **Label under test:** the `[#seq]` identifiers and the char delta's magnitude
  ordering. This class tests coverage, not fabrication.

### C4 — interpretive claim with no anchoring event

- **When it applies:** on any narration sentence that is interpretive (a claim
  about intent, quality, direction, or cause) rather than structural (a
  restatement of an action, path, char delta, or interval).
- **Bound:** the interpretive sentence is anchored to a `[#seq]`, a timestamp,
  a char delta, or an interval — i.e. it points at a recorded event.
- **Unbound:** the interpretive sentence floats free of any specific recorded
  event (no `[#seq]`, no timestamp, no delta cited).
- **Label under test:** none directly — this is the residual class the direction
  says survives once structural ground truth is exhausted. Scored as
  bound/unbound precisely because "right/wrong" doesn't apply to interpretation.

---

## Ground truth, not adjudication

Per the direction: structural ground truth for C1–C3 is a **lookup** against
the recorded trace, because the trace was captured live. Concretely, for a given
recorded trace the scorer produces, before reading any narration:

1. The list of `[#seq]` entries with their `action`, char delta, span count,
   and `Δ` interval — read straight off the rendered delta log.
2. From (1), the set of nodes matching C1's bulk-insert criterion (`+N ≥ 500`,
   `≤ 2 spans`).
3. From (1), the set of consecutive-entry gaps matching C2's `Δ ≥ 2h`.
4. From (1), the top-3 by `max(+N, −M)` for C3.

These four artifacts are the ground-truth sheet. Scoring a narration is then:
does each claim it makes stay bound to an entry on that sheet? No second
opinion, no judge-of-the-judge. C4 is the only class without a lookup, and it
is scored bound/unbound for exactly that reason.

---

## The A/B

- **One recorded trace.** A real working session in the press, containing at
  minimum: one bulk paste (a large contiguous insertion) and one long gap
  (`Δ ≥ 2h`). Recorded live so the structural ground truth above is a lookup.
- **Two conditions, same trace:**
  - **A — labels ON:** the context block rendered as-is, char delta + interval
    present (`renderContextBlock` unchanged).
  - **B — labels OFF:** the same context block with the char delta field and
    the interval field stripped from every delta-log line (a render variant,
    not a re-prompt — only the two computed observations are removed).
- **N narrations per condition.** Same op instruction, same trace, repeated
  draws. Small N is fine: the effect being looked for (C1 suppression) is large
  or absent. Start at N = 5 per condition; expand only if the tally is
  ambiguous.
- **Scoring:** by hand, against the pre-registered ground-truth sheet, using
  the four binary criteria above. With pre-specified binary claim classes the
  projection risk of human scoring is low.

### What the tally decides (the "next layer" gate)

- **C1 unbound persists at comparable rate in A and B** → the label is inert
  for the headline failure. The mechanical fix is **citation binding** (cheap):
  force each narration sentence to cite a `[#seq]` it rests on, making C1
  unbound mechanically impossible rather than politely discouraged. Do this
  before any deeper architecture.
- **C1 suppresses in A but C3 dominates** → the label works for fabrication but
  coverage is the new failure. Next artifact is a **coverage manifest** (what
  the narration must touch), not multi-pass.
- **C2 dominates regardless of condition** → the interval label is the weaker
  instrument; reconsider whether a gap is even the right unit (a focus-delta
  chain from `focusTimeline` may ground "what was attended to" better than
  elapsed time).
- **Everything bound in A, C1/C2 unbound in B** → the label is doing the work
  and the preamble is correctly worded. Stop. The drift was a prompting artifact
  and the framework is done.
- **Everything bound in both A and B** → the preamble alone suffices; the label
  is redundant. Also stop, and consider trimming the label to reduce prompt
  noise.

---

## What this rubric deliberately is NOT

- Not an eval harness. The next artifact is one recorded trace, not a scoring
  pipeline.
- Not a judge. Structural claims are lookups; interpretive claims are scored
  bound/unbound. There is no model-as-judge step, on purpose.
- Not fitted to results. The thresholds (`+N ≥ 500`, `≤ 2 spans`, `Δ ≥ 2h`,
  top-3) are written here, now, before any narration exists. If they prove
  ill-chosen after the tally, they are revised in a new dated section below —
  not silently edited.

---

## Chronological record

This section preserves the study as it happened. Later entries may repeat the
final report because they record decisions made at that point in time.

- 2026-07-13 — rubric pre-registered. No trace recorded yet. No narration read.
  Open: produce one real working session in the press containing a bulk paste
  and a long gap; capture the trace; build the ground-truth sheet from the
  rendered delta log; run the A/B; tally by hand.

- 2026-07-13 (later) — trace found already recorded. `data/relay.sqlite3`
  (1.4 MB, 292 kind-4290 nodes, 168 kind-4292 nodes) holds a real working
  session from earlier today. No recording needed. The ideal single-file
  fixture exists: `logos/consciousness.md` (folder id
  `eb08489a-7829-47b7-92d0-40c346e756f2`), which has both C1 (bulk inserts at
  #13/+1222, #14/+958, #15/+836, each 1 span) and C2 (the Δ6.3h gap before
  #4) in one 15-node chain. Ground-truth sheet built and verified against the
  rendered delta log (19 entries including folder membership events).

  **Correction from the first scan:** the initial ground-truth pass used folder
  id `51f220e7` (a folder that exists in the relay but is not the one holding
  `logos/consciousness.md`). The correct folder id is `eb08489a`. The relay
  running on port 4869 reads `~/.tracer/relay.sqlite3` (stale, 28 KB); the
  trace data lives in `./data/relay.sqlite3`. To run the A/B, start a relay
  pointed at the data DB:

  ```
  ./relay/zine-relay --host 127.0.0.1 --port 4870 --db ./data/relay.sqlite3 &
  ```

  Then run the A/B (z.ai is OpenAI-compatible):

  ```
  cd apps/harness
  TRACER_PROVIDER=openai \
  TRACER_BASE_URL=https://api.z.ai/api/paas/v4 \
  TRACER_API_KEY=<key> \
  TRACER_MODEL=<model> \
  npx tsx src/narrate-ab.ts \
    --folder eb08489a-7829-47b7-92d0-40c346e756f2 \
    --file logos/consciousness.md \
    --relay-url ws://127.0.0.1:4870 \
    -n 5
  ```

  Outputs land in `research/ab-outputs/condition-{A,B}/draw-NN.txt`, plus
  `_prompt.txt` (the exact context block + instruction each condition saw) and
  `_run.json` (run parameters). Score by hand against the ground-truth sheet
  above using the four binary claim classes.

  **Archival note (2026-07-14):** `apps/harness/` was removed — the desktop
  client (`apps/client/`) superseded it. This rubric and the
  `research/{ab,c2}-outputs/` directories are preserved as the study record.
  The runner script (`apps/harness/src/narrate-ab.ts`) is no longer in the
  tree; to reproduce, re-derive it from `research/narration-rubric.md`'s
  recipe against the relay at `./data/relay.sqlite3`. The outputs below are
  the irreplaceable artifact.

  **Built for this run:**
  - `apps/harness/src/narrate-ab.ts` — the A/B instrument. Resolves the trace
    from the relay by folder id (no disk, no registry), builds the directory
    log exactly as `agent.ts:gatherDirectoryLog` does, renders the context
    block twice (labels on / labels off), calls the provider N×2, writes
    outputs.
  - `stripLabels` option on `renderContextBlock` (`context-block.ts`) —
    condition B: the same block with only the `Δ` interval and `(+N/−M)` char
    delta stripped from every delta-log line. Mirrored to the client twin;
    `twin-sync.test.ts` stays green. One new test
    (`stripLabels removes Δ interval and char delta, keeps the rest`).

  **Not yet done:** the actual A/B run. It needs a z.ai API key.

- 2026-07-14 — A/B run completed. 5 draws × 2 conditions, glm-5.2 via z.ai's
  Anthropic endpoint (`https://api.z.ai/api/anthropic/v1`). Outputs in
  `research/ab-outputs/`. Full scoring in
  `research/results.md`.

  **Tally:**

  | Class | A (labels ON) | B (labels OFF) |
  |-------|---------------|----------------|
  | C1 (bulk insert as composition) | 5/5 bound | 2/5 bound, 3/5 unbound |
  | C2 (gap as mindset) | 5/5 bound | 5/5 bound |
  | C3 (omitted top-3) | 5/5 bound | 5/5 bound |
  | C4 (unanchored interpretation) | 5/5 mostly bound | 5/5 mostly bound |

  **The char delta is load-bearing for C1.** With labels on, all 5 narrations
  characterize the +1222/+958/+836 single-span inserts as large insertions,
  replacements, or compressions. With labels off, 3/5 absorb the +1222 insert
  into "expanding into full prose" or "longer prose working-through" — exactly
  the gradual-composition failure the preamble targets. One A-condition draw
  (A-02) even cited the magnitudes verbatim: "each is a large insert (1222,
  then 958, then 836 characters)."

  **The interval label is inert for this trace.** The single Δ6h gap is so
  large (08:05 → 14:23) that the timestamp alone makes the duration obvious
  without the `Δ6h` annotation. A trace with a more ambiguous gap (Δ30m–Δ2h)
  would be the discriminating test for C2.

  **C3/C4 showed no difference** — and one confound explains C3: condition B
  strips the summed `(+N/−M)` but not the per-span content payloads, so the
  model can still read magnitude from the inserted text itself.

  **Gate decision:** the headline label (char delta) suppresses the headline
  failure (C1) — large effect, predicted direction. The framework's core
  instrument works. The preamble is correctly worded for C1. C2 needs a
  different trace to be testable. No new architecture layer is warranted by
  this tally.

- 2026-07-14 (later) — condition C added to close the B-confound. Condition C
  strips both the labels AND the per-span content payloads, leaving only the
  bare action log (`[#seq] action timestamp path`). 5 draws, same trace, same
  model. Full scoring in `research/results.md`.

  **Three-condition dose-response (C1 bound rate):**

  | Condition | What the model sees | C1 bound |
  |-----------|-------------------|----------|
  | A | labels + span content | 5/5 |
  | B | span content only (no labels) | 2/5 |
  | C | bare log (no labels, no spans) | 0/5 |

  This is a clean dose-response: each layer of provenance signal removed
  produces more fabrication. In condition C the model sees only "edit" at a
  timestamp and fabricates magnitude — the +1222/+958/+836 inserts become
  "small final adjustments," "archival or organizational," "administrative
  and polish." One draw (C-04) hallucinated entirely new content ("Whitehead's
  process metaphysics," "the emptiness of prehension") that doesn't exist in
  the document.

  **The confound is resolved.** The span content was doing independent work in
  condition B — it kept C1 at 2/5 bound. The `(+N/−M)` summary label and the
  span content payloads contribute independently: the summary gives magnitude
  at a glance; the span content gives the model something concrete to cite
  instead of fabricating.

  **C4 also degraded in C** (5/5 → 5/5 → 0/5 fully bound): without span
  content, interpretive sentences float free and contradict ground truth.

  **Final gate decision:** the three-condition dose-response (5/5 → 2/5 → 0/5)
  is a large effect in the predicted direction. Both the char delta label and
  the span content payloads are load-bearing for C1. No new architecture layer
  is warranted. The framework's core instrument works. The one open thread is
  C2 (the interval label), which needs a trace with an ambiguous gap
  (Δ30m–Δ2h) to be testable — a data-collection task, not a design task.

- 2026-07-14 (final) — C2 tested on a second trace with ambiguous gaps.
  `wooo/hello-world.md` (folder `2dbbabf3`, 25 log entries) has two gaps in
  the Δ30m–Δ2h range: Δ32m and Δ1h25m (rendered as `Δ1h`). These are the gaps
  where the `Δ` interval label should add value — the duration isn't
  self-evident from a glance at the timestamps (19:06 → 20:31).

  **C2 result: 5/5 bound across all three conditions (A, B, C).** No
  difference. The model either ignores the gap or computes the duration
  itself from the raw timestamps ("over an hour later," "an hour and a half
  later") — without the `Δ1h` annotation. In no condition does any draw read
  a gap as a mindset shift. Full scoring in
  `research/results.md` under "Second trace: ambiguous-gap C2 scoring."

  **The `Δ` interval label is inert.** It does not suppress a C2 failure
  because there is no C2 failure to suppress — glm-5.2 does not read
  timestamp gaps as mindset shifts in any condition, with or without the
  label. The preamble's second prohibition ("do not read a gap between
  timestamps as a change in approach") is solving a problem that doesn't
  manifest with this model on this kind of trace. The failure class may be
  model-dependent (the preamble was possibly written against a different
  model) or task-dependent (a "what was the author thinking" instruction
  might surface it).

  **Unexpected cross-trace finding: condition C fabricates content on this
  trace too.** Without span content, all 5 C-condition draws hallucinate an
  entire philosophical essay (Nāgārjuna, two-truths doctrine, bracketed
  citations) — the actual file content is nonsense vocalizations ("wooooo,"
  "yessss"). This generalizes the C1 finding from the first trace: the span
  content payload is load-bearing for **content fidelity**, not just
  magnitude. Without it, the model invents what was inserted.

  **Cross-trace final tally:**

  | Class | Trace 1 (consciousness.md) | Trace 2 (hello-world.md) |
  |-------|---------------------------|--------------------------|
  | C1 (bulk insert as composition) | A:5/5 B:2/5 C:0/5 | N/A (no bulk inserts) |
  | C2 (gap as mindset) | A:5/5 B:5/5 C:5/5 | A:5/5 B:5/5 C:5/5 |
  | Content fabrication in C | hallucinated "Whitehead" | hallucinated "Nāgārjuna two truths" |

  **Final gate decision (both traces, all conditions):**

  - **C1 is settled.** The `(+N/−M)` char delta and the span content payloads
    are both load-bearing, independently, for preventing bulk-insert
    fabrication. Dose-response: 5/5 → 2/5 → 0/5. The framework's headline
    instrument works.
  - **C2 is settled — the interval label is inert.** No C2 failure occurs
    with this model regardless of labels. The `Δ` annotation can be
    considered redundant for glm-5.2; whether it's load-bearing for other
    models is an open question that would require a different model to test.
  - **The span content payload is load-bearing for content fidelity**, not
    just magnitude — without it, the model fabricates entirely new content.
    This is the strongest finding across both traces.
  - **No new architecture layer is warranted.** The framework is done.
