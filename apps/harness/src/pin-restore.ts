import DiffMatchPatch from 'diff-match-patch';
import type { Diff } from 'diff-match-patch';

import { computeDeltas } from './diff.js';
import type { DeltaSpan } from './models.js';
import type { PinnedSpan } from './pins.js';

export type PinOutcome = 'survived' | 'restored' | 'conflict';

export interface PinResult {
  pin: PinnedSpan;
  outcome: PinOutcome;
  /** Why restored where it was, or why it conflicted. */
  detail?: string;
}

export interface RestoreResult {
  restored: string;
  results: PinResult[];
}

/**
 * Chars of slack: if the model's version of the pin's slot is this many
 * times larger than the pin itself, the slot was restructured, not just
 * altered — surface a conflict rather than delete a large swath of model
 * output to enforce the pin.
 */
const MAX_SLOT_EXPANSION = 4;

/**
 * Enforce pinned spans against a model's full-file rewrite.
 *
 * A pin is its canonical `text`, not its position — offsets are meaningless
 * after any rewrite, so location is re-derived from the diff between
 * `currentContent` (pre-rewrite) and `modelOutput`. Three outcomes per pin:
 *
 *  - `survived` — the pin's text appears verbatim in the output. Left
 *    alone. This is the common case once sediment has accrued: most pins
 *    just survive each round, and over time the model is effectively only
 *    writing the unpinned remainder.
 *  - `restored` — the model rewrote the pin's span (a `replace` delta
 *    covers the pin's old range). The canonical text is spliced back in
 *    where the model put its version, replacing it.
 *  - `conflict` — the model *deleted* the pin's span (a `delete` delta
 *    covers it, with no replacement), or restructured the slot too
 *    heavily. Surfaced, NOT silently resurrected — a pin the model chose
 *    to delete needs the user's eye, not a silent reinsertion.
 *
 * The pin's canonical text always wins over the model's version of that
 * span. That is the guarantee "fixed" makes — fixed content cannot
 * silently drift across rounds.
 *
 * Provenance note: because `recordSnapshot` diffs the pre-rewrite content
 * against the post-restore content, a restored pin shows as `DIFF_EQUAL`
 * (canonical text was in both) → no delta for the pin's span. The model's
 * transient alteration never reaches disk or the trace. Across rounds the
 * pin's text is continuous in the history — that is the "sediment accrues"
 * property, and it holds without any protocol change.
 *
 * Implementation uses `computeDeltas` (cleaned, merges delete+insert into
 * `replace`) for both discrimination and coarse slot location, then narrows
 * the slot to just the pin's portion by aligning the pin's old text against
 * the delta's `newValue`. The cleaning step's tendency to merge the pin
 * with surrounding context into one replace block is exactly why the
 * narrowing step is needed: the delta's `newValue` may span context the
 * model legitimately rewrote, and we must replace only the pin's portion,
 * not clobber that context.
 *
 * Pins are processed in reverse position order (end of file first) so that
 * each restoration — which changes text at or after the current pin —
 * doesn't shift the offsets of pins earlier in the file. Results are
 * returned in the original pin order.
 */
