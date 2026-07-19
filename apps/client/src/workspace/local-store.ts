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

import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import type { KEdit } from "../provenance/provenance.js";
import { operationIdFromNode } from "../provenance/provenance.js";
import { contentFingerprint } from "../ai/context-snapshot.js";
import { hashCanonicalV1 } from "../ai/desktop-operation-envelope.js";
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
  /** Exact immutable file node signed for the pending operation. It is stored
   * before any outbox or relay write so recovery republishes these bytes
   * instead of minting a sibling after a crash. */
  pendingSignedEvent?: Event;
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
  resultingRunsSha256: string;
  resultingKEditsSha256: string;
  modelVoicePubkey: string;
}

export interface LocalFolder {
  id: string;
  label?: string;
  /** Exact Root folder checkpoint represented by this local projection. */
  nodeId?: string;
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
  /** Structural gestures span several immutable file/folder appends plus a
   * local path update. Persist the exact gesture before its first append so an
   * attach after a crash can reuse its causal id and finish idempotently. */
  pendingStructuralOperations?: Record<string, PendingStructuralOperation>;
  /** Terminal semantic conflicts are retained for diagnosis/UI without
   * blocking every later Root mutation through automatic recovery. */
  structuralConflicts?: Record<string, StructuralOperationConflict>;
}

export interface PendingStructuralMove {
  oldRel: string;
  newRel: string;
}

export interface PendingFolderMemberExpectation {
  traceId: string;
  nodeId: string;
}

export type PendingStructuralOperation =
  | {
      version: 2;
      kind: "delete";
      operationId: string;
      sourcePath: string;
      isFolder: boolean;
      affectedPaths: string[];
      /** Exact folder memberships this gesture is authorized to remove. */
      expectedFolders: Record<string, PendingFolderMemberExpectation>;
      shieldedPathsBefore?: string[];
      shieldedPathsDuring?: string[];
      shieldedPathsAfter?: string[];
    }
  | {
      version: 2;
      kind: "move";
      operationId: string;
      sourcePath: string;
      targetPath: string;
      isFolder: true;
      moves: PendingStructuralMove[];
      /** The folder identity/head being moved, never merely a destination path. */
      expectedFolder: PendingFolderMemberExpectation;
      /** Every recursive folder membership touched by Oblivion recovery. */
      expectedFolders: Record<string, PendingFolderMemberExpectation>;
      shieldedPathsBefore?: string[];
      shieldedPathsDuring?: string[];
      shieldedPathsAfter?: string[];
    }
  | {
      version: 1;
      kind: "create-folder";
      operationId: string;
      sourcePath: string;
      isFolder: true;
      genesisId: string;
      contentHash: string;
      /** Full public signed event, kept in the same atomic journal write as
       * its id so recovery can republish it after a pre-outbox crash. */
      genesisEvent: Event;
    };

