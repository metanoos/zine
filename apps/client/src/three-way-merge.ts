/**
 * Line-based three-way merge (diff3-style) for unilateral incorporate.
 *
 * Inputs: base (common ancestor / fork point), ours (receiving chain head),
 * theirs (merge-parent head). Auto-resolves single-side edits and identical
 * both-side edits; overlapping different edits become conflict chunks the
 * press resolves by choice (ours / theirs / both / base).
 *
 * Protocol §3.8: the merge snapshot is whatever the owner seals — this module
 * only helps build that snapshot. Pure: no I/O.
 */

import { diffArrays } from "diff";

/** One region of the three-way result. */
export type MergeChunk =
  | { type: "stable"; lines: string[] }
  /** Only we changed this base region (or pure insert on our side). */
  | { type: "ours"; lines: string[] }
  /** Only they changed this base region. */
  | { type: "theirs"; lines: string[] }
  /** Both sides made the same change. */
  | { type: "same"; lines: string[] }
  /** Both sides changed differently — needs a choice. */
  | { type: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export type ConflictChoice = "ours" | "theirs" | "both" | "base";

export interface ThreeWayResult {
  chunks: MergeChunk[];
  /** Number of `conflict` chunks. */
  conflictCount: number;
  /** True when conflictCount === 0 (safe to seal without UI). */
  clean: boolean;
}

/** Split on `\n`, preserving empty trailing line semantics of `split`. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split("\n");
}

export function joinLines(lines: string[]): string {
  return lines.join("\n");
}

/** One aligned edit against base: consumes `base` lines, produces `out` lines. */
interface SideEdit {
  base: string[];
  out: string[];
}

/**
 * Collapse a jsdiff `diffArrays(base, side)` stream into sequential SideEdits
 * that each cover a base span (possibly empty for pure inserts) and the
 * corresponding side output.
 */
function sideEdits(base: string[], side: string[]): SideEdit[] {
  const parts = diffArrays(base, side);
  const edits: SideEdit[] = [];
  let i = 0;
  while (i < parts.length) {
    const p = parts[i];
    if (!p.added && !p.removed) {
      edits.push({ base: p.value, out: p.value });
      i++;
      continue;
    }
    // Collect a contiguous change: optional removes + optional adds.
    let removed: string[] = [];
    let added: string[] = [];
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) removed = removed.concat(parts[i].value);
      if (parts[i].added) added = added.concat(parts[i].value);
      i++;
    }
    edits.push({ base: removed, out: added });
  }
  return edits;
}

/**
 * Zip two SideEdit streams that both walk the same base. When both consume
 * equal base prefixes we can compare outs; when one inserts (empty base)
 * ahead of the other, emit that insert first.
 *
 * Invariant: total base lines consumed by both streams equal `base.length`.
 */
