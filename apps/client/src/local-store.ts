/**
 * localStorage persistence for webapp folders — the primary store.
 *
 * The webapp is local-first: every read/write hits localStorage synchronously
 * so the editor is ready instantly, with zero dependency on the relay being
 * up. The relay is a background sync target (see workspace-local.ts), not the
 * boot read — which is what unblocks offline use and the :1420 dev server.
 *
 * One localStorage key holds an entire folder (its file set + per-file
 * content/tags/nodeId + a local `updatedAt` timestamp used for relay
 * reconciliation). The key shape is stable across reloads and across the
 * folder's lifetime:
 *
 *   zine.folder.<folderId> = {
 *     id, label,
 *     files: { [relativePath]: { content, tags, nodeId, updatedAt, runs? } }
 *   }
 *
 * `updatedAt` is ms-precision (set on every local write). The relay's
 * `created_at` is sec-precision. Last-writer-wins on background pull compares
 * `relay.created_at * 1000 > local.updatedAt`.
 */

import type { KEdit } from "./provenance.js";
import type { FolderRef, Run } from "./workspace-core.js";

const PREFIX = "zine.folder.";

export interface LocalFile {
  /** "file" or "folder". Absent on legacy/local entries — default "file". A
   *  folder-member (kind: "folder") is a placeholder: content is "", nodeId is
   *  the subfolder genesis, runs/tags empty. Stored so the tree renders the
   *  folder-member across reloads without re-fetching the manifest. */
  kind?: "file" | "folder";
  content: string;
  tags: string[];
  /** The latest kind-4290 node id stepped for this file (relay chain head), or
   *  "" if not yet pushed. Used as prevEventId on the next relay push. */
  nodeId: string;
  /** Stable file-trace identity (genesis event id). Optional on legacy local
   * records and backfilled the next time their relay chain is resolved. */
  traceId?: string;
  /** Durable local movement journal. It is written before the relay-side half
   * of a move/to-Oblivion/restore gesture and cleared only after the new file
   * node and folder membership land. This lets attach retry an interrupted
   * gesture. */
  pendingMove?: {
    kind: "move" | "to-oblivion" | "restore";
    fromPath: string;
  };
  /** ms-precision local write time. The tiebreaker vs the relay. */
  updatedAt: number;
  /** Live per-voice attribution (the editor's run list). Optional: absent on
   *  legacy records and on relay-pulled content (the protocol carries no runs),
   *  in which case the file loads as a single run under the active voice.
   *  Validated against `content` on load — stale attribution from an external
   *  edit falls back to a single run rather than mis-coloring. */
  runs?: Run[];
  /** The pubkey of the voice that authored the local edit, so the debounced
   *  relay push signs with the correct key (not just the active one). Absent
   *  on legacy records and relay-pulled content → push uses the active voice.
   *  Stores a pubkey, never a secret; resolved to bytes via keys-store at push. */
  voicePubkey?: string;
  /** The stepped node id this write is a reply to (Reply action's source),
   *  held here only until the next debounced relay push consumes it into a
   *  `reply-to` delta + paired `q` tag (spec §reply-to delta type) —
   *  `writeFile` has no synchronous Step to carry it directly, unlike the
   *  disk/relay backends. Cleared by `pushToRelay` once stepped. */
  pendingReplyingTo?: string;
  /** Cited-trace node ids tagged onto this file without a body bracket (the
   *  protocol's `tag-add`, spec §Tagging vs. bracketing) — persistent, like
   *  `tags`, NOT one-shot like `pendingReplyingTo`: a tag stays across steps
   *  until untagged, so every push re-emits them. Read back from the relay head
   *  as (head q-tags) minus (body brackets) on attach. */
  taggedTraces?: string[];
  /** When true, the next debounced relay push steps to the home relay only
   *  (the Step gesture, protocol §8) — doesn't fan out to external write
   *  relays. Like `pendingReplyingTo`, this is one-shot: consumed (and
   *  cleared) by `pushToRelay` on the next push. Absent → fan out (the
   *  default Send posture). */
  pendingLocalOnly?: boolean;
  /** When true, the next debounced relay push mints a new checkpoint node
   *  even when content/tags/citations are unchanged since the last step — the
   *  deliberate explicit-Step path (protocol §8). One-shot like
   *  `pendingLocalOnly`: consumed (and
   *  cleared) by `pushToRelay`. Absent → the content-hash no-op branch
   *  collapses a redundant trailing debounce, as before. */
  pendingForce?: boolean;
  /** One-shot keystroke log drained from the editor at step time, staged for
   *  the next debounced relay push. Consumed (and cleared) by `pushToRelay`.
   *  Absent on nodes stepped with an empty buffer (e.g. a forced no-op Step). */
  pendingKedits?: KEdit[];
  /** The in-flight keystroke log mirrored to the crash pad (desktop) so an
   *  unstepped buffer survives a reload. Distinct from `pendingKedits`: this is
   *  the live editor buffer for crash recovery, not the one-shot push stage.
   *  Absent on the primary store and on stepped/clean files. */
  kedits?: KEdit[];
}

