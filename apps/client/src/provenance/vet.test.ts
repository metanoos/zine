/**
 * Vet signals — pure unit tests (protocol/rendezvous.md §5).
 *
 * Tests the three process-signal functions (anteriority, timing, revision)
 * and the composed verdict. All pure — no relay, no IO. The relay-bound
 * chain-walker that extracts CheckpointMeta from real events is excluded by
 * the codebase convention (see co-mint.test.ts / provenance.inbound.test.ts).
 *
 * The load-bearing properties tested:
 *   - An instant sybil (all unstamped) scores near-zero on anteriority
 *   - A real trace (dense stamps, bursty timing, real deletions) scores high
 *   - The verdict's reject/review threshold works
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  anteriorityScore,
  timingCV,
  timingScore,
  revisionScore,
  vetTrace,
  DEFAULT_REJECT_THRESHOLD,
  type CheckpointMeta,
} from "./vet.js";

// Helpers --------------------------------------------------------------

/** A checkpoint at time T (hours ago), with optional anchor/delta fields. */
function cp(hoursAgo: number, opts?: Partial<CheckpointMeta>): CheckpointMeta {
  return {
    steppedAtMs: Date.now() - hoursAgo * 3600_000,
    ...opts,
  };
}

/** A realistic human trace: stamped, bursty timing, with deletions. */
function humanTrace(): CheckpointMeta[] {
  return [
    cp(720, { anchored: true, charDelta: 500, deltaCount: 3 }),
    cp(718, { anchored: true, charDelta: -120, deltaCount: 2 }), // deletion
    cp(700, { anchored: true, charDelta: 800, deltaCount: 5 }),
    cp(690, { anchored: true, charDelta: -300, deltaCount: 4 }), // big deletion
    cp(500, { anchored: true, charDelta: 200, deltaCount: 1 }),
    cp(480, { anchored: true, charDelta: -50, deltaCount: 2 }),
    cp(200, { anchored: true, charDelta: 1000, deltaCount: 8 }),
    cp(190, { anchored: true, charDelta: -400, deltaCount: 6 }),
    cp(24, { anchored: true, charDelta: 300, deltaCount: 3 }),
    cp(20, { anchored: true, charDelta: -100, deltaCount: 2 }),
  ];
}

/** An instant sybil: materialized today, no anchors, uniform spacing, appends only. */
function instantSybil(): CheckpointMeta[] {
  const now = Date.now();
  return Array.from({ length: 10 }, (_, i) => ({
    steppedAtMs: now - i * 3600_000, // exactly 1h apart — perfectly uniform
    anchored: false, // none stamped
    charDelta: 500, // all positive (append-only, no deletions)
    deltaCount: 1, // uniform complexity
  })).reverse();
}

// --- Anteriority -------------------------------------------------------

test("anteriorityScore: all stamped → 1.0", () => {
  const cps = [cp(1, { anchored: true }), cp(2, { anchored: true })];
  const r = anteriorityScore(cps);
  assert.equal(r.score, 1.0);
  assert.equal(r.stamped, 2);
  assert.equal(r.total, 2);
});

test("anteriorityScore: none stamped → 0.0 (instant sybil)", () => {
  const cps = [cp(1, { anchored: false }), cp(2, { anchored: false }), cp(3, { anchored: false })];
  assert.equal(anteriorityScore(cps).score, 0.0);
});

test("anteriorityScore: partial stamping → proportional score", () => {
  const cps = [
    cp(1, { anchored: true }),
    cp(2, { anchored: false }),
    cp(3, { anchored: true }),
    cp(4, { anchored: false }),
  ];
  assert.equal(anteriorityScore(cps).score, 0.5);
});

test("anteriorityScore: empty chain → 0", () => {
  assert.equal(anteriorityScore([]).score, 0);
});

test("anteriorityScore: undefined anchored treated as unstamped", () => {
  const cps = [cp(1), cp(2)]; // no anchored field
  assert.equal(anteriorityScore(cps).score, 0);
});

// --- Timing CV ---------------------------------------------------------

test("timingCV: perfectly uniform intervals → ~0 (sybil tell)", () => {
  // 10 checkpoints exactly 1 hour apart.
  const now = Date.now();
  const cps = Array.from({ length: 10 }, (_, i) => ({
    steppedAtMs: now - (9 - i) * 3600_000,
  }));
  assert.ok(timingCV(cps) < 0.01, `expected ~0, got ${timingCV(cps)}`);
});

