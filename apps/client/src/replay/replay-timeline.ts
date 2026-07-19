import type { Event } from "nostr-tools";

import { groupKEditsByTransaction } from "../provenance/kedit-capture.js";
import {
  isFocusSelection,
  eventMeta,
  keditsFromEvent,
  type FocusSelection,
  type KEdit,
} from "../provenance/provenance.js";
import { pathInTraceScopes, type TraceRef } from "../ai/scope-model.js";
import { traceProcessFromEvent } from "../provenance/trace-process.js";
import {
  applyKEditTransaction,
  flattenRuns,
  type FileState,
  type Run,
} from "../workspace/workspace-core.js";

export interface ReplayTimelineStep {
  event: Event;
  relativePath: string;
  meta: {
    steppedAtMs: number;
    operationId?: string;
    folderCheckpoint?: { cause: string; sourceNodeId?: string };
  };
  runsUpToHere: Run[];
  /** Optional structural label for a membership change on this Step. */
  membership?: unknown;
  /** Folder checkpoints are structural replay state. They never become a
   *  document path or a synthetic tab. */
  folder?: ReplayFolderState;
  /** Signed automatic roll-ups grouped beneath this visible gesture. They
   * remain inspectable data and are still applied to structural replay state. */
  derivedFolderCheckpoints?: ReplayTimelineStep[];
  /** Additional mounted projections of this same signed event. Repeated folder
   * identities are aliases, not duplicate Steps, so they share one visible
   * checkpoint while replay applies every occurrence. */
  occurrenceProjections?: ReplayTimelineStep[];
}

/** Merge independent trace chains without allowing wall-clock rollback to
 * place a causal child before its signed predecessor/source. */
export function orderReplayTimelineSteps<T extends ReplayTimelineStep>(steps: readonly T[]): T[] {
  const byId = new Map(steps.map((step) => [step.event.id, step]));
  const original = new Map(steps.map((step, index) => [step.event.id, index]));
  const dependencies = new Map<string, Set<string>>();
  for (const step of steps) {
    const deps = new Set<string>();
    const prev = step.event.tags.find((tag) => tag[0] === "e" && tag[3] === "prev")?.[1];
    const source = step.meta.folderCheckpoint?.sourceNodeId;
    if (prev && byId.has(prev)) deps.add(prev);
    if (source && byId.has(source)) deps.add(source);
    if (step.meta.folderCheckpoint?.cause === "explicit-step" && step.meta.operationId) {
      const downstream = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of steps) {
          const candidateSource = candidate.meta.folderCheckpoint?.sourceNodeId;
          if (
            candidateSource &&
            (candidateSource === step.event.id || downstream.has(candidateSource)) &&
            !downstream.has(candidate.event.id)
          ) {
            downstream.add(candidate.event.id);
            changed = true;
          }
        }
      }
      for (const candidate of steps) {
        if (
          candidate.event.id !== step.event.id &&
          candidate.meta.operationId === step.meta.operationId &&
          !downstream.has(candidate.event.id)
        ) {
          deps.add(candidate.event.id);
        }
      }
    }
    dependencies.set(step.event.id, deps);
  }
  const emitted = new Set<string>();
  const ordered: T[] = [];
  while (ordered.length < steps.length) {
    const next = steps
      .filter((step) => !emitted.has(step.event.id))
      .filter((step) => [...(dependencies.get(step.event.id) ?? [])].every((id) => emitted.has(id)))
      .sort((a, b) => a.meta.steppedAtMs - b.meta.steppedAtMs ||
        (original.get(a.event.id) ?? 0) - (original.get(b.event.id) ?? 0))[0];
    if (!next) return [...steps];
    emitted.add(next.event.id);
    ordered.push(next);
  }
  return ordered;
}

/** Coalesce every load of one recursive folder identity, including lazy
 * historical occurrences discovered concurrently. The promise is cached
 * before the fetch starts so repeated occurrences cannot race into duplicate
 * relay queries. */
export function memoizedReplayFolderNodeLoad(
  cache: Map<string, Promise<Event[]>>,
  folderId: string,
  load: (folderId: string) => Promise<Event[]>,
): Promise<Event[]> {
  const existing = cache.get(folderId);
  if (existing) return existing;
  const pending = load(folderId);
  cache.set(folderId, pending);
  return pending;
}

