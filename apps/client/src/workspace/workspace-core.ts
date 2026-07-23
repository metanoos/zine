/**
 * The workspace storage interface.
 *
 * One UI, two storage backends, both selected at boot by `isTauri()`:
 *
 *   - **Desktop** (`workspace.ts`): a real folder on disk is the private
 *     mirror; the relay is the sync/publish target. Every mutation writes to
 *     disk first, then steps a relay node.
 *   - **Webapp/headless** (`workspace-local.ts`): localStorage is the immediate
 *     source of truth; relay pull/push runs as background synchronization.
 *
 * The two agree because the protocol is already folder-keyed, not
 * author-keyed: a kind-4290 chain is walked by `prev` links (any signer can
 * extend it) and a kind-34290 TraceHead is addressed by `folderId` (any reader
 * holding the id can list its files). So a webapp keypair can read and extend
 * a desktop-created folder's chain — the chain just becomes multi-author,
 * which `reconstructFromChain`/`fetchChain` already handle.
 *
 * Both backends use the same protocol and reconcile through the relay without
 * making editor availability depend on a network round trip.
 */

// --- shared editor types ------------------------------------------------
//
// `Run` and `FileState` live here (the storage interface owns the shapes it
// round-trips) and are re-exported by both backends + App.tsx. A run is a
// contiguous span of text attributed to one voice; a file's content is an
// ordered list of runs.
//
// `EventMeta` is type-only here — it's defined in provenance.ts (the nostr
// bridge owns the shape) and carried as an optional on FileState. Type-only,
// so the storage interface doesn't take a runtime dep on nostr-tools.

import {
  synthesizeEditorTransactionTransition,
  validateEditorTransactionTransition,
  type EditorTransaction,
} from "@zine/protocol";
import type { PublicationFence, SampleEventMeta } from "../provenance/provenance.js";

export {
  synthesizeEditorTransactionTransition,
  validateEditorTransactionTransition,
} from "@zine/protocol";
export type { EditorTransactionTransitionValidation } from "@zine/protocol";

/** Append-efficient in-memory log for the current editor-transaction schema. */
export interface EditorTransactionLog {
  readonly length: number;
  readonly tail: EditorTransactionChunk | null;
}

interface EditorTransactionChunk {
  readonly transactions: readonly EditorTransaction[];
  readonly previous: EditorTransactionChunk | null;
}

export const EMPTY_EDITOR_TRANSACTION_LOG: EditorTransactionLog = Object.freeze({
  length: 0,
  tail: null,
});

export function appendEditorTransactionLog(
  log: EditorTransactionLog,
  transactions: readonly EditorTransaction[],
): EditorTransactionLog {
  if (transactions.length === 0) return log;
  return {
    length: log.length + transactions.length,
    tail: { transactions, previous: log.tail },
  };
}

export function editorTransactionLogFromArray(
  transactions: readonly EditorTransaction[],
): EditorTransactionLog {
  return transactions.length === 0
    ? EMPTY_EDITOR_TRANSACTION_LOG
    : appendEditorTransactionLog(EMPTY_EDITOR_TRANSACTION_LOG, transactions);
}

export function editorTransactionLogToArray(
  log: EditorTransactionLog | undefined,
): EditorTransaction[] {
  if (!log || log.length === 0) return [];
  const chunks: (readonly EditorTransaction[])[] = [];
  for (let chunk = log.tail; chunk; chunk = chunk.previous) {
    chunks.push(chunk.transactions);
  }
  chunks.reverse();
  const out: EditorTransaction[] = [];
  for (const chunk of chunks) out.push(...chunk);
  return out;
}

export function nextEditorTransactionSequence(log: EditorTransactionLog): number {
  const transactions = log.tail?.transactions;
  const last = transactions?.[transactions.length - 1];
  const sequence = last?.sequence;
  return Number.isSafeInteger(sequence)
    && sequence !== undefined
    && sequence >= 0
    && sequence < Number.MAX_SAFE_INTEGER
    ? sequence + 1
    : 0;
}

