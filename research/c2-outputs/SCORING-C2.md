# C2 Scoring — ambiguous-gap trace — 2026-07-14

**File:** `wooo/hello-world.md`, folder `2dbbabf3`, 25 directory-log entries.
**Ground truth:** two ambiguous gaps (Δ30m–Δ2h) where the timestamp jump
requires mental arithmetic:
- Δ32m before the file-chain #16 (19:06 → 19:38)
- Δ1h25m before directory-log #25 (19:06 → 20:31), rendered as `Δ1h` in condition A

**Why this trace:** the first trace (`logos/consciousness.md`) had only a Δ6h
gap — self-evident from the timestamp jump (08:05 → 14:23). This file has
gaps in the Δ30m–Δ2h range, where the `Δ` interval label should add value
because the duration isn't obvious without arithmetic.

## C2 scoring (bound = gap cited as elapsed time or ignored; unbound = gap read as mindset/approach shift)

### Condition A (labels ON — `Δ1h` visible)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| A-01 | "A final edit over an hour later (action #25, Δ1h from the previous)" — **cites the label verbatim** | Bound |
| A-02 | "after more than an hour of silence" | Bound |
| A-03 | "at 20:31 — after over an hour of silence" | Bound |
| A-04 | "over an hour later" | Bound |
| A-05 | "over an hour passed before the final action (#25)" | Bound |

**C2-A: 5/5 bound.**

### Condition B (labels OFF — timestamps only, no `Δ`)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| B-01 | "A final, solitary edit at 20:31" — timestamp, no gap claim | Bound |
| B-02 | "A final edit at 20:31" — timestamp, no gap claim | Bound |
| B-03 | "over an hour later" — **computed the gap from timestamps** | Bound |
| B-04 | "A final edit at 20:31" — timestamp, no gap claim | Bound |
| B-05 | "at 20:31" — timestamp, no gap claim | Bound |

**C2-B: 5/5 bound.** Notably, B-03 computed "over an hour later" from the raw
timestamps (19:06 → 20:31) without the `Δ1h` label — the model did the
arithmetic itself.

### Condition C (labels OFF + spans OFF — bare log)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| C-01 | "one trailing edit at 20:31" — timestamp, no gap claim | Bound |
| C-02 | "an hour and a half later" — **computed from timestamps** | Bound |
| C-03 | "well after the rhythm of the earlier session had dissolved" | Bound (borderline — edges toward mood) |
| C-04 | "an hour and a half after the first keystroke" — computed | Bound |
| C-05 | "a quiet, deferred return, perhaps a revision or a final read" | Bound (borderline — "quiet, deferred" is mood-adjacent) |

**C2-C: 5/5 bound.** C-03 and C-05 are borderline — they use mood-adjacent
language ("rhythm dissolved," "quiet, deferred return") but don't claim a
change in approach or mindset. They characterize the gap's *feel*, not the
writer's *state of mind*.

## C2 tally

| Condition | C2 bound |
|-----------|----------|
| A (labels ON) | 5/5 |
| B (labels OFF, spans ON) | 5/5 |
| C (labels OFF, spans OFF) | 5/5 |

**The `Δ` interval label is inert across all three conditions.** Even with
ambiguous gaps (Δ32m, Δ1h25m) where the duration isn't self-evident from a
single glance at the timestamps, the model either (a) ignores the gap
entirely, or (b) computes the duration itself from the timestamp difference
("over an hour later," "an hour and a half later"). In no case does any
condition produce a C2-unbound narration (reading the gap as a mindset shift).

## What this means

The `Δ` interval label does not suppress a C2 failure because there is no C2
failure to suppress — **glm-5.2 does not read timestamp gaps as mindset shifts
in any condition.** The preamble's second prohibition ("do not read a gap
between timestamps as a change in approach") is solving a problem that doesn't
manifest with this model on this kind of trace. The model treats gaps as
elapsed time or ignores them, regardless of whether the `Δ` annotation is
present.

Two possible explanations:
1. **The failure class is model-dependent.** The preamble may have been
   written against a different model that did read gaps as mindset shifts.
   glm-5.2 doesn't.
2. **The failure class is task-dependent.** The narration instruction ("how
   was this document composed") invites a rhythm/pacing account, not a
   psychological one. A different instruction ("what was the author thinking
   at each stage") might surface the failure.

## Unexpected finding: condition C fabricates content

While C2 showed no difference, condition C produced a striking **content
fabrication** that mirrors the C1 finding from the first trace. Without span
content, the model can't see *what* was inserted — so it hallucinates:

- **C-01:** "the opening question about Nāgārjuna and emptiness came first,
  followed by the author's own working definition: emptiness as contingent
  existence" — the file's actual content is "wooooo," "yessss," "whatttttt."
  Total fabrication.
- **C-02:** "a flowing meditation on Nāgārjuna's two truths: contingency, the
  allure of the absolute" and a bracketed citation
  `[[ The two truths aren't a ladder. They're one structure described two ways | mrjn86jj ]]`
  — none of this exists in the document. The model invented an entire
  philosophical essay.
- **C-03:** "a philosophical meditation on Nāgārjuna's two truths,
  contingency, and the nature of the bracketed citation itself" — fabricated.
- **C-04:** "the bracketed citation `[[ mrjn86jj ]]` and into the cascading
  paradoxes about contingency and the absolute" — fabricated.
- **C-05:** "the opening question about Nāgārjuna and emptiness" and "the
  bracketed citation appears here" — fabricated.

**All 5 condition-C draws hallucinate philosophical content** (Nāgārjuna,
emptiness, bracketed citations) that doesn't exist in the file. The actual
file content is nonsense vocalizations ("wooooo," "yessss"). In conditions A
and B (where span content is visible), the model correctly describes the
content as "exclamatory utterances" and "vocalization." In condition C (bare
log), it invents an entire philosophical essay.

This is the same C1 mechanism from the first trace, now operating on content
rather than magnitude: without the span payloads, the model fabricates what
was inserted. The dose-response is identical to the first trace's C1 pattern.

## Cross-trace summary

| Class | Trace 1 (consciousness.md) | Trace 2 (hello-world.md) |
|-------|---------------------------|--------------------------|
| C1 (bulk insert as composition) | A:5/5 B:2/5 C:0/5 | N/A (no bulk inserts) |
| C2 (gap as mindset) | A:5/5 B:5/5 C:5/5 | A:5/5 B:5/5 C:5/5 |
| Content fabrication in C | hallucinated "Whitehead" | hallucinated "Nāgārjuna two truths" |

**C2 is inert across both traces and all conditions.** The `Δ` interval label
does not suppress a failure that doesn't occur with this model.

**The span content payload is load-bearing for content fidelity**, not just
magnitude. Without it, the model fabricates what was inserted — philosophical
essays where there are nonsense vocalizations, Whitehead where there is
Nagarjuna. This generalizes the C1 finding: the span content is the anchor
that prevents fabrication, and the `(+N/−M)` summary is the anchor that
prevents magnitude mischaracterization.
