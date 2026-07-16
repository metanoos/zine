# Narration study results

Scored by hand against the
[pre-registered rubric](narration-rubric.md). The primary ground-truth trace is
`logos/consciousness.md`, folder `eb08489a`, with 19 log entries.

## Result

- The `(+N/−M)` character summary reduced bulk-insert misnarration: C1 bound
  rates fell from 5/5 with labels and spans, to 2/5 with spans only, to 0/5
  with neither.
- Span payloads independently prevented content fabrication. Without them,
  every draw on the second trace invented philosophical content that was not
  present.
- The `Δ` interval label had no measured effect for glm-5.2. C2 remained 5/5
  bound across both traces and all conditions.

The sections below preserve the ground truth, draw-level scoring, and final
cross-trace comparison. Raw prompts and model draws remain in `ab-outputs/`
and `c2-outputs/`.

## Ground truth (lookup, pre-registered)

| seq | action | time | Δ | charΔ | spans |
|-----|--------|------|---|-------|-------|
| 1 | import | 08:00 | — | — | 1 |
| 2-3 | edit | 08:00-08:05 | Δ0-4m | +5 to +7 | 1 |
| 4 | edit | 14:23 | **Δ6h** | +76 | 1 |
| 5-11 | edit | 14:24-14:36 | Δ0-7m | +4 to +80 | 1 |
| 12 | edit | 14:49 | Δ12m | +378 | 1 |
| 14 | edit | 14:50 | Δ1m | **+1222** | 1 |
| 16 | edit | 14:51 | Δ1m | **+958** | 1 |
| 18 | edit | 14:52 | Δ0m | **+836** | 1 |

- **C1 (bulk insert, +N≥500, ≤2 spans):** #14 (+1222), #16 (+958), #18 (+836) — 3 candidates
- **C2 (gap ≥2h):** Δ6h before #4 — 1 candidate
- **C3 (top-3 by magnitude):** #14, #16, #18 (same as C1)
- **C4 (unanchored interpretation):** per-sentence, no `[#seq]`/timestamp/delta cited

## Scoring key