export function applyEditorTransaction(
  runs: Run[],
  transaction: EditorTransaction,
): Run[] {
  const baseLength = flattenRuns(runs).length;
  const changes = transaction.changes.map((change, index) => {
    const from = Math.max(0, Math.min(change.from, baseLength));
    const to = Math.max(from, Math.min(change.to, baseLength));
    return { change, index, from, to };
  });
  changes.sort((a, b) => b.from - a.from || b.to - a.to || b.index - a.index);

  let next = runs;
  for (const { change, from, to } of changes) {
    next = spliceRuns(next, from, to, change.text, transaction.actor);
  }
  return next;
}

export function dropEditorTransactionLogPrefix(
  current: EditorTransactionLog,
  stepped: EditorTransactionLog,
): EditorTransactionLog {
  if (stepped.length === 0) return current;
  if (current.tail === stepped.tail) return EMPTY_EDITOR_TRANSACTION_LOG;

  const suffixNewestFirst: (readonly EditorTransaction[])[] = [];
  let cursor = current.tail;
  while (cursor && cursor !== stepped.tail) {
    suffixNewestFirst.push(cursor.transactions);
    cursor = cursor.previous;
  }
  if (cursor !== stepped.tail) return current;

  let suffix = EMPTY_EDITOR_TRANSACTION_LOG;
  for (let index = suffixNewestFirst.length - 1; index >= 0; index -= 1) {
    suffix = appendEditorTransactionLog(suffix, suffixNewestFirst[index]);
  }
  return suffix;
}

export function resolveStepEditorTransactions(
  before: string,
  after: string,
  captured: readonly EditorTransaction[] | undefined,
  voice: string,
  timestamp = Date.now(),
): {
  editorTransactions: EditorTransaction[];
  source: "captured" | "snapshot";
  rejectedReason?: string;
} {
  if (captured !== undefined) {
    const validation = validateEditorTransactionTransition(before, after, captured);
    if (!validation.valid) {
      throw new Error(
        `invalid captured EditorTransaction log${validation.reason ? `: ${validation.reason}` : ""}`,
      );
    }
    return { editorTransactions: [...captured], source: "captured" };
  }
  return {
    editorTransactions: synthesizeEditorTransactionTransition(
      before,
      after,
      voice,
      timestamp,
    ),
    source: "snapshot",
  };
}

