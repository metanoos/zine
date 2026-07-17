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
 * The delta log is an AGGREGATED SCOPE LOG: every selected file's kind-4290
 * chain plus matching folder kind-4292 membership events, interleaved by
 * steppedAt. Folder scopes recursively add descendant files; multiple scopes
 * form a union; shielded boundaries below each explicit scope root are omitted.
 * File events come from one
 * `fetchChain` per included file (walked genesis→head so the client can
 * derive each node's `oldValue` from the prior node's snapshot — it doesn't
 * persist oldValue, spec-compliant); one `fetchFolderNodes` call gets every
 * membership event.
 *
 * Memoization: both fetches are network calls, so the merged log is memoized
 * under a key that includes the scope set and a fingerprint of included head
 * nodeIds. Any step/mint/fork that advances an included chain head
 * changes the fingerprint → the next gather refetches automatically. No
 * manual invalidation hooks. Cleared wholesale on folder switch.
 */
import type { Event } from "nostr-tools";

import type { FileState, FolderRef } from "./workspace-core.js";
import { flattenRuns } from "./workspace-core.js";
import { findResolvedBrackets } from "./brackets.js";
import { fetchChain, fetchFolderNodes } from "./provenance.js";
import { pathInEffectiveScopes, scopeKey, type ScopeRef } from "./scope-model.js";
import {
  renderContextBlock,
  type ContextEntry,
  type DeltaLogEntry,
  type DeltaSpanView,
  renderLimelightLog,
  type LimelightEntry,
} from "./context-block.js";
import {
  createContextSnapshot,
  type ContextShieldDecision,
  type ContextSnapshot,
  type ContextSnapshotFailure,
} from "./context-snapshot.js";

// Re-export so App.tsx can import the limelight renderer alongside the gather
// entry point from one module (same pattern as the types below would use).
export { renderLimelightLog, type LimelightEntry };

/** Memo key → merged directory log entries. */
const logMemo = new Map<string, DeltaLogEntry[]>();
const snapshotChainMemo = new Map<string, Event[]>();

/** Drop the whole memo — e.g. on folder switch (see the `folder?.id` effect in
 *  App.tsx). Per-directory invalidation is implicit: the memo key includes a
 *  fingerprint of the directory's direct-child nodeIds, so any head advance
 *  refetches on the next gather. */
export function clearChainMemo(): void {
  logMemo.clear();
  snapshotChainMemo.clear();
}

/** Gather and render the canonical context block for an op against `activePath`
 *  (the focused/target file), scoped to the union of `scopes`. A folder scope
 *  gathers every descendant file's content + membership chain; a file scope
 *  gathers only that file.
 *
 *  `shielded` is the set of recursive traversal boundaries. A shielded descendant
 *  of a scoped folder is dropped from the rendered entries and delta log, but
 *  explicitly selecting that shielded file/folder starts a new inclusion root.
 *
 *  Never throws: if a chain fetch fails, that file's log is simply omitted (the
 *  rest still renders). */
export async function gatherContextBlock(
  folder: FolderRef,
  files: Record<string, FileState>,
  scopes: readonly ScopeRef[],
  activePath: string,
  shielded: Set<string> = new Set(),
): Promise<string> {
  const entries: ContextEntry[] = entriesFromFiles(files).filter(
    (e) => pathInEffectiveScopes(scopes, shielded, e.relativePath),
  );

  const deltaLog = await loadDirectoryLog(folder.id, scopes, files, shielded);

  return renderContextBlock({
    folderLabel: folder.label ?? folder.id.slice(0, 8),
    entries,
    activePath,
    deltaLog,
  });
}

export interface ContextGatherOptions {
  signal?: AbortSignal;
  concurrency?: number;
  maxBytes?: number;
  fetchChain?: (folderId: string, relativePath: string) => Promise<Event[]>;
  fetchFolderNodes?: (folderId: string) => Promise<Event[]>;
}

interface CanonicalLogEntry {
  steppedAt: number;
  action: string;
  relativePath: string;
  source: "file" | "folder";
  prompt: string | null;
  summary: string | null;
  deltas: DeltaSpanView[] | undefined;
  stableId: string;
}

