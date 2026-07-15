/**
 * Process-vetting signals (protocol/rendezvous.md §5).
 *
 * The "captcha" — an automated proof-of-process that rejects sybils by reading
 * the timestamped save graph, not the prose. A human cannot do this by eyeballing
 * text: the signals are statistical (timing distributions) or cryptographic
 * (anteriority chain). This module implements the pure analysis layer.
 *
 * Two layers, split for testability (same convention as co-citation.ts):
 *   - Pure signal functions: take arrays of timestamps / edit-graph data,
 *     produce scores. Fully unit-testable, no IO.
 *   - The relay-bound fetcher (walks a peer's chain, extracts the data) is NOT
 *     here — it's excluded by convention and would live in the UI layer that
 *     already has relay access.
 *
 * The three signals (rendezvous.md §5.3), weakest to strongest:
 *   1. Anteriority chain (cryptographic, unfakeable for the past)
 *   2. Timing distribution (statistical, arms-race)
 *   3. Revision-graph entropy (statistical)
 *
 * Honest limit (rendezvous.md §5.4): a patient attacker who runs a fake corpus
 * over months, stamping faithfully, hits all three. This is cost-raising, not
 * a hard proof — same epistemic status as a captcha. The point is to make
 * "forge a vettable corpus" cost months of real process, not an afternoon.
 */

/** A single timestamped checkpoint on a trace's save chain. The minimal data
 *  the vet needs — extracted from kind-4290 TraceNodes. */
export interface CheckpointMeta {
  /** When the checkpoint was sealed (ms since epoch). */
  sealedAtMs: number;
  /** Does this node carry a valid OTS anchor (kind-1040 proof resolved to a
   *  Bitcoin block)? The anteriority signal. Undefined/unknown = treat as
   *  unstamped (the safe default — unstamped history can't be trusted as past). */
  anchored?: boolean;
  /** Character delta vs. the previous checkpoint: net chars added/removed.
   *  Positive = insert-heavy, negative = delete-heavy, zero = no-op or tag-only.
   *  Used for revision-graph entropy. */
  charDelta?: number;
  /** Number of distinct body-edit deltas on this node. A node with 1 delta is
   *  a single insertion; 10 deltas is a complex multi-region revision. */
  deltaCount?: number;
}

/** The vet's verdict on one trace. `score` is 0..1 (higher = more human-like
 *  process). `signals` breaks down the contribution so the UI can show *why*. */
export interface VetVerdict {
  score: number;
  signals: {
    anteriority: { score: number; stamped: number; total: number };
    timing: { score: number; reason?: string };
    revision: { score: number; reason?: string };
  };
  /** "reject" = machine-vet failed (score below threshold); "review" = passed
   *  machine vet, show to a human for compatibility judgment. */
  recommendation: "reject" | "review";
}

/** Default threshold: below this, the trace is rejected without human review.
 *  Tunable — this is a starting point calibrated to "instant sybils fail,
 *  real traces pass." Needs empirical adjustment against real data. */
export const DEFAULT_REJECT_THRESHOLD = 0.4;

// --- Signal 1: Anteriority chain (cryptographic) ------------------------

/** Fraction of checkpoints that carry a valid OTS anchor. The floor signal:
 *  a sybil materializing a fake history today has zero stamped past nodes.
 *
 *  Note: this counts *density* of anchors, not just existence. One anchor on
 *  the latest node (the old Affirm-only model) would score 1/N where N is the
 *  chain length — near-zero for any real trace. Distributed anteriority on
 *  Step is what makes this signal meaningful (rendezvous.md §3). */
export function anteriorityScore(checkpoints: CheckpointMeta[]): {
  score: number;
  stamped: number;
  total: number;
} {
  if (checkpoints.length === 0) return { score: 0, stamped: 0, total: 0 };
  const stamped = checkpoints.filter((c) => c.anchored === true).length;
  return { score: stamped / checkpoints.length, stamped, total: checkpoints.length };
}

// --- Signal 2: Timing distribution (statistical) ------------------------

/** Coefficient of variation (CV) of inter-event intervals. Real human writing
 *  is bursty and irregular (CV > 1); a generated corpus tends toward uniform
 *  spacing (CV near 0). Higher CV = more human-like irregularity.
 *
 *  CV = stddev / mean. A CV of 0 means perfectly uniform intervals; CV > 1
 *  means high variance (bursty). We return 0 for chains with < 2 checkpoints
 *  (can't compute intervals). */
