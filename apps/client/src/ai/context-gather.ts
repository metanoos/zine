/**
 * Client-side adapter for the canonical context block. Gathers the inputs the
 * pure renderer (`context-block.ts`) needs from the in-memory file set + the
 * relay chains, then returns the rendered string for an op to prepend to its
 * user message.
 *
 * The folder tree and sibling file text come straight from App state
 * (`files: Record<string, FileState>`) — the active workspace already
 * populated it from the local store and relay on attach, so no Tauri IPC is
 * needed and this works equally in the desktop shell and hosted webapp.
 *
 * The delta log is an AGGREGATED SCOPE LOG: every included file's kind-4290
 * chain plus matching folder kind-4292 membership events, interleaved by
 * steppedAt. A folder mount recursively adds descendant files; shielded
 * boundaries below that one explicit root are omitted.
 * File events come from one stable-identity exact-head resolution per included
 * file (walked genesis→head so the client can
 * derive each node's `oldValue` from the prior node's snapshot — it doesn't
 * persist oldValue, spec-compliant); one `fetchFolderNodes` call gets every
 * membership event.
 *
 * Memoization: both fetches are network calls, so the merged log is memoized
 * under a key that includes the active mount and a fingerprint of included head
 * nodeIds. Any step/mint/fork that advances an included chain head
 * changes the fingerprint → the next gather refetches automatically. No
 * manual invalidation hooks. Cleared wholesale on folder switch.
 */
import type { Event } from "nostr-tools";

import type { FileState, FolderRef } from "../workspace/workspace-core.js";
import { flattenRuns } from "../workspace/workspace-core.js";
import { findResolvedBrackets } from "../provenance/brackets.js";
import {
  isMintPath,
  isOblivionPath,
  isScanPath,
} from "../workspace/generated-paths.js";
import {
  fetchChain,
  fetchEventById,
  fetchFolderNodes,
  resolveTraceChainAtHead,
  resolveTraceIdentity,
  resolveVerifiedFolderTraceIdentityAtHead,
  assertTraceTraversalBudget,
  traceSignedEventBytes,
  TRACE_TRAVERSAL_MAX_EVENTS,
  TRACE_TRAVERSAL_MAX_SIGNED_BYTES,
} from "../provenance/provenance.js";
import {
  pathInEffectiveScope,
  traceRefsKey,
  type ContextMounts,
} from "./scope-model.js";
import {
  renderContextBlock,
  type ContextEntry,
  type DeltaLogEntry,
  type DeltaSpanView,
  renderLimelightLog,
  type LimelightEntry,
} from "./context-block.js";
import {
  assertUsableContextSnapshot,
  createContextSnapshot,
  type ContextShieldDecision,
  type ContextSnapshot,
  type ContextSnapshotFailure,
} from "./context-snapshot.js";
import { traceProcessFromEvent, type TraceProcessView } from "../provenance/trace-process.js";
import {
  verifyFileTraceChain,
  verifyFolderTraceChain,
  type TraceConformanceStatus,
} from "../provenance/trace-conformance.js";
import {
  folderReplayState,
  historicalReplayMembers,
  orderReplayTraceChain,
} from "../replay/replay-timeline.js";
import { orderReplayTraceChainAtHead } from "../replay/replay-timeline.js";
import { loadLocalFolder } from "../workspace/local-store.js";

// Re-export so App.tsx can import the limelight renderer alongside the gather
// entry point from one module (same pattern as the types below would use).
export { renderLimelightLog, type LimelightEntry };

/** Memo key → merged directory log entries. */
const logMemo = new Map<string, DeltaLogEntry[]>();
const chainMemo = new Map<string, Event[]>();
export const MAX_HISTORICAL_FOLDER_TRACES = 512;

/** Drop the whole memo — e.g. on folder switch (see the `folder?.id` effect in
 *  App.tsx). Per-directory invalidation is implicit: the memo key includes the
 *  scoped file heads and fetched folder-node ids, so content changes and
 *  folder-only checkpoints both refetch on the next gather. */
export function clearChainMemo(): void {
  logMemo.clear();
  chainMemo.clear();
}

/** Gather and render the canonical context block for an op against `activePath`
 *  (the focused/target file), scoped to the one active mount. A folder mount
 *  gathers every descendant file's content + membership chain; a file mount
 *  gathers only that file.
 *
 *  `shielded` is the set of recursive traversal boundaries. A shielded descendant
 *  of a scoped folder is dropped from the rendered entries and delta log, but
 *  mounting a shielded file/folder replaces the active root and clears the
 *  conflicting shield.
 *
 *  Never throws: if a chain fetch fails, that file's log is simply omitted (the
 *  rest still renders). */
export async function gatherContextBlock(
  folder: FolderRef,
  files: Record<string, FileState>,
  scopes: ContextMounts,
  activePath: string,
  shielded: Set<string> = new Set(),
): Promise<string> {
  const snapshot = await gatherContextSnapshot(
    folder,
    files,
    scopes,
    activePath,
    shielded,
  );
  assertUsableContextSnapshot(snapshot);
  return snapshot.renderedBlock;
}

export interface ContextGatherOptions {
  signal?: AbortSignal;
  concurrency?: number;
  maxBytes?: number;
  fetchChain?: (folderId: string, relativePath: string) => Promise<Event[]>;
  /** Test seam for the production stable-identity lookup. Coordinate fetches
   * cannot recover ancestors from before a rename or reparent. */
  resolveFileChainAtHead?: (
    headId: string,
  ) => Promise<{ traceId: string; chain: Event[] }>;
  fetchFolderNodes?: (folderId: string) => Promise<Event[]>;
  /** Test seam below the production folder-identity verifier. Unlike the
   * higher-level resolver seam, this still exercises the exact signed-node
   * lookup and Full Trace verification used by production. */
  fetchEventById?: (nodeId: string) => Promise<Event | null>;
  /** Resolve a historical folder member pin to its stable folder identity.
   * Used to discover parent traces that no longer exist in the live map. */
  resolveFolderIdentityAtHead?: (headId: string) => Promise<string | null>;
  /** Exact Root folder checkpoint represented by the supplied local file set.
   * Production callers normally use the persisted local Root head. */
  rootFolderNodeId?: string;
  /** Test seam that may only tighten the production aggregate ceilings. */
  folderTraversalLimits?: { maxEvents?: number; maxSignedBytes?: number };
}

interface GatherJobResult {
  merged: CanonicalMerged[];
  failures: ContextSnapshotFailure[];
  fileTrace?: LoadedFileTrace;
}

interface LoadedFileTrace {
  traceId: string;
  path: string;
  chain: Event[];
}

interface CanonicalMerged {
  steppedAt: number;
  action: string;
  relativePath: string;
  fromPath?: string;
  source: "file" | "folder";
  prompt: string | null;
  summary: string | null;
  deltas: DeltaSpanView[] | undefined;
  process: TraceProcessView | undefined;
  conformance: TraceConformanceStatus | undefined;
  conformanceReason: string | undefined;
  nodeId: string | undefined;
  stableId: string;
  /** Signed nodes that must precede this observation. Wall clocks only order
   * observations once every available causal prerequisite is ready. */
  dependencyIds: readonly string[];
}

type DecodedFolderMembershipDelta =
  | { kind: "skip" }
  | { kind: "invalid"; message: string }
  | {
      kind: "membership";
      action: "add" | "remove" | "rename";
      relativePath: string;
      fromPath?: string;
    };

function projectFolderMembershipToScope(
  delta: Extract<DecodedFolderMembershipDelta, { kind: "membership" }>,
  scopes: ContextMounts,
  shielded: Set<string>,
): Extract<DecodedFolderMembershipDelta, { kind: "membership" }> | null {
  const destinationVisible = pathInEffectiveScope(scopes, shielded, delta.relativePath);
  if (delta.action !== "rename" || delta.fromPath === undefined) {
    return destinationVisible ? delta : null;
  }

  const sourceVisible = pathInEffectiveScope(scopes, shielded, delta.fromPath);
  if (sourceVisible && destinationVisible) return delta;
  // A crossing rename must never disclose the hidden endpoint. Project it as
  // the visible structural effect at the active context boundary.
  if (sourceVisible) {
    return { kind: "membership", action: "remove", relativePath: delta.fromPath };
  }
  if (destinationVisible) {
    return { kind: "membership", action: "add", relativePath: delta.relativePath };
  }
  return null;
}