interface GatherJobResult {
  entries: CanonicalLogEntry[];
  failures: ContextSnapshotFailure[];
}

/** Gather one immutable, fail-closed snapshot for a prepared MODEL request.
 * Completion order cannot affect path ordering, log ordering, or the final
 * fingerprint. The active target is always included even when it sits outside
 * the mounted context union; mounts add readable context, not write authority. */
export async function gatherContextSnapshot(
  folder: FolderRef,
  files: Record<string, FileState>,
  scopes: readonly ScopeRef[],
  activePath: string,
  shielded: Set<string> = new Set(),
  options: ContextGatherOptions = {},
): Promise<ContextSnapshot> {
  throwIfAborted(options.signal);
  const targetState = files[activePath];
  const failures: ContextSnapshotFailure[] = [];
  if (!targetState || targetState.kind === "folder") {
    failures.push({
      stage: "target",
      path: activePath,
      message: !targetState
        ? "focused target is unavailable"
        : "folder focus is not a document target",
    });
  }

  const includedPaths = Object.keys(files)
    .filter((path) => files[path]?.kind !== "folder")
    .filter((path) => path === activePath || pathInEffectiveScopes(scopes, shielded, path))
    .sort();
  const selectedFiles = Object.fromEntries(
    includedPaths.map((path) => [path, files[path]]),
  );
  const entries = entriesFromFiles(selectedFiles);
  const chainFetcher = options.fetchChain ?? fetchChain;
  const folderFetcher = options.fetchFolderNodes ?? fetchFolderNodes;
  const jobs: Array<() => Promise<GatherJobResult>> = includedPaths
    .filter((path) => Boolean(files[path]?.nodeId))
    .map((path) => () => gatherFileChain(
      folder.id,
      path,
      files[path].nodeId,
      chainFetcher,
      options.signal,
      chainFetcher === fetchChain,
    ));
  if (scopes.length > 0) {
    jobs.push(() => gatherFolderLog(
      folder.id,
      scopes,
      activePath,
      shielded,
      folderFetcher,
      options.signal,
    ));
  }
  const results = await mapBounded(
    jobs,
    options.concurrency ?? 4,
    (job) => job(),
  );
  throwIfAborted(options.signal);
  failures.push(...results.flatMap((result) => result.failures));
  const merged = results.flatMap((result) => result.entries);
  merged.sort((left, right) =>
    left.steppedAt - right.steppedAt ||
    left.relativePath.localeCompare(right.relativePath) ||
    left.source.localeCompare(right.source) ||
    left.stableId.localeCompare(right.stableId));
  const deltaLog: DeltaLogEntry[] = merged.map(
    ({ stableId: _stableId, ...entry }, index) => ({ seq: index + 1, ...entry }),
  );
  const renderedBlock = renderContextBlock({
    folderLabel: folder.label ?? folder.id.slice(0, 8),
    entries,
    activePath,
    deltaLog,
    // Prepared requests reject an oversized full snapshot. They never replace
    // selected file bodies with renderer-level omission stubs.
    budget: Number.MAX_SAFE_INTEGER,
  });
  const targetBody = targetState && targetState.kind !== "folder"
    ? flattenRuns(targetState.runs)
    : "";

  return createContextSnapshot({
    target: {
      kind: "file",
      folderId: folder.id,
      path: activePath,
      traceId: targetState?.traceId ?? null,
      headId: targetState?.nodeId || null,
      body: targetBody,
    },
    mounts: scopes.map((scope) => ({ ...scope })),
    shields: contextShieldDecisions(files, scopes, activePath, shielded),
    inputs: includedPaths.map((path) => {
      const state = files[path];
      const body = flattenRuns(state.runs);
      return {
        path,
        traceId: state.traceId ?? null,
        headId: state.nodeId || null,
        body,
        citations: [
          ...(state.taggedTraces ?? []),
          ...findResolvedBrackets(body).map((citation) => citation.nodeId),
        ],
        deltaLog: deltaLog.filter((entry) => entry.relativePath === path),
        unstepped: !state.nodeId,
      };
    }),
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
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        results[index] = await mapper(values[index], index);
      }
    }),
  );
  return results;
}