export function restorePins(
  currentContent: string,
  modelOutput: string,
  pins: PinnedSpan[],
): RestoreResult {
  if (pins.length === 0) return { restored: modelOutput, results: [] };

  const deltas = computeDeltas(currentContent, modelOutput);
  const dmp = new DiffMatchPatch();

  // Pre-compute each delta's start offset in modelOutput by walking the
  // delta list the way applyDeltas does, accounting for EQUAL gaps between
  // deltas (which computeDeltas does not emit).
  const deltaNewStarts = new Map<DeltaSpan, number>();
  {
    let oldCursor = 0;
    let newOffset = 0;
    for (const d of deltas) {
      newOffset += d.positionStart - oldCursor; // EQUAL gap before this delta
      deltaNewStarts.set(d, newOffset);
      if (d.type === 'replace' || d.type === 'insert') {
        newOffset += d.newValue?.length ?? 0;
      }
      oldCursor = d.positionEnd;
    }
  }

  // Pair each pin with its position in currentContent. Pins whose text
  // isn't in currentContent (the file drifted from canonical between
  // rounds, e.g. an external edit changed the pinned span) are conflicts.
  interface PinWithPos {
    pin: PinnedSpan;
    pos: number;
    originalIndex: number;
  }
  const withPos: PinWithPos[] = [];
  const resultsByIndex = new Map<number, PinResult>();

  for (let i = 0; i < pins.length; i++) {
    const pin = pins[i];
    const pos = currentContent.indexOf(pin.text);
    if (pos === -1) {
      resultsByIndex.set(i, {
        pin,
        outcome: 'conflict',
        detail: 'pin text not found in pre-rewrite file (file drifted from canonical)',
      });
    } else {
      withPos.push({ pin, pos, originalIndex: i });
    }
  }
  withPos.sort((a, b) => b.pos - a.pos); // descending position

  let restored = modelOutput;
  for (const { pin, pos, originalIndex } of withPos) {
    if (restored.includes(pin.text)) {
      resultsByIndex.set(originalIndex, { pin, outcome: 'survived' });
      continue;
    }

    const pinEnd = pos + pin.text.length;
    const overlapping = deltas.filter(
      (d) => d.positionStart < pinEnd && d.positionEnd > pos,
    );

    if (overlapping.length === 0) {
      resultsByIndex.set(originalIndex, {
        pin,
        outcome: 'conflict',
        detail: 'pin in unchanged region but text not found in output',
      });
      continue;
    }

    const hasReplace = overlapping.some((d) => d.type === 'replace');
    const allDelete = overlapping.every((d) => d.type === 'delete');
    if (allDelete && !hasReplace) {
      resultsByIndex.set(originalIndex, {
        pin,
        outcome: 'conflict',
        detail: 'pin was deleted by the model (no replacement to overwrite)',
      });
      continue;
    }
    if (!hasReplace) {
      resultsByIndex.set(originalIndex, {
        pin,
        outcome: 'conflict',
        detail: 'pin position mapped to a pure insertion point',
      });
      continue;
    }

    // The model rewrote at least part of the pin. Locate the precise slot
    // in modelOutput: the region of the replace delta(s)' newValues that
    // corresponds to the pin's old range. Narrow within each delta's
    // newValue by aligning the pin's old text against the newValue, so we
    // replace only the pin's portion and preserve the model's legitimate
    // context rewrites within the same merged delta.
    const slot = locateSlot(dmp, deltas, deltaNewStarts, currentContent, pos, pinEnd);
    if (slot === null) {
      resultsByIndex.set(originalIndex, {
        pin,
        outcome: 'conflict',
        detail: 'pin slot could not be located within the model rewrite',
      });
      continue;
    }

    const modelSlotLen = slot.end - slot.start;
    if (modelSlotLen > pin.text.length * MAX_SLOT_EXPANSION) {
      resultsByIndex.set(originalIndex, {
        pin,
        outcome: 'conflict',
        detail: `pin slot restructured (${modelSlotLen} chars vs pin ${pin.text.length})`,
      });
      continue;
    }

    restored = restored.slice(0, slot.start) + pin.text + restored.slice(slot.end);
    resultsByIndex.set(originalIndex, {
      pin,
      outcome: 'restored',
      detail: `restored at offset ${slot.start} (replaced ${modelSlotLen} char(s))`,
    });
  }

  const results = pins.map((_, i) => resultsByIndex.get(i)!).filter(Boolean);
  return { restored, results };
}

/**
 * Locates the pin's slot in modelOutput. Walks the overlapping deltas in
 * order, and for each, computes the portion of the pin's old range that
 * falls inside that delta, then maps it into the delta's `newValue` by
 * aligning (lowercased, to survive case-only rewrites) the pin's old
 * portion against the newValue. The slot is the union of these mapped
 * portions across all overlapping deltas, plus any EQUAL text between them
 * that sits inside the pin's range.
 */