export const REPLAY_MAX_FOLDER_OCCURRENCES = 4_096;
export const REPLAY_MAX_FOLDER_DEPTH = 64;

export function admitReplayFolderOccurrence(
  seen: Set<string>,
  key: string,
  path: string,
  limits: { maxOccurrences?: number; maxDepth?: number } = {},
): { admitted: boolean; error?: string } {
  if (seen.has(key)) return { admitted: false };
  const maxDepth = limits.maxDepth ?? REPLAY_MAX_FOLDER_DEPTH;
  const depth = path.split("/").filter(Boolean).length;
  if (depth > maxDepth) {
    return {
      admitted: false,
      error: `recursive Replay folder depth ${depth} exceeds ${maxDepth}`,
    };
  }
  const maxOccurrences = limits.maxOccurrences ?? REPLAY_MAX_FOLDER_OCCURRENCES;
  if (seen.size >= maxOccurrences) {
    return {
      admitted: false,
      error: `recursive Replay folder occurrences exceed ${maxOccurrences}`,
    };
  }
  seen.add(key);
  return { admitted: true };
}

/** Group signed checkpoints into the gesture that produced them. An explicit
 * folder Step is the visible endpoint for its whole operation; ordinary file
 * Steps retain the source-linked folder→ancestor roll-up tree. A derived node
 * without its source stays visible: incomplete history is never hidden. */
export function collapseDerivedFolderCheckpoints<T extends ReplayTimelineStep>(
  steps: readonly T[],
  options: { collapsibleNodeIds?: ReadonlySet<string> } = {},
): T[] {
  const indexById = new Map(steps.map((step, index) => [step.event.id, index]));
  const children = new Map<string, T[]>();
  const attached = new Set<string>();
  const explicitOperationMembers = new Set<string>();

  const byOperation = new Map<string, T[]>();
  for (const step of steps) {
    if (!step.meta.operationId) continue;
    const group = byOperation.get(step.meta.operationId) ?? [];
    group.push(step);
    byOperation.set(step.meta.operationId, group);
  }
  for (const group of byOperation.values()) {
    const explicit = group.filter((step) =>
      step.folder && step.meta.folderCheckpoint?.cause === "explicit-step",
    );
    if (explicit.length !== 1 || group.length < 2) continue;
    if (
      options.collapsibleNodeIds &&
      group.some((step) => !options.collapsibleNodeIds!.has(step.event.id))
    ) continue;
    const endpoint = explicit[0]!;
    for (const step of group) explicitOperationMembers.add(step.event.id);
    children.set(
      endpoint.event.id,
      group.filter((step) => step.event.id !== endpoint.event.id),
    );
    for (const step of group) {
      if (step.event.id !== endpoint.event.id) attached.add(step.event.id);
    }
  }

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (explicitOperationMembers.has(step.event.id)) continue;
    const operationId = step.meta.operationId;
    const sourceNodeId = step.meta.folderCheckpoint?.sourceNodeId;
    if (
      !step.folder ||
      step.meta.folderCheckpoint?.cause !== "child-advance" ||
      !operationId ||
      !sourceNodeId
    ) continue;
    const sourceIndex = indexById.get(sourceNodeId);
    const source = sourceIndex === undefined ? undefined : steps[sourceIndex];
    if (!source || source.meta.operationId !== operationId) continue;
    if (
      options.collapsibleNodeIds &&
      (!options.collapsibleNodeIds.has(source.event.id) ||
        !options.collapsibleNodeIds.has(step.event.id))
    ) continue;
    const group = children.get(sourceNodeId) ?? [];
    group.push(step);
    children.set(sourceNodeId, group);
    attached.add(step.event.id);
  }

  const materialize = (step: T): T => {
    const derived = children.get(step.event.id);
    if (!derived || derived.length === 0) return step;
    return {
      ...step,
      derivedFolderCheckpoints: derived.map(materialize),
    } as T;
  };
  return steps.filter((step) => !attached.has(step.event.id)).map(materialize);
}

export interface DerivedFolderCheckpointDetail {
  nodeId: string;
  path: string;
  cause: string;
  operationId?: string;
  signerPubkey: string;
  signedEventJson: string;
}

/** Flatten one visible gesture's automatic signed roll-ups for an inspectable
 * disclosure list. Replay still applies them recursively to structural state. */
