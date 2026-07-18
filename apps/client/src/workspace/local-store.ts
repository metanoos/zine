import { vaultStorage as localStorage } from "../storage/vault-storage.js";

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

import type { KEdit } from "../provenance/provenance.js";
import type { FolderRef, Run } from "./workspace-core.js";

const PREFIX = "zine.folder.";

export interface LocalFile {
  /** "file" or "folder". A folder-member (kind: "folder") is a placeholder:
   *  content is "", nodeId is
   *  the subfolder genesis, runs/tags empty. Stored so the tree renders the
   *  folder-member across reloads without re-fetching the manifest. */
  kind: "file" | "folder";
  content: string;
  tags: string[];
  /** The latest kind-4290 node id stepped for this file (relay chain head), or
   *  "" if not yet pushed. Used as prevEventId on the next relay push. */
  nodeId: string;
  /** Set only after the Mint transaction has stepped and published the signed
   *  Coin genesis, published its same-minter TraceAttestation, and persisted
   *  Mint membership. Missing means an incomplete/legacy Mint artifact, never
   *  a Coin. The marker is local transaction state and never enters the trace. */
  coinComplete?: boolean;
  /** One-shot bootstrap intent for a preloaded starter document. Its first
   *  relay flush publishes and persists an empty genesis before appending the
   *  preloaded body as Step 1. Kept until the body step lands so a crash between
   *  those two publishes resumes from the empty genesis instead of forking. */
  pendingEmptyGenesis?: boolean;
  /** Stable file-trace identity (genesis event id). Optional until the file's
   * genesis has been stepped or its relay chain has been resolved. */
  traceId?: string;
  /** Durable local movement journal. It is written before the relay-side half
   * of a move/to-Oblivion/restore gesture and cleared only after the new file
   * node and folder membership land. This lets attach retry an interrupted
   * gesture. */
  pendingMove?: {
    kind: "move" | "to-oblivion" | "restore";
    fromPath: string;
  };
  /** Causal id reused across a staged file Step, its folder roll-ups, and any
   * retry after a partial relay failure. Cleared only after the gesture lands. */
  pendingOperationId?: string;
  /** ms-precision local write time. The tiebreaker vs the relay. */
  updatedAt: number;
  /** Live per-voice attribution (the editor's run list). Optional on
   *  relay-pulled content (the protocol carries no local run objects),
   *  in which case the file loads as a single run under the active voice.
   *  Validated against `content` on load — stale attribution from an external
   *  edit falls back to a single run rather than mis-coloring. */
  runs?: Run[];
  /** The pubkey of the voice that authored the local edit, so the debounced
   *  relay push signs with the correct key (not just the active one). Absent
   *  on relay-pulled content → push uses the active voice.
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
  citationIds?: string[];
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
  /** Vault-local idempotency receipt for an accepted desktop MODEL result.
   *  This lives only in the encrypted crash pad. It binds the runtime's
   *  durable apply intent to the exact buffer write so recovery can observe
   *  that an accepted response already landed without inserting it twice. */
  desktopOperationReceipt?: DesktopOperationCrashPadReceiptV1;
}

export interface DesktopOperationCrashPadReceiptV1 {
  version: 1;
  intentId: string;
  resultingContentHash: string;
}

export interface LocalFolder {
  id: string;
  label?: string;
  files: Record<string, LocalFile>;
  /** Folder-level tags keyed by folder relative path. Folders are otherwise
   *  implicit in file paths; this is the one piece of folder metadata. Optional
   *  until the user adds folder tags. */
  folderTags?: Record<string, string[]>;
  /** Paths the user has shielded (excluded from context injection). Stored as an
   *  array because JSON has no Set; folder paths exclude their whole subtree. */
  shieldedPaths?: string[];
  /** Durable transaction ids for explicit recursive folder Steps that have
   * started but not yet reached their final explicit folder checkpoint. */
  pendingFolderSteps?: Record<string, string>;
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
    const unknownFiles = parsed.files as Record<string, unknown>;
    if (!Object.values(unknownFiles).every(isLocalFile)) return null;
    const files = unknownFiles as Record<string, LocalFile>;
    return {
      id: parsed.id,
      label: parsed.label,
      files,
      folderTags: parsed.folderTags,
      shieldedPaths: parsed.shieldedPaths,
      pendingFolderSteps: parsed.pendingFolderSteps,
    };
  } catch {
    return null;
  }
}

