import type { Event } from "nostr-tools";

import { groupKEditsByTransaction } from "./kedit-capture.js";
import {
  isFocusSelection,
  keditsFromEvent,
  type FocusSelection,
  type KEdit,
} from "./provenance.js";
import { pathInTraceScopes, type TraceRef } from "./scope-model.js";
import { traceProcessFromEvent } from "./trace-process.js";
import {
  applyKEditTransaction,
  flattenRuns,
  type Run,
} from "./workspace-core.js";

export interface ReplayTimelineStep {
  event: Event;
  relativePath: string;
  meta: { steppedAtMs: number };
  runsUpToHere: Run[];
  /** Optional structural label for a membership change on this Step. */
  membership?: unknown;
  /** Folder checkpoints are structural replay state. They never become a
   *  document path or a synthetic tab. */
  folder?: ReplayFolderState;
}

export interface PlayFrame {
  kind: "file" | "folder" | "focus";
  path: string;
  stepIndex: number;
  runs: Run[];
  at: number;
  /** This action is also the durable checkpoint for `stepIndex`. KEdit frames
   * before it remain ordinary editor actions; the checkpoint frame lets the
   * transport announce the Step exactly when playback reaches it. */
  reachesStep?: boolean;
  /** Exact text mutation carried by this recorded editor transaction. This is
   * reconstructed from the KEdit plus its pre-action document, so deletions
   * retain the removed text even though the wire entry stores only offsets. */
  action?: ReplayEditorAction;
  /** Character footprint of this replay action. Fine-grained frames describe
   * one editor transaction; the savepoint frame aggregates its Step. Counts
   * are Unicode code points so the UI does not report one emoji as two chars. */
  delta?: ReplayActionDelta;
  panelIndex?: number;
  folder?: ReplayFolderState;
  focus?: ReplayFocusDelta;
}

export interface ReplayActionDelta {
  inserted: number;
  deleted: number;
}

export interface ReplayEditorAction {
  type: "insert" | "delete" | "replace" | "undo" | "redo" | "snapshot";
  changes: ReplayEditorChange[];
}

export interface ReplayEditorChange {
  inserted: string;
  deleted: string;
}

export interface ReplayFileDisplay {
  runs: Run[];
  nodeId: string;
}

export interface ReplayDisplay {
  files: Record<string, ReplayFileDisplay>;
  folders: Record<string, ReplayFolderState>;
  /** Current recorded occupant of each historical panel slot. */
  panels: Record<number, string>;
  /** Last recorded slot for a path, retained across an unmount so a later edit
   *  can return to the same place when no newer mount exists. */
  panelIndexByPath: Record<string, number>;
}

export interface ReplayFolderMember {
  kind: "file" | "folder";
  relativePath: string;
  latestNodeId?: string;
  contentHash?: string;
}

export interface ReplayFocusDelta {
  type: "focus";
  op: "mount" | "unmount";
  selection: FocusSelection;
  panelIndex: number;
  timestamp: number;
}

export interface ReplayFolderState {
  path: string;
  members: ReplayFolderMember[];
  focus: ReplayFocusDelta[];
}

function charCount(text: string): number {
  return [...text].length;
}

/** Describe a transaction against the pre-transaction document. KEdit offsets
 * share that coordinate space, including multi-range edits. */
function keditAction(
  before: string,
  edits: readonly KEdit[],
): ReplayEditorAction {
  const changes = edits.map((edit) => {
    const from = Math.max(0, Math.min(edit.from, before.length));
    const to = Math.max(from, Math.min(edit.to, before.length));
    return { inserted: edit.text, deleted: before.slice(from, to) };
  });
  const intent = edits.find((edit) => edit.intent)?.intent;
  const hasInserted = changes.some((change) => change.inserted.length > 0);
  const hasDeleted = changes.some((change) => change.deleted.length > 0);
  const type = intent ?? (hasInserted && hasDeleted
    ? "replace"
    : hasDeleted
      ? "delete"
      : "insert");
  return { type, changes };
}

function actionDelta(action: ReplayEditorAction): ReplayActionDelta | undefined {
  const inserted = action.changes.reduce(
    (total, change) => total + charCount(change.inserted),
    0,
  );
  const deleted = action.changes.reduce(
    (total, change) => total + charCount(change.deleted),
    0,
  );
  return inserted > 0 || deleted > 0 ? { inserted, deleted } : undefined;
}

/** Compact a snapshot-only change to its changed middle. This mirrors the
 * protocol delta fallback: common prefix/suffix are unchanged, so the action
 * reports only the removed and inserted middles. */