export interface LocalFolder {
  id: string;
  label?: string;
  files: Record<string, LocalFile>;
  /** Folder-level tags keyed by folder relative path. Folders are otherwise
   *  implicit in file paths; this is the one piece of folder metadata. Optional
   *  — absent on legacy records → no folder tags until the user adds one. */
  folderTags?: Record<string, string[]>;
  /** Paths the user has shielded (excluded from context injection). Stored as an
   *  array because JSON has no Set; folder paths exclude their whole subtree. */
  shieldedPaths?: string[];
}

function key(folderId: string): string {
  return PREFIX + folderId;
}

/** Read a folder's full state from localStorage. Synchronous, never throws. */
export function loadLocalFolder(folderId: string): LocalFolder | null {
  try {
    const raw = localStorage.getItem(key(folderId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocalFolder>;
    if (typeof parsed.id !== "string" || typeof parsed.files !== "object" || !parsed.files) {
      return null;
    }
    const files = parsed.files as Record<string, LocalFile>;
    // Migrate the short-lived pre-Oblivion movement-journal spelling. Keeping
    // this at the storage boundary prevents the old synonym from leaking back
    // into the application model while an interrupted gesture is resumed.
    for (const file of Object.values(files)) {
      const persisted = file as unknown as {
        pendingMove?: { kind: string; fromPath: string };
      };
      if (persisted.pendingMove?.kind === "archive") {
        file.pendingMove = {
          kind: "to-oblivion",
          fromPath: persisted.pendingMove.fromPath,
        };
      }
    }
    return {
      id: parsed.id,
      label: parsed.label,
      files,
      folderTags: parsed.folderTags,
      shieldedPaths: parsed.shieldedPaths,
    };
  } catch {
    return null;
  }
}

/** Persist a whole folder (overwrites). */
function saveLocalFolder(folder: LocalFolder): void {
  try {
    localStorage.setItem(key(folder.id), JSON.stringify(folder));
  } catch {
    // Quota exceeded or disabled storage — the editor still works in-memory
    // for this session; persistence just won't survive a reload. Non-fatal.
  }
}

/**
 * Write/update a single file in a folder. Creates the folder record if it
 * doesn't exist yet (first file in a fresh folder). Synchronous.
 */
export function saveLocalFile(
  folderId: string,
  relativePath: string,
  data: {
    kind?: "file" | "folder";
    content: string;
    tags: string[];
    nodeId: string;
    traceId?: string;
    pendingMove?: LocalFile["pendingMove"];
    runs?: Run[];
    voicePubkey?: string;
    pendingReplyingTo?: string;
    taggedTraces?: string[];
    pendingLocalOnly?: boolean;
    pendingForce?: boolean;
    pendingKedits?: KEdit[];
  },
  label?: string,
): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, label, files: {} };
  existing.files[relativePath] = {
    content: data.content,
    tags: data.tags,
    nodeId: data.nodeId,
    ...(data.traceId ?? existing.files[relativePath]?.traceId
      ? { traceId: data.traceId ?? existing.files[relativePath]?.traceId }
      : {}),
    ...(data.pendingMove ? { pendingMove: data.pendingMove } : {}),
    updatedAt: Date.now(),
    // Persist runs only when the caller has live attribution. Absent (rather
    // than []) on relay pulls / legacy writes → loads as a single run.
    ...(data.runs && data.runs.length > 0 ? { runs: data.runs } : {}),
    ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
    ...(data.pendingReplyingTo ? { pendingReplyingTo: data.pendingReplyingTo } : {}),
    ...(data.taggedTraces && data.taggedTraces.length > 0 ? { taggedTraces: data.taggedTraces } : {}),
    // One-shot flags consumed by the next pushToRelay. Persisted so they survive
    // the debounce gap (writeFile returns; pushToRelay fires later from the same
    // record). Cleared by pushToRelay after the step lands.
    ...(data.pendingLocalOnly ? { pendingLocalOnly: data.pendingLocalOnly } : {}),
    ...(data.pendingForce ? { pendingForce: data.pendingForce } : {}),
    ...(data.pendingKedits ? { pendingKedits: data.pendingKedits } : {}),
  };
  if (label !== undefined) existing.label = label;
  saveLocalFolder(existing);
}

/** Remove a file from a local folder (tombstone). Synchronous. */
export function deleteLocalFile(folderId: string, relativePath: string): void {
  const existing = loadLocalFolder(folderId);
  if (!existing) return;
  delete existing.files[relativePath];
  saveLocalFolder(existing);
}