function isLocalFile(value: unknown): value is LocalFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<LocalFile>;
  return (
    (file.kind === "file" || file.kind === "folder") &&
    typeof file.content === "string" &&
    Array.isArray(file.tags) &&
    file.tags.every((tag) => typeof tag === "string") &&
    typeof file.nodeId === "string" &&
    (file.coinComplete === undefined || typeof file.coinComplete === "boolean") &&
    (
      file.desktopOperationReceipt === undefined ||
      isDesktopOperationCrashPadReceiptV1(file.desktopOperationReceipt)
    ) &&
    typeof file.updatedAt === "number"
  );
}

function isDesktopOperationCrashPadReceiptV1(
  value: unknown,
): value is DesktopOperationCrashPadReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Partial<DesktopOperationCrashPadReceiptV1>;
  return receipt.version === 1
    && typeof receipt.intentId === "string"
    && receipt.intentId.length > 0
    && typeof receipt.resultingContentHash === "string"
    && /^[0-9a-f]{64}$/.test(receipt.resultingContentHash);
}

/** Persist a whole folder (overwrites). Returns false when browser storage
 * rejects the write so transaction coordinators can keep their retry journal. */
function saveLocalFolder(folder: LocalFolder): boolean {
  try {
    localStorage.setItem(key(folder.id), JSON.stringify(folder));
    return true;
  } catch {
    // Quota exceeded or disabled storage — the editor still works in-memory
    // for this session; persistence just won't survive a reload. Non-fatal.
    return false;
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
    coinComplete?: boolean;
    traceId?: string;
    pendingMove?: LocalFile["pendingMove"];
    runs?: Run[];
    voicePubkey?: string;
    pendingReplyingTo?: string;
    citationIds?: string[];
    pendingLocalOnly?: boolean;
    pendingForce?: boolean;
    pendingKedits?: KEdit[];
    pendingEmptyGenesis?: boolean;
    pendingOperationId?: string;
  },
  label?: string,
): boolean {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, label, files: {} };
  existing.files[relativePath] = {
    kind: data.kind ?? existing.files[relativePath]?.kind ?? "file",
    content: data.content,
    tags: data.tags,
    nodeId: data.nodeId,
    ...((data.coinComplete ?? existing.files[relativePath]?.coinComplete)
      ? { coinComplete: true }
      : {}),
    ...(data.traceId ?? existing.files[relativePath]?.traceId
      ? { traceId: data.traceId ?? existing.files[relativePath]?.traceId }
      : {}),
    ...(data.pendingMove ? { pendingMove: data.pendingMove } : {}),
    updatedAt: Date.now(),
    // Persist runs only when the caller has live attribution. Relay pulls omit
    // them and load as a single run.
    ...(data.runs && data.runs.length > 0 ? { runs: data.runs } : {}),
    ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
    ...(data.pendingReplyingTo ? { pendingReplyingTo: data.pendingReplyingTo } : {}),
    ...(data.citationIds && data.citationIds.length > 0 ? { citationIds: data.citationIds } : {}),
    // One-shot flags consumed by the next pushToRelay. Persisted so they survive
    // the debounce gap (writeFile returns; pushToRelay fires later from the same
    // record). Cleared by pushToRelay after the step lands.
    ...(data.pendingLocalOnly ? { pendingLocalOnly: data.pendingLocalOnly } : {}),
    ...(data.pendingForce ? { pendingForce: data.pendingForce } : {}),
    ...(data.pendingKedits ? { pendingKedits: data.pendingKedits } : {}),
    ...(data.pendingEmptyGenesis ? { pendingEmptyGenesis: true } : {}),
    ...(data.pendingOperationId ? { pendingOperationId: data.pendingOperationId } : {}),
  };
  if (label !== undefined) existing.label = label;
  return saveLocalFolder(existing);
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
  pendingOperationId?: string,
): void {
  const existing = loadLocalFolder(folderId);
  if (!existing) return;
  const file = existing.files[oldPath];
  if (!file) return;
  delete existing.files[oldPath];
  existing.files[newPath] = {
    ...file,
    ...(pendingMove ? { pendingMove } : {}),
    ...(pendingOperationId ? { pendingOperationId } : {}),
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

export function pendingFolderStepOperation(
  folderId: string,
  relativePath: string,
): string | null {
  return loadLocalFolder(folderId)?.pendingFolderSteps?.[relativePath] ?? null;
}

export function stageFolderStepOperation(
  folderId: string,
  relativePath: string,
  operationId: string,
): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  saveLocalFolder({
    ...existing,
    pendingFolderSteps: {
      ...existing.pendingFolderSteps,
      [relativePath]: operationId,
    },
  });
}

export function clearFolderStepOperation(folderId: string, relativePath: string): void {
  const existing = loadLocalFolder(folderId);
  if (!existing?.pendingFolderSteps?.[relativePath]) return;
  const next = { ...existing.pendingFolderSteps };
  delete next[relativePath];
  saveLocalFolder({
    ...existing,
    ...(Object.keys(next).length > 0 ? { pendingFolderSteps: next } : { pendingFolderSteps: undefined }),
  });
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
    traceId?: string;
    runs?: Run[];
    voicePubkey?: string;
    citationIds?: string[];
    kedits?: KEdit[];
    desktopOperationReceipt?: DesktopOperationCrashPadReceiptV1;
  },
): boolean {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const pad = currentLocalFiles(parsed) ?? {};
    const desktopOperationReceipt = data.desktopOperationReceipt
      ?? pad[relativePath]?.desktopOperationReceipt;
    pad[relativePath] = {
      kind: "file",
      content: data.content,
      tags: data.tags,
      nodeId: data.nodeId,
      ...(data.traceId ? { traceId: data.traceId } : {}),
      updatedAt: Date.now(),
      ...(data.runs && data.runs.length > 0 ? { runs: data.runs } : {}),
      ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
      ...(data.citationIds && data.citationIds.length > 0 ? { citationIds: data.citationIds } : {}),
      ...(data.kedits && data.kedits.length > 0 ? { kedits: data.kedits } : {}),
      ...(desktopOperationReceipt ? { desktopOperationReceipt } : {}),
    };
    localStorage.setItem(padKey(folderId), JSON.stringify(pad));
    return true;
  } catch {
    // Quota exceeded or disabled storage — the buffer just won't survive a
    // crash this session. Ordinary editor mirrors remain best-effort; callers
    // establishing an accepted-operation receipt must treat false as fatal.
    return false;
  }
}

/** Read a folder's full crash pad. `null` if the pad is absent. */
export function loadPad(folderId: string): Record<string, LocalFile> | null {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    if (!raw) return null;
    return currentLocalFiles(JSON.parse(raw));
  } catch {
    return null;
  }
}

function currentLocalFiles(value: unknown): Record<string, LocalFile> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const files = value as Record<string, unknown>;
  return Object.values(files).every(isLocalFile)
    ? files as Record<string, LocalFile>
    : null;
}

/** Remove one path from a folder's pad (called after a successful step).
 *  If the pad becomes empty, the key is removed entirely. Synchronous. */
export function clearPadPath(folderId: string, relativePath: string): void {
  try {
    const raw = localStorage.getItem(padKey(folderId));
    if (!raw) return;
    const pad = currentLocalFiles(JSON.parse(raw));
    if (!pad) {
      localStorage.removeItem(padKey(folderId));
      return;
    }
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
