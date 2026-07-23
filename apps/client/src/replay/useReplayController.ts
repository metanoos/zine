import type { Event } from "nostr-tools";
import { useEffect, useRef, useState } from "react";

import type { TraceConformanceVerdict } from "../provenance/trace-conformance.js";
import { appendReplayStepsAtLiveEnd } from "./replay-live-sync.js";
import {
  loadReplaySpeed,
  nextReplaySpeed,
  saveReplaySpeed,
  type ReplaySpeed,
} from "./replay-speed.js";
import {
  buildReplayTimeline,
  emptyReplayDisplay,
  replayDisplayAt,
  replayDisplayThroughFrame,
  replayDisplayWithFrame,
  replayFrameIndexAtOrBefore,
  type PlayFrame,
  type ReplayDisplay,
  type ReplayStep,
} from "./replay-timeline.js";
import {
  REPLAY_IDLE_THRESHOLD_MS,
  buildReplayTiming,
  formatReplayDuration,
  replayTransition,
  type ReplayTiming,
} from "./replay-timing.js";

export interface ReplaySession {
  steps: ReplayStep[];
  index: number;
}

export interface ReplayProjectionTarget {
  activePath?: string;
  activeRecordedPanel?: number;
  clearRecordedPanel?: number;
}

interface ReplayInstallation {
  steps: ReplayStep[];
  chains: Record<string, Event[]>;
  conformance: TraceConformanceVerdict | null;
}

interface ReplayControllerOptions {
  projectDisplay: (display: ReplayDisplay, target?: ReplayProjectionTarget) => void;
}

/**
 * Own replay's read-only session and transport state. The controller projects
 * historical displays through one callback and deliberately has no access to
 * the live workspace file store.
 */