function snapshotAction(before: string, after: string): ReplayEditorAction | undefined {
  if (before === after) return undefined;
  let start = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (start < maxPrefix && before[start] === after[start]) start++;

  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (
    beforeEnd > start &&
    afterEnd > start &&
    before[beforeEnd - 1] === after[afterEnd - 1]
  ) {
    beforeEnd--;
    afterEnd--;
  }
  return {
    type: "snapshot",
    changes: [{
      inserted: after.slice(start, afterEnd),
      deleted: before.slice(start, beforeEnd),
    }],
  };
}

/** Locate the last replay action at or before a wall-clock timestamp. Choosing
 *  the last same-time frame preserves every action recorded at the band's
 *  opening instant. */
export function replayFrameIndexAtOrBefore(
  frames: readonly PlayFrame[],
  at: number,
): number {
  let index = -1;
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || frame.at > at) break;
    index = i;
  }
  return index;
}

interface FolderEventContent {
  snapshot?: {
    members?: Array<{
      kind?: "file" | "folder";
      relativePath?: string;
      latestNodeId?: string;
      contentHash?: string;
    }>;
  };
  deltas?: Array<{
    type?: string;
    op?: "mount" | "unmount";
    selection?: FocusSelection;
    panelIndex?: number;
    timestamp?: number;
  }>;
}

/** Parse one signed folder checkpoint into structural replay state. The
 * snapshot drives membership and focus deltas drive panel occupancy; neither
 * is converted into editor text. */
export function folderReplayState(event: Event, path: string): ReplayFolderState {
  let parsed: FolderEventContent = {};
  try {
    parsed = JSON.parse(event.content) as FolderEventContent;
  } catch {
    // A malformed advisory body degrades to an empty structural frame. The
    // signed event still occupies its real Step position.
  }
  const members: ReplayFolderMember[] = [];
  for (const member of Array.isArray(parsed.snapshot?.members)
    ? parsed.snapshot.members
    : []) {
    if (
      typeof member.relativePath !== "string" ||
      !member.relativePath ||
      (member.kind !== "file" && member.kind !== "folder")
    ) continue;
    members.push({
      kind: member.kind,
      relativePath: member.relativePath,
      ...(typeof member.latestNodeId === "string"
        ? { latestNodeId: member.latestNodeId }
        : {}),
      ...(typeof member.contentHash === "string"
        ? { contentHash: member.contentHash }
        : {}),
    });
  }
  const focus: ReplayFocusDelta[] = [];
  for (const delta of Array.isArray(parsed.deltas) ? parsed.deltas : []) {
    if (
      delta.type !== "focus" ||
      (delta.op !== "mount" && delta.op !== "unmount") ||
      !isFocusSelection(delta.selection) ||
      !Number.isInteger(delta.panelIndex) ||
      (delta.panelIndex ?? -1) < 0 ||
      !Number.isFinite(delta.timestamp)
    ) {
      continue;
    }
    focus.push({
      type: "focus",
      op: delta.op,
      selection: delta.selection,
      panelIndex: delta.panelIndex as number,
      timestamp: delta.timestamp as number,
    });
  }
  return { path, members, focus };
}

/** Resolve one append-only trace from an unordered event set. Only a chain
 * that reaches the requested genesis is eligible. A deterministic newest-head
 * tie-break keeps replay stable if an unresolved branch is present. */
export function orderReplayTraceChain(
  events: readonly Event[],
  genesisId: string,
): Event[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  if (!byId.has(genesisId)) return [];

  const citedAsPrev = new Set<string>();
  for (const event of events) {
    const prev = event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
    if (prev) citedAsPrev.add(prev);
  }
  const heads = events
    .filter((event) => !citedAsPrev.has(event.id))
    .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id));

  for (const head of heads) {
    const newestFirst: Event[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined = head.id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const event = byId.get(cursor);
      if (!event) break;
      newestFirst.push(event);
      if (event.id === genesisId) {
        const prev = event.tags.find(
          (tag) => tag[0] === "e" && tag[3] === "prev",
        )?.[1];
        if (!prev) return newestFirst.reverse();
        break;
      }
      cursor = event.tags.find(
        (tag) => tag[0] === "e" && tag[3] === "prev",
      )?.[1];
    }
  }
  return [];
}

/** Resolve the deduplicated path union contributed by the replay selection. */
export function selectedReplayPaths(
  paths: readonly string[],
  scopes: readonly TraceRef[],
  shielded: ReadonlySet<string>,
): string[] {
  return [...new Set(paths)].filter((path) =>
    pathInTraceScopes(scopes, shielded, path),
  );
}