test("timingCV: bursty intervals → high CV (human tell)", () => {
  // Gaps: 2h, 18h, 10h, 190h, 20h, 280h, 10h, 166h, 4h — bursty and irregular.
  const cps = humanTrace();
  const cv = timingCV(cps);
  assert.ok(cv > 1.0, `expected CV > 1 (bursty), got ${cv}`);
});

test("timingCV: < 2 checkpoints → 0", () => {
  assert.equal(timingCV([cp(1)]), 0);
  assert.equal(timingCV([]), 0);
});

test("timingCV: identical timestamps → 0 (uniform edge case)", () => {
  const now = Date.now();
  const cps = Array.from({ length: 3 }, () => ({ steppedAtMs: now }));
  assert.equal(timingCV(cps), 0);
});

// --- Timing score (composed) -------------------------------------------

test("timingScore: short chain penalized regardless of CV", () => {
  const r = timingScore([cp(1), cp(2), cp(3)]); // < 5
  assert.ok(r.score <= 0.3);
  assert.ok(r.reason?.includes("too short"));
});

test("timingScore: uniform long chain scores low", () => {
  const now = Date.now();
  const cps = Array.from({ length: 10 }, (_, i) => ({
    steppedAtMs: now - (9 - i) * 3600_000,
  }));
  assert.ok(timingScore(cps).score < 0.1);
});

// --- Revision score ----------------------------------------------------

test("revisionScore: append-only (no deletions) + uniform complexity → low", () => {
  const cps = instantSybil(); // all charDelta=500, deltaCount=1
  const r = revisionScore(cps);
  assert.ok(r.score < 0.2, `expected <0.2, got ${r.score}`);
});

test("revisionScore: with deletions + varied complexity → high", () => {
  const r = revisionScore(humanTrace());
  assert.ok(r.score > 0.3, `expected >0.3, got ${r.score}`);
});

test("revisionScore: insufficient data (<3 deltas) → partial penalty", () => {
  const r = revisionScore([cp(1, { charDelta: 10 }), cp(2, { charDelta: 10 })]);
  assert.ok(r.score <= 0.3);
  assert.ok(r.reason?.includes("insufficient"));
});

// --- Composed verdict --------------------------------------------------

test("vetTrace: instant sybil → reject", () => {
  const v = vetTrace(instantSybil());
  assert.equal(v.recommendation, "reject");
  assert.ok(v.score < DEFAULT_REJECT_THRESHOLD, `expected <${DEFAULT_REJECT_THRESHOLD}, got ${v.score}`);
  assert.equal(v.signals.anteriority.score, 0); // no anchors
});

test("vetTrace: real human trace → review (passes machine vet)", () => {
  const v = vetTrace(humanTrace());
  assert.equal(v.recommendation, "review");
  assert.ok(v.score > DEFAULT_REJECT_THRESHOLD, `expected >${DEFAULT_REJECT_THRESHOLD}, got ${v.score}`);
});

test("vetTrace: empty trace → reject", () => {
  const v = vetTrace([]);
  assert.equal(v.recommendation, "reject");
  assert.ok(v.score < DEFAULT_REJECT_THRESHOLD, `empty trace should be below threshold, got ${v.score}`);
});

test("vetTrace: custom threshold works", () => {
  // A borderline trace that passes at 0.3 but fails at 0.8.
  const cps = [
    cp(100, { anchored: true, charDelta: 100, deltaCount: 1 }),
    cp(99, { anchored: true, charDelta: 100, deltaCount: 1 }),
    cp(50, { anchored: true, charDelta: 100, deltaCount: 1 }),
    cp(49, { anchored: true, charDelta: 100, deltaCount: 1 }),
    cp(1, { anchored: true, charDelta: 100, deltaCount: 1 }),
  ];
  const lenient = vetTrace(cps, 0.3);
  const strict = vetTrace(cps, 0.8);
  // Anteriority is 1.0 (all stamped), but timing/revision are weak (uniform, append-only).
  // So the score is moderate — passes lenient, fails strict.
  assert.ok(lenient.score > 0.3);
  assert.equal(strict.recommendation, "reject");
});

test("vetTrace: signals object contains all three breakdowns", () => {
  const v = vetTrace(humanTrace());
  assert.ok("anteriority" in v.signals);
  assert.ok("timing" in v.signals);
  assert.ok("revision" in v.signals);
  assert.ok(typeof v.signals.anteriority.score === "number");
  assert.ok(typeof v.signals.timing.score === "number");
  assert.ok(typeof v.signals.revision.score === "number");
});