export function derivedFolderCheckpointDetails(
  step: ReplayTimelineStep | undefined,
): DerivedFolderCheckpointDetail[] {
  const details: DerivedFolderCheckpointDetail[] = [];
  const visit = (candidate: ReplayTimelineStep) => {
    for (const derived of candidate.derivedFolderCheckpoints ?? []) {
      details.push({
        nodeId: derived.event.id,
        path: derived.folder?.path ?? derived.relativePath,
        cause: derived.meta.folderCheckpoint?.cause ?? "child-advance",
        operationId: derived.meta.operationId,
        signerPubkey: derived.event.pubkey,
        signedEventJson: JSON.stringify(derived.event, null, 2),
      });
      visit(derived);
    }
  };
  if (step) visit(step);
  return details;
}

function flattenGroupedSteps(
  steps: readonly ReplayTimelineStep[],
): ReplayTimelineStep[] {
  const discovered: ReplayTimelineStep[] = [];
  const seen = new Set<string>();
  const visit = (step: ReplayTimelineStep) => {
    if (seen.has(step.event.id)) return;
    seen.add(step.event.id);
    discovered.push(step);
    for (const derived of step.derivedFolderCheckpoints ?? []) visit(derived);
  };
  for (const step of steps) visit(step);

  const byId = new Map(discovered.map((step) => [step.event.id, step]));
  const originalIndex = new Map(discovered.map((step, index) => [step.event.id, index]));
  const dependencies = new Map<string, Set<string>>();
  for (const step of discovered) {
    const source = step.meta.folderCheckpoint?.sourceNodeId;
    if (source && byId.has(source)) dependencies.set(step.event.id, new Set([source]));
  }
  for (const step of discovered) {
    if (step.meta.folderCheckpoint?.cause !== "explicit-step") continue;
    const prerequisites = discovered
      .filter((candidate) =>
        candidate.event.id !== step.event.id &&
        candidate.meta.operationId === step.meta.operationId,
      )
      .map((candidate) => candidate.event.id);
    if (prerequisites.length > 0) dependencies.set(step.event.id, new Set(prerequisites));
  }

  const ordered: ReplayTimelineStep[] = [];
  const emitted = new Set<string>();
  while (ordered.length < discovered.length) {
    const ready = discovered
      .filter((step) => !emitted.has(step.event.id))
      .filter((step) => [...(dependencies.get(step.event.id) ?? [])].every((id) => emitted.has(id)))
      .sort((left, right) =>
        left.meta.steppedAtMs - right.meta.steppedAtMs ||
        (originalIndex.get(left.event.id) ?? 0) - (originalIndex.get(right.event.id) ?? 0),
      );
    const next = ready[0];
    if (!next) {
      // Defensive fallback for malformed cyclic source links. The verifier
      // normally prevents this; preserving every step is safer than dropping it.
      return discovered;
    }
    emitted.add(next.event.id);
    ordered.push(next);
  }
  return ordered.flatMap((step) => [step, ...(step.occurrenceProjections ?? [])]);
}

export interface PlayFrame {
  kind: "file" | "folder" | "focus";
  path: string;
  stepIndex: number;
  /** Immutable signed event that produced this frame. `stepIndex` addresses the
   * collapsed visible gesture and may therefore name a different folder node. */
  eventId?: string;
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
  /** Evicted immutable members retained by node identity so a later signed
   * re-add can restore its last replay projection without inventing a Step. */
  detached: Record<string, ReplayDetachedSubtree>;
}

export interface ReplayDetachedSubtree {
  boundary: string;
  files: Record<string, ReplayFileDisplay>;
  folders: Record<string, ReplayFolderState>;
  panels: Record<number, string>;
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
  /** Same-kind, same-path members whose stable trace identity was replaced in
   * this checkpoint. Ordinary child `advance` deltas deliberately do not
   * appear here: their existing replay subtree remains the same occurrence. */
  identityReplacements?: ReplayFolderIdentityReplacement[];
}

export interface ReplayFolderIdentityReplacement {
  kind: "file" | "folder";
  relativePath: string;
  previousNodeId: string;
  nodeId: string;
}