/** Build the state of every replay tab at one real global Step. */
export function replayDisplayAt(
  steps: readonly ReplayTimelineStep[],
  index: number,
): ReplayDisplay {
  let display = emptyReplayDisplay();
  for (let i = 0; i <= index && i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    if (step.folder) {
      display = {
        ...display,
        folders: { ...display.folders, [step.folder.path]: step.folder },
      };
      for (const focus of step.folder.focus) {
        display = applyReplayFocus(display, focus);
      }
    } else if (step.relativePath) {
      display = {
        ...display,
        files: {
          ...display.files,
          [step.relativePath]: {
            runs: step.runsUpToHere,
            nodeId: step.event.id,
          },
        },
      };
    }
  }
  return display;
}

export function emptyReplayDisplay(): ReplayDisplay {
  return { files: {}, folders: {}, panels: {}, panelIndexByPath: {} };
}

function focusPath(selection: FocusSelection): string {
  if (selection.kind === "file") return selection.path;
  if (selection.kind === "coin") return selection.originPath;
  return "";
}

function applyReplayFocus(
  display: ReplayDisplay,
  focus: ReplayFocusDelta,
): ReplayDisplay {
  const path = focusPath(focus.selection);
  const panels = { ...display.panels };
  const panelIndexByPath = { ...display.panelIndexByPath };
  if (focus.op === "unmount" || !path) {
    if (!path || panels[focus.panelIndex] === path) delete panels[focus.panelIndex];
  } else {
    panels[focus.panelIndex] = path;
    panelIndexByPath[path] = focus.panelIndex;
  }
  return { ...display, panels, panelIndexByPath };
}

/** Apply one wall-clock frame to replay-only display state. */
export function replayDisplayWithFrame(
  display: ReplayDisplay,
  frame: PlayFrame,
  nodeId = "",
): ReplayDisplay {
  if (frame.kind === "folder" && frame.folder) {
    return {
      ...display,
      folders: { ...display.folders, [frame.folder.path]: frame.folder },
    };
  }
  if (frame.kind === "focus" && frame.focus) {
    return applyReplayFocus(display, frame.focus);
  }
  if (frame.kind !== "file" || !frame.path) return display;
  return {
    ...display,
    files: {
      ...display.files,
      [frame.path]: { runs: frame.runs, nodeId },
    },
    panelIndexByPath:
      frame.panelIndex === undefined
        ? display.panelIndexByPath
        : { ...display.panelIndexByPath, [frame.path]: frame.panelIndex },
  };
}

/** Reconstruct replay-only state through one action cursor. Rebuilding from an
 * empty display makes backward scrubs deterministic without touching live
 * editor state. */
export function replayDisplayThroughFrame(
  frames: readonly PlayFrame[],
  cursor: number,
  nodeIdsByStep: readonly string[] = [],
): ReplayDisplay {
  let display = emptyReplayDisplay();
  const last = Number.isFinite(cursor)
    ? Math.min(frames.length - 1, Math.max(-1, Math.trunc(cursor)))
    : -1;
  for (let i = 0; i <= last; i++) {
    const frame = frames[i];
    if (!frame) continue;
    display = replayDisplayWithFrame(
      display,
      frame,
      nodeIdsByStep[frame.stepIndex] ?? "",
    );
  }
  return display;
}

/**
 * Expand every selected trace chain into one timestamp-interleaved playback.
 * Per-file run state remains independent even though the resulting frames use
 * one global clock.
 */