export interface StructuralOperationConflict {
  operation: PendingStructuralOperation;
  reason: string;
  failedAt: number;
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
    const droppedOperationIds = new Set<string>();
    const structuralOperations = Object.fromEntries(
      Object.entries(parsed.pendingStructuralOperations ?? {})
        .filter((entry): entry is [string, PendingStructuralOperation] => {
          const accepted = isPendingStructuralOperation(entry[1]);
          // Track which causal ids were filter-dropped (unknown version,
          // malformed shape, or a future schema) so a file whose optimistic
          // projection still points at one of them via `pendingOperationId`
          // can be reconciled below instead of leaving a phantom path
          // mutation whose journal can no longer be recovered.
          if (!accepted && entry[0]) droppedOperationIds.add(entry[0]);
          return accepted;
        }),
    );
    // Reconcile phantom projections: if a file references a dropped operation
    // id, drop the reference so the next gesture does not attempt to resume a
    // journal that no longer exists. A file may also carry `pendingSignedEvent`
    // — the exact signed bytes staged to republish under that operation id. If
    // its embedded operation id matches a dropped journal, those bytes cannot
    // be safely republished (their causal binding is gone and `pushToRelay`
    // would throw on the id mismatch against a freshly-minted operation id),
    // so clear it too and let the next push re-sign under the new id. Other
    // pending fields (`pendingMove`, `pendingEmptyGenesis`) are durable
    // movement/bootstrap journals of their own and are left intact so an
    // interrupted move/bootstrap can still resume.
    if (droppedOperationIds.size > 0) {
      for (const file of Object.values(files)) {
        const droppedId = file.pendingOperationId;
        if (droppedId && droppedOperationIds.has(droppedId)) {
          delete file.pendingOperationId;
        }
        if (file.pendingSignedEvent) {
          let signedOperationId: string | null = null;
          try {
            signedOperationId = operationIdFromNode(file.pendingSignedEvent);
          } catch {
            signedOperationId = null;
          }
          if (signedOperationId !== null && droppedOperationIds.has(signedOperationId)) {
            // `nodeId` is advanced to the pending event's id at the same atomic
            // write as `pendingSignedEvent` (see persistPendingFileNode), so it
            // is left dangling once those bytes are gone. Clear it back to the
            // genesis-pending sentinel so the next push computes `prevId` from
            // the folder manifest (or null for a brand-new file) instead of
            // linking a new node to a never-published event id — which would
            // produce a `broken-prev` chain the relay accepts but conformance
            // downgrades to SNAPSHOT ONLY.
            if (file.nodeId === file.pendingSignedEvent.id) {
              file.nodeId = "";
            }
            delete file.pendingSignedEvent;
          }
        }
      }
    }
    const structuralConflicts = Object.fromEntries(
      Object.entries(parsed.structuralConflicts ?? {})
        .filter((entry): entry is [string, StructuralOperationConflict] => {
          const conflict = entry[1] as Partial<StructuralOperationConflict> | undefined;
          return !!conflict &&
            isPendingStructuralOperation(conflict.operation) &&
            typeof conflict.reason === "string" &&
            typeof conflict.failedAt === "number";
        }),
    );
    return {
      id: parsed.id,
      label: parsed.label,
      ...(typeof parsed.nodeId === "string" ? { nodeId: parsed.nodeId } : {}),
      files,
      folderTags: parsed.folderTags,
      shieldedPaths: parsed.shieldedPaths,
      pendingFolderSteps: parsed.pendingFolderSteps,
      ...(Object.keys(structuralOperations).length > 0
        ? { pendingStructuralOperations: structuralOperations }
        : {}),
      ...(Object.keys(structuralConflicts).length > 0
        ? { structuralConflicts }
        : {}),
    };
  } catch {
    return null;
  }
}

