import DiffMatchPatch from 'diff-match-patch';
import type { DeltaSpan } from './models.js';

/**
 * Decomposes the change from oldText to newText into positional
 * insert/delete/replace spans, anchored to offsets in oldText. An adjacent
 * delete+insert pair is merged into a single "replace" delta since that's
 * what a rewrite of a span looks like to a writer. Ported from the Dart
 * implementation in apps/tracer so both engines produce identical delta
 * shapes.
 */
export function computeDeltas(oldText: string, newText: string): DeltaSpan[] {
  const dmp = new DiffMatchPatch();
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  const result: DeltaSpan[] = [];
  let oldPos = 0;
  let i = 0;
  while (i < diffs.length) {
    const [op, text] = diffs[i];
    if (op === DiffMatchPatch.DIFF_EQUAL) {
      oldPos += text.length;
      i++;
      continue;
    }
    if (op === DiffMatchPatch.DIFF_DELETE) {
      const start = oldPos;
      const end = oldPos + text.length;
      const next = diffs[i + 1];
      if (next && next[0] === DiffMatchPatch.DIFF_INSERT) {
        result.push({
          type: 'replace',
          positionStart: start,
          positionEnd: end,
          oldValue: text,
          newValue: next[1],
        });
        i += 2;
      } else {
        result.push({
          type: 'delete',
          positionStart: start,
          positionEnd: end,
          oldValue: text,
          newValue: null,
        });
        i++;
      }
      oldPos = end;
      continue;
    }
    // DIFF_INSERT with no preceding delete: zero-width insertion point.
    result.push({
      type: 'insert',
      positionStart: oldPos,
      positionEnd: oldPos,
      oldValue: null,
      newValue: text,
    });
    i++;
  }
  return result;
}

/**
 * Replays deltas (as produced by computeDeltas) against base to reconstruct
 * the text they were computed from -> to. Used to rebuild a file's current
 * content by walking its trace-node chain, since only deltas are persisted
 * rather than full snapshots.
 */
export function applyDeltas(base: string, deltas: DeltaSpan[]): string {
  let result = '';
  let cursor = 0;
  for (const d of deltas) {
    result += base.slice(cursor, d.positionStart);
    if (d.newValue !== null) result += d.newValue;
    cursor = d.positionEnd;
  }
  result += base.slice(cursor);
  return result;
}