export interface HistoricalReplayMember {
  kind: "file" | "folder";
  path: string;
  parentFolderId: string;
  relativePath: string;
  nodeId: string;
  contentHash: string;
  observedAtMs: number;
  /** First checkpoint where this path occurrence is no longer a member.
   * Omitted while the occurrence remains active at the pinned Root head. */
  removedAtMs?: number;
}

/** Membership chronology decides where a file Step is projected. The first
 * occurrence owns pre-membership genesis/edit events; later paths begin only
 * at their structural checkpoint, and removed paths end at that checkpoint. */
export function replayPathOccurrenceActiveAt(
  occurrence: Pick<HistoricalReplayMember, "observedAtMs" | "removedAtMs">,
  eventAtMs: number,
  initial: boolean,
): boolean {
  if (!initial && eventAtMs < occurrence.observedAtMs) return false;
  return occurrence.removedAtMs === undefined || eventAtMs < occurrence.removedAtMs;
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
    kind?: "file" | "folder";
    relativePath?: string;
    nodeId?: string;
    selection?: FocusSelection;
    panelIndex?: number;
    timestamp?: number;
  }>;
}

function folderIdentityReplacements(
  deltas: FolderEventContent["deltas"],
): ReplayFolderIdentityReplacement[] {
  const removedByMember = new Map<string, string>();
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (
      delta.type !== "remove" ||
      (delta.kind !== "file" && delta.kind !== "folder") ||
      typeof delta.relativePath !== "string" ||
      typeof delta.nodeId !== "string"
    ) continue;
    removedByMember.set(
      `${delta.kind}\u0000${delta.relativePath}`,
      delta.nodeId,
    );
  }

  const replacements: ReplayFolderIdentityReplacement[] = [];
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    if (
      delta.type !== "add" ||
      (delta.kind !== "file" && delta.kind !== "folder") ||
      typeof delta.relativePath !== "string" ||
      typeof delta.nodeId !== "string"
    ) continue;
    const previousNodeId = removedByMember.get(
      `${delta.kind}\u0000${delta.relativePath}`,
    );
    if (!previousNodeId || previousNodeId === delta.nodeId) continue;
    replacements.push({
      kind: delta.kind,
      relativePath: delta.relativePath,
      previousNodeId,
      nodeId: delta.nodeId,
    });
  }
  return replacements;
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
  const identityReplacements = folderIdentityReplacements(parsed.deltas);
  return {
    path,
    members,
    focus,
    ...(identityReplacements.length > 0 ? { identityReplacements } : {}),
  };
}

/** Recover every direct member that appeared anywhere in one verified folder
 * chain. Entries survive later removal so Replay can still load their pinned
 * historical nodes even when the live workspace no longer contains the path. */
export function historicalReplayMembers(
  parentFolderId: string,
  folderPath: string,
  chain: readonly Event[],
): HistoricalReplayMember[] {
  const history: HistoricalReplayMember[] = [];
  const active = new Map<string, number>();
  for (const event of chain) {
    const state = folderReplayState(event, folderPath);
    const checkpointAt = eventMeta(event).steppedAtMs;
    const replacementHeads = new Set(
      state.identityReplacements?.map((replacement) =>
        `${replacement.kind}\u0000${replacement.relativePath}\u0000${replacement.nodeId}`
      ),
    );
    const present = new Set<string>();
    for (const member of state.members) {
      if (!member.latestNodeId || !member.contentHash) continue;
      const key = `${member.kind}\u0000${member.relativePath}`;
      present.add(key);
      const path = folderPath
        ? `${folderPath}/${member.relativePath}`
        : member.relativePath;
      const index = active.get(key);
      const prior = index === undefined ? undefined : history[index];
      // A file membership can switch immutable trace identity at the same
      // structural path during fork-on-write. Without the member node itself
      // there is no synchronous way to distinguish that seam from an ordinary
      // same-trace advance, so retain each distinct file pin. The loader later
      // resolves stable identities and coalesces same-trace prefixes.
      const startsNewFileOccurrence =
        member.kind === "file" &&
        prior !== undefined &&
        prior.nodeId !== member.latestNodeId;
      const startsNewFolderOccurrence =
        member.kind === "folder" &&
        prior !== undefined &&
        prior.nodeId !== member.latestNodeId &&
        replacementHeads.has(
          `${member.kind}\u0000${member.relativePath}\u0000${member.latestNodeId}`,
        );
      if (index === undefined || startsNewFileOccurrence || startsNewFolderOccurrence) {
        if (index !== undefined && prior) {
          history[index] = { ...prior, removedAtMs: checkpointAt };
        }
        active.set(key, history.length);
        history.push({
          kind: member.kind,
          path,
          parentFolderId,
          relativePath: member.relativePath,
          nodeId: member.latestNodeId,
          contentHash: member.contentHash,
          observedAtMs: checkpointAt,
        });
      } else {
        history[index] = {
          ...history[index]!,
          nodeId: member.latestNodeId,
          contentHash: member.contentHash,
        };
      }
    }
    for (const [key, index] of active) {
      if (!present.has(key)) {
        history[index] = { ...history[index]!, removedAtMs: checkpointAt };
        active.delete(key);
      }
    }
  }
  return history;
}