export function buildReplayTimeline(
  steps: readonly ReplayTimelineStep[],
  chains: Readonly<Record<string, Event[]>>,
): PlayFrame[] | null {
  const stepIndexByEventId = new Map(steps.map((step, index) => [step.event.id, index]));
  const all: PlayFrame[] = [];
  for (const [path, chain] of Object.entries(chains)) {
    const frames: PlayFrame[] = [];
    let runs: Run[] = [];
    for (const event of chain) {
      const stepIndex = stepIndexByEventId.get(event.id);
      if (stepIndex === undefined) continue;
      const step = steps[stepIndex];
      const stepAt = step?.meta.steppedAtMs ?? event.created_at * 1000;
      if (step?.folder) {
        for (const focus of step.folder.focus) {
          frames.push({
            kind: "focus",
            path: focusPath(focus.selection),
            stepIndex,
            runs: [],
            at: Math.min(focus.timestamp, stepAt),
            panelIndex: focus.panelIndex,
            focus,
          });
        }
        frames.push({
          kind: "folder",
          path: "",
          stepIndex,
          runs: [],
          at: stepAt,
          reachesStep: true,
          folder: step.folder,
        });
        continue;
      }
      let parsed: { snapshot?: string };
      try {
        parsed = JSON.parse(event.content) as { snapshot?: string };
      } catch {
        parsed = {};
      }
      const kedits = keditsFromEvent(event);
      const process = traceProcessFromEvent(event, flattenRuns(runs));
      let stepDelta: ReplayActionDelta | undefined;
      if (process.status === "complete" && kedits.length > 0) {
        let replayRuns = runs;
        let replayDelta: ReplayActionDelta | undefined;
        const replayFrames: PlayFrame[] = [];
        for (const transaction of groupKEditsByTransaction(kedits)) {
          const before = flattenRuns(replayRuns);
          const action = keditAction(before, transaction);
          const delta = actionDelta(action);
          if (delta) {
            replayDelta = {
              inserted: (replayDelta?.inserted ?? 0) + delta.inserted,
              deleted: (replayDelta?.deleted ?? 0) + delta.deleted,
            };
          }
          replayRuns = applyKEditTransaction(replayRuns, transaction);
          const recordedAt = transaction.find((edit) => Number.isFinite(edit.t))?.t;
          replayFrames.push({
            kind: "file",
            path,
            stepIndex,
            runs: replayRuns,
            at: recordedAt === undefined ? stepAt : Math.min(recordedAt, stepAt),
            action,
            ...(delta ? { delta } : {}),
          });
        }
        // traceProcessFromEvent validated transaction ids, atomic ranges,
        // operation labels, and the final snapshot before Replay exposes any
        // intermediate state. Nonconforming process falls through to the
        // visibly labelled snapshot-only checkpoint below.
        runs = replayRuns;
        stepDelta = replayDelta;
        frames.push(...replayFrames);
      }
      if (
        typeof parsed.snapshot === "string" &&
        flattenRuns(runs) !== parsed.snapshot
      ) {
        const snapText = parsed.snapshot;
        const before = flattenRuns(runs);
        const action = snapshotAction(before, snapText);
        stepDelta = action ? actionDelta(action) : undefined;
        const reconstructedRuns = step?.runsUpToHere ?? [];
        runs =
          flattenRuns(reconstructedRuns) === snapText
            ? reconstructedRuns
            : snapText.length > 0
              ? [{ voice: event.pubkey, text: snapText }]
              : [];
        frames.push({
          kind: "file",
          path,
          stepIndex,
          runs,
          at: stepAt,
          ...(action ? { action } : {}),
          ...(stepDelta ? { delta: stepDelta } : {}),
        });
      }
      const lastFrame = frames[frames.length - 1];
      if (!lastFrame || lastFrame.stepIndex !== stepIndex || lastFrame.at !== stepAt) {
        frames.push({
          kind: "file",
          path,
          stepIndex,
          runs,
          at: stepAt,
          reachesStep: true,
          ...(stepDelta ? { delta: stepDelta } : {}),
        });
      } else {
        lastFrame.reachesStep = true;
        // When the last edit and Step share a timestamp, that frame is both the
        // final transaction and the savepoint. Show the whole Step footprint.
        if (stepDelta) lastFrame.delta = stepDelta;
      }
    }
    if (frames.length > 0) all.push(...frames);
  }

  if (all.length === 0) return null;
  all.sort((a, b) => a.at - b.at);
  const firstContentIndex = all.findIndex(
    (frame) => frame.kind === "file" && flattenRuns(frame.runs).length > 0,
  );
  const firstContent = firstContentIndex >= 0 ? all[firstContentIndex] : undefined;
  // Contentful geneses need a transient blank opening frame. A real empty
  // genesis already supplies Step 0, so do not duplicate it.
  if (firstContent) {
    all.splice(firstContentIndex, 0, {
      kind: "file",
      path: firstContent.path,
      stepIndex: firstContent.stepIndex,
      runs: [],
      at: firstContent.at,
    });
  }

  // Replay focus is a sparse, dynamic occupancy log. Route each file edit to
  // the panel currently holding that path, then fall back to its last recorded
  // slot. Traces with no focus evidence remain unplaced and the layout layer
  // gives each one a fresh column.
  const occupied = new Map<number, string>();
  const lastPanelByPath = new Map<string, number>();
  for (const frame of all) {
    if (frame.kind === "focus" && frame.focus) {
      const focusedPath = focusPath(frame.focus.selection);
      if (frame.focus.op === "unmount" || !focusedPath) {
        if (!focusedPath || occupied.get(frame.focus.panelIndex) === focusedPath) {
          occupied.delete(frame.focus.panelIndex);
        }
      } else {
        occupied.set(frame.focus.panelIndex, focusedPath);
        lastPanelByPath.set(focusedPath, frame.focus.panelIndex);
      }
      continue;
    }
    if (frame.kind !== "file" || !frame.path) continue;
    const current = [...occupied.entries()].find(([, value]) => value === frame.path)?.[0];
    frame.panelIndex = current ?? lastPanelByPath.get(frame.path);
  }
  return all;
}