function locateSlot(
  dmp: DiffMatchPatch,
  deltas: DeltaSpan[],
  deltaNewStarts: Map<DeltaSpan, number>,
  currentContent: string,
  pinStart: number,
  pinEnd: number,
): { start: number; end: number } | null {
  let slotStart: number | null = null;
  let slotEnd: number | null = null;
  let prevOldEnd = 0;

  for (const d of deltas) {
    const deltaNewStart = deltaNewStarts.get(d)!;

    // EQUAL gap between previous delta and this one — text copied verbatim.
    // If it falls inside the pin's range, it's part of the slot.
    const gapStart = prevOldEnd;
    const gapEnd = d.positionStart;
    if (gapEnd > pinStart && gapStart < pinEnd) {
      const gapInPinStart = Math.max(gapStart, pinStart);
      const gapInPinEnd = Math.min(gapEnd, pinEnd);
      // Gap text maps 1:1 to new text at offset deltaNewStart - (gapEnd - gapInPinStart)
      const gapNewStart = deltaNewStart - (gapEnd - gapInPinStart);
      const gapNewEnd = gapNewStart + (gapInPinEnd - gapInPinStart);
      if (slotStart === null) slotStart = gapNewStart;
      slotEnd = gapNewEnd;
    }

    // Does this delta overlap the pin's range?
    if (d.positionStart < pinEnd && d.positionEnd > pinStart) {
      if (d.type === 'replace') {
        // Portion of the pin's old range inside this delta.
        const portionStart = Math.max(pinStart, d.positionStart);
        const portionEnd = Math.min(pinEnd, d.positionEnd);
        const portionOld = currentContent.slice(portionStart, portionEnd);

        // Align portionOld against the delta's newValue to find where the
        // pin's text maps within the model's replacement. Lowercased to
        // survive case-only rewrites (the most common model alteration).
        const subSlot = alignWithin(dmp, portionOld, d.newValue ?? '');
        if (subSlot !== null) {
          const absStart = deltaNewStart + subSlot.start;
          const absEnd = deltaNewStart + subSlot.end;
          if (slotStart === null) slotStart = absStart;
          slotEnd = absEnd;
        } else {
          // Alignment failed — fall back to the whole newValue as the slot.
          if (slotStart === null) slotStart = deltaNewStart;
          slotEnd = deltaNewStart + (d.newValue?.length ?? 0);
        }
      } else if (d.type === 'delete') {
        // Deleted old text — no new text, slot collapses to the current
        // new offset (a following replace/insert will extend it).
        if (slotStart === null) slotStart = deltaNewStart;
        // Don't advance slotEnd for a pure delete; it maps to zero width.
      }
      // 'insert' deltas have zero old width, can't overlap a non-empty pin range.
    }

    prevOldEnd = d.positionEnd;
  }

  if (slotStart === null) return null;
  if (slotEnd === null) slotEnd = slotStart;
  return { start: slotStart, end: slotEnd };
}

/**
 * Aligns `needle` (the pin's old text portion) against `haystack` (the
 * delta's full newValue, which may include context the model rewrote
 * around the pin) and returns the `[start, end)` range within haystack
 * that corresponds to needle. Lowercased for case-insensitive alignment.
 * Returns null if no meaningful alignment is found.
 */
function alignWithin(
  dmp: DiffMatchPatch,
  needle: string,
  haystack: string,
): { start: number; end: number } | null {
  if (needle.length === 0 || haystack.length === 0) return null;

  const diffs = dmp.diff_main(needle.toLowerCase(), haystack.toLowerCase());
  dmp.diff_cleanupSemantic(diffs);

  let needlePos = 0;
  let hayPos = 0;
  let start: number | null = null;
  let end: number | null = null;

  for (const [op, text] of diffs) {
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      if (start === null) start = hayPos;
      end = hayPos + text.length;
      needlePos += text.length;
      hayPos += text.length;
    } else if (op === DiffMatchPatch.DIFF_DELETE) {
      // Text in needle not in haystack (the pin's old text that the model
      // removed). Advances needle position; hayPos stays.
      needlePos += text.length;
    } else {
      // INSERT: text in haystack not in needle (the model's additions).
      // If we're inside the pin's alignment (slot open), this insert is
      // part of the model's version of the pin — extends the slot. This
      // includes trailing inserts after the last EQUAL (e.g. the model
      // appended "N BY THE MODEL." after "REWRITTE"), since those are the
      // model's continuation of the pin's replacement.
      if (start !== null) {
        end = hayPos + text.length;
      }
      hayPos += text.length;
    }
  }

  if (start === null) return null;
  if (end === null) end = start;
  return { start, end };
}