/** Gather one immutable, fail-closed snapshot. Parallel completion order never
 * affects the path/log order or fingerprint returned to downstream consumers. */
export async function gatherContextSnapshot(
  folder: FolderRef,
  files: Record<string, FileState>,
  scopes: ContextMounts,
  activePath: string,
  shielded: Set<string> = new Set(),
  options: ContextGatherOptions = {},
): Promise<ContextSnapshot> {
  throwIfAborted(options.signal);
  const contextFiles = promptContextFiles(files);
  const targetState = contextFiles[activePath];
  const targetBody = targetState && targetState.kind !== "folder"
    ? flattenRuns(targetState.runs)
    : "";
  const failures: ContextSnapshotFailure[] = [];
  if (!targetState || targetState.kind === "folder") {
    failures.push({
      stage: "target",
      path: activePath,
      message: !targetState ? "focused target is unavailable" : "folder focus is not a document target",
    });
  }

  // Target content is always present; mounts add context but never determine
  // which document the MODEL operation mutates.
  const includedPaths = Object.keys(contextFiles)
    .filter((path) => contextFiles[path]?.kind !== "folder")
    .filter((path) => path === activePath || pathInEffectiveScope(scopes, shielded, path))
    .sort();
  const selectedFiles = Object.fromEntries(
    includedPaths.map((path) => [path, contextFiles[path]]),
  );
  const entries = entriesFromFiles(selectedFiles);

  const fetchChainImpl = options.fetchChain ?? fetchChain;
  const resolveFileChainAtHeadImpl = options.resolveFileChainAtHead ??
    (options.fetchChain === undefined
      ? async (headId: string) => {
          const traceId = await resolveTraceIdentity(headId);
          if (!traceId) throw new Error(`cannot resolve stable file identity at ${headId}`);
          const resolution = await resolveTraceChainAtHead(traceId, headId);
          if (resolution.status !== "resolved") {
            throw new Error(`cannot resolve exact file head ${headId}`);
          }
          return { traceId, chain: resolution.chain };
        }
      : undefined);
  const fetchFolderNodesImpl = options.fetchFolderNodes ?? fetchFolderNodes;
  const resolveFolderIdentityAtHeadImpl = options.resolveFolderIdentityAtHead ??
    (async (headId: string) => {
      const head = await (options.fetchEventById ?? fetchEventById)(headId);
      return resolveVerifiedFolderTraceIdentityAtHead(head, fetchFolderNodesImpl);
    });
  const fileJobs: Array<() => Promise<GatherJobResult>> = includedPaths
    .filter((path) => Boolean(contextFiles[path]?.nodeId))
    .map((path) => () => {
      const coordinate = directoryTraceCoordinate(folder.id, contextFiles, path);
      if (!coordinate) {
        return Promise.resolve({
          merged: [],
          failures: [{
            stage: "chain" as const,
            path,
            message: "direct recursive folder trace is unavailable",
          }],
        });
      }
      return gatherFileChain(
        coordinate.folderId,
        coordinate.relativePath,
        path,
        contextFiles[path].nodeId,
        fetchChainImpl,
        resolveFileChainAtHeadImpl,
        options.signal,
        options.fetchChain === undefined && options.resolveFileChainAtHead === undefined,
      );
    });
  const rootFolderNodeId = options.rootFolderNodeId ??
    loadLocalFolder(folder.id)?.nodeId;
  const folderTraces = scopes.length > 0
    ? directoryFolderTraces(
        folder.id,
        contextFiles,
        scopes,
        shielded,
        rootFolderNodeId,
      )
    : [];
  const boundedFolderTraces = folderTraces.slice(0, MAX_HISTORICAL_FOLDER_TRACES);
  if (folderTraces.length > boundedFolderTraces.length) {
    failures.push({
      stage: "folder-log",
      path: boundedFolderTraces[boundedFolderTraces.length - 1]?.path ?? "",
      message: `initial folder traversal exceeds ${MAX_HISTORICAL_FOLDER_TRACES} occurrences`,
    });
  }
  const requestedFolderLimits = options.folderTraversalLimits ?? {};
  const folderLoadContext: FolderLoadContext = {
    fetcher: fetchFolderNodesImpl,
    signal: options.signal,
    budget: {
      maxEvents: Math.min(
        requestedFolderLimits.maxEvents ?? TRACE_TRAVERSAL_MAX_EVENTS,
        TRACE_TRAVERSAL_MAX_EVENTS,
      ),
      maxSignedBytes: Math.min(
        requestedFolderLimits.maxSignedBytes ?? TRACE_TRAVERSAL_MAX_SIGNED_BYTES,
        TRACE_TRAVERSAL_MAX_SIGNED_BYTES,
      ),
      events: 0,
      signedBytes: 0,
      charged: new Set(),
    },
    chains: new Map(),
  };
  type ContextLoadResult =
    | { kind: "file"; result: GatherJobResult }
    | { kind: "folder"; result: Awaited<ReturnType<typeof loadFolderTrace>> };
  const loadJobs: Array<() => Promise<ContextLoadResult>> = [
    ...fileJobs.map((job) => async () => ({
      kind: "file" as const,
      result: await job(),
    })),
    ...boundedFolderTraces.map((trace) => async () => ({
      kind: "folder" as const,
      result: await loadFolderTrace(trace, folderLoadContext),
    })),
  ];
  const loadResults = await mapBounded(
    loadJobs,
    options.concurrency ?? 4,
    (job) => job(),
  );
  const fileResults = loadResults.flatMap((loaded) =>
    loaded.kind === "file" ? [loaded.result] : []
  );
  const folderLoadResults = loadResults.flatMap((loaded) =>
    loaded.kind === "folder" ? [loaded.result] : []
  );
  throwIfAborted(options.signal);
  const initialFolderTraces = folderLoadResults.flatMap((result) =>
    result.ok ? [result.trace] : []
  );
  const loadedFileTraces = fileResults.flatMap((result) =>
    result.fileTrace ? [result.fileTrace] : []
  );
  const historicalFolders = await discoverHistoricalFolderTraces(
    initialFolderTraces,
    loadedFileTraces,
    folderLoadContext,
    resolveFolderIdentityAtHeadImpl,
    options.signal,
    options.concurrency ?? 4,
  );
  const loadedFolderTraces = historicalFolders.traces;
  failures.push(...historicalFolders.failures);
  const eventPaths = temporalTraceEventPaths(loadedFolderTraces, loadedFileTraces);
  const fileTraceIdByNodeId = new Map(
    loadedFileTraces.flatMap((trace) =>
      trace.chain.map((event) => [event.id, trace.traceId] as const)
    ),
  );
  const historicalFilePaths = new Set(loadedFileTraces.flatMap((trace) =>
    trace.chain.flatMap((event) => {
      const path = temporalTraceEventPath(eventPaths, event.id, trace.path);
      return path && !isShielded(shielded, path) ? [path] : [];
    })
  ));
  const relevantMembership = relevantContextMembership(
    initialFolderTraces,
    loadedFolderTraces,
    loadedFileTraces,
  );
  for (const result of fileResults) {
    result.merged = result.merged.filter((observation) => {
      if (observation.nodeId) {
        const historicalPath = temporalTraceEventPath(
          eventPaths,
          observation.nodeId,
          result.fileTrace?.path ?? observation.relativePath,
        ) ?? observation.relativePath;
        // A trace moved out of a shield does not authorize disclosure of its
        // former hidden pathname or process evidence. Non-shielded historical
        // paths remain visible because Analyze follows stable trace identity.
        if (isShielded(shielded, historicalPath)) return false;
        observation.relativePath = historicalPath;
      }
      return true;
    });
  }
  const folderResults = [
    ...folderLoadResults.flatMap((result) => result.ok ? [] : [result.failure]),
    ...loadedFolderTraces.map((trace) => gatherLoadedFolderLog(
      trace,
      eventPaths,
      scopes,
      shielded,
      historicalFilePaths,
      relevantMembership.nodeIds,
      relevantMembership.folderIds,
      loadedFileTraces.length > 0 || initialFolderTraces.some((folderTrace) => folderTrace.path !== ""),
    )),
  ];
  const jobResults = [...fileResults, ...folderResults];
  const merged = jobResults.flatMap((result) => result.merged);
  failures.push(...jobResults.flatMap((result) => result.failures));
  const causallyOrdered = orderCanonicalMerged(merged);
  const deltaLog: DeltaLogEntry[] = causallyOrdered.map(({
    stableId: _stableId,
    dependencyIds: _dependencyIds,
    ...entry
  }, index) => ({
    seq: index + 1,
    ...entry,
  }));

  const renderedBlock = renderContextBlock({
    folderLabel: folder.label ?? folder.id.slice(0, 8),
    entries,
    activePath,
    deltaLog,
    // A snapshot is all-or-nothing. The total snapshot budget below rejects
    // an oversized request instead of silently substituting omitted stubs.
    budget: Number.MAX_SAFE_INTEGER,
  });
  const shieldDecisions = contextShieldDecisions(contextFiles, scopes, shielded);
  return createContextSnapshot({
    target: {
      kind: "file",
      folderId: folder.id,
      path: activePath,
      traceId: targetState?.traceId ?? null,
      headId: targetState?.nodeId || null,
      body: targetBody,
    },
    mount: scopes[0] ? { ...scopes[0] } : null,
    shields: shieldDecisions,
    inputs: includedPaths.map((path) => {
      const state = contextFiles[path];
      const inputTraceId = state.traceId ?? fileTraceIdByNodeId.get(state.nodeId);
      const body = flattenRuns(state.runs);
      const citations = [
        ...(state.citationIds ?? []),
        ...findResolvedBrackets(body).map((citation) => citation.nodeId),
      ];
      return {
        path,
        traceId: state.traceId ?? null,
        headId: state.nodeId || null,
        body,
        citations,
        deltaLog: deltaLog.filter((entry) =>
          entry.source === "file"
            ? Boolean(
                inputTraceId &&
                entry.nodeId &&
                fileTraceIdByNodeId.get(entry.nodeId) === inputTraceId
              )
            : entry.relativePath === path
        ),
        unstepped: !state.nodeId,
      };
    }),
    deltaLog,
    renderedBlock,
    failures,
    maxBytes: options.maxBytes,
  });
}