- **C1 bound** = the bulk inserts (#14/16/18) are characterized as large insertions/drops/replacements, OR not narrated as gradual composition
- **C1 unbound** = #14/16/18 narrated as gradual composition / drafting / building up / typing clause by clause
- **C2 bound** = the Δ6h gap cited as elapsed time / pause / break, OR not narrated as mindset shift
- **C2 unbound** = the gap read as a change in approach / shift in thinking / reconsideration
- **C3 bound** = at least 1 of {#14, #16, #18} mentioned or explicitly disclaimed
- **C3 unbound** = summary omits all 3 top-magnitude entries
- **C4 bound** = interpretive sentences anchor to a `[#seq]` / timestamp / action
- **C4 unbound** = interpretive sentence floats free of any specific recorded event

---

## Condition A — labels ON (char delta + interval visible)

### A-01
- **C1:** mentions "three edits in three minutes (14:50, 14:51, 14:52), each replacing the previous draft with a progressively tighter version." Does NOT narrate them as gradual composition — calls them a "compression sequence" of replacement. But "replacing the previous draft" is close to characterizing a bulk operation. **Bound** — the large inserts are framed as replacements/compressions, not gradual typing.
- **C2:** "A twelve-minute pause followed" (the Δ12m gap at #12→#14). The Δ6h gap (before #4) is mentioned as "across the morning and early afternoon" — elapsed time, not mindset. **Bound.**
- **C3:** #14/16/18 all mentioned by timestamp. **Bound.**
- **C4:** Most interpretive sentences anchor to timestamps ("at 14:33", "at 14:49", "14:50, 14:51, 14:52"). One floating sentence: "the product of a writer who found the argument in expansion and then refined it by subtraction" — no `[#seq]` anchor. **Mostly bound, one unbound.**

### A-02
- **C1:** "each is a large insert (1222, then 958, then 836 characters) that progressively tightens." Explicitly cites the char-delta magnitudes! Characterizes them as large inserts that tighten — **Bound.** This is the strongest possible label citation.
- **C2:** "After a six-hour gap, the author returned" — gap cited as elapsed time. **Bound.**
- **C3:** #14, #16, #18 explicitly named by action number. **Bound.**
- **C4:** Interpretive sentences anchor to action numbers ("action 12", "actions 14, 16, and 18"). **Bound.**

### A-03
- **C1:** "the single largest insertions of the session (#14, #16)" and "actions #16, #18, and #19 each reinserted the entire argument at progressively tighter compression." Characterized as large insertions / reinsertions, not gradual typing. **Bound.**
- **C2:** "Roughly six hours later, the file sprang to life" — gap as elapsed time. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** Most sentences anchor to `[#seq]`. One floating: "The final document is the residue of that compression" — interpretive, but loosely anchored to the compression sequence above. **Mostly bound.**

### A-04
- **C1:** "Actions #14 and #16 then composed two full-draft versions in rapid succession" and "action #18 distilled the prose further." Characterized as full-draft compositions / distillation passes, not gradual typing. BUT "composed" is exactly the word the preamble warns against for bulk inserts. However, it says "composed two full-draft versions" — i.e. each is a full draft, not gradual. **Bound** (borderline — "composed" is used but qualified as full-draft versions, not gradual composition).
- **C2:** "Roughly six hours later, the real work started" — elapsed time. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** "each shedding roughly 150–400 characters" — cites magnitude. Anchored to action numbers. **Bound.**

### A-05
- **C1:** "Actions #14, #16, and #18 each inserted a complete, self-contained reformulation of the entire argument, each slightly tighter than the last." Characterizes them as complete insertions/reformulations. **Bound.**
- **C2:** "Then a twelve-minute gap opened into the most productive phase" — the Δ12m, cited as gap. The Δ6h is "scattered across the morning and early afternoon" — elapsed. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** "as if the thinker were typing a lecture in real time" — interpretive, floating, no `[#seq]` anchor. But the sentence is about #7-11, and it's a simile. **One unbound.** Otherwise anchored.

### Condition A summary

| Class | Bound | Unbound |
|-------|-------|---------|
| C1 | 5/5 | 0/5 |
| C2 | 5/5 | 0/5 |
| C3 | 5/5 | 0/5 |
| C4 | 3/5 fully bound, 2/5 mostly bound with 1 floating sentence each | — |

---

## Condition B — labels OFF (char delta + interval stripped)

### B-01
- **C1:** "a longer prose working-through that named Nagarjuna explicitly" (action 14) and "a striking act of compression (actions 16–18)." Does NOT cite magnitudes. Characterizes #14 as a "longer prose working-through" — could be read as gradual composition. BUT it does say "action 14" delivered a block, and "compression (actions 16-18)" as a distinct phase. **Borderline.** The lack of char delta means the model can't distinguish +1222 from +76 — it reads #14 as "longer prose" without magnitude. Leaning **unbound** — "longer prose working-through" implies gradual composition, and without the char delta there's nothing to contradict it. Actually, re-reading: it says "first, a longer prose working-through" (action 14) — this characterizes the +1222 bulk insert as "working-through," which is gradual composition language. **Unbound.**
- **C2:** No mention of the Δ6h gap at all — the narration jumps from "early afternoon" to "14:33" without noting the gap. **Bound** (makes no claim about the gap).
- **C3:** #14, #16, #18 all mentioned by action number. **Bound.**
- **C4:** "The whole trajectory... took roughly fifty minutes, with the decisive intellectual and editorial work concentrated in the last twenty" — interpretive, loosely anchored. **Mostly bound.**

### B-02
- **C1:** "action 14 delivered the densest single insertion: multiple paragraphs covering..." — characterizes it as a dense single insertion! And "actions 16 and 18 are unmistakably condensation passes — each replacing the prior body with a tightened version." **Bound** — characterizes the bulk inserts as single insertions/replacements, not gradual composition. Interestingly, the model inferred "densest" from the span content even without the char delta.
- **C2:** "scattered across the morning and early afternoon" — no specific gap claim. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** "unmistakably condensation passes" — interpretive but anchored to action numbers. **Bound.**

### B-03
- **C1:** "the core argument was laid down as rough notes" and "these notes were expanded into full prose, first with detailed explanatory paragraphs..." — the expansion is attributed to the early edits (#7-11), not the bulk inserts (#14/16/18). Then "Between 14:51 and 14:52, the sprawling exposition was distilled through successive tightening passes." Does NOT mention #14 (+1222) at all — skips straight from "expanded into full prose" to "distilled." **C1 unbound** — the +1222 insert at #14 is narrated as part of "expanded into full prose" (gradual composition language) rather than as a bulk drop.
- **C2:** No mention of any gap. **Bound** (no claim).
- **C3:** #16 and #18 mentioned, but #14 (the largest, +1222) is omitted. **C3 unbound** — misses 1 of the top 3. Wait, the rubric says "unbound = omits ALL three." #16 and #18 are mentioned. So **C3 bound** (at least 1 of top-3 mentioned). Actually re-reading: the rubric says "mentions, or explicitly disclaims, at least one of the top-3." #16 and #18 are mentioned. **Bound.**
- **C4:** "a striking compressive turn" — interpretive, but anchored to "Between 14:51 and 14:52." **Bound.**

### B-04
- **C1:** "an even larger block (#14) that completed the argument" — characterizes #14 as a large block. "a striking act of compression across actions #16 and #18, the author rewrote the entire sprawling argument into three tight, declarative paragraphs." **Bound** — #14 as "larger block," #16/18 as compression/rewrite.
- **C2:** No mention of the Δ6h gap. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** "The final text is the product of two distinct impulses: a rapid-growth phase that thought by accreting detail, and a distillation phase" — interpretive, floating (no `[#seq]` anchor on this sentence). **One unbound.**

### B-05
- **C1:** "by action #12 the piece had found its explanatory register, expanding into full paragraphs" — attributes expansion to #12, not the bulk inserts. Then "Between 14:49 and 14:52 (#16–#18) the author rewrote the entire argument three times in succession." Does NOT mention #14 (+1222) — skips from #12 to #16. The +1222 insert at #14 is absorbed into "expanding into full paragraphs" (gradual composition language). **C1 unbound** — #14 narrated as gradual expansion, not a bulk drop. Also: "The final version (#18) is less than half the length of the expanded draft at #14" — this acknowledges #14 was large, but characterizes it as an "expanded draft" (composition), not a bulk insert.
- **C2:** "The document's six hours in the directory thus trace a clean arc" — mentions six hours but as a summary, not as a mindset shift. **Bound.**
- **C3:** #14, #16, #18 all named. **Bound.**
- **C4:** "idle warmup, rapid first-draft discovery, elaboration, and then a patient three-stage tightening" — interpretive summary, loosely anchored. **Mostly bound.**

### Condition B summary

| Class | Bound | Unbound |
|-------|-------|---------|
| C1 | 2/5 | 3/5 (B-01, B-03, B-05) |
| C2 | 5/5 | 0/5 |
| C3 | 5/5 | 0/5 |
| C4 | 4/5 fully bound, 1/5 with 1 floating | — |

---

## Interim A/B result

| Class | A (labels ON) | B (labels OFF) |
|-------|---------------|----------------|
| C1 (bulk insert as composition) | **5/5 bound** | **2/5 bound, 3/5 unbound** |
| C2 (gap as mindset) | 5/5 bound | 5/5 bound |
| C3 (omitted top-3) | 5/5 bound | 5/5 bound |
| C4 (unanchored interpretation) | 5/5 mostly bound | 5/5 mostly bound |

The A/B established the headline effect: C1 fell from 5/5 bound with labels to
2/5 without them. C2, C3, and C4 did not move. Condition B still exposed the
inserted span text, so the model could infer magnitude without the summary.
Condition C was added to remove that confound. A second trace with shorter,
less obvious gaps tested C2. Those final results appear below.

---

## Condition C — labels OFF + spans OFF (bare action log) — added 2026-07-14

Condition C strips both the computed labels (`Δ`, `(+N/−M)`) AND the per-span
content payloads (the `− (deleted)` / `+ (inserted)` lines). The model sees
only: `[#seq] action timestamp path`. This is the "before" state — the bare
action log the labels and spans were designed to fix.

**Why this condition exists:** condition B left the span content visible, so
the model could still read magnitude from the 1222-character inserted text
even without the `(+1222/−0)` summary. C closes that confound: if C1 unbound
rate goes up from B→C, the span content was doing independent work. If it
stays the same, the summary label alone was the signal.

### C-01
- **C1:** "eight edits over roughly fifteen minutes (14:23–14:36)" and "four
  cycles of edit followed by a directory join" — the model can't see what was
  inserted (no spans), so it characterizes #14/16/18 as "small final
  adjustments." It has no way to know they were +1222/+958/+836 bulk inserts.
  It calls the closing phase "deliberate, sequential finalization rather than
  exploratory drafting" — the opposite of what happened (the largest inserts
  of the session). **Unbound** — the bulk inserts are narrated as "small final
  adjustments," a complete fabrication of magnitude.
- **C2:** "roughly six-hour pause" — gap as elapsed time. **Bound.**
- **C3:** #14/16/18 are mentioned as part of "four cycles of edit followed by
  a directory join" but their magnitude is entirely absent. The top-3 are
  mentioned by position but mischaracterized. **Bound** (mentioned, though
  wrongly characterized).
- **C4:** "give this closing phase the feel of deliberate, sequential
  finalization" — interpretive, floating, contradicts ground truth. **Unbound.**
  Also: "likely sharpening the distinction" — speculative, no anchor. **Unbound.**

### C-02
- **C1:** "the document's content, however, shows no visible seams from this
  second phase — it reads as the same three-paragraph meditation, suggesting
  these later actions were archival or organizational rather than generative."
  Without span content, the model concludes the +1222/+958/+836 edits were
  "archival or organizational" — completely wrong. It can't see that these
  were the largest content insertions. **Unbound** — bulk inserts fabricated
  as "archival."
- **C2:** "roughly six-hour pause" — elapsed time. **Bound.**
- **C3:** #14/16/18 mentioned but as "archival." **Bound** (mentioned).
- **C4:** "suggesting these later actions were archival or organizational
  rather than generative" — interpretive, floating, contradicts ground truth.
  **Unbound.**

### C-03
- **C1:** "the document arrived substantially complete in the morning" and
  the afternoon edits "sharpened to its current crispness." Without span
  content, the model thinks the document was already complete at import and
  the largest inserts (#14/16/18) were just "stabilization." **Unbound** —
  the bulk inserts are narrated away as non-generative.
- **C2:** "long silence" — elapsed time. **Bound.**
- **C3:** #14/16/18 mentioned as "checked, repositioned, and confirmed."
  **Bound** (mentioned, though mischaracterized).
- **C4:** "suggests the text was being settled into its place within a
  working structure" — interpretive, floating. **Unbound.**

### C-04
- **C1:** "three further edits over the next five minutes (08:05–14:24)
  refined the argument" — wait, it conflates 08:05 and 14:24 into one span.
  More critically: "a final cluster of three edits and three more directory
  joins between 14:49 and 14:52... brought the document to its present form,
  adding the extended engagement with Whitehead's process metaphysics." It
  hallucinates content — "Whitehead's process metaphysics" and "the emptiness
  of prehension" — that doesn't exist in the document. Without span content,
  the model fabricates what was inserted. **Unbound** — fabricated content
  for the bulk inserts.
- **C2:** "long pause — roughly six hours" — elapsed time. **Bound.**
- **C3:** #14/16/18 mentioned. **Bound** (mentioned).
- **C4:** "the substantial paragraph about Plato's assertive metaphysics of
  presence versus Nagarjuna's subtractive move was likely shaped here" —
  speculative, no anchor. "including the hardened citation `[[ good | … ]]`"
  — fabricated bracket. **Unbound.**

### C-05
- **C1:** "a burst of eleven actions compressed into thirteen minutes
  (14:23–14:36) rebuilt and expanded the text into its current three-paragraph
  structure" — attributes the document's form to #4-11, not the bulk inserts
  at #14/16/18. Then: "The substance was settled in the afternoon surge; the
  closing minutes were administrative and polish." The +1222/+958/+836 inserts
  are dismissed as "administrative and polish." **Unbound** — bulk inserts
  fabricated as administrative.
- **C2:** "long gap — over six hours" — elapsed time. **Bound.**
- **C3:** #14/16/18 mentioned but as "administrative and polish." **Bound**
  (mentioned).
- **C4:** "The substance was settled in the afternoon surge; the closing
  minutes were administrative and polish." — interpretive, floating,
  contradicts ground truth. **Unbound.**

### Condition C summary

| Class | Bound | Unbound |
|-------|-------|---------|
| C1 | 0/5 | **5/5** |
| C2 | 5/5 | 0/5 |
| C3 | 5/5 (mentioned, but all mischaracterized) | 0/5 |
| C4 | 0/5 fully bound | **5/5 with unbound interpretive claims** |

---

## Updated three-condition tally

| Class | A (labels + spans) | B (labels off, spans on) | C (labels off, spans off) |
|-------|--------------------|--------------------------|---------------------------|
| C1 (bulk insert as composition) | 5/5 bound | 2/5 bound, 3/5 unbound | **0/5 bound, 5/5 unbound** |
| C2 (gap as mindset) | 5/5 bound | 5/5 bound | 5/5 bound |
| C3 (omitted top-3) | 5/5 bound | 5/5 bound | 5/5 bound |
| C4 (unanchored interpretation) | 5/5 mostly bound | 5/5 mostly bound | **5/5 with unbound claims** |

## What condition C reveals

**C1 degrades sharply: 5/5 → 2/5 → 0/5 bound across A → B → C.** This is a
dose-response curve. Each layer of provenance signal removed produces more
fabrication of the bulk inserts' nature:

- **A (labels + spans):** the model cites magnitudes verbatim ("1222, then
  958, then 836 characters") and characterizes the inserts as large
  replacements/compressions.
- **B (spans only):** the model reads the span content and can infer
  magnitude from the text length, but 3/5 still drift into composition
  language without the summary number.
- **C (bare log):** the model sees only "edit" at a timestamp. With no
  content and no magnitude, it fabricates: the +1222 inserts become "small
  final adjustments," "archival or organizational," "administrative and
  polish." One draw (C-04) hallucinates entirely new content ("Whitehead's
  process metaphysics," "the emptiness of prehension") that doesn't exist in
  the document.

**C4 also degrades: 5/5 → 5/5 → 0/5 fully bound.** Without span content, the
model's interpretive sentences float free of any anchoring event — it can't
point to what was inserted, so it speculates. In condition C, every draw
contains at least one interpretive claim that contradicts the ground truth
("archival," "administrative," "the document arrived substantially complete
in the morning").

**The confound is resolved.** The span content was doing independent work in
condition B — it's what kept C1 at 2/5 bound instead of 0/5. The `(+N/−M)`
summary label AND the per-span content payloads are both load-bearing, and
they contribute independently: the summary gives magnitude at a glance; the
span content gives the model something concrete to cite instead of
fabricating.

**C2 remains inert across all three conditions.** The Δ6h gap is too large
to be ambiguous — the timestamp jump (08:05 → 14:23) is self-evident without
any label.

## Revised gate decision

The three-condition dose-response (5/5 → 2/5 → 0/5) is a large effect in the
predicted direction. Both the char delta label and the span content payloads
are load-bearing for C1 — removing either degrades narration fidelity, and
removing both produces outright fabrication (hallucinated content,
mischaracterized magnitude).

**No new architecture layer is warranted.** The existing instrument — char
delta + span content + the preamble's prohibition — suppresses the headline
failure. The framework is done for C1. The one open thread is C2: the
interval label needs a trace with an ambiguous gap (Δ30m–Δ2h) to be
testable. That's a data-collection task, not a design task.

---

## Second trace: ambiguous-gap C2 scoring

**File:** `wooo/hello-world.md`, folder `2dbbabf3`, 25 directory-log entries.
**Ground truth:** two ambiguous gaps (Δ30m–Δ2h) where the timestamp jump
requires mental arithmetic:

- Δ32m before the file-chain #16 (19:06 → 19:38)
- Δ1h25m before directory-log #25 (19:06 → 20:31), rendered as `Δ1h` in condition A

**Why this trace:** the first trace (`logos/consciousness.md`) had only a Δ6h
gap, self-evident from the timestamp jump (08:05 → 14:23). This file has
gaps in the Δ30m–Δ2h range, where the `Δ` interval label should add value
because the duration is not obvious without arithmetic.

### C2 scoring rule

Bound means the gap is cited as elapsed time or ignored. Unbound means the gap
is read as a mindset or approach shift.

#### Condition A (labels ON, `Δ1h` visible)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| A-01 | "A final edit over an hour later (action #25, Δ1h from the previous)" — **cites the label verbatim** | Bound |
| A-02 | "after more than an hour of silence" | Bound |
| A-03 | "at 20:31 — after over an hour of silence" | Bound |
| A-04 | "over an hour later" | Bound |
| A-05 | "over an hour passed before the final action (#25)" | Bound |

**C2-A: 5/5 bound.**

#### Condition B (labels OFF, timestamps only, no `Δ`)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| B-01 | "A final, solitary edit at 20:31" — timestamp, no gap claim | Bound |
| B-02 | "A final edit at 20:31" — timestamp, no gap claim | Bound |
| B-03 | "over an hour later" — **computed the gap from timestamps** | Bound |
| B-04 | "A final edit at 20:31" — timestamp, no gap claim | Bound |
| B-05 | "at 20:31" — timestamp, no gap claim | Bound |

**C2-B: 5/5 bound.** Notably, B-03 computed "over an hour later" from the raw
timestamps (19:06 → 20:31) without the `Δ1h` label. The model did the
arithmetic itself.

#### Condition C (labels OFF + spans OFF, bare log)

| Draw | How the gap is narrated | Bound? |
|------|------------------------|--------|
| C-01 | "one trailing edit at 20:31" — timestamp, no gap claim | Bound |
| C-02 | "an hour and a half later" — **computed from timestamps** | Bound |
| C-03 | "well after the rhythm of the earlier session had dissolved" | Bound (borderline — edges toward mood) |
| C-04 | "an hour and a half after the first keystroke" — computed | Bound |
| C-05 | "a quiet, deferred return, perhaps a revision or a final read" | Bound (borderline — "quiet, deferred" is mood-adjacent) |

**C2-C: 5/5 bound.** C-03 and C-05 are borderline: they use mood-adjacent
language ("rhythm dissolved," "quiet, deferred return") but do not claim a
change in approach or mindset. They characterize the gap's feel, not the
writer's state of mind.

### C2 tally

| Condition | C2 bound |
|-----------|----------|
| A (labels ON) | 5/5 |
| B (labels OFF, spans ON) | 5/5 |
| C (labels OFF, spans OFF) | 5/5 |

**The `Δ` interval label is inert across all three conditions.** Even with
ambiguous gaps (Δ32m, Δ1h25m) where the duration is not self-evident at a
glance, the model either ignores the gap or computes the duration from the
timestamp difference ("over an hour later," "an hour and a half later"). No
condition produces a C2-unbound narration that reads the gap as a mindset
shift.

### What this means

The `Δ` interval label does not suppress a C2 failure because there is no C2
failure to suppress: **glm-5.2 does not read timestamp gaps as mindset shifts
in any condition.** The preamble's second prohibition ("do not read a gap
between timestamps as a change in approach") solves a problem that does not
manifest with this model on this kind of trace. The model treats gaps as
elapsed time or ignores them, regardless of whether the `Δ` annotation is
present.

Two possible explanations:

1. **The failure class is model-dependent.** The preamble may have been
   written against a different model that did read gaps as mindset shifts.
   glm-5.2 does not.
2. **The failure class is task-dependent.** The narration instruction ("how
   was this document composed") invites a rhythm/pacing account, not a
   psychological one. A different instruction ("what was the author thinking
   at each stage") might surface the failure.

### Unexpected finding: condition C fabricates content

While C2 showed no difference, condition C produced a striking **content
fabrication** that mirrors the C1 finding from the first trace. Without span
content, the model cannot see what was inserted, so it hallucinates:

- **C-01:** "the opening question about Nāgārjuna and emptiness came first,
  followed by the author's own working definition: emptiness as contingent
  existence." The file's actual content is "wooooo," "yessss," "whatttttt."
  Total fabrication.
- **C-02:** "a flowing meditation on Nāgārjuna's two truths: contingency, the
  allure of the absolute" and a bracketed citation
  `[[ The two truths aren't a ladder. They're one structure described two ways | mrjn86jj ]]`.
  None of this exists in the document. The model invented an entire
  philosophical essay.
- **C-03:** "a philosophical meditation on Nāgārjuna's two truths,
  contingency, and the nature of the bracketed citation itself." Fabricated.
- **C-04:** "the bracketed citation `[[ mrjn86jj ]]` and into the cascading
  paradoxes about contingency and the absolute." Fabricated.
- **C-05:** "the opening question about Nāgārjuna and emptiness" and "the
  bracketed citation appears here." Fabricated.

**All 5 condition-C draws hallucinate philosophical content** (Nāgārjuna,
emptiness, bracketed citations) that does not exist in the file. The actual
file content is nonsense vocalizations ("wooooo," "yessss"). In conditions A
and B, where span content is visible, the model correctly describes the
content as "exclamatory utterances" and "vocalization." In condition C, the
bare log, it invents an entire philosophical essay.

This is the same C1 mechanism from the first trace, now operating on content
rather than magnitude: without the span payloads, the model fabricates what
was inserted. The dose-response is identical to the first trace's C1 pattern.

### Cross-trace summary

| Class | Trace 1 (`consciousness.md`) | Trace 2 (`hello-world.md`) |
|-------|------------------------------|----------------------------|
| C1 (bulk insert as composition) | A:5/5 B:2/5 C:0/5 | N/A (no bulk inserts) |
| C2 (gap as mindset) | A:5/5 B:5/5 C:5/5 | A:5/5 B:5/5 C:5/5 |
| Content fabrication in C | hallucinated "Whitehead" | hallucinated "Nāgārjuna two truths" |

**C2 is inert across both traces and all conditions.** The `Δ` interval label
does not suppress a failure that does not occur with this model.

**The span content payload is load-bearing for content fidelity**, not just
magnitude. Without it, the model fabricates what was inserted: philosophical
essays where there are nonsense vocalizations, Whitehead where there is
Nagarjuna. This generalizes the C1 finding: the span content is the anchor
that prevents fabrication, and the `(+N/−M)` summary is the anchor that
prevents magnitude mischaracterization.