/** Resolve one append-only trace from an unordered event set. Replay and prompt
 * context require the whole unique chain: branches, gaps, cycles, and orphaned
 * nodes are rejected instead of being hidden by a best-effort head choice. */
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
  const heads = [...byId.values()].filter((event) => !citedAsPrev.has(event.id));
  if (heads.length !== 1) return [];

  const newestFirst: Event[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = heads[0]!.id;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const event = byId.get(cursor);
    if (!event) return [];
    newestFirst.push(event);
    const prev = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1];
    if (event.id === genesisId) {
      return !prev && newestFirst.length === byId.size ? newestFirst.reverse() : [];
    }
    cursor = prev;
  }
  return [];
}

/** Resolve one complete ancestry ending at an exact immutable head. Later
 * siblings and unrelated branches are irrelevant to a membership pin: only
 * the cited head's own prev path must reach the requested genesis exactly. */
export function orderReplayTraceChainAtHead(
  events: readonly Event[],
  genesisId: string,
  headId: string,
): Event[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const newestFirst: Event[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = headId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const event = byId.get(cursor);
    if (!event) return [];
    newestFirst.push(event);
    const prev = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1];
    if (event.id === genesisId) {
      return !prev ? newestFirst.reverse() : [];
    }
    cursor = prev;
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

export interface RecursiveReplayFileSource {
  path: string;
  folderId: string;
  relativePath: string;
  nodeId: string;
}

export interface RecursiveReplayFolderSource {
  path: string;
  folderId: string;
  /** Optional membership-pinned head for one historical path occurrence. */
  nodeId?: string;
}

/** Resolve flattened UI paths to the direct recursive trace coordinates used
 * on the wire. A file focus contributes exactly that file. A folder focus
 * contributes every file and folder trace in its subtree. */
export function recursiveReplaySources(
  rootFolderId: string,
  files: Readonly<Record<string, FileState>>,
  scopes: readonly TraceRef[],
  rootNodeId?: string,
): {
  files: RecursiveReplayFileSource[];
  folders: RecursiveReplayFolderSource[];
} {
  const selectedFiles = Object.entries(files)
    .filter(([, file]) => file.kind !== "folder" && Boolean(file.nodeId))
    .filter(([path]) => pathInTraceScopes(scopes, new Set(), path))
    .flatMap(([path, file]) => {
      const separator = path.lastIndexOf("/");
      if (separator === -1) {
        return [{ path, folderId: rootFolderId, relativePath: path, nodeId: file.nodeId }];
      }
      const parent = files[path.slice(0, separator)];
      const folderId = parent?.kind === "folder" ? parent.traceId ?? parent.nodeId : null;
      return folderId
        ? [{
            path,
            folderId,
            relativePath: path.slice(separator + 1),
            nodeId: file.nodeId,
          }]
        : [];
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const candidates: RecursiveReplayFolderSource[] = [
    { path: "", folderId: rootFolderId, ...(rootNodeId ? { nodeId: rootNodeId } : {}) },
    ...Object.entries(files).flatMap(([path, file]) => {
      if (file.kind !== "folder") return [];
      const folderId = file.traceId ?? file.nodeId;
      return folderId ? [{ path, folderId, nodeId: file.nodeId || undefined }] : [];
    }),
  ];
  const selectedFolders = candidates
    .filter((candidate, index, all) =>
      all.findIndex((other) =>
        other.folderId === candidate.folderId && other.path === candidate.path
      ) === index,
    )
    .filter((candidate) => scopes.some((scope) => {
      if (candidate.path === "" || scope.path === "") return true;
      const candidateIsAncestor = scope.path.startsWith(`${candidate.path}/`);
      if (scope.kind === "file") return candidateIsAncestor;
      return candidate.path === scope.path ||
        candidateIsAncestor ||
        candidate.path.startsWith(`${scope.path}/`);
    }))
    .sort((left, right) => left.path.localeCompare(right.path));

  return { files: selectedFiles, folders: selectedFolders };
}

/** Build the state of every replay tab at one real global Step. */
export function replayDisplayAt(
  steps: readonly ReplayTimelineStep[],
  index: number,
): ReplayDisplay {
  let display = emptyReplayDisplay();
  const applyStep = (step: ReplayTimelineStep) => {
    if (step.folder) {
      display = applyReplayFolderState(display, step.folder);
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
  };
  for (let i = 0; i <= index && i < steps.length; i++) {
    const step = steps[i];
    if (!step) continue;
    for (const grouped of flattenGroupedSteps([step])) applyStep(grouped);
  }
  return display;
}

export function emptyReplayDisplay(): ReplayDisplay {
  return { files: {}, folders: {}, panels: {}, panelIndexByPath: {}, detached: {} };
}

function pathAtOrBelow(path: string, boundary: string): boolean {
  return path === boundary || path.startsWith(`${boundary}/`);
}

function replayMemberKey(member: ReplayFolderMember): string | null {
  return member.latestNodeId ? `${member.kind}\u0000${member.latestNodeId}` : null;
}

function rebaseReplayPath(path: string, from: string, to: string): string {
  if (path === from) return to;
  return `${to}/${path.slice(from.length + 1)}`;
}

function restoreReplaySnapshot(
  snapshot: ReplayDisplay["detached"][string],
  boundary: string,
  files: ReplayDisplay["files"],
  folders: ReplayDisplay["folders"],
  panels: ReplayDisplay["panels"],
  panelIndexByPath: ReplayDisplay["panelIndexByPath"],
  restorePanels: boolean,
): void {
  for (const [path, file] of Object.entries(snapshot.files)) {
    files[rebaseReplayPath(path, snapshot.boundary, boundary)] = file;
  }
  for (const [path, state] of Object.entries(snapshot.folders)) {
    const rebased = rebaseReplayPath(path, snapshot.boundary, boundary);
    folders[rebased] = { ...state, path: rebased };
  }
  for (const [path, panelIndex] of Object.entries(snapshot.panelIndexByPath)) {
    panelIndexByPath[rebaseReplayPath(path, snapshot.boundary, boundary)] = panelIndex;
  }
  if (restorePanels) {
    for (const [panelIndex, path] of Object.entries(snapshot.panels)) {
      panels[Number(panelIndex)] = rebaseReplayPath(path, snapshot.boundary, boundary);
    }
  }
}

/** Apply a structural checkpoint and evict projections whose direct member (or
 * ancestor folder member) disappeared. Historical documents re-enter only when
 * a later checkpoint and file frame explicitly restore them. */
function applyReplayFolderState(
  display: ReplayDisplay,
  folder: ReplayFolderState,
): ReplayDisplay {
  const previous = display.folders[folder.path];
  const directKey = (member: ReplayFolderMember) =>
    `${member.kind}\u0000${member.relativePath}`;
  const replacementKeys = new Set(
    folder.identityReplacements?.map((replacement) =>
      `${replacement.kind}\u0000${replacement.relativePath}\u0000${replacement.previousNodeId}\u0000${replacement.nodeId}`
    ) ?? [],
  );
  const replaces = (
    before: ReplayFolderMember,
    after: ReplayFolderMember,
  ) => replacementKeys.has(
    `${before.kind}\u0000${before.relativePath}\u0000${before.latestNodeId ?? ""}\u0000${after.latestNodeId ?? ""}`,
  );
  const previousByKey = new Map(previous?.members.map((member) => [directKey(member), member]) ?? []);
  const currentByKey = new Map(folder.members.map((member) => [directKey(member), member]));
  const removedMembers = previous?.members.filter((member) => {
    const retained = currentByKey.get(directKey(member));
    return !retained || replaces(member, retained);
  }) ?? [];
  const addedMembers = folder.members.filter((member) =>
    !previousByKey.has(directKey(member)) ||
    replaces(previousByKey.get(directKey(member))!, member),
  );
  const detached = { ...display.detached };
  const detachedThisFrame = new Set<string>();
  const removedBoundaryByMemberKey = new Map<string, string>();
  const removedBoundarySet = new Set<string>();
  for (const member of removedMembers) {
    const boundary = folder.path
      ? `${folder.path}/${member.relativePath}`
      : member.relativePath;
    removedBoundarySet.add(boundary);
    const key = replayMemberKey(member);
    if (!key) continue;
    removedBoundaryByMemberKey.set(key, boundary);
    detachedThisFrame.add(key);
  }
  const removedBoundaryFor = (path: string): string | null => {
    let cursor = path;
    while (cursor) {
      if (removedBoundarySet.has(cursor)) return cursor;
      const slash = cursor.lastIndexOf("/");
      cursor = slash < 0 ? "" : cursor.slice(0, slash);
    }
    return removedBoundarySet.has("") ? "" : null;
  };
  type DetachedBuilder = ReplayDetachedSubtree;
  const detachedByBoundary = new Map<string, DetachedBuilder>();
  for (const boundary of removedBoundarySet) {
    detachedByBoundary.set(boundary, {
      boundary,
      files: {},
      folders: {},
      panels: {},
      panelIndexByPath: {},
    });
  }
  const files: ReplayDisplay["files"] = {};
  for (const [path, value] of Object.entries(display.files)) {
    const boundary = removedBoundaryFor(path);
    if (boundary === null) files[path] = value;
    else detachedByBoundary.get(boundary)!.files[path] = value;
  }
  const panelIndexByPath: ReplayDisplay["panelIndexByPath"] = {};
  for (const [path, value] of Object.entries(display.panelIndexByPath)) {
    const boundary = removedBoundaryFor(path);
    if (boundary === null) panelIndexByPath[path] = value;
    else detachedByBoundary.get(boundary)!.panelIndexByPath[path] = value;
  }
  const panels: ReplayDisplay["panels"] = {};
  for (const [panelIndex, path] of Object.entries(display.panels)) {
    const boundary = removedBoundaryFor(path);
    if (boundary === null) panels[Number(panelIndex)] = path;
    else detachedByBoundary.get(boundary)!.panels[Number(panelIndex)] = path;
  }
  const folders: Record<string, ReplayFolderState> = {};
  for (const [path, value] of Object.entries(display.folders)) {
    const boundary = path === folder.path ? null : removedBoundaryFor(path);
    if (boundary === null) folders[path] = value;
    else detachedByBoundary.get(boundary)!.folders[path] = value;
  }
  for (const [key, boundary] of removedBoundaryByMemberKey) {
    detached[key] = detachedByBoundary.get(boundary)!;
  }
  // Cross-parent moves are persisted target-add first, source-remove second.
  // At removal time the destination membership is already visible, so move
  // the just-captured projection there immediately instead of leaving it only
  // in detached history with no later add frame to restore it.
  const destinationsByMemberKey = new Map<
    string,
    Array<{ candidatePath: string; member: ReplayFolderMember }>
  >();
  for (const [candidatePath, candidate] of Object.entries(display.folders)) {
    for (const member of candidate.members) {
      const key = replayMemberKey(member);
      if (!key) continue;
      const destinations = destinationsByMemberKey.get(key) ?? [];
      destinations.push({ candidatePath, member });
      destinationsByMemberKey.set(key, destinations);
    }
  }
  for (const member of removedMembers) {
    const key = replayMemberKey(member);
    const snapshot = key ? detached[key] : undefined;
    if (!key || !snapshot) continue;
    for (const { candidatePath, member: relocated } of destinationsByMemberKey.get(key) ?? []) {
      if (candidatePath === folder.path || pathAtOrBelow(candidatePath, snapshot.boundary)) {
        continue;
      }
      const boundary = candidatePath
        ? `${candidatePath}/${relocated.relativePath}`
        : relocated.relativePath;
      restoreReplaySnapshot(
        snapshot,
        boundary,
        files,
        folders,
        panels,
        panelIndexByPath,
        true,
      );
    }
  }
  for (const member of addedMembers) {
    const key = replayMemberKey(member);
    if (!key) continue;
    const snapshot = detached[key];
    if (!snapshot) continue;
    const boundary = folder.path
      ? `${folder.path}/${member.relativePath}`
      : member.relativePath;
    restoreReplaySnapshot(
      snapshot,
      boundary,
      files,
      folders,
      panels,
      panelIndexByPath,
      detachedThisFrame.has(key),
    );
  }
  folders[folder.path] = folder;
  return { files, folders, panels, panelIndexByPath, detached };
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
    return applyReplayFolderState(display, frame.folder);
  }
  if (frame.kind === "focus" && frame.focus) {
    return applyReplayFocus(display, frame.focus);
  }
  if (frame.kind !== "file" || !frame.path) return display;
  return {
    ...display,
    files: {
      ...display.files,
      [frame.path]: { runs: frame.runs, nodeId: frame.eventId ?? nodeId },
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
  const stepIndexByEventId = new Map<string, number>();
  const stepByEventId = new Map<string, ReplayTimelineStep>();
  const occurrenceProjectionsByEventId = new Map<string, ReplayTimelineStep[]>();
  const causalOrderByEventId = new Map<string, number>();
  let causalOrder = 0;
  steps.forEach((step, visibleIndex) => {
    for (const grouped of flattenGroupedSteps([step])) {
      stepIndexByEventId.set(grouped.event.id, visibleIndex);
      if (!stepByEventId.has(grouped.event.id)) {
        stepByEventId.set(grouped.event.id, grouped);
      } else {
        const projections = occurrenceProjectionsByEventId.get(grouped.event.id) ?? [];
        projections.push(grouped);
        occurrenceProjectionsByEventId.set(grouped.event.id, projections);
      }
      causalOrderByEventId.set(grouped.event.id, causalOrder++);
    }
  });
  const all: PlayFrame[] = [];
  const causalOrderByFrame = new WeakMap<PlayFrame, number>();
  for (const [path, chain] of Object.entries(chains)) {
    const frames: PlayFrame[] = [];
    let runs: Run[] = [];
    for (const event of chain) {
      const eventFrameStart = frames.length;
      const stepIndex = stepIndexByEventId.get(event.id);
      if (stepIndex === undefined) continue;
      const step = stepByEventId.get(event.id);
      const stepAt = step?.meta.steppedAtMs ?? event.created_at * 1000;
      const eventPath = step?.relativePath ?? path;
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
        for (const projection of occurrenceProjectionsByEventId.get(event.id) ?? []) {
          if (!projection.folder) continue;
          for (const focus of projection.folder.focus) {
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
            folder: projection.folder,
          });
        }
        for (let index = eventFrameStart; index < frames.length; index += 1) {
          frames[index]!.eventId = event.id;
          causalOrderByFrame.set(
            frames[index]!,
            causalOrderByEventId.get(event.id) ?? Number.MAX_SAFE_INTEGER,
          );
        }
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
            path: eventPath,
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
          path: eventPath,
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
          path: eventPath,
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
      const primaryFrames = frames.slice(eventFrameStart);
      for (const projection of occurrenceProjectionsByEventId.get(event.id) ?? []) {
        if (!projection.relativePath || projection.folder) continue;
        frames.push(...primaryFrames.map((frame) => ({
          ...frame,
          path: projection.relativePath,
          reachesStep: false,
        })));
      }
      for (let index = eventFrameStart; index < frames.length; index += 1) {
        frames[index]!.eventId = event.id;
        causalOrderByFrame.set(
          frames[index]!,
          causalOrderByEventId.get(event.id) ?? Number.MAX_SAFE_INTEGER,
        );
      }
    }
    if (frames.length > 0) all.push(...frames);
  }

  if (all.length === 0) return null;
  all.sort((a, b) =>
    a.at - b.at ||
    (causalOrderByFrame.get(a) ?? Number.MAX_SAFE_INTEGER) -
      (causalOrderByFrame.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
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
      eventId: firstContent.eventId,
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

/** Every immutable event already represented by a visible Replay timeline,
 * including checkpoints collapsed beneath an explicit folder gesture. */
export function replayTimelineEventIds(
  steps: readonly ReplayTimelineStep[],
): Set<string> {
  return new Set(flattenGroupedSteps(steps).map((step) => step.event.id));
}