async function gatherFileChain(
  folderId: string,
  path: string,
  expectedHead: string,
  fetcher: (folderId: string, relativePath: string) => Promise<Event[]>,
  signal: AbortSignal | undefined,
  memoize: boolean,
): Promise<GatherJobResult> {
  const key = `${folderId}|${path}|${expectedHead}`;
  try {
    throwIfAborted(signal);
    let chain = memoize ? snapshotChainMemo.get(key) : undefined;
    if (!chain) {
      chain = await fetcher(folderId, path);
      throwIfAborted(signal);
      if (chain.length === 0 || chain[chain.length - 1]?.id !== expectedHead) {
        return {
          entries: [],
          failures: [{
            stage: "chain",
            path,
            message: "published head is unavailable or changed",
          }],
        };
      }
      if (memoize) snapshotChainMemo.set(key, chain);
    }
    const entries: CanonicalLogEntry[] = [];
    for (let index = 0; index < chain.length; index++) {
      const event = chain[index];
      const previousSnapshot = index > 0 ? parsedSnapshot(chain[index - 1]) : "";
      let parsed: { steppedAt?: number; summary?: string; deltas?: RawFileDelta[] };
      try {
        parsed = JSON.parse(event.content) as typeof parsed;
      } catch {
        return {
          entries: [],
          failures: [{
            stage: "chain",
            path,
            message: `invalid event ${event.id.slice(0, 8)}…`,
          }],
        };
      }
      const spans = fileDeltasToViews(parsed.deltas ?? [], previousSnapshot);
      entries.push({
        steppedAt: typeof parsed.steppedAt === "number"
          ? parsed.steppedAt
          : (event.created_at ?? 0) * 1000,
        action: event.tags.find((tag) => tag[0] === "action")?.[1] ?? "edit",
        relativePath: path,
        source: "file",
        prompt: null,
        summary: typeof parsed.summary === "string" ? parsed.summary : null,
        deltas: spans.length > 0 ? spans : undefined,
        stableId: event.id,
      });
    }
    return { entries, failures: [] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      entries: [],
      failures: [{
        stage: "chain",
        path,
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

async function gatherFolderLog(
  folderId: string,
  scopes: readonly ScopeRef[],
  activePath: string,
  shielded: Set<string>,
  fetcher: (folderId: string) => Promise<Event[]>,
  signal?: AbortSignal,
): Promise<GatherJobResult> {
  try {
    throwIfAborted(signal);
    const nodes = await fetcher(folderId);
    throwIfAborted(signal);
    const entries: CanonicalLogEntry[] = [];
    for (const node of nodes) {
      let parsed: {
        steppedAt?: number;
        deltas?: { type: string; relativePath: string }[];
      };
      try {
        parsed = JSON.parse(node.content) as typeof parsed;
      } catch {
        return {
          entries: [],
          failures: [{
            stage: "folder-log",
            path: "",
            message: `invalid event ${node.id.slice(0, 8)}…`,
          }],
        };
      }
      const steppedAt = typeof parsed.steppedAt === "number"
        ? parsed.steppedAt
        : (node.created_at ?? 0) * 1000;
      for (let index = 0; index < (parsed.deltas ?? []).length; index++) {
        const delta = parsed.deltas![index];
        if (
          delta.relativePath !== activePath &&
          !pathInEffectiveScopes(scopes, shielded, delta.relativePath)
        ) continue;
        entries.push({
          steppedAt,
          action: delta.type,
          relativePath: delta.relativePath,
          source: "folder",
          prompt: null,
          summary: null,
          deltas: undefined,
          stableId: `${node.id}:${index}`,
        });
      }
    }
    return { entries, failures: [] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      entries: [],
      failures: [{
        stage: "folder-log",
        path: "",
        message: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function contextShieldDecisions(
  files: Record<string, FileState>,
  scopes: readonly ScopeRef[],
  activePath: string,
  shielded: Set<string>,
): ContextShieldDecision[] {
  return Object.keys(files)
    .filter((path) => files[path]?.kind !== "folder")
    .sort()
    .map((path) => {
      if (path === activePath || pathInEffectiveScopes(scopes, shielded, path)) {
        return { path, decision: "included" as const, boundary: null };
      }
      const boundary = [...shielded]
        .filter((candidate) =>
          candidate === "" || path === candidate || path.startsWith(`${candidate}/`))
        .sort((left, right) => right.length - left.length)[0] ?? null;
      return boundary
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

/** Build the aggregated directory log for the scope subtree: every descendant
 *  file's chain events (one `fetchChain` per descendant, walked genesis→head so
 *  oldValue is derivable from the prior snapshot) PLUS every directory's folder
 *  membership events (from `fetchFolderNodes`), filtered to descendants of the
 *  selected union, merged and sorted by steppedAt. A file scope is exact; a
 *  folder scope includes its full subtree; ROOT includes the attached folder.
 *
 *  This is the recursive generalization of the pre-scope-split behavior, which
 *  gathered only the active file's immediate parent's direct children (1 level
 *  deep). Now a mounted folder brings its whole subtree's content AND its
 *  orchestration (add/remove/rename) into context together — content never
 *  travels without the membership chain that placed it. Version-aware
 *  memoization via a fingerprint of the subtree's nodeIds. */
async function loadDirectoryLog(
  folderId: string,
  scopes: readonly ScopeRef[],
  files: Record<string, FileState>,
  shielded: Set<string> = new Set(),
): Promise<DeltaLogEntry[]> {
  // Every file in the selected union. Folder-members (kind: "folder") are
  // skipped — they have no file chain to fetch. Shielded descendants do not
  // enter the chain fetch unless a scope starts at or inside their boundary.
  const subtree = Object.keys(files).filter(
    (p) => files[p]?.kind !== "folder" && pathInEffectiveScopes(scopes, shielded, p),
  );
  // Fingerprint: sorted (path, nodeId) pairs over the WHOLE subtree. Any step/
  // mint/fork on any descendant advances its nodeId, changing the fingerprint
  // and forcing a refetch. Includes empty-string nodeIds (unstepped-this-
  // session) so a first step also invalidates. Includes the shielded set so a
  // toggle re-invalidates the cache.
  const fingerprint = subtree
    .sort()
    .map((p) => `${p}:${files[p]?.nodeId ?? ""}`)
    .join("|");
  const key = `${folderId}|${scopeKey(scopes)}|${fingerprint}|${[...shielded].sort().join(",")}`;

  const cached = logMemo.get(key);
  if (cached) return cached;

  type Merged = {
    steppedAt: number;
    action: string;
    relativePath: string;
    source: "file" | "folder";
    prompt: string | null;
    summary: string | null;
    deltas: DeltaSpanView[] | undefined;
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
    let chain: Event[];
    try {
      chain = await fetchChain(folderId, rel);
    } catch {
      continue; // relay hiccup on this descendant — skip it, others may still land.
    }
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
      const spans = fileDeltasToViews(parsed.deltas ?? [], prevSnapshot);
      merged.push({
        steppedAt,
        action,
        relativePath: rel,
        source: "file",
        prompt: null,
        summary,
        deltas: spans.length > 0 ? spans : undefined,
      });
    }
  }

  // Folder membership events: every 4292 node whose affected path belongs to
  // the effective scope union. Genesis nodes (no delta) are dropped.
  try {
    const nodes = await fetchFolderNodes(folderId);
    for (const node of nodes) {
      let steppedAt = (node.created_at ?? 0) * 1000;
      let delta: { type: string; relativePath: string } | null = null;
      try {
        const parsed = JSON.parse(node.content) as {
          steppedAt?: number;
          deltas?: { type: string; relativePath: string }[];
        };
        if (typeof parsed.steppedAt === "number") steppedAt = parsed.steppedAt;
        delta = parsed.deltas?.[0] ?? null;
      } catch {
        continue;
      }
      if (!delta) continue;
      if (!pathInEffectiveScopes(scopes, shielded, delta.relativePath)) continue;
      merged.push({
        steppedAt,
        action: delta.type, // 'add' | 'remove' | 'rename'
        relativePath: delta.relativePath,
        source: "folder",
        prompt: null,
        summary: null,
        deltas: undefined, // membership events have no content payload
      });
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