export function useReplayController({ projectDisplay }: ReplayControllerOptions) {
  const projectDisplayRef = useRef(projectDisplay);
  projectDisplayRef.current = projectDisplay;

  const [replay, setReplay] = useState<ReplaySession | null>(null);
  const replayRef = useRef<ReplaySession | null>(null);
  const replayChainsRef = useRef<Record<string, Event[]>>({});
  const [replayDisplay, setReplayDisplay] = useState<ReplayDisplay | null>(null);
  const replayDisplayRef = useRef<ReplayDisplay | null>(null);
  const [replayTiming, setReplayTiming] = useState<ReplayTiming | null>(null);
  const [replaySkipNotice, setReplaySkipNotice] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayConformance, setReplayConformance] =
    useState<TraceConformanceVerdict | null>(null);
  const replayLoadSequenceRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState<ReplaySpeed>(() => loadReplaySpeed());
  const playSpeedRef = useRef(playSpeed);
  const [playTimeline, setPlayTimeline] = useState<PlayFrame[] | null>(null);
  const playTimelineRef = useRef<PlayFrame[] | null>(null);
  const [playCursor, setPlayCursor] = useState(0);
  const playCursorRef = useRef(0);
  const [replayPlayheadAt, setReplayPlayheadAt] = useState<number | undefined>();

  useEffect(() => {
    playTimelineRef.current = playTimeline;
  }, [playTimeline]);

  useEffect(() => {
    playCursorRef.current = playCursor;
  }, [playCursor]);

  useEffect(() => {
    replayDisplayRef.current = replayDisplay;
  }, [replayDisplay]);

  useEffect(() => {
    if (!replaySkipNotice) return;
    const id = window.setTimeout(() => setReplaySkipNotice(null), 1_800);
    return () => window.clearTimeout(id);
  }, [replaySkipNotice]);

  function buildTimeline(): PlayFrame[] | null {
    const current = replayRef.current;
    if (!current) return null;
    return buildReplayTimeline(current.steps, replayChainsRef.current);
  }

  function setReplayCursor(n: number) {
    const current = replayRef.current;
    if (!current || current.steps.length === 0) return;
    const index = Math.max(0, Math.min(n, current.steps.length - 1));
    if (current.index === index) return;
    const next = { ...current, index };
    replayRef.current = next;
    setReplay(next);
  }

  function renderPlayFrame(frame: PlayFrame) {
    const current = replayRef.current;
    if (!current) return;
    if (frame.kind !== "focus") setReplayCursor(frame.stepIndex);
    const nextDisplay = replayDisplayWithFrame(
      replayDisplayRef.current ?? emptyReplayDisplay(),
      frame,
      current.steps[frame.stepIndex]?.event.id ?? "",
    );
    replayDisplayRef.current = nextDisplay;
    setReplayDisplay(nextDisplay);
    if (frame.kind === "file" && frame.path) {
      projectDisplayRef.current(nextDisplay, {
        activePath: frame.path,
        activeRecordedPanel: frame.panelIndex,
      });
    } else if (frame.kind === "focus" && frame.focus) {
      if (frame.focus.op === "mount" && frame.path) {
        projectDisplayRef.current(nextDisplay, {
          activePath: frame.path,
          activeRecordedPanel: frame.panelIndex,
        });
      } else {
        projectDisplayRef.current(nextDisplay, {
          clearRecordedPanel: frame.focus.panelIndex,
        });
      }
    }
  }

  // The play tick uses the recorded EditorTransaction/checkpoint timestamps. Long idle
  // gaps are accelerated, while every arriving action still crosses a paint
  // boundary before projection.
  useEffect(() => {
    if (!playing) return;
    const timeline = playTimelineRef.current;
    if (!timeline || timeline.length === 0) return;
    if (playCursorRef.current >= timeline.length - 1) {
      setPlaying(false);
      const lastFrame = timeline[timeline.length - 1];
      if (lastFrame) {
        setReplayPlayheadAt(lastFrame.at);
        setReplayCursor(lastFrame.stepIndex);
      }
      return;
    }
    const current = timeline[playCursorRef.current];
    const nextFrame = timeline[playCursorRef.current + 1];
    if (!current || !nextFrame) return;
    const transition = replayTransition(
      current.at,
      nextFrame.at,
      playSpeed,
      replayTiming?.idleThresholdMs ?? REPLAY_IDLE_THRESHOLD_MS,
    );
    if (transition.fastForwardedMs > 0) {
      setReplaySkipNotice(
        `Fast-forwarding ${formatReplayDuration(transition.fastForwardedMs)} of inactivity at 100×`,
      );
    }
    let paintId: number | undefined;
    const timerId = window.setTimeout(() => {
      paintId = window.requestAnimationFrame(() => {
        const next = playCursorRef.current + 1;
        const frame = timeline[next];
        if (!frame) return;
        setReplaySkipNotice(null);
        renderPlayFrame(frame);
        setReplayPlayheadAt(frame.at);
        playCursorRef.current = next;
        setPlayCursor(next);
      });
    }, transition.delayMs);
    return () => {
      window.clearTimeout(timerId);
      if (paintId !== undefined) window.cancelAnimationFrame(paintId);
    };
  }, [playing, playCursor, playSpeed, playTimeline, replayTiming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Completion is earned by reaching the end of a real replay. App observes
  // the controller cursor to advance onboarding without owning the play tick.

  function beginReplayLoad(): number {
    const sequence = ++replayLoadSequenceRef.current;
    setReplayLoading(true);
    return sequence;
  }

  function isReplayLoadCurrent(sequence: number): boolean {
    return replayLoadSequenceRef.current === sequence;
  }

  function finishReplayLoad(sequence: number) {
    if (isReplayLoadCurrent(sequence)) setReplayLoading(false);
  }

  function installReplay({ steps, chains, conformance }: ReplayInstallation) {
    const index = steps.length - 1;
    const next = { steps, index };
    replayRef.current = next;
    replayChainsRef.current = chains;
    setReplay(next);
    setReplayConformance(conformance);
    setPlaying(false);

    const timingFrames = buildReplayTimeline(steps, chains) ?? [];
    const timeline = timingFrames.length > 0 ? timingFrames : null;
    const cursor = Math.max(0, timingFrames.length - 1);
    playTimelineRef.current = timeline;
    setPlayTimeline(timeline);
    playCursorRef.current = cursor;
    setPlayCursor(cursor);
    setReplayTiming(
      buildReplayTiming(
        [
          ...timingFrames.map((frame) => frame.at),
          ...steps.map((step) => step.meta.steppedAtMs),
        ],
        timingFrames.map((frame) => frame.at),
      ),
    );
  }

  function appendLiveSteps(appended: ReplayStep[]) {
    setReplay((previous) => {
      if (!previous) return previous;
      const next = appendReplayStepsAtLiveEnd(
        previous,
        appended,
        (step) => step.event.id,
        (step) => step.meta.steppedAtMs,
      );
      if (next === previous) return previous;
      replayRef.current = next;
      return next;
    });
  }

  function replayStepTo(n: number) {
    const current = replayRef.current;
    if (!current || current.steps.length === 0) return;
    const index = Math.max(0, Math.min(n, current.steps.length - 1));
    const display = replayDisplayAt(current.steps, index);
    replayDisplayRef.current = display;
    setReplayDisplay(display);
    const target = current.steps[index];
    const targetPath = target?.folder ? "" : target?.relativePath ?? "";
    projectDisplayRef.current(display, {
      activePath: targetPath,
      activeRecordedPanel: targetPath ? display.panelIndexByPath[targetPath] : undefined,
    });
    const playheadAt = target?.meta.steppedAtMs;
    setReplayPlayheadAt(playheadAt);
    const timeline = playTimelineRef.current ?? buildTimeline();
    if (timeline && timeline.length > 0 && playheadAt !== undefined) {
      const cursor = Math.max(0, replayFrameIndexAtOrBefore(timeline, playheadAt));
      playTimelineRef.current = timeline;
      setPlayTimeline(timeline);
      playCursorRef.current = cursor;
      setPlayCursor(cursor);
    }
    setReplayCursor(index);
  }

  function seekReplayToAction(n: number) {
    const current = replayRef.current;
    if (!current || current.steps.length === 0) return;
    const timeline = playTimelineRef.current ?? buildTimeline();
    if (!timeline || timeline.length === 0) return;
    const cursor = Math.max(0, Math.min(timeline.length - 1, Math.trunc(n)));
    const target = timeline[cursor];
    if (!target) return;
    const display = replayDisplayThroughFrame(
      timeline,
      cursor,
      current.steps.map((step) => step.event.id),
    );

    setReplaySkipNotice(null);
    replayDisplayRef.current = display;
    setReplayDisplay(display);
    playTimelineRef.current = timeline;
    setPlayTimeline(timeline);
    playCursorRef.current = cursor;
    setPlayCursor(cursor);
    setReplayPlayheadAt(target.at);
    let checkpointFrame: PlayFrame | undefined;
    for (let i = cursor; i >= 0; i -= 1) {
      const frame = timeline[i];
      if (frame?.kind === "focus") continue;
      checkpointFrame = frame;
      break;
    }
    if (checkpointFrame) setReplayCursor(checkpointFrame.stepIndex);

    if (target.kind === "file" && target.path) {
      projectDisplayRef.current(display, {
        activePath: target.path,
        activeRecordedPanel: target.panelIndex,
      });
    } else if (target.kind === "focus" && target.focus) {
      if (target.focus.op === "mount" && target.path) {
        projectDisplayRef.current(display, {
          activePath: target.path,
          activeRecordedPanel: target.panelIndex,
        });
      } else {
        projectDisplayRef.current(display, {
          clearRecordedPanel: target.focus.panelIndex,
        });
      }
    } else {
      projectDisplayRef.current(display);
    }
  }

  function seekReplayToTime(at: number) {
    const timeline = playTimelineRef.current ?? buildTimeline();
    if (!timeline || timeline.length === 0) return;
    seekReplayToAction(Math.max(0, replayFrameIndexAtOrBefore(timeline, at)));
  }

  function startPlayback(): boolean {
    const current = replayRef.current;
    if (!current) return false;
    const existing = playTimelineRef.current;
    if (
      existing &&
      playCursorRef.current < existing.length - 1 &&
      replayDisplayRef.current
    ) {
      setPlaying(true);
      return true;
    }
    const timeline = buildTimeline();
    if (!timeline || timeline.length === 0) return false;
    const initialDisplay = emptyReplayDisplay();
    replayDisplayRef.current = initialDisplay;
    setReplayDisplay(initialDisplay);
    projectDisplayRef.current(initialDisplay);
    setReplayTiming(
      buildReplayTiming(
        [
          ...timeline.map((frame) => frame.at),
          ...current.steps.map((step) => step.meta.steppedAtMs),
        ],
        timeline.map((frame) => frame.at),
      ),
    );
    const first = timeline[0];
    if (first) {
      renderPlayFrame(first);
      setReplayPlayheadAt(first.at);
    }
    playTimelineRef.current = timeline;
    setPlayTimeline(timeline);
    playCursorRef.current = 0;
    setPlayCursor(0);
    setPlaying(true);
    return true;
  }

  function pausePlayback() {
    const frame = playTimelineRef.current?.[playCursorRef.current];
    if (frame) setReplayPlayheadAt(frame.at);
    setPlaying(false);
  }

  function cycleSpeed() {
    const next = nextReplaySpeed(playSpeedRef.current);
    playSpeedRef.current = next;
    setPlaySpeed(next);
    saveReplaySpeed(next);
  }

  function clearReplayNotice() {
    setReplaySkipNotice(null);
  }

  function closeReplaySurface() {
    setPlaying(false);
    setPlayTimeline(null);
    playTimelineRef.current = null;
    replayDisplayRef.current = null;
    setReplayDisplay(null);
    setReplaySkipNotice(null);
  }

  function resetReplay() {
    replayLoadSequenceRef.current += 1;
    replayRef.current = null;
    replayChainsRef.current = {};
    replayDisplayRef.current = null;
    setReplay(null);
    setReplayDisplay(null);
    setReplayPlayheadAt(undefined);
    setReplayTiming(null);
    setReplaySkipNotice(null);
    setReplayLoading(false);
    setReplayConformance(null);
    setPlaying(false);
    setPlayTimeline(null);
    playTimelineRef.current = null;
  }

  return {
    replay,
    replayRef,
    replayDisplay,
    replayTiming,
    replaySkipNotice,
    replayLoading,
    replayConformance,
    playing,
    playSpeed,
    playTimeline,
    playCursor,
    replayPlayheadAt,
    beginReplayLoad,
    isReplayLoadCurrent,
    finishReplayLoad,
    installReplay,
    appendLiveSteps,
    replayStepTo,
    seekReplayToAction,
    seekReplayToTime,
    startPlayback,
    pausePlayback,
    cycleSpeed,
    clearReplayNotice,
    closeReplaySurface,
    resetReplay,
  };
}