/** Move a file's path within a local folder. Synchronous. */
export function moveLocalFile(
  folderId: string,
  oldPath: string,
  newPath: string,
  pendingMove?: LocalFile["pendingMove"],
): void {
  const existing = loadLocalFolder(folderId);
  if (!existing) return;
  const file = existing.files[oldPath];
  if (!file) return;
  delete existing.files[oldPath];
  existing.files[newPath] = {
    ...file,
    ...(pendingMove ? { pendingMove } : {}),
    updatedAt: Date.now(),
  };
  saveLocalFolder(existing);
}

/** Read a folder's folder-level tags (keyed by folder relative path). `{}` if
 *  the folder or the map is absent. */
export function loadLocalFolderTags(folderId: string): Record<string, string[]> {
  return loadLocalFolder(folderId)?.folderTags ?? {};
}

/** Overwrite a folder's full folder-tags map. Creates the folder record if
 *  missing. Synchronous. */
export function saveLocalFolderTags(folderId: string, tags: Record<string, string[]>): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  saveLocalFolder({ ...existing, folderTags: tags });
}

/** The exact persisted shielded set for a folder. */
export function loadLocalShielded(folderId: string): Set<string> {
  const folder = loadLocalFolder(folderId);
  const arr = folder?.shieldedPaths;
  return arr ? new Set(arr) : new Set();
}

/** Overwrite a folder's shielded set. */
export function saveLocalShielded(folderId: string, paths: Set<string>): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  saveLocalFolder({ ...existing, shieldedPaths: [...paths] });
}

/** Ensure a folder record exists (for create/remember). */
export function rememberLocalFolder(ref: FolderRef): void {
  const existing = loadLocalFolder(ref.id);
  if (!existing) {
    saveLocalFolder({ id: ref.id, label: ref.label, files: {} });
  } else if (ref.label && existing.label !== ref.label) {
    saveLocalFolder({ ...existing, label: ref.label });
  }
}

// --- crash pad (desktop) ------------------------------------------------
//
// On desktop, the real on-disk folder is a committed snapshot: it only moves
// when the user Steps (Cmd+S) the active file. Every other unstepped file's
// buffer lives here, in a localStorage "crash pad" under a distinct prefix.
// The pad survives crashes/reloads/folder-switches and auto-restores on boot,
// so work is never lost — but the disk file stays pristine until the user
// explicitly Steps it. One pad key holds every buffered file for a folder:
//
//   zine.pad.<folderId> = { [relativePath]: LocalFile }
//
// This is desktop-only. The webapp uses `zine.folder.` as its primary store
// (its "disk"), and that path is untouched. The pad is the webapp store's
// structure borrowed for the desktop crash-safety role.

const PAD_PREFIX = "zine.pad.";

function padKey(folderId: string): string {
  return PAD_PREFIX + folderId;
}

/** Write/update a single buffered file into a folder's pad. Synchronous.
 *  Stores the live editor state (content/runs/tags/nodeId/etc.) so a buffer
 *  reconstructs exactly on restore. Creates the pad record on first write. */
export function mirrorPad(
  folderId: string,
  relativePath: string,
  data: {
    content: string;
    tags: string[];
    nodeId: string;
    runs?: Run[];
    voicePubkey?: string;
    taggedTraces?: string[];
    kedits?: KEdit[];
  },
): void {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    const pad = raw ? (JSON.parse(raw) as Record<string, LocalFile>) : {};
    pad[relativePath] = {
      content: data.content,
      tags: data.tags,
      nodeId: data.nodeId,
      updatedAt: Date.now(),
      ...(data.runs && data.runs.length > 0 ? { runs: data.runs } : {}),
      ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
      ...(data.taggedTraces && data.taggedTraces.length > 0 ? { taggedTraces: data.taggedTraces } : {}),
      ...(data.kedits && data.kedits.length > 0 ? { kedits: data.kedits } : {}),
    };
    localStorage.setItem(padKey(folderId), JSON.stringify(pad));
  } catch {
    // Quota exceeded or disabled storage — the buffer just won't survive a
    // crash this session. Non-fatal: the editor still works in-memory.
  }
}

/** Read a folder's full crash pad. `null` if the pad is absent. */
export function loadPad(folderId: string): Record<string, LocalFile> | null {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    if (!raw) return null;
    const pad = JSON.parse(raw) as Record<string, LocalFile>;
    return pad;
  } catch {
    return null;
  }
}

/** Remove one path from a folder's pad (called after a successful step).
 *  If the pad becomes empty, the key is removed entirely. Synchronous. */
export function clearPadPath(folderId: string, relativePath: string): void {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    if (!raw) return;
    const pad = JSON.parse(raw) as Record<string, LocalFile>;
    delete pad[relativePath];
    if (Object.keys(pad).length === 0) {
      localStorage.removeItem(padKey(folderId));
    } else {
      localStorage.setItem(padKey(folderId), JSON.stringify(pad));
    }
  } catch {
    // Non-fatal — a stale pad entry just gets overwritten on the next mirror.
  }
}
