/**
 * Client-side adapter for the canonical context block. Gathers the inputs the
 * pure renderer (`context-block.ts`) needs from the in-memory file set + the
 * relay chains, then returns the rendered string for an op to prepend to its
 * user message.
 *
 * The folder tree and sibling file text come straight from App state
 * (`files: Record<string, FileState>`) — `baselineScan` already populated it
 * on attach, so no new Tauri IPC is needed and this works equally on the
 * webapp (where `files` is populated from localStorage/the relay).
 *
 * The delta log is now an AGGREGATED DIRECTORY LOG: every direct-child file's
 * kind-4290 chain events PLUS the folder's kind-4292 membership events (add/
 * remove) for that directory, interleaved by sealedAt. File events come from
 * one `fetchChain` per direct child (walked genesis→head so the client can
 * derive each node's `oldValue` from the prior node's snapshot — it doesn't
 * persist oldValue, spec-compliant); one `fetchFolderNodes` call gets every
 * membership event. Both are filtered to the active file's immediate parent
 * directory (1 level deep).
 *
 * Memoization: both fetches are network calls, so the merged log is memoized
 * under a key that includes a FINGERPRINT of the directory's direct children's
 * nodeIds. Any seal/mint/fork that advances a direct child's chain head
 * changes the fingerprint → the next gather refetches automatically. No
 * manual invalidation hooks. Cleared wholesale on folder switch.
 */
import type { Event } from "nostr-tools";

import type { FileState, FolderRef } from "./workspace-core.js";
import { flattenRuns } from "./workspace-core.js";
import { fetchChain, fetchFolderNodes } from "./provenance.js";
import {
  renderContextBlock,
  type ContextEntry,
  type DeltaLogEntry,
  type DeltaSpanView,
  renderLimelightLog,
  type LimelightEntry,
} from "./context-block.js";

// Re-export so App.tsx can import the limelight renderer alongside the gather
// entry point from one module (same pattern as the types below would use).
export { renderLimelightLog, type LimelightEntry };

/** Memo key → merged directory log entries. */
const logMemo = new Map<string, DeltaLogEntry[]>();

/** Drop the whole memo — e.g. on folder switch (see the `folder?.id` effect in
 *  App.tsx). Per-directory invalidation is implicit: the memo key includes a
 *  fingerprint of the directory's direct-child nodeIds, so any head advance
 *  refetches on the next gather. */
export function clearChainMemo(): void {
  logMemo.clear();
}

/** The scope mount: the file or folder whose subtree bounds the context an LLM
 *  op receives. Distinct from the focused/active file (the write target): the
 *  scope decides HOW MUCH context is gathered; the active file decides WHERE
 *  an op lands and gets the (ACTIVE) emphasis tag. `path === ""` (ROOT) means
 *  the whole attached folder — the pre-scope-split behavior. */
export interface ScopeRef {
  kind: "file" | "folder";
  path: string;
}

/** Gather and render the canonical context block for an op against `activePath`
 *  (the focused/target file), scoped to `scope`'s subtree. The scope recurses:
 *  a folder scope gathers every descendant file's content + every directory's
 *  membership chain; a file scope treats its parent directory as the root (and
 *  still recurses beneath that, so siblings-and-below all enter context).
 *
 *  Never throws: if a chain fetch fails, that file's log is simply omitted (the
 *  rest still renders). */
export async function gatherContextBlock(
  folder: FolderRef,
  files: Record<string, FileState>,
  scope: ScopeRef,
  activePath: string,
): Promise<string> {
  const entries: ContextEntry[] = entriesFromFiles(files);
  // Ensure the active file is present even if (pathologically) it isn't in
  // `files` yet — the renderer tags it (ACTIVE) and shows "(empty)".
  if (!entries.some((e) => e.relativePath === activePath)) {
    entries.push({ relativePath: activePath, content: "" });
  }

  const deltaLog = await loadDirectoryLog(folder.id, scope, files);

  return renderContextBlock({
    folderLabel: folder.label ?? folder.id.slice(0, 8),
    entries,
    activePath,
    deltaLog,
  });
}

/** Immediate parent directory of a POSIX relative path. `notes/essay.md` →
 *  `notes`; `essay.md` → `""` (folder root). */
function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf("/");
  return slash < 0 ? "" : relativePath.slice(0, slash);
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

/** Is `descendant` inside `ancestor`'s subtree (the ancestor itself, or
 *  nested beneath it)? ROOT ("") matches everything — the whole attached
 *  folder. */
function within(ancestor: string, descendant: string): boolean {
  if (ancestor === "") return true;
  if (descendant === ancestor) return true;
  return descendant.startsWith(ancestor + "/");
}