export function recoverStepEditorTransactions(
  before: string,
  after: string,
  captured: readonly EditorTransaction[] | undefined,
  voice: string,
  timestamp = Date.now(),
): {
  editorTransactions: EditorTransaction[];
  source: "captured" | "snapshot";
  rejectedReason?: string;
} {
  try {
    return resolveStepEditorTransactions(before, after, captured, voice, timestamp);
  } catch (error) {
    return {
      editorTransactions: synthesizeEditorTransactionTransition(
        before,
        after,
        voice,
        timestamp,
      ),
      source: "snapshot",
      rejectedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface Run {
  voice: string;
  text: string;
  /** OPTIONAL: event id of a node signed by `voice` that corroborates this
   *  run's text (protocol §3.6 `src`). Used on merge nodes so a foreign
   *  author's runs verify one merge-parent edge away. Absent → asserted,
   *  not verified, until a seam search finds corroboration. */
  src?: string;
}

/**
 * Collapse a run list to its flat text. The inverse direction (text → runs) is
 * lossy by design — voice attribution isn't recoverable from text alone — so
 * backends store runs alongside the flattened text and use this to validate
 * that persisted runs still match the content before trusting them (an external
 * edit invalidates stale attribution, which falls back to a single run).
 */
export function flattenRuns(runs: Run[]): string {
  return runs.map((r) => r.text).join("");
}

/** Append one run while preserving provenance seams. Adjacent runs may only
 * collapse when both their voice and corroborating source are identical. */
function appendRun(out: Run[], run: Run): void {
  if (run.text.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.voice === run.voice && last.src === run.src) {
    last.text += run.text;
  } else {
    out.push({ ...run });
  }
}

/** Slice a run list using the UTF-16 offsets used by JavaScript strings and
 * CodeMirror. Unlike `[...text]`, this keeps astral characters (emoji, some
 * CJK extensions) aligned with editor transaction positions. */
function sliceRuns(runs: Run[], from: number, to: number): Run[] {
  const out: Run[] = [];
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    const overlapFrom = Math.max(from, cursor);
    const overlapTo = Math.min(to, end);
    if (overlapTo > overlapFrom) {
      appendRun(out, {
        ...run,
        text: run.text.slice(overlapFrom - cursor, overlapTo - cursor),
      });
    }
    cursor = end;
    if (cursor >= to) break;
  }
  return out;
}

/** Apply one editor replacement without re-attributing untouched text.
 * `start`/`end` are UTF-16 offsets into the pre-edit document. Only inserted
 * text receives `voice`; surviving runs retain both their voice and `src`. */
export function spliceRuns(
  runs: Run[],
  start: number,
  end: number,
  insertText: string,
  voice: string,
): Run[] {
  const length = flattenRuns(runs).length;
  const from = Math.max(0, Math.min(Math.trunc(start), length));
  const to = Math.max(from, Math.min(Math.trunc(end), length));
  const out = sliceRuns(runs, 0, from);
  appendRun(out, { voice, text: insertText });
  for (const run of sliceRuns(runs, to, length)) appendRun(out, run);
  return out;
}

export interface MinimalTextChange {
  from: number;
  to: number;
  insert: string;
}

/** Find the smallest single replacement that turns `before` into `after`.
 * Offsets use UTF-16 so the result can be sent directly to CodeMirror and to
 * `spliceRuns`. Returns null when the strings are identical. */
export function minimalTextChange(before: string, after: string): MinimalTextChange | null {
  if (before === after) return null;
  const maxPrefix = Math.min(before.length, after.length);
  let from = 0;
  while (from < maxPrefix && before[from] === after[from]) from++;
  let oldEnd = before.length;
  let newEnd = after.length;
  while (oldEnd > from && newEnd > from && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}

/** Reconcile one contiguous external rewrite while retaining the unchanged
 * prefix and suffix runs. This is for metadata rewrites such as changing one
 * citation id: the id is the current author's gesture, but the quoted/model
 * prose around it must keep its original voice. */
export function reconcileRunsText(runs: Run[], nextText: string, voice: string): Run[] {
  const change = minimalTextChange(flattenRuns(runs), nextText);
  return change
    ? spliceRuns(runs, change.from, change.to, change.insert, voice)
    : runs;
}

/**
 * The voice (pubkey) that owns the most characters in `[start, end)` of the
 * flattened run list, by total UTF-16 code-unit length. Offsets are clamped to
 * the document bounds and `start >= end` returns `null` (no region → no voice).
 *
 * Used by the step path to pick a signer that actually matches the *new* text a
 * step commits, so a node's `event.pubkey` attributes its net-new content
 * truthfully even when the `authors` map is later lost (see stepFile in App.tsx).
 * Tie-breaking is first-seen-wins (stable across equal-content runs).
 */
export function dominantVoiceInRegion(
  runs: Run[],
  start: number,
  end: number,
): string | null {
  if (start >= end) return null;
  let cursor = 0;
  const tally = new Map<string, number>();
  for (const r of runs) {
    const len = r.text.length;
    if (len === 0) continue;
    const overlapStart = Math.max(start, cursor);
    const overlapEnd = Math.min(end, cursor + len);
    if (overlapEnd > overlapStart) {
      tally.set(r.voice, (tally.get(r.voice) ?? 0) + (overlapEnd - overlapStart));
    }
    cursor += len;
    if (cursor >= end) break;
  }
  let best: string | null = null;
  let bestLen = -1;
  for (const [voice, n] of tally) {
    if (n > bestLen) {
      best = voice;
      bestLen = n;
    }
  }
  return best;
}

/**
 * The single contiguous region where `prev` and `next` differ, expressed as
 * offsets into `next` — the same common-prefix/suffix shape as
 * provenance.ts's `stepDeltaRange`. A pure local copy so workspace-core callers
 * don't take a provenance import just for the diff. Returns `null` when the
 * texts are identical (no new-text region to attribute).
 */
export function changedRegion(
  prev: string,
  next: string,
): { from: number; to: number } | null {
  const change = minimalTextChange(prev, next);
  return change
    ? { from: change.from, to: change.from + change.insert.length }
    : null;
}

export interface FileState {
  /** "file" or "folder". Omitted by callers for the default file case.
   *  A folder-member (kind: "folder") is a subfolder trace cited by the parent
   *  folder's manifest: its nodeId is the subfolder's genesis, runs is empty
   *  (no body), tags is empty. The tree renders it as a folder; context-gather
   *  and fetchChain skip it. (spec §3.2 nesting revision) */
  kind?: "file" | "folder";
  runs: Run[];
  /** The latest kind-4290 event id for this file (the chain head). Empty
   * string while a file exists but hasn't been stepped this session. */
  nodeId: string;
  /** Durable local proof that a Mint transaction reached its public Coin +
   * same-minter attestation + membership boundary. Absent Mint entries are
   * quarantined as incomplete artifacts and must not be treated as Coins. */
  coinComplete?: boolean;
  /** Stable trace identity: the genesis kind-4290 event id. Unlike `nodeId`,
   * this never changes when the trace takes a Step or moves to another path.
   * Optional before genesis is stepped; readers derive and persist it when the
   * chain is resolved. */
  traceId?: string;
  /** User-authored `t` tags for this file (everything after the folder tag,
   *  which is derived from the path and never stored here). */
  tags: string[];
  /** Cited-trace node ids tagged onto this file *without* a body bracket — the
   *  protocol's `tag-add` (spec §Tagging vs. bracketing): a `q` edge with no
   *  inline quote. A trace also quoted in the body (`[[ phrase | nodeId ]]`) is
   *  NOT listed here; it's recovered from the body at publish via
   *  `findResolvedBrackets` and folded into the same `q` set. So this is the
   *  *tagged-but-not-quoted* subset — read back from the head node on attach as
   *  (head's q-tags) minus (body's bracket node ids). Empty/absent for a leaf. */
  citationIds?: string[];
  /** Local activity time used only for directory presentation. It is copied
   *  from local-store's reconciliation timestamp and never enters a trace. */
  updatedAt?: number;
  /** Present only on files freshly sampled from a relay this session. Not
   *  persisted — a sampled file reloads as a plain clean document (the body
   *  on disk is clean text with no frontmatter). Drives the event-metadata
   *  strip in the editor pane. */
  eventMeta?: SampleEventMeta;
  /** The in-flight editor transaction log since the last Step, drained from
   *  the editor and threaded through `writeFile`.
   *  Not part of long-term FileState identity: cleared after every step, and
   *  mirrored to the crash pad only so an unstepped buffer survives a reload. */
  editorTransactions?: EditorTransactionLog;
}

export interface FileStepBaseline {
  content: string;
  tags: readonly string[];
  citationIds: readonly string[];
}

/**
 * Whether a file has working state waiting for Step.
 *
 * A newly created empty file has no prior Step baseline yet, but creation alone
 * is not an edit: it starts with no badge. Content, tag, citation, or transaction
 * activity makes a baseline-less file pending immediately. Once a baseline
 * exists, its stepped state is the comparison source.
 */
export function fileHasUnsteppedChanges(
  file: FileState,
  baseline: FileStepBaseline | undefined,
): boolean {
  if (file.kind === "folder") return false;
  const content = flattenRuns(file.runs);
  const tags = file.tags;
  const citationIds = file.citationIds ?? [];
  if (!baseline) {
    return (
      content.length > 0 ||
      tags.length > 0 ||
      citationIds.length > 0 ||
      (file.editorTransactions?.length ?? 0) > 0
    );
  }
  return (
    baseline.content !== content ||
    baseline.tags.length !== tags.length ||
    baseline.tags.some((tag, index) => tag !== tags[index]) ||
    baseline.citationIds.length !== citationIds.length ||
    baseline.citationIds.some((nodeId, index) => nodeId !== citationIds[index]) ||
    (file.editorTransactions?.length ?? 0) > 0
  );
}

/** A folder's effective trace-tags: the transitive union of every descendant
 *  file's `citationIds` (de-duplicated). Folders don't carry their own tag
 *  store — they inherit from their contents, so a folder's tags are exactly the
 *  traces anything inside it names. `ROOT` ("") collects over the whole tree.
 *  Returns node ids; callers resolve names via the same path used for file
 *  chips. Pure + cheap; memoize at the call site if profiling warrants. */
export function folderTags(
  files: Record<string, FileState>,
  folderPath: string,
): string[] {
  const prefix = folderPath === "" ? "" : folderPath + "/";
  const out = new Set<string>();
  for (const [rel, state] of Object.entries(files)) {
    if (state.kind === "folder") continue;
    if (folderPath !== "" && !rel.startsWith(prefix)) continue;
    for (const id of state.citationIds ?? []) out.add(id);
  }
  return [...out];
}

/**
 * A reference to an attached folder, storable in localStorage. On the desktop
 * `path` is the absolute disk path; on the webapp it's undefined (the folder
 * lives on the relay, addressed by `id`). `label` is for display in the
 * folders picker.
 *
 * `forkedFrom` records that this folder is a fork — its source folder id, for
 * display ("forked from …") and as the lineage anchor for fork-on-write. A
 * folder without this field is either a fresh creation or a foreign folder
 * opened read-only (see `readOnly`).
 */
export interface FolderRef {
  id: string;
  /** Absolute disk path (desktop only). Undefined on webapp. */
  path?: string;
  /** Human label for the folders picker. Desktop: basename of the path;
   *  webapp: the name the user gave when creating, or the id prefix. */
  label?: string;
  /** Source folder id if this folder is a fork (spec §Forking). Absent on
   *  fresh creations. Present after `forkFolder` seeds a new folder under the
   *  user's key from a foreign source. */
  forkedFrom?: string;
  /** ms-epoch of the last time this folder was opened via `rememberFolder`.
   *  Drives the picker's MRU ordering and the prune-on-overflow heuristic
   *  (folders never written to and untouched for >7d drop first). Absent on
   *  pre-existing entries, which fall back to content-recency for ordering. */
  lastOpened?: number;
}

/** The result of attaching a folder: the reconstructed in-memory file set.
 *  On desktop with `onReconciled`, `files` is the relay-only skeleton and
 *  `reconciled` resolves once the background disk-drift reconcile finishes (so
 *  the caller can clear a progress indicator). Without `onReconciled`, `files`
 *  is fully reconciled and `reconciled` is already-resolved. */
export interface AttachResult {
  files: Record<string, FileState>;
  reconciled: Promise<void>;
}

/**
 * What App.tsx calls. The backend closes over its attached folder, so the
 * mutation methods take only relative paths — the UI never sees an absolute
 * path or a folderId, and the disk vs relay distinction stays inside the
 * implementations.
 */
export interface Workspace {
  /** The folder this workspace is bound to. Null until attach succeeds. */
  readonly ref: FolderRef | null;

  /** Attach (or re-attach) a folder: reconcile against the relay and return
   *  the reconstructed file set. Throws if the folder can't be read (e.g. a
   *  desktop path that no longer exists, or a relay folder id with no
   *  manifest).
   *
   *  On desktop, when `onReconciled` is passed the call returns a relay-only
   *  skeleton immediately and the disk-drift reconcile runs in the background,
   *  emitting each reconciled file via the callback (`file` = null signals a
   *  deletion: the file was tombstoned and should drop from the tree). This is
   *  what lets the press render from the db before the folder is scanned.
   *  Without it, the reconcile completes inline and the returned map is fully
   *  reconciled. */
  attach(ref: FolderRef, onReconciled?: (path: string, file: FileState | null) => void): Promise<AttachResult>;

  /** Read a file's current text content. */
  readFile(relativePath: string): Promise<string>;

  /** Persist `content` + step an edit/import node. Returns the new nodeId, or
   *  the existing one if nothing changed (content hash + tags both match).
   *  `signer` overrides the signing key for this step (per-voice Send/zine);
   *  omit for the default manual-key posture used by background Steps.
   *  `runs` is the live per-voice attribution to persist alongside the content
   *  so it survives reload; omitted by callers that have no attribution (e.g.
   *  the LLM "reply" path) or that want a single-run reset. `replyingTo`
   *  is the stepped node id this write is a reply to (the Reply action's
   *  source) — emits a `reply-to` delta + paired `q` tag (spec §reply-to
   *  delta type); omit for every ordinary write. `citationIds` are cited-trace
   *  node ids tagged onto this file without a body bracket (the protocol's
   *  `tag-add`); each emits a `q` tag + `tag-add` delta, folded into the same
   *  dedup as body quotes and the reply source so a trace cited more than one
   *  way never doubles up. Omit for every write that doesn't tag a trace. */
  writeFile(
    relativePath: string,
    content: string,
    tags?: string[],
    signer?: Uint8Array,
    runs?: Run[],
    replyingTo?: string,
    citationIds?: string[],
    /** The transaction log drained from the editor at Step
     *  time. When omitted by a non-editor caller, the backend records the
     *  content transition as one atomic EditorTransaction. Every published
     *  file node receives a replay-valid `editorTransactions` array. */
    editorTransactions?: EditorTransaction[] | null,
    /** When true, step to the home relay only — don't fan out to external
     *  write relays. This is the Step gesture (protocol §8): a local
     *  checkpoint that doesn't leave the machine. Default false (fan out
     *  to all write-enabled relays, the Send posture). */
    localOnly?: boolean,
    /** When true, mint a new checkpoint node even when content/tags/citations
     *  are unchanged since the last step. This is the explicit-Step path
     *  (Step/Cmd+S — protocol §8). The debounced path leaves this false so a
     *  redundant trailing step stays a no-op; only an explicit author action
     *  forces the checkpoint. */
    force?: boolean,
    /** Optional causal id supplied by a containing folder/Root Step so the
     * file checkpoint and every derived roll-up form one inspectable gesture. */
    operationId?: string,
    /** Optional caller-owned lease/cancellation boundary for a multi-phase
     * recovery write. Ordinary interactive writes omit it. */
    publicationFence?: PublicationFence,
  ): Promise<string>;

  /** Append one merge node from an exact local head, repoint folder
   * membership at that same node, and adopt it as the local stepped baseline.
   * The backend serializes this with ordinary file Steps so accepting a merge
   * can never publish a merge and then accidentally append a sibling/extra
   * ordinary edit. `expectedContent` also makes a staged pull decision stale
   * as soon as the author changes the local buffer. */
  acceptMerge(input: {
    relativePath: string;
    expectedNodeId: string;
    expectedContent: string;
    mergeParentId: string;
    mergeParentPubkey: string;
    snapshot: string;
    tags?: string[];
    runs?: Run[];
    citationIds?: string[];
    summary?: string;
  }): Promise<{ id: string; content: string }>;

  /** Immediately drain a staged local write to the home relay and return its
   *  signed node id. Minting uses this barrier because `[[ text | nodeId ]]`
   *  cannot be resolved against the normal debounced write's temporary empty
   *  id. Ordinary typing continues to use the debounce. */
  flushFile(relativePath: string): Promise<string>;

  /** Create a new empty file. If it already exists, just open it. */
  createFile(relativePath: string): Promise<string>;

  /** Create a directory and its empty folder-trace genesis. Returns that
   *  stable genesis id so replay can begin at the folder's inception. */
  createFolder(relativePath: string): Promise<string>;

  /** Deliberately checkpoint one folder's exact current recursive frontier.
   *  `""` selects Root. Callers flush dirty descendant files first; the
   *  backend appends the final explicit folder landmark and ancestor roll-up. */
  stepFolder(
    relativePath: string,
    signer?: Uint8Array,
    operationId?: string,
  ): Promise<string>;

  /** Delete a file or folder. For folders, every tracked descendant is
   *  tombstoned in the manifest. */
  deletePath(relativePath: string, isFolder: boolean): Promise<void>;

  /** Permanently remove only the retained local copy. This never publishes a
   * trace tombstone or a relay revocation request. */
  deleteLocalPath(relativePath: string, isFolder: boolean): Promise<void>;

  /** Move `src` into `destFolder` ("" = root), keeping the basename.
   *  `isFolder` selects the folder-member reparent path (spec §3.3: a folder
   *  member's name lives in the parent only — O(1), no descendant walk) vs the
   *  file path. File moves extend the same stable trace identity and change
   *  folder membership; moving into/restoring from Oblivion likewise never mints a replacement
   *  genesis. `tagsByPath` carries user tags so file content survives the
   *  reparent (folders carry no user tags). */
  movePath(
    src: string,
    destFolder: string,
    isFolder: boolean,
    tagsByPath?: Record<string, string[]>,
  ): Promise<void>;

  /** Rename `src` (file or folder) to `newName` within its current parent.
   *  Provenance-wise a rename is a single `rename` folder delta (fromPath →
   *  toPath). `isFolder` selects the folder-member rename (spec §3.3: one
   *  delta on the parent carrying the folder's existing genesis id — no new
   *  node, no descendant walk) vs the file path (publish at new name, then
   *  rename delta). Folder names must satisfy the tag-token rule. `tagsByPath`
   *  carries user tags so file content survives the move. */
  renamePath(
    src: string,
    newName: string,
    isFolder: boolean,
    tagsByPath?: Record<string, string[]>,
  ): Promise<void>;

  /** Read all folder-level tags, keyed by folder relative path. Folders are
   *  otherwise implicit in file paths — this is the one place a folder gets its
   *  own metadata. Returns `{}` on a fresh folder or a read-only backend. */
  readFolderTags(): Promise<Record<string, string[]>>;

  /** Persist the full folder-tags map. Backends that can't write (foreign /
   *  relay read-only) no-op. Best-effort and non-fatal, like the attribution
   *  sidecar. */
  writeFolderTags(tags: Record<string, string[]>): Promise<void>;
}

/** Ensure a workspace file path ends in `.md`. Every file in a zine folder is
 *  markdown — this is the single normalization point called by both backends'
 *  `writeFile`/`createFile`, so it covers the UI, imports, and the MCP
 *  `zine_step` tool (which all funnel through those entry points).
 *
 *  Operates on the last path segment only; folder prefixes and synthetic
 *  trace suffixes (e.g. `note.md#fork-abc`) are left intact. */
export function ensureMdExt(path: string): string {
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  // Empty name or one that already carries `.md` (including a `#suffix`)
  // needs no change.
  if (name === "" || name.includes(".md")) return path;
  return path + ".md";
}