function zipEdits(ours: SideEdit[], theirs: SideEdit[]): MergeChunk[] {
  const chunks: MergeChunk[] = [];
  let oi = 0;
  let ti = 0;

  while (oi < ours.length || ti < theirs.length) {
    const o = ours[oi];
    const t = theirs[ti];

    // Pure insert on one side (empty base) — emit before the peer's next base chunk.
    if (o && o.base.length === 0 && o.out.length > 0) {
      // If both pure-insert at the same base point, treat as conflict/same.
      if (t && t.base.length === 0 && t.out.length > 0) {
        if (linesEqual(o.out, t.out)) chunks.push({ type: "same", lines: o.out });
        else chunks.push({ type: "conflict", base: [], ours: o.out, theirs: t.out });
        oi++;
        ti++;
        continue;
      }
      chunks.push({ type: "ours", lines: o.out });
      oi++;
      continue;
    }
    if (t && t.base.length === 0 && t.out.length > 0) {
      chunks.push({ type: "theirs", lines: t.out });
      ti++;
      continue;
    }

    if (!o && !t) break;
    if (!o) {
      // Only theirs remains — should be pure inserts already handled; dump rest.
      chunks.push({ type: "theirs", lines: t!.out });
      ti++;
      continue;
    }
    if (!t) {
      chunks.push({ type: "ours", lines: o.out });
      oi++;
      continue;
    }

    // Both have a non-empty base span (or both empty with empty out — skip).
    if (o.base.length === 0 && t.base.length === 0) {
      oi++;
      ti++;
      continue;
    }

    // Align on the shorter common base prefix length, splitting if needed.
    const n = Math.min(o.base.length, t.base.length);
    if (n === 0) {
      // One has base, one is stuck — shouldn't happen after insert handling.
      if (o.base.length > 0) {
        chunks.push(classify(o.base, o.out, o.base)); // treat theirs as unchanged
        oi++;
      } else {
        chunks.push(classify(t.base, t.base, t.out));
        ti++;
      }
      continue;
    }

    const oBaseHead = o.base.slice(0, n);
    const tBaseHead = t.base.slice(0, n);
    // Bases should match (same original lines). If not, fall back to conflict.
    if (!linesEqual(oBaseHead, tBaseHead)) {
      chunks.push({
        type: "conflict",
        base: oBaseHead,
        ours: o.out.slice(0, Math.min(o.out.length, n)) || o.out,
        theirs: t.out.slice(0, Math.min(t.out.length, n)) || t.out,
      });
      // Consume n base lines from each, splitting SideEdits.
      ours[oi] = splitEdit(o, n);
      theirs[ti] = splitEdit(t, n);
      if (ours[oi].base.length === 0 && ours[oi].out.length === 0) oi++;
      if (theirs[ti].base.length === 0 && theirs[ti].out.length === 0) ti++;
      continue;
    }

    // When the full edit base lengths match, use full outs.
    if (o.base.length === t.base.length) {
      chunks.push(classify(o.base, o.out, t.out));
      oi++;
      ti++;
      continue;
    }

    // Split the longer side so both advance by n base lines.
    // Approximate out proportionally is wrong for merges — conflict the whole
    // mismatched-length base region instead for safety when bases diverge in size.
    // Here bases of length n match; take proportional outs only when one side
    // is "equal" (out === base) for the head.
    const oHead = takeBaseHead(o, n);
    const tHead = takeBaseHead(t, n);
    chunks.push(classify(oHead.base, oHead.out, tHead.out));
    ours[oi] = oHead.rest;
    theirs[ti] = tHead.rest;
    if (ours[oi].base.length === 0 && ours[oi].out.length === 0) oi++;
    if (theirs[ti].base.length === 0 && theirs[ti].out.length === 0) ti++;
  }

  return mergeAdjacent(chunks);
}

function splitEdit(e: SideEdit, n: number): SideEdit {
  return {
    base: e.base.slice(n),
    // When splitting mid-change, remaining out is residual after taking head —
    // head was already emitted; leftover out stays with leftover base.
    out: e.base.length === e.out.length ? e.out.slice(n) : e.out.length > n ? e.out.slice(n) : [],
  };
}

function takeBaseHead(e: SideEdit, n: number): { base: string[]; out: string[]; rest: SideEdit } {
  const base = e.base.slice(0, n);
  // If this side didn't change (out mirrors base), head out is base head.
  if (linesEqual(e.base, e.out)) {
    return {
      base,
      out: base,
      rest: { base: e.base.slice(n), out: e.out.slice(n) },
    };
  }
  // If pure replace of whole span, don't split outs proportionally — conflict
  // will handle when peer also changed. For head: if n < full base, leave full
  // out on rest and treat head as unchanged base (conservative).
  if (n < e.base.length) {
    return {
      base,
      out: base, // pretend unchanged for the shared prefix
      rest: { base: e.base.slice(n), out: e.out },
    };
  }
  return {
    base,
    out: e.out,
    rest: { base: [], out: [] },
  };
}

function classify(base: string[], ours: string[], theirs: string[]): MergeChunk {
  const oSame = linesEqual(base, ours);
  const tSame = linesEqual(base, theirs);
  if (oSame && tSame) return { type: "stable", lines: base };
  if (oSame && !tSame) return { type: "theirs", lines: theirs };
  if (!oSame && tSame) return { type: "ours", lines: ours };
  if (linesEqual(ours, theirs)) return { type: "same", lines: ours };
  return { type: "conflict", base, ours, theirs };
}

function linesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Merge adjacent same-type non-conflict chunks for cleaner UI. */
function mergeAdjacent(chunks: MergeChunk[]): MergeChunk[] {
  const out: MergeChunk[] = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.type === c.type && c.type !== "conflict" && last.type !== "conflict") {
      (last as { lines: string[] }).lines = (last as { lines: string[] }).lines.concat(
        (c as { lines: string[] }).lines,
      );
    } else {
      out.push(c);
    }
  }
  return out;
}

/** Compute the three-way merge of base / ours / theirs. */
export function threeWayMerge(base: string, ours: string, theirs: string): ThreeWayResult {
  // Fast paths.
  if (ours === theirs) {
    const lines = splitLines(ours);
    return {
      chunks: lines.length ? [{ type: "same", lines }] : [],
      conflictCount: 0,
      clean: true,
    };
  }
  if (ours === base) {
    const lines = splitLines(theirs);
    return {
      chunks: lines.length ? [{ type: "theirs", lines }] : [],
      conflictCount: 0,
      clean: true,
    };
  }
  if (theirs === base) {
    const lines = splitLines(ours);
    return {
      chunks: lines.length ? [{ type: "ours", lines }] : [],
      conflictCount: 0,
      clean: true,
    };
  }

  const baseL = splitLines(base);
  const oursL = splitLines(ours);
  const theirsL = splitLines(theirs);
  const chunks = zipEdits(sideEdits(baseL, oursL), sideEdits(baseL, theirsL));
  const conflictCount = chunks.filter((c) => c.type === "conflict").length;
  return { chunks, conflictCount, clean: conflictCount === 0 };
}

/**
 * Apply per-conflict choices (keyed by conflict index among conflict chunks
 * only, 0..conflictCount-1) and return the merged document string.
 * Non-conflict chunks auto-resolve: stable/same/ours/theirs as labeled.
 * Missing choices default to `"ours"` (receiving owner wins).
 */
export function applyMergeChoices(
  chunks: MergeChunk[],
  choices: Record<number, ConflictChoice> = {},
): string {
  const lines: string[] = [];
  let conflictIdx = 0;
  for (const c of chunks) {
    if (c.type === "conflict") {
      const choice = choices[conflictIdx] ?? "ours";
      conflictIdx++;
      if (choice === "ours") lines.push(...c.ours);
      else if (choice === "theirs") lines.push(...c.theirs);
      else if (choice === "base") lines.push(...c.base);
      else lines.push(...c.ours, ...c.theirs); // both
    } else {
      lines.push(...c.lines);
    }
  }
  return joinLines(lines);
}

/** Auto-merged text when clean; null when conflicts remain unresolved. */
export function autoMergedText(result: ThreeWayResult): string | null {
  if (!result.clean) return null;
  return applyMergeChoices(result.chunks, {});
}

/**
 * Outcome of a background-pull merge decision (protocol §3.8 model, applied to
 * the sync loop rather than the manual incorporate flow). Pure over the three
 * sides — no relay, no chain walk; the caller supplies base/ours/theirs.
 *
 *  - noop       — ours and theirs are identical; nothing to do.
 *  - fastforward— we're still at the ancestor (no local edits); theirs wins
 *                 wholesale. No merge node is sealed; the caller overwrites.
 *  - clean      — both sides changed but diff3 resolves with no conflict.
 *                 `merged` holds the reconciled text; caller stages for review.
 *  - conflict   — overlapping edits; caller must surface a human.
 */
export type PullMergeOutcome = "noop" | "fastforward" | "clean" | "conflict";

export interface PullMergeDecision {
  outcome: PullMergeOutcome;
  /** Present only when outcome === "clean". */
  merged?: string;
}

export function decidePullMerge(
  base: string,
  ours: string,
  theirs: string,
): PullMergeDecision {
  if (theirs === ours) return { outcome: "noop" };
  // Remote didn't move off the ancestor — nothing to pull. (Distinct from
  // fastforward: here local may have edits, and they should be preserved
  // rather than swapped for a spurious merge node.)
  if (theirs === base) return { outcome: "noop" };
  // We haven't moved off the ancestor — accept the remote tip verbatim.
  if (ours === base) return { outcome: "fastforward" };
  const merged = autoMergedText(threeWayMerge(base, ours, theirs));
  if (merged === null) return { outcome: "conflict" };
  return { outcome: "clean", merged };
}
