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
  /** The latest kind-4290 node id sealed for this file (relay chain head), or
   *  "" if not yet pushed. Used as prevEventId on the next relay push. */
  nodeId: string;
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
  /** The sealed node id this write is a reply to (Reply action's source),
   *  held here only until the next debounced relay push consumes it into a
   *  `reply-to` delta + paired `q` tag (spec §reply-to delta type) —
   *  `writeFile` has no synchronous seal step to carry it directly, unlike the
   *  disk/relay backends. Cleared by `pushToRelay` once sealed. */
  pendingReplyingTo?: string;
  /** Cited-trace node ids tagged onto this file without a body bracket (the
   *  protocol's `tag-add`, spec §Tagging vs. bracketing) — persistent, like
   *  `tags`, NOT one-shot like `pendingReplyingTo`: a tag stays across seals
   *  until untagged, so every push re-emits them. Read back from the relay head
   *  as (head q-tags) minus (body brackets) on attach. */
  taggedTraces?: string[];
  /** When true, the next debounced relay push seals to the home relay only
   *  (the Step gesture, protocol §8) — doesn't fan out to external write
   *  relays. Like `pendingReplyingTo`, this is one-shot: consumed (and
   *  cleared) by `pushToRelay` on the next push. Absent → fan out (the
   *  default Send posture). */
  pendingLocalOnly?: boolean;
}

export interface LocalFolder {
  id: string;
  label?: string;
  files: Record<string, LocalFile>;
  /** Folder-level tags keyed by folder relative path. Folders are otherwise
   *  implicit in file paths; this is the one piece of folder metadata. Optional
   *  — absent on legacy records → no folder tags until the user adds one. */
  folderTags?: Record<string, string[]>;
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
    return {
      id: parsed.id,
      label: parsed.label,
      files: parsed.files as Record<string, LocalFile>,
      folderTags: parsed.folderTags,
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
    runs?: Run[];
    voicePubkey?: string;
    pendingReplyingTo?: string;
    taggedTraces?: string[];
    pendingLocalOnly?: boolean;
  },
  label?: string,
): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, label, files: {} };
  existing.files[relativePath] = {
    content: data.content,
    tags: data.tags,
    nodeId: data.nodeId,
    updatedAt: Date.now(),
    // Persist runs only when the caller has live attribution. Absent (rather
    // than []) on relay pulls / legacy writes → loads as a single run.
    ...(data.runs && data.runs.length > 0 ? { runs: data.runs } : {}),
    ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
    ...(data.pendingReplyingTo ? { pendingReplyingTo: data.pendingReplyingTo } : {}),
    ...(data.taggedTraces && data.taggedTraces.length > 0 ? { taggedTraces: data.taggedTraces } : {}),
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
export function moveLocalFile(folderId: string, oldPath: string, newPath: string): void {
  const existing = loadLocalFolder(folderId);
  if (!existing) return;
  const file = existing.files[oldPath];
  if (!file) return;
  delete existing.files[oldPath];
  existing.files[newPath] = { ...file, updatedAt: Date.now() };
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

// --- folder discovery ----------------------------------------------------

/** List all locally-known folders (for the switcher), most-recent first. */
export function listLocalFolders(): FolderRef[] {
  const out: FolderRef[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) {
      const id = k.slice(PREFIX.length);
      const folder = loadLocalFolder(id);
      if (folder) out.push({ id: folder.id, label: folder.label });
    }
  }
  // Most-recently-modified last (so [length-1] is the most recent).
  return out.sort((a, b) => localUpdatedAt(a.id) - localUpdatedAt(b.id));
}

/** The newest updatedAt across a folder's files (0 if empty/missing). Used as
 *  the MRU fallback for folders with no `lastOpened` stamp (pre-existing
 *  entries created before the stamp was introduced). */
export function localUpdatedAt(folderId: string): number {
  const folder = loadLocalFolder(folderId);
  if (!folder) return 0;
  let max = 0;
  for (const f of Object.values(folder.files)) {
    if (f.updatedAt > max) max = f.updatedAt;
  }
  return max;
}

/** Number of local files a folder has (0 if the record is missing/empty).
 *  Used by the picker's prune heuristic to recognize auto-provisioned folders
 *  that were never written to. */
export function localFolderFileCount(folderId: string): number {
  const folder = loadLocalFolder(folderId);
  if (!folder) return 0;
  return Object.keys(folder.files).length;
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

/** Delete a folder's local record entirely. */
export function forgetLocalFolder(folderId: string): void {
  localStorage.removeItem(key(folderId));
}