export function timingCV(checkpoints: CheckpointMeta[]): number {
  const times = checkpoints
    .map((c) => c.sealedAtMs)
    .filter((t) => typeof t === "number" && t > 0)
    .sort((a, b) => a - b);
  if (times.length < 2) return 0;

  const intervals: number[] = [];
  for (let i = 1; i < times.length; i++) {
    intervals.push(times[i] - times[i - 1]);
  }
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (mean === 0) return 0; // all timestamps identical — uniform, not human
  const variance =
    intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length;
  const stddev = Math.sqrt(variance);
  return stddev / mean;
}

/** Score the timing signal: map CV to 0..1. CV >= 1 (clearly bursty) → 1.0;
 *  CV near 0 (suspiciously uniform) → near 0. Uses a simple linear ramp
 *  clamped to [0, 1]. Also penalizes very short chains (< 5 checkpoints)
 *  regardless of CV — not enough data to judge rhythm. */
export function timingScore(checkpoints: CheckpointMeta[]): {
  score: number;
  reason?: string;
} {
  if (checkpoints.length < 5) {
    return { score: 0.2, reason: "chain too short (<5 checkpoints)" };
  }
  const cv = timingCV(checkpoints);
  // Linear ramp: CV 0 → 0, CV 1 → 1, CV > 1 clamped to 1.
  const raw = Math.min(cv, 1);
  return { score: raw, reason: `CV=${cv.toFixed(2)}` };
}

// --- Signal 3: Revision-graph entropy (statistical) ---------------------

/** Score the revision graph: does the trace show real editing (content moved,
 *  deleted, restructured) or only appended polished text? A generator that
 *  only appends fluent paragraphs has low revision entropy; a real author
 *  deleting and restructuring has high entropy.
 *
 *  Heuristic: (a) fraction of checkpoints with negative charDelta (deletions —
 *  a strong "real revision" signal); (b) variance in deltaCount across
 *  checkpoints (uniform delta counts look generated; varied looks human). */
export function revisionScore(checkpoints: CheckpointMeta[]): {
  score: number;
  reason?: string;
} {
  const withDelta = checkpoints.filter(
    (c) => typeof c.charDelta === "number" || typeof c.deltaCount === "number",
  );
  if (withDelta.length < 3) {
    return { score: 0.3, reason: "insufficient revision data (<3 checkpoints with deltas)" };
  }

  // (a) deletion fraction: how many checkpoints removed content?
  const deletions = withDelta.filter((c) => (c.charDelta ?? 0) < 0).length;
  const deletionFraction = deletions / withDelta.length;

  // (b) delta-count variance: real revisions vary in complexity.
  const counts = withDelta.map((c) => c.deltaCount ?? 1);
  const meanCount = counts.reduce((a, b) => a + b, 0) / counts.length;
  const countVariance =
    meanCount > 0
      ? counts.reduce((s, v) => s + (v - meanCount) ** 2, 0) / counts.length
      : 0;
  const countCV = meanCount > 0 ? Math.sqrt(countVariance) / meanCount : 0;

  // Combine: deletion presence (0..0.5) + count variety (0..0.5).
  // A trace with no deletions AND uniform delta counts scores ~0 (generated).
  // A trace with deletions and varied complexity scores ~1 (human revision).
  const deletionScore = Math.min(deletionFraction * 2, 0.5); // 25% deletions → full 0.5
  const varietyScore = Math.min(countCV, 0.5);
  return {
    score: deletionScore + varietyScore,
    reason: `del=${deletionFraction.toFixed(2)}, countCV=${countCV.toFixed(2)}`,
  };
}

// --- Composition: the full verdict -------------------------------------

/** Run all three signals and compose a verdict. Weights favor anteriority
 *  (the cryptographic floor) but give meaningful weight to the statistical
 *  signals, which catch the patient-but-naive attacker.
 *
 *  Weights: anteriority 0.4, timing 0.3, revision 0.3. Tunable. */
export function vetTrace(
  checkpoints: CheckpointMeta[],
  rejectThreshold: number = DEFAULT_REJECT_THRESHOLD,
): VetVerdict {
  const anteriority = anteriorityScore(checkpoints);
  const timing = timingScore(checkpoints);
  const revision = revisionScore(checkpoints);

  const score =
    anteriority.score * 0.4 + timing.score * 0.3 + revision.score * 0.3;

  return {
    score,
    signals: { anteriority, timing, revision },
    recommendation: score >= rejectThreshold ? "review" : "reject",
  };
}
