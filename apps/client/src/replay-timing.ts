export const REPLAY_IDLE_THRESHOLD_MS = 20_000;
export const REPLAY_IDLE_SPEED_MULTIPLIER = 100;
export const REPLAY_ACTIVITY_MERGE_GAP_MS = 5_000;

export interface ReplayInterval {
  startAt: number;
  endAt: number;
  durationMs: number;
}

export type ReplayGap = ReplayInterval;

export interface ReplayActivityBubble extends ReplayInterval {
  actionCount: number;
}

export interface ReplayTiming {
  startAt: number;
  endAt: number;
  idleThresholdMs: number;
  activityMergeGapMs: number;
  gaps: ReplayGap[];
  activity: ReplayActivityBubble[];
}

function sortedTimes(times: readonly number[]): number[] {
  return times.filter(Number.isFinite).sort((a, b) => a - b);
}

function sortedUniqueTimes(times: readonly number[]): number[] {
  return [...new Set(sortedTimes(times))];
}

/**
 * Build the shared playback-time axis used by playback and the transport.
 * Every recorded action contributes one activity bubble. Bubbles whose actions
 * are no more than five seconds apart merge into one continuous burst, while
 * playback's longer idle-gap compression remains an independent concern.
 */
export function buildReplayTiming(
  times: readonly number[],
  activityTimes: readonly number[] = times,
): ReplayTiming {
  const ordered = sortedUniqueTimes(times);
  const startAt = ordered[0] ?? 0;
  const endAt = ordered[ordered.length - 1] ?? startAt;
  const idleThresholdMs = REPLAY_IDLE_THRESHOLD_MS;
  const activityMergeGapMs = REPLAY_ACTIVITY_MERGE_GAP_MS;
  const gaps: ReplayGap[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const durationMs = ordered[i] - ordered[i - 1];
    if (durationMs > idleThresholdMs) {
      gaps.push({
        startAt: ordered[i - 1],
        endAt: ordered[i],
        durationMs,
      });
    }
  }
  const activity: ReplayActivityBubble[] = [];
  const actions = sortedTimes(activityTimes);
  if (actions.length > 0) {
    let activityStartAt = actions[0] ?? 0;
    let activityEndAt = activityStartAt;
    let actionCount = 1;
    for (let i = 1; i < actions.length; i++) {
      const at = actions[i] ?? activityEndAt;
      if (at - activityEndAt <= activityMergeGapMs) {
        activityEndAt = at;
        actionCount += 1;
        continue;
      }
      activity.push({
        startAt: activityStartAt,
        endAt: activityEndAt,
        durationMs: activityEndAt - activityStartAt,
        actionCount,
      });
      activityStartAt = at;
      activityEndAt = at;
      actionCount = 1;
    }
    activity.push({
      startAt: activityStartAt,
      endAt: activityEndAt,
      durationMs: activityEndAt - activityStartAt,
      actionCount,
    });
  }
  return {
    startAt,
    endAt,
    idleThresholdMs,
    activityMergeGapMs,
    gaps,
    activity,
  };
}

/** Elapsed playback time at `at`, with accelerated idle gaps scaled inversely. */
function replayAxisElapsed(timing: ReplayTiming, at: number): number {
  const clampedAt = Math.max(timing.startAt, Math.min(timing.endAt, at));
  let elapsed = clampedAt - timing.startAt;
  for (const gap of timing.gaps) {
    const overlapStart = Math.max(timing.startAt, gap.startAt);
    const overlapEnd = Math.min(clampedAt, gap.endAt);
    const overlapMs = Math.max(0, overlapEnd - overlapStart);
    elapsed -= overlapMs;
    elapsed += overlapMs / REPLAY_IDLE_SPEED_MULTIPLIER;
  }
  return elapsed;
}

/** Map a timestamp onto the replay track's shared 0..1 playback-time axis. */
export function replayTimeFraction(timing: ReplayTiming, at: number): number {
  const span = replayAxisElapsed(timing, timing.endAt);
  if (span <= 0) return 0;
  return Math.max(0, Math.min(1, replayAxisElapsed(timing, at) / span));
}

export interface ReplayTransition {
  delayMs: number;
  fastForwardedMs: number;
}

/**
 * At 1x every ordinary recorded interval is literal wall time. Gaps over the
 * idle threshold are the sole exception: they play at 100x the selected
 * transport speed while occupying 1/100 of their recorded duration on the
 * shared playback-time axis.
 */
export function replayTransition(
  fromAt: number,
  toAt: number,
  speed: number,
  idleThresholdMs: number,
): ReplayTransition {
  const elapsed = Math.max(0, toAt - fromAt);
  if (elapsed > idleThresholdMs) {
    return {
      delayMs: elapsed / (Math.max(0.01, speed) * REPLAY_IDLE_SPEED_MULTIPLIER),
      fastForwardedMs: elapsed,
    };
  }
  return {
    delayMs: elapsed / Math.max(0.01, speed),
    fastForwardedMs: 0,
  };
}

/** Human-readable but exact enough for the inline fast-forward announcement. */
export function formatReplayDuration(ms: number): string {
  let seconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}