/** Build the aggregated directory log for the scope subtree: every descendant
 *  file's chain events (one `fetchChain` per descendant, walked genesis→head so
 *  oldValue is derivable from the prior snapshot) PLUS every directory's folder
 *  membership events (from `fetchFolderNodes`), filtered to descendants of the
 *  scope root, merged and sorted by sealedAt. A file scope roots at the file's
 *  parent directory (siblings-and-below); a folder scope roots at the folder
 *  itself; ROOT means the whole attached folder.
 *
 *  This is the recursive generalization of the pre-scope-split behavior, which
 *  gathered only the active file's immediate parent's direct children (1 level
 *  deep). Now a mounted folder brings its whole subtree's content AND its
 *  orchestration (add/remove/rename) into context together — content never
 *  travels without the membership chain that placed it. Version-aware
 *  memoization via a fingerprint of the subtree's nodeIds. */
async function loadDirectoryLog(
  folderId: string,
  scope: ScopeRef,
  files: Record<string, FileState>,
): Promise<DeltaLogEntry[]> {
  // The scope root directory: a file mounts its parent (siblings-and-below); a
  // folder mounts itself. ROOT ("") = the whole attached folder.
  const root = scope.kind === "file" ? parentOf(scope.path) : scope.path;
  // Every descendant file under the scope root. Folder-members (kind: "folder")
  // are skipped — they have no file chain to fetch, and fetchChain is relpath-
  // keyed for files, not folder-id-keyed.
  const subtree = Object.keys(files).filter(
    (p) => files[p]?.kind !== "folder" && within(root, p),
  );
  // Fingerprint: sorted (path, nodeId) pairs over the WHOLE subtree. Any seal/
  // mint/fork on any descendant advances its nodeId, changing the fingerprint
  // and forcing a refetch. Includes empty-string nodeIds (unsealed-this-
  // session) so a first seal also invalidates.
  const fingerprint = subtree
    .sort()
    .map((p) => `${p}:${files[p]?.nodeId ?? ""}`)
    .join("|");
  const key = `${folderId}|${root}|${fingerprint}`;

  const cached = logMemo.get(key);
  if (cached) return cached;

  type Merged = {
    sealedAt: number;
    action: string;
    relativePath: string;
    source: "file" | "folder";
    prompt: string | null;
    summary: string | null;
    deltas: DeltaSpanView[] | undefined;
  };
  const merged: Merged[] = [];
  const childSet = new Set(subtree);

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
      let sealedAt = (event.created_at ?? 0) * 1000;
      let summary: string | null = null;
      let parsed: {
        deltas?: RawFileDelta[];
        snapshot?: string;
      };
      try {
        parsed = JSON.parse(event.content) as { sealedAt?: number; summary?: string; deltas?: RawFileDelta[]; snapshot?: string };
        const full = parsed as { sealedAt?: number; summary?: string };
        if (typeof full.sealedAt === "number") sealedAt = full.sealedAt;
        if (typeof full.summary === "string") summary = full.summary;
      } catch {
        // non-JSON content — no deltas, fall back to created_at.
        continue;
      }
      const action = event.tags.find((t) => t[0] === "action")?.[1] ?? "edit";
      const spans = fileDeltasToViews(parsed.deltas ?? [], prevSnapshot);
      merged.push({
        sealedAt,
        action,
        relativePath: rel,
        source: "file",
        prompt: null,
        summary,
        deltas: spans.length > 0 ? spans : undefined,
      });
    }
  }

  // Folder membership events: every 4292 node, filtered to those whose delta
  // touches a file in the scope subtree (childSet). Genesis nodes (no delta)
  // are dropped.
  try {
    const nodes = await fetchFolderNodes(folderId);
    for (const node of nodes) {
      let sealedAt = (node.created_at ?? 0) * 1000;
      let delta: { type: string; relativePath: string } | null = null;
      try {
        const parsed = JSON.parse(node.content) as {
          sealedAt?: number;
          deltas?: { type: string; relativePath: string }[];
        };
        if (typeof parsed.sealedAt === "number") sealedAt = parsed.sealedAt;
        delta = parsed.deltas?.[0] ?? null;
      } catch {
        continue;
      }
      if (!delta) continue;
      if (!childSet.has(delta.relativePath)) continue;
      merged.push({
        sealedAt,
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

  // Stable sort by sealedAt (oldest first). Ties keep insertion order, which
  // is file-events-then-folder-events — matching publish order (a file node is
  // sealed before its paired folder-membership node).
  merged.sort((a, b) => a.sealedAt - b.sealedAt);
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