function isPendingStructuralOperation(value: unknown): value is PendingStructuralOperation {
  if (!value || typeof value !== "object") return false;
  const operation = value as Partial<PendingStructuralOperation>;
  if (
    typeof operation.operationId !== "string" ||
    !/^[0-9a-f]{64}$/.test(operation.operationId) ||
    typeof operation.sourcePath !== "string" ||
    typeof operation.isFolder !== "boolean"
  ) return false;
  if (operation.kind === "delete") {
    return operation.version === 2 &&
      Array.isArray(operation.affectedPaths) &&
      operation.affectedPaths.every((path) => typeof path === "string") &&
      isOptionalStringArray(operation.shieldedPathsBefore) &&
      isOptionalStringArray(operation.shieldedPathsDuring) &&
      isOptionalStringArray(operation.shieldedPathsAfter) &&
      isPendingFolderExpectationRecord(operation.expectedFolders);
  }
  if (operation.kind === "create-folder") {
    return operation.version === 1 &&
      operation.isFolder === true &&
      typeof operation.genesisId === "string" &&
      /^[0-9a-f]{64}$/.test(operation.genesisId) &&
      typeof operation.contentHash === "string" &&
      /^[0-9a-f]{64}$/.test(operation.contentHash) &&
      !!operation.genesisEvent &&
      operation.genesisEvent.id === operation.genesisId &&
      verifyEvent(operation.genesisEvent);
  }
  return operation.version === 2 &&
    operation.kind === "move" &&
    operation.isFolder === true &&
    typeof operation.targetPath === "string" &&
    isOptionalStringArray(operation.shieldedPathsBefore) &&
    isOptionalStringArray(operation.shieldedPathsDuring) &&
    isOptionalStringArray(operation.shieldedPathsAfter) &&
    isPendingFolderExpectation(operation.expectedFolder) &&
    isPendingFolderExpectationRecord(operation.expectedFolders) &&
    Array.isArray(operation.moves) &&
    operation.moves.every((move) =>
      !!move &&
      typeof move.oldRel === "string" &&
      typeof move.newRel === "string",
    );
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isPendingFolderExpectation(
  value: unknown,
): value is PendingFolderMemberExpectation {
  if (!value || typeof value !== "object") return false;
  const expectation = value as Partial<PendingFolderMemberExpectation>;
  return typeof expectation.traceId === "string" &&
    /^[0-9a-f]{64}$/.test(expectation.traceId) &&
    typeof expectation.nodeId === "string" &&
    /^[0-9a-f]{64}$/.test(expectation.nodeId);
}

function isPendingFolderExpectationRecord(
  value: unknown,
): value is Record<string, PendingFolderMemberExpectation> {
  return !!value &&
    typeof value === "object" &&
    Object.entries(value).every(([path, expectation]) =>
      typeof path === "string" && isPendingFolderExpectation(expectation)
    );
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
    (file.desktopOperationReceipt === undefined || (
      isDesktopOperationCrashPadReceiptV1(file.desktopOperationReceipt)
      && isExactDesktopOperationCrashPadReceipt(file as LocalFile)
    )) &&
    typeof file.updatedAt === "number" &&
    (
      file.pendingSignedEvent === undefined ||
      (
        file.pendingSignedEvent.id === file.nodeId &&
        verifyEvent(file.pendingSignedEvent)
      )
    )
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
    && /^[0-9a-f]{64}$/.test(receipt.resultingContentHash)
    && typeof receipt.resultingRunsSha256 === "string"
    && /^[0-9a-f]{64}$/.test(receipt.resultingRunsSha256)
    && typeof receipt.resultingKEditsSha256 === "string"
    && /^[0-9a-f]{64}$/.test(receipt.resultingKEditsSha256)
    && typeof receipt.modelVoicePubkey === "string"
    && /^[0-9a-f]{64}$/.test(receipt.modelVoicePubkey);
}

export function createDesktopOperationCrashPadReceiptV1(input: {
  intentId: string;
  content: string;
  runs: readonly Run[];
  kedits: readonly KEdit[];
  modelVoicePubkey: string;
}): DesktopOperationCrashPadReceiptV1 {
  if (!input.intentId || !/^[0-9a-f]{64}$/.test(input.modelVoicePubkey)) {
    throw new Error("Desktop operation crash-pad receipt identity is invalid");
  }
  if (input.runs.map((run) => run.text).join("") !== input.content) {
    throw new Error("Desktop operation crash-pad runs do not match their content");
  }
  return Object.freeze({
    version: 1,
    intentId: input.intentId,
    resultingContentHash: contentFingerprint(input.content),
    resultingRunsSha256: hashCanonicalV1("zine.desktop-operation.pad-runs.v1", input.runs),
    resultingKEditsSha256: hashCanonicalV1("zine.desktop-operation.pad-kedits.v1", input.kedits),
    modelVoicePubkey: input.modelVoicePubkey,
  });
}

export function isExactDesktopOperationCrashPadReceipt(file: LocalFile): boolean {
  const receipt = file.desktopOperationReceipt;
  if (
    !receipt
    || !isDesktopOperationCrashPadReceiptV1(receipt)
    || !Array.isArray(file.runs)
    || !Array.isArray(file.kedits)
    || file.voicePubkey !== receipt.modelVoicePubkey
    || file.runs.map((run) => run.text).join("") !== file.content
  ) return false;
  try {
    return receipt.resultingContentHash === contentFingerprint(file.content)
      && receipt.resultingRunsSha256
        === hashCanonicalV1("zine.desktop-operation.pad-runs.v1", file.runs)
      && receipt.resultingKEditsSha256
        === hashCanonicalV1("zine.desktop-operation.pad-kedits.v1", file.kedits);
  } catch {
    return false;
  }
}

/** Persist a whole folder (overwrites). Returns false when browser storage
 * rejects the write so transaction coordinators can keep their retry journal.
 * The boolean lets transaction barriers distinguish a durable write from the
 * editor's best-effort cache writes. */
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
    pendingSignedEvent?: Event;
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
    ...(data.pendingSignedEvent ? { pendingSignedEvent: data.pendingSignedEvent } : {}),
  };
  if (label !== undefined) existing.label = label;
  return saveLocalFolder(existing);
}