async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

async function gatherFileChain(
  folderId: string,
  relativePath: string,
  displayPath: string,
  expectedHead: string,
  fetcher: (folderId: string, relativePath: string) => Promise<Event[]>,
  exactResolver: ((headId: string) => Promise<{ traceId: string; chain: Event[] }>) | undefined,
  signal: AbortSignal | undefined,
  memoize: boolean,
): Promise<GatherJobResult> {
  const key = `${folderId}|${relativePath}|${expectedHead}`;
  try {
    throwIfAborted(signal);
    let chain = memoize ? chainMemo.get(key) : undefined;
    let traceId: string | undefined;
    if (!chain) {
      if (exactResolver) {
        const resolved = await exactResolver(expectedHead);
        chain = resolved.chain;
        traceId = resolved.traceId;
      } else {
        chain = await fetcher(folderId, relativePath);
      }
      throwIfAborted(signal);
      assertTraceTraversalBudget(chain);
      if (chain.length === 0 || chain[chain.length - 1]?.id !== expectedHead) {
        return {
          merged: [],
          failures: [{ stage: "chain", path: displayPath, message: "published head is unavailable or changed" }],
        };
      }
      if (memoize) chainMemo.set(key, chain);
    }
    traceId ??= chain[0]?.id;
    if (!traceId || chain[0]?.id !== traceId) {
      return {
        merged: [],
        failures: [{ stage: "chain", path: displayPath, message: "file trace identity does not match its genesis" }],
      };
    }
    const conformance = await verifyFileTraceChain(chain);
    const conformanceByNode = new Map(
      conformance.steps.map((step) => [step.nodeId, step.status]),
    );
    const merged: CanonicalMerged[] = [];
    for (let index = 0; index < chain.length; index++) {
      const event = chain[index];
      const prevSnapshot = index > 0 ? parsedSnapshot(chain[index - 1]) : "";
      let parsed: { steppedAt?: number; summary?: string; deltas?: RawFileDelta[] };
      try {
        parsed = JSON.parse(event.content) as typeof parsed;
      } catch {
        return {
          merged: [],
          failures: [{ stage: "chain", path: displayPath, message: `invalid event ${event.id.slice(0, 8)}…` }],
        };
      }
      const stepConformance = conformance.status === "invalid"
        ? "invalid"
        : conformanceByNode.get(event.id) ?? conformance.status;
      const spans = stepConformance === "invalid"
        ? []
        : fileDeltasToViews(parsed.deltas ?? [], prevSnapshot);
      merged.push({
        steppedAt: typeof parsed.steppedAt === "number"
          ? parsed.steppedAt
          : (event.created_at ?? 0) * 1000,
        action: event.tags.find((tag) => tag[0] === "action")?.[1] ?? "edit",
        relativePath: displayPath,
        source: "file",
        prompt: null,
        summary: typeof parsed.summary === "string" ? parsed.summary : null,
        deltas: spans.length > 0 ? spans : undefined,
        process: stepConformance === "invalid"
          ? undefined
          : traceProcessFromEvent(event, prevSnapshot),
        conformance: stepConformance,
        conformanceReason: conformance.issues.find(
          (issue) => issue.nodeId === event.id,
        )?.message,
        nodeId: event.id,
        stableId: event.id,
        dependencyIds: [
          ...eventDependencyIds(event),
          ...(index > 0 ? [chain[index - 1].id] : []),
        ],
      });
    }
    return {
      merged,
      failures: [],
      fileTrace: {
        traceId: traceId ?? expectedHead,
        path: displayPath,
        chain,
      },
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      merged: [],
      failures: [{
        stage: "chain",
        path: displayPath,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

interface LoadedFolderTrace {
  folderId: string;
  path: string;
  nodeId?: string;
  chain: Event[];
}

interface FolderLoadBudget {
  maxEvents: number;
  maxSignedBytes: number;
  events: number;
  signedBytes: number;
  charged: Set<string>;
}

interface FolderLoadContext {
  fetcher: (folderId: string) => Promise<Event[]>;
  signal?: AbortSignal;
  budget: FolderLoadBudget;
  chains: Map<string, Promise<{ chain: Event[]; nodeId: string }>>;
}

function folderEventTime(event: Event): number {
  try {
    const parsed = JSON.parse(event.content) as { steppedAt?: unknown };
    if (typeof parsed.steppedAt === "number" && Number.isFinite(parsed.steppedAt)) {
      return parsed.steppedAt;
    }
  } catch {
    // Fall back to the signed Nostr timestamp.
  }
  return (event.created_at ?? 0) * 1000;
}

const temporalOccurrencePaths = new WeakMap<
  ReadonlyMap<string, string>,
  ReadonlyMap<string, string>
>();

/** Map each folder checkpoint to the path where that folder identity was
 * mounted at that time. Parent membership history, not today's local path,
 * supplies the projection. */
export function temporalTraceEventPaths(
  traces: readonly LoadedFolderTrace[],
  fileTraces: readonly LoadedFileTrace[] = [],
): Map<string, string> {
  type LocatedNode = { traceId: string; index: number };
  type Occurrence = {
    at: number;
    order: number;
    path: string;
    pinnedIndex: number;
    parentChain: string;
    parentIndex: number;
    aliased: boolean;
  };
  const folderNode = new Map<string, LocatedNode>();
  for (const trace of traces) {
    trace.chain.forEach((event, index) => {
      folderNode.set(event.id, { traceId: trace.folderId, index });
    });
  }
  const fileNode = new Map<string, LocatedNode>();
  for (const trace of fileTraces) {
    trace.chain.forEach((event, index) => {
      fileNode.set(event.id, { traceId: trace.traceId, index });
    });
  }
  const occurrences = new Map<string, Occurrence[]>();
  const paths = new Map<string, string>();
  const occurrencePaths = new Map<string, string>();
  temporalOccurrencePaths.set(paths, occurrencePaths);
  let occurrenceOrder = 0;
  const assignTracePaths = (
    traceId: string,
    path: string,
    chain: readonly Event[],
  ) => {
    const allHistory = occurrences.get(traceId) ?? [];
    // If one parent mounted the same immutable trace more than once, each
    // loaded occurrence must retain its own projection. A rename is different:
    // its old and new paths are causal history for the same occurrence.
    const aliasedAtThisPath = allHistory.some(
      (candidate) => candidate.aliased && candidate.path === path,
    );
    const history = (aliasedAtThisPath
      ? allHistory.filter((candidate) => !candidate.aliased || candidate.path === path)
      : allHistory
    ).slice().sort((left, right) => {
      if (left.parentChain === right.parentChain) {
        return left.parentIndex - right.parentIndex || left.order - right.order;
      }
      return left.at - right.at || left.order - right.order;
    });
    chain.forEach((event, index) => {
      // The first parent checkpoint whose pinned descendant reaches this node
      // proves where the immutable event entered the recursive tree. This also
      // handles child genesis, which necessarily predates its first add.
      const occurrence = history.find((candidate) => candidate.pinnedIndex >= index);
      const historicalPath = occurrence?.path ?? path;
      occurrencePaths.set(traceEventOccurrenceKey(event.id, path), historicalPath);
      if (!paths.has(event.id)) paths.set(event.id, historicalPath);
    });
  };
  const sorted = [...traces].sort((left, right) =>
    left.path.split("/").filter(Boolean).length -
      right.path.split("/").filter(Boolean).length ||
    left.path.localeCompare(right.path)
  );
  for (const trace of sorted) {
    assignTracePaths(trace.folderId, trace.path, trace.chain);
    const traceIsAliased = (occurrences.get(trace.folderId) ?? []).some(
      (candidate) => candidate.aliased && candidate.path === trace.path,
    );
    const parentChain = `${trace.folderId}\u0000${trace.path}`;
    for (const [parentIndex, event] of trace.chain.entries()) {
      const at = folderEventTime(event);
      const parentPath = temporalTraceEventPath(paths, event.id, trace.path) ?? trace.path;
      const members = folderReplayState(event, parentPath).members.flatMap((member) => {
        if (!member.latestNodeId) return [];
        const located = member.kind === "folder"
          ? folderNode.get(member.latestNodeId)
          : fileNode.get(member.latestNodeId);
        if (!located) return [];
        const childPath = parentPath
          ? `${parentPath}/${member.relativePath}`
          : member.relativePath;
        return [{ located, childPath }];
      });
      const countByTrace = new Map<string, number>();
      for (const member of members) {
        countByTrace.set(
          member.located.traceId,
          (countByTrace.get(member.located.traceId) ?? 0) + 1,
        );
      }
      for (const { located, childPath } of members) {
        const history = occurrences.get(located.traceId) ?? [];
        history.push({
          at,
          order: occurrenceOrder++,
          path: childPath,
          pinnedIndex: located.index,
          parentChain,
          parentIndex,
          aliased: traceIsAliased || (countByTrace.get(located.traceId) ?? 0) > 1,
        });
        occurrences.set(located.traceId, history);
      }
    }
  }
  for (const trace of fileTraces) {
    assignTracePaths(trace.traceId, trace.path, trace.chain);
  }
  return paths;
}

function traceEventOccurrenceKey(eventId: string, occurrencePath: string): string {
  return `${eventId}\u0000${occurrencePath}`;
}

/** Resolve one immutable event through a particular mounted occurrence. The
 * raw event-id entry remains for compatibility with callers that have no
 * occurrence coordinate, but recursive context always supplies one. */
export function temporalTraceEventPath(
  paths: ReadonlyMap<string, string>,
  eventId: string,
  occurrencePath: string,
): string | undefined {
  return temporalOccurrencePaths.get(paths)?.get(
    traceEventOccurrenceKey(eventId, occurrencePath),
  ) ?? paths.get(eventId);
}

export function temporalFolderEventPaths(
  traces: readonly LoadedFolderTrace[],
): Map<string, string> {
  return temporalTraceEventPaths(traces);
}

async function loadFolderTrace(
  trace: { folderId: string; path: string; nodeId?: string },
  context: FolderLoadContext,
): Promise<
  | { ok: true; trace: LoadedFolderTrace }
  | { ok: false; failure: GatherJobResult }
> {
  try {
    throwIfAborted(context.signal);
    const requestedKey = `${trace.folderId}\u0000${trace.nodeId ?? "latest"}`;
    let pending = context.chains.get(requestedKey);
    if (!pending) {
      pending = (async () => {
        const nodes = await context.fetcher(trace.folderId);
        throwIfAborted(context.signal);
        if (nodes.length === 0) throw new Error("folder trace is unavailable");
        const chain = trace.nodeId
          ? orderReplayTraceChainAtHead(nodes, trace.folderId, trace.nodeId)
          : orderReplayTraceChain(nodes, trace.folderId);
        if (chain.length === 0) {
          throw new Error("cannot resolve one complete verified folder chain");
        }
        assertTraceTraversalBudget(chain);
        const nodeId = chain[chain.length - 1].id;
        const conformance = await verifyFolderTraceChain(chain, {
          expectedTraceId: trace.folderId,
          expectedNucleusId: nodeId,
        });
        if (conformance.status !== "full") {
          const reason = conformance.issues[0]?.message ?? conformance.status;
          throw new Error(`folder trace is not fully conformant: ${reason}`);
        }
        const immutableKey = `${trace.folderId}\u0000${nodeId}`;
        if (!context.budget.charged.has(immutableKey)) {
          const signedBytes = chain.reduce(
            (total, event) => total + traceSignedEventBytes(event),
            0,
          );
          if (context.budget.events + chain.length > context.budget.maxEvents) {
            throw new Error(
              `aggregate folder history exceeds ${context.budget.maxEvents} signed events`,
            );
          }
          if (context.budget.signedBytes + signedBytes > context.budget.maxSignedBytes) {
            throw new Error(
              `aggregate folder history exceeds ${context.budget.maxSignedBytes} signed bytes`,
            );
          }
          context.budget.events += chain.length;
          context.budget.signedBytes += signedBytes;
          context.budget.charged.add(immutableKey);
        }
        return { chain, nodeId };
      })();
      context.chains.set(requestedKey, pending);
    }
    const loaded = await pending;
    const immutableKey = `${trace.folderId}\u0000${loaded.nodeId}`;
    context.chains.set(immutableKey, Promise.resolve(loaded));
    return { ok: true, trace: { ...trace, nodeId: loaded.nodeId, chain: loaded.chain } };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      ok: false,
      failure: {
        merged: [],
        failures: [{
          stage: "folder-log",
          path: trace.path,
          message: error instanceof Error ? error.message : String(error),
        }],
      },
    };
  }
}

/** Follow immutable folder-member pins from the verified current ancestry.
 * File Steps name their direct historical `f` identity, but that identity may
 * have been removed from today's workspace. Recursively loading signed parent
 * membership is the only honest way to recover its mounted path. */
async function discoverHistoricalFolderTraces(
  initial: readonly LoadedFolderTrace[],
  files: readonly LoadedFileTrace[],
  loadContext: FolderLoadContext,
  resolveIdentity: (headId: string) => Promise<string | null>,
  signal: AbortSignal | undefined,
  concurrency: number,
): Promise<{ traces: LoadedFolderTrace[]; failures: ContextSnapshotFailure[] }> {
  const traces = [...initial];
  const failures: ContextSnapshotFailure[] = [];
  const required = new Set(files.flatMap((file) =>
    file.chain.flatMap((event) => {
      const folderId = event.tags.find((tag) => tag[0] === "f")?.[1];
      return folderId ? [folderId] : [];
    })
  ));
  const queued = new Set(traces.map((trace) =>
    `${trace.folderId}\u0000${trace.path}\u0000${trace.nodeId ?? ""}`
  ));
  const processed = new Set<string>();
  let cursor = 0;
  let truncated = false;
  // Bound hostile recursive alias graphs while leaving ample room for a real
  // zine. Hitting the bound fails completeness below for any required parent.
  while (cursor < traces.length && traces.length < MAX_HISTORICAL_FOLDER_TRACES) {
    throwIfAborted(signal);
    const batch = traces.slice(cursor, cursor + Math.max(1, concurrency));
    cursor += batch.length;
    const remaining = MAX_HISTORICAL_FOLDER_TRACES - traces.length;
    const candidates: ReturnType<typeof historicalReplayMembers> = [];
    candidateScan:
    for (const parent of batch) {
      for (const member of historicalReplayMembers(parent.folderId, parent.path, parent.chain)) {
        if (member.kind !== "folder") continue;
        const key = `${member.nodeId}\u0000${member.path}`;
        if (processed.has(key)) continue;
        // Enforce the traversal budget before exact-node fetch or identity
        // verification. A single hostile parent can no longer overshoot the
        // cap by contributing an arbitrarily large batch.
        if (candidates.length >= remaining) {
          truncated = true;
          break candidateScan;
        }
        processed.add(key);
        candidates.push(member);
      }
    }
    const discovered = await mapBounded(
      candidates,
      concurrency,
      async (member) => {
        try {
          const folderId = await resolveIdentity(member.nodeId);
          if (!folderId) return null;
          // A folder containing itself beneath the same occurrence path is a
          // cycle, not another alias occurrence.
          if (traces.some((trace) =>
            trace.folderId === folderId &&
            (member.path === trace.path || member.path.startsWith(`${trace.path}/`))
          )) return null;
          const key = `${folderId}\u0000${member.path}\u0000${member.nodeId}`;
          if (queued.has(key)) return null;
          const loaded = await loadFolderTrace({
            folderId,
            path: member.path,
            nodeId: member.nodeId,
          }, loadContext);
          if (!loaded.ok) return null;
          queued.add(key);
          return loaded.trace;
        } catch (error) {
          if (isAbort(error)) throw error;
          return null;
        }
      },
    );
    traces.push(...discovered.filter((trace): trace is LoadedFolderTrace => trace !== null));
  }
  if (truncated || cursor < traces.length) {
    failures.push({
      stage: "folder-log",
      path: traces[Math.min(cursor, traces.length - 1)]?.path ?? "",
      message: `historical folder traversal exceeds ${MAX_HISTORICAL_FOLDER_TRACES} occurrences`,
    });
  }
  const loadedIds = new Set(traces.map((trace) => trace.folderId));
  for (const folderId of required) {
    if (!loadedIds.has(folderId)) {
      failures.push({
        stage: "folder-log",
        path: files.find((file) => file.chain.some((event) =>
          event.tags.some((tag) => tag[0] === "f" && tag[1] === folderId)
        ))?.path ?? "",
        message: `historical parent folder ${folderId} is unavailable`,
      });
    }
  }
  return { traces, failures };
}

function rebaseObservationPath(path: string, from: string, to: string): string {
  if (from === to) return path;
  if (path === from) return to;
  if (from && path.startsWith(`${from}/`)) {
    const suffix = path.slice(from.length + 1);
    return to ? `${to}/${suffix}` : suffix;
  }
  if (!from && to) return path ? `${to}/${path}` : to;
  return path;
}

function eventDependencyIds(event: Event): string[] {
  const dependencies = new Set<string>();
  for (const tag of event.tags) {
    if (
      (tag[0] === "e" && tag[3] === "prev") ||
      tag[0] === "q"
    ) {
      if (tag[1]) dependencies.add(tag[1]);
    }
  }
  try {
    const parsed = JSON.parse(event.content) as {
      deltas?: Array<{ nodeId?: unknown; previousNodeId?: unknown }>;
      folderCheckpoint?: { sourceNodeId?: unknown };
    };
    if (typeof parsed.folderCheckpoint?.sourceNodeId === "string") {
      dependencies.add(parsed.folderCheckpoint.sourceNodeId);
    }
    for (const delta of parsed.deltas ?? []) {
      if (typeof delta.nodeId === "string") dependencies.add(delta.nodeId);
      if (typeof delta.previousNodeId === "string") dependencies.add(delta.previousNodeId);
    }
  } catch {
    // Invalid payloads are rejected before folder observations reach this path.
  }
  dependencies.delete(event.id);
  return [...dependencies];
}

function canonicalReadyOrder(left: CanonicalMerged, right: CanonicalMerged): number {
  return left.steppedAt - right.steppedAt ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.source.localeCompare(right.source) ||
    left.stableId.localeCompare(right.stableId);
}

/** Stable Kahn ordering. A rolled-back steppedAt can never place a descendant
 * before its signed `prev`, cited member, or child-advance dependency. */
function orderCanonicalMerged(entries: readonly CanonicalMerged[]): CanonicalMerged[] {
  const observationsByNode = new Map<string, CanonicalMerged[]>();
  for (const entry of entries) {
    if (!entry.nodeId) continue;
    const observations = observationsByNode.get(entry.nodeId) ?? [];
    observations.push(entry);
    observationsByNode.set(entry.nodeId, observations);
  }
  const remainingDependencies = new Map<CanonicalMerged, number>();
  const dependents = new Map<CanonicalMerged, CanonicalMerged[]>();
  for (const entry of entries) {
    const prerequisites = new Set<CanonicalMerged>();
    for (const dependencyId of entry.dependencyIds) {
      for (const prerequisite of observationsByNode.get(dependencyId) ?? []) {
        if (prerequisite !== entry) prerequisites.add(prerequisite);
      }
    }
    remainingDependencies.set(entry, prerequisites.size);
    for (const prerequisite of prerequisites) {
      const next = dependents.get(prerequisite) ?? [];
      next.push(entry);
      dependents.set(prerequisite, next);
    }
  }
  const ready = entries.filter((entry) => remainingDependencies.get(entry) === 0)
    .sort(canonicalReadyOrder);
  const ordered: CanonicalMerged[] = [];
  while (ready.length > 0) {
    const entry = ready.shift()!;
    ordered.push(entry);
    for (const dependent of dependents.get(entry) ?? []) {
      const remaining = (remainingDependencies.get(dependent) ?? 0) - 1;
      remainingDependencies.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort(canonicalReadyOrder);
      }
    }
  }
  // Verified trace chains are acyclic. Keep a deterministic, visible fallback
  // if an injected test seam supplies a cycle instead of silently dropping it.
  if (ordered.length < entries.length) {
    const emitted = new Set(ordered);
    ordered.push(...entries.filter((entry) => !emitted.has(entry)).sort(canonicalReadyOrder));
  }
  return ordered;
}

function relevantContextMembership(
  initialFolders: readonly LoadedFolderTrace[],
  folders: readonly LoadedFolderTrace[],
  files: readonly LoadedFileTrace[],
): { folderIds: Set<string>; nodeIds: Set<string> } {
  const folderIds = new Set(initialFolders.map((trace) => trace.folderId));
  for (const file of files) {
    for (const event of file.chain) {
      const parent = event.tags.find((tag) => tag[0] === "f")?.[1];
      if (parent) folderIds.add(parent);
    }
  }
  const folderByNode = new Map<string, string>();
  for (const trace of folders) {
    for (const event of trace.chain) folderByNode.set(event.id, trace.folderId);
  }
  // If a loaded historical folder contains a relevant child folder, that
  // parent is part of the selected identity's ancestry as well.
  let changed = true;
  while (changed) {
    changed = false;
    for (const trace of folders) {
      if (folderIds.has(trace.folderId)) continue;
      const containsRelevantFolder = trace.chain.some((event) =>
        folderReplayState(event, trace.path).members.some((member) =>
          Boolean(member.latestNodeId && folderIds.has(folderByNode.get(member.latestNodeId) ?? ""))
        )
      );
      if (containsRelevantFolder) {
        folderIds.add(trace.folderId);
        changed = true;
      }
    }
  }
  const nodeIds = new Set(files.flatMap((trace) => trace.chain.map((event) => event.id)));
  for (const trace of folders) {
    if (!folderIds.has(trace.folderId)) continue;
    for (const event of trace.chain) nodeIds.add(event.id);
  }
  return { folderIds, nodeIds };
}

function gatherLoadedFolderLog(
  trace: LoadedFolderTrace,
  temporalPaths: ReadonlyMap<string, string>,
  scopes: ContextMounts,
  shielded: Set<string>,
  historicalFilePaths: ReadonlySet<string> = new Set(),
  relevantMembershipNodeIds: ReadonlySet<string> = new Set(),
  relevantFolderIds: ReadonlySet<string> = new Set(),
  filterMembershipIdentities = false,
): GatherJobResult {
  const merged: CanonicalMerged[] = [];
  if (relevantFolderIds.size > 0 && !relevantFolderIds.has(trace.folderId)) {
    return { merged, failures: [] };
  }
  for (const [nodeIndex, node] of trace.chain.entries()) {
    const historicalPath = temporalTraceEventPath(temporalPaths, node.id, trace.path) ?? trace.path;
    for (const observation of folderCheckpointLogObservations(node, historicalPath)) {
      if (
        filterMembershipIdentities &&
        observation.membershipNodeId &&
        !relevantMembershipNodeIds.has(observation.membershipNodeId)
      ) continue;
      const projected = projectFolderLogObservationToScope(
        observation,
        scopes,
        shielded,
        historicalFilePaths,
      );
      if (!projected) continue;
      merged.push({
        steppedAt: projected.steppedAt,
        action: projected.action,
        relativePath: projected.relativePath,
        ...(projected.fromPath !== undefined
          ? { fromPath: projected.fromPath }
          : {}),
        source: "folder",
        prompt: null,
        summary: null,
        deltas: undefined,
        process: undefined,
        conformance: undefined,
        conformanceReason: undefined,
        nodeId: node.id,
        stableId: `${node.id}:${projected.action}:${projected.fromPath ?? ""}:${projected.relativePath}`,
        dependencyIds: [
          ...eventDependencyIds(node),
          ...(nodeIndex > 0 ? [trace.chain[nodeIndex - 1].id] : []),
        ],
      });
    }
  }
  return { merged, failures: [] };
}

function contextShieldDecisions(
  files: Record<string, FileState>,
  scopes: ContextMounts,
  shielded: Set<string>,
): ContextShieldDecision[] {
  return Object.keys(files)
    .filter((path) => files[path]?.kind !== "folder")
    .sort()
    .map((path) => {
      if (pathInEffectiveScope(scopes, shielded, path)) {
        return { path, decision: "included" as const, boundary: null };
      }
      const boundary = [...shielded]
        .sort((left, right) => right.length - left.length)
        .find((candidate) => candidate === "" || path === candidate || path.startsWith(`${candidate}/`));
      return boundary !== undefined
        ? { path, decision: "shielded" as const, boundary }
        : { path, decision: "outside-mount" as const, boundary: null };
    });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Context gather was cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Keep the prompt-context view aligned with the Press tree's four independent
 * regions. Mint, Scan, and Oblivion share the client-side file map with Root
 * for UI rendering, but none is a descendant of Root: Coins are supplied only
 * by operations that explicitly request a local stepped-trace inventory, intake must
 * be adopted deliberately, and deleted drafts must not re-enter a model prompt.
 */
export function promptContextFiles(
  files: Record<string, FileState>,
): Record<string, FileState> {
  return Object.fromEntries(
    Object.entries(files).filter(
      ([path]) =>
        !isMintPath(path) &&
        !isScanPath(path) &&
        !isOblivionPath(path),
    ),
  );
}

/** Derive the flat entry list from the in-memory file map. Directories are
 *  synthesized from path prefixes (the client's `files` only knows files).
 *  Folder-member entries (kind: "folder") are skipped — they have no body to
 *  render, and their path enters the tree as a directory via prefix-synthesis
 *  from the files beneath them (or as a standalone dir if empty). */
function entriesFromFiles(files: Record<string, FileState>): ContextEntry[] {
  const out: ContextEntry[] = [];
  const seenDirs = new Set<string>();
  for (const [rel, state] of Object.entries(files)) {
    if (state.kind === "folder") continue; // folder-member: no body to render
    // Synthesize directory entries for every prefix, so the tree shows them.
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        out.push({ relativePath: dir, content: null });
      }
    }
    out.push({ relativePath: rel, content: flattenRuns(state.runs) });
  }
  return out;
}

/** Is `path` at or below a raw shielded boundary? Effective scope selection may
 *  lift a boundary by starting an explicit scope root at or inside it. */
export function isShielded(shielded: Set<string>, path: string): boolean {
  if (shielded.size === 0) return false;
  if (shielded.has("")) return true;
  if (shielded.has(path)) return true;
  // Walk ancestor prefixes: `a/b/c.md` → `a/b` → `a`.
  let slash = path.lastIndexOf("/");
  while (slash > 0) {
    if (shielded.has(path.slice(0, slash))) return true;
    slash = path.lastIndexOf("/", slash - 1);
  }
  return false;
}

/** Resolve one flattened workspace path to its direct recursive folder trace.
 * File TraceNodes carry the direct folder id and one-segment structural name,
 * even though local/UI state addresses them from Root. */
export function directoryTraceCoordinate(
  rootFolderId: string,
  files: Readonly<Record<string, FileState>>,
  path: string,
): { folderId: string; relativePath: string } | null {
  const separator = path.lastIndexOf("/");
  if (separator === -1) return { folderId: rootFolderId, relativePath: path };
  const parentPath = path.slice(0, separator);
  const parent = files[parentPath];
  const folderId = parent?.kind === "folder" ? parent.traceId ?? parent.nodeId : null;
  return folderId
    ? { folderId, relativePath: path.slice(separator + 1) }
    : null;
}

/** Folder traces needed to explain the selected recursive context. Ancestors
 * preserve how an exact file/folder was placed; a folder mount also contributes
 * every descendant folder's own orchestration. */
export function directoryFolderTraces(
  rootFolderId: string,
  files: Readonly<Record<string, FileState>>,
  scopes: ContextMounts,
  shielded: ReadonlySet<string> = new Set(),
  rootNodeId?: string,
): Array<{ folderId: string; path: string; nodeId?: string }> {
  if (scopes.length === 0) return [];
  const candidates = [
    {
      folderId: rootFolderId,
      path: "",
      ...(rootNodeId ? { nodeId: rootNodeId } : {}),
    },
    ...Object.entries(files).flatMap(([path, file]) => {
      if (file.kind !== "folder") return [];
      const folderId = file.traceId ?? file.nodeId;
      return folderId
        ? [{ folderId, path, ...(file.nodeId ? { nodeId: file.nodeId } : {}) }]
        : [];
    }),
  ];
  return candidates.filter((candidate, index, all) =>
    all.findIndex((other) =>
      other.folderId === candidate.folderId && other.path === candidate.path
    ) === index &&
    (
      candidate.path === "" ||
      pathInEffectiveScope(scopes, shielded, candidate.path) ||
      scopes.some((scope) =>
        scope.path === candidate.path || scope.path.startsWith(`${candidate.path}/`),
      )
    ) &&
    scopes.some((scope) => {
      const path = scope.path;
      if (candidate.path === "") return true;
      if (scope.kind === "file") {
        return path === candidate.path || path.startsWith(`${candidate.path}/`);
      }
      return (
        path === "" ||
        candidate.path === path ||
        candidate.path.startsWith(`${path}/`) ||
        path.startsWith(`${candidate.path}/`)
      );
    }),
  );
}

export interface FolderLogObservation {
  steppedAt: number;
  action: "add" | "remove" | "rename" | "advance" | "step" | "metadata";
  relativePath: string;
  fromPath?: string;
  /** Immutable member pin affected by a structural checkpoint. This remains
   * internal to context selection and is stripped from rendered rows. */
  membershipNodeId?: string;
}

/** Project one verified-shape folder payload into mechanical AI observations.
 * A kind replacement may carry remove+add, so one checkpoint can yield more
 * than one row. Cryptographic/chain conformance remains a reader concern. */
export function folderCheckpointLogObservations(
  node: Event,
  folderPath: string,
): FolderLogObservation[] {
  let parsed: {
    steppedAt?: number;
    deltas?: Array<{
      type?: string;
      relativePath?: string;
      fromPath?: string;
      toPath?: string;
      nodeId?: string;
    }>;
    folderCheckpoint?: { cause?: string };
  };
  try {
    parsed = JSON.parse(node.content) as typeof parsed;
  } catch {
    return [];
  }
  const steppedAt = typeof parsed.steppedAt === "number"
    ? parsed.steppedAt
    : (node.created_at ?? 0) * 1000;
  const qualify = (path: string) => folderPath ? `${folderPath}/${path}` : path;
  const structural = (parsed.deltas ?? []).flatMap((delta): FolderLogObservation[] => {
    if (
      delta.type !== "add" &&
      delta.type !== "remove" &&
      delta.type !== "rename" &&
      delta.type !== "advance"
    ) return [];
    if (delta.type === "rename") {
      return delta.fromPath && delta.toPath
        ? [{
            steppedAt,
            action: "rename",
            relativePath: qualify(delta.toPath),
            fromPath: qualify(delta.fromPath),
            ...(delta.nodeId ? { membershipNodeId: delta.nodeId } : {}),
          }]
        : [];
    }
    return delta.relativePath
      ? [{
          steppedAt,
          action: delta.type,
          relativePath: qualify(delta.relativePath),
          ...(delta.nodeId ? { membershipNodeId: delta.nodeId } : {}),
        }]
      : [];
  });
  if (structural.length > 0) return structural;
  if (parsed.folderCheckpoint?.cause === "explicit-step") {
    return [{ steppedAt, action: "step", relativePath: folderPath }];
  }
  if (parsed.folderCheckpoint?.cause === "metadata-change") {
    return [{ steppedAt, action: "metadata", relativePath: folderPath }];
  }
  return [];
}

function projectFolderLogObservationToScope(
  observation: FolderLogObservation,
  scopes: ContextMounts,
  shielded: Set<string>,
  historicalFilePaths: ReadonlySet<string> = new Set(),
): FolderLogObservation | null {
  if (
    observation.action === "add" ||
    observation.action === "remove" ||
    observation.action === "rename"
  ) {
    const projected = projectFolderMembershipToScope({
      kind: "membership",
      action: observation.action,
      relativePath: observation.relativePath,
      ...(observation.fromPath !== undefined ? { fromPath: observation.fromPath } : {}),
    }, scopes, shielded);
    if (projected) {
      return {
        steppedAt: observation.steppedAt,
        action: projected.action,
        relativePath: projected.relativePath,
        ...(projected.fromPath !== undefined ? { fromPath: projected.fromPath } : {}),
        ...(observation.membershipNodeId
          ? { membershipNodeId: observation.membershipNodeId }
          : {}),
      };
    }
    const touchesHistoricalFile = (path: string) =>
      historicalFilePaths.has(path) ||
      [...historicalFilePaths].some((filePath) => filePath.startsWith(`${path}/`));
    const destinationVisible = touchesHistoricalFile(observation.relativePath);
    const sourceVisible = observation.fromPath !== undefined &&
      touchesHistoricalFile(observation.fromPath);
    if (!destinationVisible && !sourceVisible) return null;
    if (observation.action === "rename" && sourceVisible !== destinationVisible) {
      return {
        steppedAt: observation.steppedAt,
        action: sourceVisible ? "remove" : "add",
        relativePath: sourceVisible ? observation.fromPath! : observation.relativePath,
        ...(observation.membershipNodeId
          ? { membershipNodeId: observation.membershipNodeId }
          : {}),
      };
    }
    return observation;
  }
  return pathInEffectiveScope(scopes, shielded, observation.relativePath) ||
      [...historicalFilePaths].some((path) =>
        path === observation.relativePath || path.startsWith(`${observation.relativePath}/`)
      )
    ? observation
    : null;
}

/** Build the aggregated directory log for the scope subtree: every descendant
 *  file's chain events (one `fetchChain` per descendant, walked genesis→head so
 *  oldValue is derivable from the prior snapshot) PLUS every directory's folder
 *  membership events (from `fetchFolderNodes`), filtered to descendants of the
 *  active mount, merged and sorted by steppedAt. A file mount is exact; a
 *  folder mount includes its full subtree; ROOT includes the attached folder.
 *
 *  This is the recursive generalization of the pre-scope-split behavior, which
 *  gathered only the active file's immediate parent's direct children (1 level
 *  deep). Now a mounted folder brings its whole subtree's content AND its
 *  orchestration (add/remove/rename/advance/explicit Step) into context
 *  together — content never travels without the membership chain that placed
 *  it. Version-aware
 *  memoization via a fingerprint of the subtree's nodeIds. */
export async function loadDirectoryLog(
  folderId: string,
  scopes: ContextMounts,
  files: Record<string, FileState>,
  shielded: Set<string> = new Set(),
): Promise<DeltaLogEntry[]> {
  // Every file in the active context. Folder-members (kind: "folder") are
  // skipped — they have no file chain to fetch. Shielded descendants do not
  // enter the chain fetch.
  const subtree = Object.keys(files).filter(
    (p) => files[p]?.kind !== "folder" && pathInEffectiveScope(scopes, shielded, p),
  );
  const folderTraces = [
    {
      folderId,
      path: "",
      ...(loadLocalFolder(folderId)?.nodeId
        ? { nodeId: loadLocalFolder(folderId)!.nodeId }
        : {}),
    },
    ...Object.entries(files).flatMap(([path, file]) => {
      if (file.kind !== "folder" || !pathInEffectiveScope(scopes, shielded, path)) return [];
      const traceId = file.traceId ?? file.nodeId;
      return traceId
        ? [{ folderId: traceId, path, ...(file.nodeId ? { nodeId: file.nodeId } : {}) }]
        : [];
    }),
  ].filter((trace, index, all) =>
    all.findIndex((candidate) =>
      candidate.folderId === trace.folderId && candidate.path === trace.path
    ) === index,
  );
  // Folder nodes participate in the cache key too. An explicit folder/Root
  // Step may change no file head, but it is still new process context.
  const folderNodeSets = await Promise.all(folderTraces.map(async (trace) => {
    try {
      return { ...trace, nodes: await fetchFolderNodes(trace.folderId) };
    } catch {
      return { ...trace, nodes: [] as Event[] };
    }
  }));
  // Fingerprint: sorted (path, nodeId) pairs over the WHOLE subtree. Any step/
  // mint/fork on any descendant advances its nodeId, changing the fingerprint
  // and forcing a refetch. Includes empty-string nodeIds (unstepped-this-
  // session) so a first step also invalidates. Includes the shielded set so a
  // toggle re-invalidates the cache.
  const fingerprint = subtree
    .sort()
    .map((p) => `${p}:${files[p]?.nodeId ?? ""}`)
    .join("|");
  const folderFingerprint = folderNodeSets
    .map(({ folderId: traceId, nodes }) =>
      `${traceId}:${nodes.map((node) => node.id).sort().join(",")}`,
    )
    .join("|");
  const key = `${folderId}|${traceRefsKey(scopes)}|${fingerprint}|${folderFingerprint}|${[...shielded].sort().join(",")}`;

  const cached = logMemo.get(key);
  if (cached) return cached;

  type Merged = {
    steppedAt: number;
    action: string;
    relativePath: string;
    fromPath?: string;
    source: "file" | "folder";
    prompt: string | null;
    summary: string | null;
    deltas: DeltaSpanView[] | undefined;
    process: TraceProcessView | undefined;
    conformance: TraceConformanceStatus | undefined;
    conformanceReason: string | undefined;
    nodeId: string | undefined;
  };
  const merged: Merged[] = [];
  // File events: walk each descendant's prev-chain in genesis→head order
  // (fetchChain resolves the head and walks `e...prev` back, then reverses —
  // store.ts does the same). Ordering matters here because the client doesn't
  // persist `oldValue` on publish (spec-compliant — recoverable as
  // prev.snapshot.slice(start, end)); walking the chain in order lets us derive
  // each node's oldValue from the prior node's snapshot. This is the data the
  // bare action log lacked: with the per-span payload the model can reconstruct
  // any prior state, not just "an edit happened."
  for (const rel of subtree) {
    const coordinate = directoryTraceCoordinate(folderId, files, rel);
    if (!coordinate) continue;
    let chain: Event[];
    try {
      chain = await fetchChain(coordinate.folderId, coordinate.relativePath);
    } catch {
      continue; // relay hiccup on this descendant — skip it, others may still land.
    }
    const conformance = await verifyFileTraceChain(chain);
    const conformanceByNode = new Map(
      conformance.steps.map((step) => [step.nodeId, step.status]),
    );
    for (let i = 0; i < chain.length; i++) {
      const event = chain[i];
      const prevSnapshot = i > 0 ? parsedSnapshot(chain[i - 1]) : "";
      let steppedAt = (event.created_at ?? 0) * 1000;
      let summary: string | null = null;
      let parsed: {
        deltas?: RawFileDelta[];
        snapshot?: string;
      };
      try {
        parsed = JSON.parse(event.content) as { steppedAt?: number; summary?: string; deltas?: RawFileDelta[]; snapshot?: string };
        const full = parsed as { steppedAt?: number; summary?: string };
        if (typeof full.steppedAt === "number") steppedAt = full.steppedAt;
        if (typeof full.summary === "string") summary = full.summary;
      } catch {
        // non-JSON content — no deltas, fall back to created_at.
        continue;
      }
      const action = event.tags.find((t) => t[0] === "action")?.[1] ?? "edit";
      const stepConformance = conformance.status === "invalid"
        ? "invalid"
        : conformanceByNode.get(event.id) ?? conformance.status;
      const spans = stepConformance === "invalid"
        ? []
        : fileDeltasToViews(parsed.deltas ?? [], prevSnapshot);
      merged.push({
        steppedAt,
        action,
        relativePath: rel,
        source: "file",
        prompt: null,
        summary,
        deltas: spans.length > 0 ? spans : undefined,
        process: stepConformance === "invalid"
          ? undefined
          : traceProcessFromEvent(event, prevSnapshot),
        conformance: stepConformance,
        conformanceReason: conformance.issues.find(
          (issue) => issue.nodeId === event.id,
        )?.message,
        nodeId: event.id,
      });
    }
  }

  // Folder checkpoints whose affected path belongs to the effective scope.
  // Genesis is dropped; explicit Steps remain visible even without a delta.
  try {
    const loadedFolderTraces: LoadedFolderTrace[] = [];
    for (const folderTrace of folderNodeSets) {
      const chain = folderTrace.nodeId
        ? orderReplayTraceChainAtHead(
            folderTrace.nodes,
            folderTrace.folderId,
            folderTrace.nodeId,
          )
        : orderReplayTraceChain(folderTrace.nodes, folderTrace.folderId);
      if (chain.length === 0) continue;
      const conformance = await verifyFolderTraceChain(chain, {
        expectedTraceId: folderTrace.folderId,
        ...(folderTrace.nodeId ? { expectedNucleusId: folderTrace.nodeId } : {}),
      });
      if (conformance.status !== "full") continue;
      loadedFolderTraces.push({
        folderId: folderTrace.folderId,
        path: folderTrace.path,
        nodeId: folderTrace.nodeId,
        chain,
      });
    }
    const folderEventPaths = temporalFolderEventPaths(loadedFolderTraces);
    for (const folderTrace of loadedFolderTraces) {
      for (const node of folderTrace.chain) {
        const historicalPath = folderEventPaths.get(node.id) ?? folderTrace.path;
        for (const observation of folderCheckpointLogObservations(node, historicalPath)) {
          const scopeObservation: FolderLogObservation = {
            ...observation,
            relativePath: rebaseObservationPath(
              observation.relativePath,
              historicalPath,
              folderTrace.path,
            ),
            ...(observation.fromPath !== undefined
              ? {
                  fromPath: rebaseObservationPath(
                    observation.fromPath,
                    historicalPath,
                    folderTrace.path,
                  ),
                }
              : {}),
          };
          const visibleObservation = projectFolderLogObservationToScope(
            scopeObservation,
            scopes,
            shielded,
          );
          if (!visibleObservation) continue;
          merged.push({
            ...visibleObservation,
            relativePath: rebaseObservationPath(
              visibleObservation.relativePath,
              folderTrace.path,
              historicalPath,
            ),
            ...(visibleObservation.fromPath !== undefined
              ? {
                  fromPath: rebaseObservationPath(
                    visibleObservation.fromPath,
                    folderTrace.path,
                    historicalPath,
                  ),
                }
              : {}),
            source: "folder",
            prompt: null,
            summary: null,
            deltas: undefined, // folder checkpoints have no prose payload
            process: undefined,
            conformance: undefined,
            conformanceReason: undefined,
            nodeId: node.id,
          });
        }
      }
    }
  } catch {
    // No folder chain yet — file events alone are fine.
  }

  // Stable sort by steppedAt (oldest first). Ties keep insertion order, which
  // is file-events-then-folder-events — matching publish order (a file node is
  // stepped before its paired folder-membership node).
  merged.sort((a, b) => a.steppedAt - b.steppedAt);
  const result: DeltaLogEntry[] = merged.map((m, i) => ({ seq: i + 1, ...m }));
  logMemo.set(key, result);
  return result;
}

/** Raw shape of a file delta on the wire (see publishEdit / spec §FileTraceNode
 *  Content). The client publishes WITHOUT `oldValue` (spec-compliant —
 *  recoverable as prev.snapshot.slice(start, end)), so this type deliberately
 *  omits it. We derive oldValue in `fileDeltasToViews` by slicing the prior
 *  node's snapshot. Non-content delta types (reply-to, tag-add) carry no
 *  position/newValue and render no span block. */
interface RawFileDelta {
  type?: string;
  position?: { start?: number; end?: number };
  newValue?: string | null;
}

/** Pull a node's `snapshot` string off its content. "" on missing/unparseable —
 *  the prior-snapshot fallback for deriving a span's oldValue. */
function parsedSnapshot(event: Event): string {
  try {
    const parsed = JSON.parse(event.content) as { snapshot?: string };
    return typeof parsed.snapshot === "string" ? parsed.snapshot : "";
  } catch {
    return "";
  }
}

/** Turn a node's raw file deltas into renderer views, deriving `oldValue` for
 *  delete/replace spans from the PRIOR node's snapshot (the client doesn't
 *  persist oldValue). Drops non-content deltas (reply-to, tag-add) and any
 *  span whose position is malformed — the renderer only wants positional prose
 *  deltas. Returns [] for a node with nothing renderable (genesis, quote-only
 *  with no payload, etc.) so the caller can omit the field. */
function fileDeltasToViews(deltas: RawFileDelta[], prevSnapshot: string): DeltaSpanView[] {
  const out: DeltaSpanView[] = [];
  for (const d of deltas) {
    const start = d.position?.start;
    const end = d.position?.end;
    if (typeof start !== "number" || typeof end !== "number") continue; // non-positional
    // Only delete/replace have an oldValue; derive it by slicing the prior
    // snapshot. insert/quote/tag-add introduced new text without removing any.
    const hasOld = d.type === "delete" || d.type === "replace";
    const oldValue = hasOld ? prevSnapshot.slice(start, end) : null;
    out.push({
      type: d.type ?? "insert",
      positionStart: start,
      positionEnd: end,
      oldValue,
      newValue: d.newValue ?? null,
    });
  }
  return out;
}
