/**
 * The workspace storage interface.
 *
 * One UI, two storage backends, both selected at boot by `isTauri()`:
 *
 *   - **Desktop** (`workspace.ts`): a real folder on disk is the private
 *     mirror; the relay is the sync/publish target. Every mutation writes to
 *     disk first, then seals a relay node.
 *   - **Webapp** (`workspace-relay.ts`): no disk. "Home" is a folder on the
 *     hosted relay — reads reconstruct from chains, writes publish events
 *     directly.
 *
 * The two agree because the protocol is already folder-keyed, not
 * author-keyed: a kind-4290 chain is walked by `prev` links (any signer can
 * extend it) and a kind-34290 TraceHead is addressed by `folderId` (any reader
 * holding the id can list its files). So a webapp keypair can read and extend
 * a desktop-created folder's chain — the chain just becomes multi-author,
 * which `reconstructFromChain`/`fetchChain` already handle.
 *
 * The relay is authoritative: on attach/boot both backends read the latest
 * relay manifest as the file list of record, so edits from one client are
 * visible to the other on next open.
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

import type { ContentCite, SampleEventMeta } from "./provenance.js";

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

/**
 * The voice (pubkey) that owns the most characters in `[start, end)` of the
 * flattened run list, by total UTF-16 code-unit length. Offsets are clamped to
 * the document bounds and `start >= end` returns `null` (no region → no voice).
 *
 * Used by the seal path to pick a signer that actually matches the *new* text a
 * seal commits, so a node's `event.pubkey` attributes its net-new content
 * truthfully even when the `authors` map is later lost (see sealNow in App.tsx).
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
  if (prev === next) return null;
  const maxPrefix = Math.min(prev.length, next.length);
  let start = 0;
  while (start < maxPrefix && prev[start] === next[start]) start++;
  let oldEnd = prev.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && prev[oldEnd - 1] === next[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { from: start, to: newEnd };
}

export interface FileState {
  /** "file" or "folder". Absent on legacy entries — readers default "file".
   *  A folder-member (kind: "folder") is a subfolder trace cited by the parent
   *  folder's manifest: its nodeId is the subfolder's genesis, runs is empty
   *  (no body), tags is empty. The tree renders it as a folder; context-gather
   *  and fetchChain skip it. (spec §3.2 nesting revision) */
  kind?: "file" | "folder";
  runs: Run[];
  /** The latest kind-4290 event id for this file (the chain head). Empty
   * string while a file exists but hasn't been sealed this session. */
  nodeId: string;
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
  taggedTraces?: string[];
  /** Present only on files freshly sampled from a relay this session. Not
   *  persisted — a sampled file reloads as a plain clean document (the body
   *  on disk is clean text with no frontmatter). Drives the event-metadata
   *  strip in the editor pane. */
  eventMeta?: SampleEventMeta;
}

/** A folder's effective trace-tags: the transitive union of every descendant
 *  file's `taggedTraces` (de-duplicated). Folders don't carry their own tag
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
    for (const id of state.taggedTraces ?? []) out.add(id);
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

  /** Persist `content` + seal an edit/import node. Returns the new nodeId, or
   *  the existing one if nothing changed (content hash + tags both match).
   *  `signer` overrides the signing key for this seal (per-voice Send/zine);
   *  omit for the default manual-key posture every auto-seal uses.
   *  `runs` is the live per-voice attribution to persist alongside the content
   *  so it survives reload; omitted by callers that have no attribution (e.g.
   *  the LLM "reply" path) or that want a single-run reset. `replyingTo`
   *  is the sealed node id this write is a reply to (the Reply action's
   *  source) — emits a `reply-to` delta + paired `q` tag (spec §reply-to
   *  delta type); omit for every ordinary write. `taggedTraces` are cited-trace
   *  node ids tagged onto this file without a body bracket (the protocol's
   *  `tag-add`); each emits a `q` tag + `tag-add` delta, folded into the same
   *  dedup as body quotes and the reply source so a trace cited more than one
   *  way never doubles up. Omit for every write that doesn't tag a trace.
   *  `contentCites` are one-shot rendezvous quotes (rendezvous.md §1): orphan-
   *  text passages the author is attesting interest in, producing `Q` tags
   *  keyed on the content hash. Transient — consumed by the next seal, not
   *  persisted on FileState (unlike `taggedTraces`). Omit for every write. */
  writeFile(
    relativePath: string,
    content: string,
    tags?: string[],
    signer?: Uint8Array,
    runs?: Run[],
    replyingTo?: string,
    taggedTraces?: string[],
    /** One-shot content-cite quotes (rendezvous.md §1). Transient: consumed
     *  by the next seal, not persisted on FileState. Produces `Q` tags. */
    contentCites?: ContentCite[],
    /** When true, seal to the home relay only — don't fan out to external
     *  write relays. This is the Step gesture (protocol §8): a local
     *  checkpoint that doesn't leave the machine. Default false (fan out
     *  to all write-enabled relays, the Send posture). */
    localOnly?: boolean,
    /** When true, mint a new checkpoint node even when content/tags/citations
     *  are unchanged since the last seal. This is the deliberate-gesture path
     *  (Step/Send/Cmd+S — protocol §8: "When a Step does seal, it mints a node
     *  carrying the snapshot"). The debounced auto-save leaves this false so a
     *  redundant trailing seal stays a no-op; only an explicit author action
     *  forces the checkpoint. */
    force?: boolean,
  ): Promise<string>;

  /** Create a new empty file. If it already exists, just open it. */
  createFile(relativePath: string): Promise<string>;

  /** Create a directory (including parents). Folders have no provenance node
   *  of their own — they're implicit in file paths. */
  createFolder(relativePath: string): Promise<void>;

  /** Delete a file or folder. For folders, every tracked descendant is
   *  tombstoned in the manifest. */
  deletePath(relativePath: string, isFolder: boolean): Promise<void>;

  /** Move `src` into `destFolder` ("" = root), keeping the basename.
   *  `isFolder` selects the folder-member reparent path (spec §3.3: a folder
   *  member's name lives in the parent only — O(1), no descendant walk) vs the
   *  file import-at-dest + tombstone-at-source path. `tagsByPath` carries user
   *  tags so file content survives the reparent (folders carry no user tags). */
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
   *  carries user tags so file content survives (disk backend reads content
   *  from disk, not the chain, so it can't recover them). */
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