/** Remove a file from a local folder (tombstone). Synchronous. */
export function deleteLocalFile(folderId: string, relativePath: string): boolean {
  const existing = loadLocalFolder(folderId);
  if (!existing) return true;
  delete existing.files[relativePath];
  return saveLocalFolder(existing);
}

/** Remove several projection paths with one read/serialize/write transaction.
 * Pull absence reconciliation uses this to avoid reparsing a large flattened
 * workspace once per missing descendant. */
export function deleteLocalFiles(folderId: string, relativePaths: readonly string[]): boolean {
  if (relativePaths.length === 0) return true;
  const existing = loadLocalFolder(folderId);
  if (!existing) return true;
  for (const relativePath of relativePaths) delete existing.files[relativePath];
  return saveLocalFolder(existing);
}

/** Move a file's path within a local folder. Synchronous. */
export function moveLocalFile(
  folderId: string,
  oldPath: string,
  newPath: string,
  pendingMove?: LocalFile["pendingMove"],
  pendingOperationId?: string,
  pendingLocalOnly?: boolean,
  shieldedPaths?: readonly string[],
): boolean {
  const existing = loadLocalFolder(folderId);
  if (!existing) return false;
  const file = existing.files[oldPath];
  if (!file) return false;
  delete existing.files[oldPath];
  existing.files[newPath] = {
    ...file,
    ...(pendingMove ? { pendingMove } : {}),
    ...(pendingOperationId ? { pendingOperationId } : {}),
    ...(pendingLocalOnly ? { pendingLocalOnly: true } : {}),
    updatedAt: Date.now(),
  };
  if (shieldedPaths) existing.shieldedPaths = [...shieldedPaths];
  return saveLocalFolder(existing);
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

export function pendingFolderStepOperations(
  folderId: string,
): Array<{ relativePath: string; operationId: string }> {
  return Object.entries(loadLocalFolder(folderId)?.pendingFolderSteps ?? {})
    .map(([relativePath, operationId]) => ({ relativePath, operationId }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function stageFolderStepOperation(
  folderId: string,
  relativePath: string,
  operationId: string,
): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  if (!saveLocalFolder({
    ...existing,
    pendingFolderSteps: {
      ...existing.pendingFolderSteps,
      [relativePath]: operationId,
    },
  })) {
    throw new Error(`cannot persist pending folder Step for ${relativePath || "Root"}`);
  }
}

export function clearFolderStepOperation(folderId: string, relativePath: string): void {
  const existing = loadLocalFolder(folderId);
  if (!existing?.pendingFolderSteps?.[relativePath]) return;
  const next = { ...existing.pendingFolderSteps };
  delete next[relativePath];
  if (!saveLocalFolder({
    ...existing,
    ...(Object.keys(next).length > 0 ? { pendingFolderSteps: next } : { pendingFolderSteps: undefined }),
  })) {
    throw new Error(`cannot clear pending folder Step for ${relativePath || "Root"}`);
  }
}

export function pendingStructuralOperations(folderId: string): PendingStructuralOperation[] {
  return Object.values(loadLocalFolder(folderId)?.pendingStructuralOperations ?? {})
    .filter(isPendingStructuralOperation);
}

/** Whether a failed optimistic path mutation still has a durable retry journal.
 * While this is true the projected destination/deletion is the user-visible
 * intent and must not be rolled back: the next Root mutation resumes the exact
 * operation before doing new work. */
export function hasPendingStructuralPathMutation(
  folderId: string,
  sourcePath: string,
  targetPath: string | null,
): boolean {
  return pendingStructuralOperations(folderId).some((operation) =>
    operation.sourcePath === sourcePath &&
    (targetPath === null
      ? operation.kind === "delete"
      : operation.kind === "move" && operation.targetPath === targetPath)
  );
}

export function stageStructuralOperation(
  folderId: string,
  operation: PendingStructuralOperation,
): void {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  if (!saveLocalFolder({
    ...existing,
    ...("shieldedPathsDuring" in operation && operation.shieldedPathsDuring
      ? { shieldedPaths: [...operation.shieldedPathsDuring] }
      : {}),
    pendingStructuralOperations: {
      ...existing.pendingStructuralOperations,
      [operation.operationId]: operation,
    },
  })) {
    throw new Error(`cannot persist pending structural operation ${operation.operationId}`);
  }
}

export function applyShieldedPathTransition(
  current: readonly string[],
  from: readonly string[],
  to: readonly string[],
): string[] {
  const next = new Set(current);
  const target = new Set(to);
  for (const path of from) if (!target.has(path)) next.delete(path);
  const source = new Set(from);
  for (const path of to) if (!source.has(path)) next.add(path);
  return [...next].sort();
}

export function clearStructuralOperation(folderId: string, operationId: string): void {
  const existing = loadLocalFolder(folderId);
  const operation = existing?.pendingStructuralOperations?.[operationId];
  if (!existing || !operation) return;
  const next = { ...existing.pendingStructuralOperations };
  delete next[operationId];
  if (!saveLocalFolder({
    ...existing,
    ...("shieldedPathsAfter" in operation && operation.shieldedPathsAfter && operation.shieldedPathsDuring
      ? { shieldedPaths: applyShieldedPathTransition(
          existing.shieldedPaths ?? [], operation.shieldedPathsDuring, operation.shieldedPathsAfter,
        ) }
      : {}),
    ...(Object.keys(next).length > 0
      ? { pendingStructuralOperations: next }
      : { pendingStructuralOperations: undefined }),
  })) {
    throw new Error(`cannot clear pending structural operation ${operationId}`);
  }
}

/** Atomically remove a terminal operation from the retry barrier while
 * retaining its exact journal and reason for diagnostics or conflict UI. */
export function failStructuralOperation(
  folderId: string,
  operation: PendingStructuralOperation,
  reason: string,
): void {
  const existing = loadLocalFolder(folderId);
  if (!existing) return;
  const pending = { ...existing.pendingStructuralOperations };
  delete pending[operation.operationId];
  if (!saveLocalFolder({
    ...existing,
    ...("shieldedPathsBefore" in operation && operation.shieldedPathsBefore && operation.shieldedPathsDuring
      ? { shieldedPaths: applyShieldedPathTransition(
          existing.shieldedPaths ?? [], operation.shieldedPathsDuring, operation.shieldedPathsBefore,
        ) }
      : {}),
    ...(Object.keys(pending).length > 0
      ? { pendingStructuralOperations: pending }
      : { pendingStructuralOperations: undefined }),
    structuralConflicts: {
      ...existing.structuralConflicts,
      [operation.operationId]: { operation, reason, failedAt: Date.now() },
    },
  })) {
    throw new Error(`cannot persist structural conflict ${operation.operationId}`);
  }
}

export function clearStructuralConflict(folderId: string, operationId: string): void {
  const existing = loadLocalFolder(folderId);
  if (!existing?.structuralConflicts?.[operationId]) return;
  const next = { ...existing.structuralConflicts };
  delete next[operationId];
  if (!saveLocalFolder({
    ...existing,
    ...(Object.keys(next).length > 0
      ? { structuralConflicts: next }
      : { structuralConflicts: undefined }),
  })) throw new Error(`cannot clear structural conflict ${operationId}`);
}

export function saveLocalFolderHead(folderId: string, nodeId: string): boolean {
  const existing = loadLocalFolder(folderId) ?? { id: folderId, files: {} };
  return saveLocalFolder({ ...existing, nodeId });
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
    const candidate: LocalFile = {
      kind: "file",
      content: data.content,
      tags: data.tags,
      nodeId: data.nodeId,
      ...(data.traceId ? { traceId: data.traceId } : {}),
      updatedAt: Date.now(),
      ...(data.runs ? { runs: data.runs } : {}),
      ...(data.voicePubkey ? { voicePubkey: data.voicePubkey } : {}),
      ...(data.citationIds && data.citationIds.length > 0 ? { citationIds: data.citationIds } : {}),
      ...(data.kedits ? { kedits: data.kedits } : {}),
    };
    const desktopOperationReceipt = data.desktopOperationReceipt
      ?? pad[relativePath]?.desktopOperationReceipt;
    if (desktopOperationReceipt) {
      candidate.desktopOperationReceipt = desktopOperationReceipt;
      if (!isExactDesktopOperationCrashPadReceipt(candidate)) {
        if (data.desktopOperationReceipt) {
          throw new Error("Desktop operation crash-pad receipt does not bind the exact pad state");
        }
        delete candidate.desktopOperationReceipt;
      }
    }
    pad[relativePath] = candidate;
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
