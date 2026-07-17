import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReplayTiming,
  formatReplayDuration,
  replayTimeFraction,
  replayTransition,
} from "./replay-timing.js";

test("1x playback preserves active wall-clock intervals exactly", () => {
  const transition = replayTransition(1_000, 2_750, 1, 20_000);
  assert.deepEqual(transition, { delayMs: 1_750, fastForwardedMs: 0 });
  assert.equal(replayTransition(1_000, 2_750, 2, 20_000).delayMs, 875);
});

test("only inactivity over 20 seconds is fast-forwarded", () => {
  assert.deepEqual(replayTransition(1_000, 8_000, 1, 20_000), {
    delayMs: 7_000,
    fastForwardedMs: 0,
  });
  assert.deepEqual(replayTransition(1_000, 21_000, 1, 20_000), {
    delayMs: 20_000,
    fastForwardedMs: 0,
  });
  assert.deepEqual(replayTransition(1_000, 21_001, 1, 20_000), {
    delayMs: 200.01,
    fastForwardedMs: 20_001,
  });
  assert.deepEqual(replayTransition(1_000, 61_000, 1, 20_000), {
    delayMs: 600,
    fastForwardedMs: 60_000,
  });
  assert.equal(replayTransition(1_000, 61_000, 2, 20_000).delayMs, 300);
});

test("idle bands occupy their accelerated playback-time share", () => {
  const timing = buildReplayTiming([0, 1_000, 2_000, 32_000, 33_000]);
  assert.equal(timing.idleThresholdMs, 20_000);
  assert.deepEqual(timing.gaps, [{ startAt: 2_000, endAt: 32_000, durationMs: 30_000 }]);
  assert.deepEqual(timing.activity, [
    { startAt: 0, endAt: 2_000, durationMs: 2_000, actionCount: 3 },
    { startAt: 32_000, endAt: 33_000, durationMs: 1_000, actionCount: 2 },
  ]);
  // 3s active + 30s / 100 idle = a 3.3s playback axis. The idle gap
  // therefore occupies 300 / 3,300 = 1/11 of the slider, not 30/33.
  assert.equal(replayTimeFraction(timing, 2_000), 20 / 33);
  assert.equal(replayTimeFraction(timing, 17_000), 43 / 66);
  assert.equal(replayTimeFraction(timing, 32_000), 23 / 33);
});

test("each action gets a bubble and bubbles within five seconds merge", () => {
  const timing = buildReplayTiming([0, 2_000, 7_000, 12_001, 30_000]);
  assert.equal(timing.activityMergeGapMs, 5_000);
  assert.deepEqual(timing.activity, [
    { startAt: 0, endAt: 7_000, durationMs: 7_000, actionCount: 3 },
    { startAt: 12_001, endAt: 12_001, durationMs: 0, actionCount: 1 },
    { startAt: 30_000, endAt: 30_000, durationMs: 0, actionCount: 1 },
  ]);
});

test("same-time deltas merge into one point bubble without losing their count", () => {
  assert.deepEqual(buildReplayTiming([1_000, 1_000, 1_000]).activity, [
    { startAt: 1_000, endAt: 1_000, durationMs: 0, actionCount: 3 },
  ]);
});

test("activity bubbles can use action times distinct from the shared axis", () => {
  const timing = buildReplayTiming([0, 10_000, 30_000], [10_000]);
  assert.equal(timing.startAt, 0);
  assert.equal(timing.endAt, 30_000);
  assert.deepEqual(timing.activity, [
    { startAt: 10_000, endAt: 10_000, durationMs: 0, actionCount: 1 },
  ]);
});

test("the fixed idle threshold does not change for a sparse recording", () => {
  const timing = buildReplayTiming([0, 1_000, 61_000]);
  assert.equal(timing.idleThresholdMs, 20_000);
  assert.deepEqual(timing.gaps, [{ startAt: 1_000, endAt: 61_000, durationMs: 60_000 }]);
});

test("the slider marks only gaps strictly over 20 seconds", () => {
  const timing = buildReplayTiming([0, 7_000, 27_000, 47_001]);
  assert.deepEqual(timing.gaps, [
    { startAt: 27_000, endAt: 47_001, durationMs: 20_001 },
  ]);
});

test("fast-forward announcements include useful compound durations", () => {
  assert.equal(formatReplayDuration(728_000), "12m 8s");
  assert.equal(formatReplayDuration(3_661_000), "1h 1m 1s");
});
