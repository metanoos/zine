/**
 * Local-primary workspace backend (webapp).
 *
 * localStorage is the source of truth on the webapp: every read is
 * synchronous (instant boot, works offline), every write lands locally first.
 * The relay is a *background sync target* — pulls merge in newer remote
 * content, pushes propagate local edits out for cross-device sync. Neither
 * direction blocks the editor.
 *
 * A relay-primary backend would require a round-trip on
 * every boot means the editor can't render until the network resolves —
 * "Connecting…" forever if the relay is slow or unreachable (e.g. the :1420
 * dev server, which has no relay endpoint). Local-primary makes the webapp
 * feel like a native app: open → editor, immediately.
 *
 * Reconciliation (background pull): a 3-way merge keyed on the chain's common
 * ancestor, not last-write-wins.
 *   - noop       — ours and theirs identical (or remote didn't move off base).
 *   - fastforward— local still at the ancestor; theirs overwrites silently.
 *   - clean      — both sides changed, diff3 resolves; STAGED for review (not
 *                  stepped automatically): the caller surfaces a badge, the user accepts.
 *   - conflict   — overlapping edits; local untouched, surfaced in the banner.
 * Local stays primary on every path that isn't a clean fast-forward, so an
 * unsaved draft is never clobbered by remote activity.
 */

import {
  createFolderGenesis,
  diffToDeltas,
  fetchChain,
  fetchEventById,
  flushLocalEventOutbox,
  fetchFolderOwner,
  fetchFolderNodes,
  fetchLatestFolderNode,
  fetchManifest,
  fetchNodeOwner,
  forkFileFromNode,
  eventMeta,
  headUserTags,
  headCitationIds,
  listUncitedHeads,
  operationIdFromNode,
  publishEdit,
  republishSignedEdit,
  requireAcceptedCurrentFolderCheckpoint,
  resolveTraceChain,
  resolveTraceChainAtHead,
  resolveTraceIdentity,
  resolveVerifiedFolderTraceIdentityAtHead,
  reconstructFromChain,
  reconstructRunsFromChain,
  membersFromNode,
  mergeFile as publishMergeFile,
  removeManifestEntry,
  renameManifestEntry,
  stepFolderManifest,
  traceSignedEventBytes,
  upsertManifestEntry,
  type KEdit,
  type ManifestFileEntry,
} from "../provenance/provenance.js";
import { createTraceOperationId } from "@zine/protocol";
import { findAddedInlineCitations, findResolvedBrackets } from "../provenance/brackets.js";
import { decidePullMerge } from "./three-way-merge.js";
import { authorVoice, secretKeyForVoice } from "../identity/keys-store.js";
import { getPublicKey } from "nostr-tools/pure";
import type {
  AttachResult,
  FileState,
  FolderRef,
  Run,
  Workspace,
} from "./workspace-core.js";
import {
  ensureMdExt,
  flattenRuns,
  resolveStepKEdits,
  synthesizeKEditTransition,
} from "./workspace-core.js";
import {
  clearFolderStepOperation,
  clearPadPath,
  clearStructuralOperation,
  deleteLocalFile,
  deleteLocalFiles,
  deletePadPath,
  failStructuralOperation,
  loadLocalFolder,
  loadLocalFolderTags,
  loadPad,
  mirrorPad,
  moveLocalFile,
  movePadPath,
  pendingStructuralOperations,
  pendingFolderStepOperations,
  rememberLocalFolder,
  saveLocalFile,
  saveLocalFolderHead,
  saveLocalFolderTags,
  stageStructuralOperation,
  type LocalFile,
  type LocalFolder,
  type PendingFolderMemberExpectation,
  type PendingStructuralOperation,
} from "./local-store.js";
import { isMintPath, isOblivionPath, isScanPath } from "./generated-paths.js";
import { verifyFileTraceChain } from "../provenance/trace-conformance.js";
import {
  enqueueLocalEvent,
  pendingLocalEventById,
} from "../provenance/event-outbox.js";

function saveLocalFileDurably(
  phase: string,
  ...args: Parameters<typeof saveLocalFile>
): void {
  if (!saveLocalFile(...args)) {
    throw new Error(`cannot persist ${phase} for ${args[1]}`);
  }
}

function deleteLocalFileDurably(folderId: string, relativePath: string): void {
  if (!deleteLocalFile(folderId, relativePath)) {
    throw new Error(`cannot persist local deletion for ${relativePath}`);
  }
}

function deleteLocalFilesDurably(folderId: string, relativePaths: readonly string[]): void {
  if (!deleteLocalFiles(folderId, relativePaths)) {
    throw new Error(`cannot persist ${relativePaths.length} reconciled local deletions`);
  }
}

function moveLocalFileDurably(
  ...args: Parameters<typeof moveLocalFile>
): void {
  if (!moveLocalFile(...args)) {
    throw new Error(`cannot persist local move from ${args[1]} to ${args[2]}`);
  }
}

function pendingFolderMemberExpectation(
  file: LocalFile | undefined,
  path: string,
): PendingFolderMemberExpectation {
  if (
    file?.kind !== "folder" ||
    !/^[0-9a-f]{64}$/.test(file.nodeId) ||
    !file.traceId ||
    !/^[0-9a-f]{64}$/.test(file.traceId)
  ) {
    throw new Error(`cannot journal the exact folder identity at ${path}`);
  }
  return { traceId: file.traceId, nodeId: file.nodeId };
}

function runsFromText(text: string): FileState["runs"] {
  // Resolves to the AUTHOR key's pubkey (not the old "author-1" label) so the
  // run renders under that key's identity.
  return text.length === 0 ? [] : [{ voice: authorVoice(), text }];
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export interface LocalFolderCoordinate {
  folderId: string;
  folderPath: string;
  relativePath: string;
}

/** One path-indexed local view over a recursive folder-trace tree. Root uses
 *  an empty `storagePath`; private system regions such as Scan use their
 *  synthetic UI path while retaining an independent folder identity. */
export interface LocalFolderTree {
  storageRootId: string;
  folderId: string;
  storagePath: string;
}

function isPathInsideTree(tree: LocalFolderTree, path: string): boolean {
  return tree.storagePath === "" ||
    path === tree.storagePath ||
    path.startsWith(`${tree.storagePath}/`);
}

/** Resolve a path inside any local recursive tree to the direct folder trace
 * that owns its final segment. This keeps system-region paths out of Root's
 * manifest while still giving every wire-level member a single-segment name. */
export function localTreeFolderCoordinate(
  tree: LocalFolderTree,
  storagePath: string,
): LocalFolderCoordinate {
  if (!isPathInsideTree(tree, storagePath) || storagePath === tree.storagePath) {
    throw new Error(`path ${storagePath} is not a member inside ${tree.storagePath || "Root"}`);
  }
  const folderPath = dirname(storagePath);
  if (folderPath === tree.storagePath) {
    return {
      folderId: tree.folderId,
      folderPath,
      relativePath: basename(storagePath),
    };
  }
  if (!isPathInsideTree(tree, folderPath)) {
    throw new Error(`path ${storagePath} escapes ${tree.storagePath || "Root"}`);
  }
  const folder = loadLocalFolder(tree.storageRootId)?.files[folderPath];
  const folderId = folder?.traceId ?? folder?.nodeId;
  if (folder?.kind !== "folder" || !folderId) {
    throw new Error(`cannot resolve containing folder trace for ${storagePath}`);
  }
  return {
    folderId,
    folderPath,
    relativePath: basename(storagePath),
  };
}

/** Resolve a flat local-storage path to the direct folder trace that owns its
 * final segment. Local storage remains path-indexed for instant UI reads; wire
 * membership is recursive and therefore always uses a single-segment name. */
export function localFolderCoordinate(
  rootId: string,
  storagePath: string,
): LocalFolderCoordinate {
  return localTreeFolderCoordinate(
    { storageRootId: rootId, folderId: rootId, storagePath: "" },
    storagePath,
  );
}

function signedNodeContentHash(event: import("nostr-tools").Event): string | null {
  try {
    const parsed = JSON.parse(event.content) as { contentHash?: unknown };
    if (typeof parsed.contentHash === "string" && /^[0-9a-f]{64}$/.test(parsed.contentHash)) {
      return parsed.contentHash;
    }
  } catch {
    return null;
  }
  return null;
}

function folderNodeContentHash(event: import("nostr-tools").Event): string {
  const contentHash = signedNodeContentHash(event);
  if (contentHash) return contentHash;
  throw new Error(`folder Step ${event.id} has no valid content hash`);
}

export function folderTraceIdentityFromNode(
  event: import("nostr-tools").Event | null,
): string | null {
  const reificationTags = event?.tags.filter((tag) => tag[0] === "z") ?? [];
  if (
    !event ||
    event.kind !== 4290 ||
    reificationTags.length !== 1 ||
    reificationTags[0]?.[1] !== "folder"
  ) return null;
  const folderIds = event.tags.filter((tag) => tag[0] === "f");
  if (folderIds.length === 1 && folderIds[0]?.[1]) return folderIds[0][1];
  if (folderIds.length > 0) return null;
  const hasPrev = event.tags.some((tag) => tag[0] === "e" && tag[3] === "prev");
  return hasPrev ? null : event.id;
}

/** Classify a local path move while retaining the original relay coordinate
 * across rapid/multi-hop gestures. Pure so Oblivion/restore interruption cases
 * are regression-testable without a relay. */
export function pendingMoveForPath(
  oldPath: string,
  newPath: string,
  current?: LocalFile["pendingMove"],
): NonNullable<LocalFile["pendingMove"]> {
  const inheritedFrom = current?.fromPath ?? oldPath;
  if (isOblivionPath(newPath)) return { kind: "to-oblivion", fromPath: inheritedFrom };
  if (isOblivionPath(oldPath)) {
    return current?.kind === "to-oblivion"
      ? { kind: "move", fromPath: current.fromPath }
      : { kind: "restore", fromPath: oldPath };
  }
  return { kind: "move", fromPath: inheritedFrom };
}

/** Finish one explicit Step after its local state has been staged. Relay
 * failures remain retryable, but never masquerade as a completed checkpoint. */
export async function completeStagedWrite(
  publish: () => Promise<string>,
  scheduleRetry: () => void,
): Promise<string> {
  try {
    return await publish();
  } catch (error) {
    scheduleRetry();
    throw error;
  }
}

/** Publish and durably remember a requested empty genesis before its caller
 *  continues to the preloaded body Step. Persisting before the second publish
 *  makes the two-node bootstrap resumable instead of creating sibling geneses
 *  after a crash or relay failure. */
export async function publishEmptyGenesisIfNeeded<T extends { id: string }>(
  pending: boolean | undefined,
  latestNodeId: string | null,
  publish: () => Promise<T>,
  persist: (node: T) => void,
): Promise<T | null> {
  if (!pending || latestNodeId) return null;
  const node = await publish();
  persist(node);
  return node;
}

/** Recover the already-published body Step when its manifest update was the
 *  only failed half of starter bootstrap. Reusing this head avoids appending a
 *  duplicate sibling body node on retry. */
export function completedEmptyGenesisBootstrapHead(
  pending: boolean | undefined,
  manifestHeadId: string | null,
  chain: readonly { id: string }[],
  reconstructedContent: string,
  localContent: string,
): string | null {
  if (!pending || manifestHeadId || chain.length < 2) return null;
  if (reconstructedContent !== localContent) return null;
  return chain[chain.length - 1]?.id ?? null;
}

/** Finish one scheduled relay push and surface the persisted FileState to the
 * attached UI. The onboarding demo is published from attach's timer,
 * not an explicit button handler, so without this notification localStorage
 * advances while React remains stuck on nodeId "" and replay stays empty. */
export async function completeBackgroundPush(
  publish: () => Promise<string>,
  readPersisted: () => FileState | null,
  onPublished?: (file: FileState | null) => void,
): Promise<string> {
  const nodeId = await publish();
  if (onPublished) onPublished(readPersisted());
  return nodeId;
}

/** Complete provenance removals before deleting the retryable local copies. */
export async function completeDeletion(
  paths: readonly string[],
  tombstone: (path: string) => Promise<void>,
  deleteLocal: (path: string) => void,
): Promise<void> {
  await Promise.all(paths.map((path) => tombstone(path)));
  for (const path of paths) deleteLocal(path);
}

export function ownershipDisposition(
  ownerPubkey: string | null,
  signerPubkey: string,
): "owned" | "foreign" | "unverifiable" {
  if (!ownerPubkey) return "unverifiable";
  return ownerPubkey === signerPubkey ? "owned" : "foreign";
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build FileState (what the editor consumes) from a local folder record.
 * Synchronous — no relay calls. When a file carries persisted `runs` that
 * still match its content, those runs survive (per-voice attribution persists
 * across reload); otherwise it collapses to a single run under the active
 * voice (relay-pulled content or stale attribution from an
 * external edit).
 */
export function localToFiles(
  local: {
    files: Record<string, {
      kind: "file" | "folder";
      content: string;
      tags: string[];
      nodeId: string;
      coinComplete?: boolean;
      updatedAt: number;
      traceId?: string;
      runs?: Run[];
      citationIds?: string[];
    }>;
  },
): Record<string, FileState> {
  const out: Record<string, FileState> = {};
  for (const [path, f] of Object.entries(local.files)) {
    if (f.kind === "folder") {
      // Folder-member placeholder: no body to reconstruct. Carry kind + nodeId.
      out[path] = {
        kind: "folder",
        runs: [],
        nodeId: f.nodeId,
        ...(f.traceId ? { traceId: f.traceId } : {}),
        tags: [],
        updatedAt: f.updatedAt,
      };
      continue;
    }
    const runs = f.runs && flattenRuns(f.runs) === f.content ? f.runs : runsFromText(f.content);
    out[path] = {
      kind: "file",
      runs,
      nodeId: f.nodeId,
      ...(f.coinComplete ? { coinComplete: true } : {}),
      updatedAt: f.updatedAt,
      ...(f.traceId ? { traceId: f.traceId } : {}),
      tags: f.tags,
      ...(f.citationIds && f.citationIds.length > 0 ? { citationIds: f.citationIds } : {}),
    };
  }
  return out;
}

export interface LocalWorkspaceOptions {
  /** Require an exact folder-genesis fetch during attach. Headless presses use
   *  this to fail at startup instead of reporting a local cache as connected. */
  requireRelayOnAttach?: boolean;
  /** Explicit signing boundary for presses that do not use the desktop
   * SecretStore keychain, such as the owner-only MCP profile. */
  signerForVoice?: (voicePubkey?: string) => Uint8Array | null;
  /** Delivers clean merge candidates and semantic conflicts from both strict
   * and background attach pulls; file reconciliation alone cannot represent
   * either outcome. */
  onPullResult?: (result: PullResult) => void;
}

/** Resolve the signer staged on a local file. A missing/deleted staged voice
 * falls back to the current AUTHOR key. */
export function localFileSigner(voicePubkey?: string): Uint8Array | null {
  if (voicePubkey) {
    const exact = secretKeyForVoice(voicePubkey);
    if (exact) return exact;
  }
  const authorPubkey = authorVoice();
  return secretKeyForVoice(authorPubkey);
}

/** A file Step and its containing folder Step may have different owners. The
 * file signer records the writing voice; membership must keep extending the
 * folder's existing single-owner chain. Return null only when that folder key
 * is not held locally, which is the actual foreign-folder boundary. */
export function folderWriteSigner(
  folderOwner: string | null,
  fileSigner: Uint8Array,
): Uint8Array | null {
  if (!folderOwner || getPublicKey(fileSigner) === folderOwner) return fileSigner;
  return secretKeyForVoice(folderOwner);
}

/** Confirm that a locally persisted immutable file node is the exact phase of
 * the operation being recovered, not merely a mutable path's previous head. */
export function isFileStepForOperation(
  event: import("nostr-tools").Event | null,
  operationId: string,
  snapshot: string,
  contentHash: string,
): event is import("nostr-tools").Event {
  if (!event) return false;
  const meta = eventMeta(event);
  if (meta.z !== "file" || meta.action === "fork") return false;
  try {
    if (operationIdFromNode(event) !== operationId) return false;
    const parsed = JSON.parse(event.content) as {
      snapshot?: unknown;
      contentHash?: unknown;
    };
    return parsed.snapshot === snapshot && parsed.contentHash === contentHash;
  } catch {
    return false;
  }
}

/** Identify the owned fork genesis that precedes the requested edit. A fork
 *  is its own durable operation phase: recovery must reuse it, but must never
 *  mistake it for the final file Step just because the snapshot is unchanged. */
export function isForkStepForOperation(
  event: import("nostr-tools").Event | null,
  operationId: string,
  folderId: string,
  relativePath: string,
  sourceNodeId?: string,
): event is import("nostr-tools").Event {
  if (!event) return false;
  const meta = eventMeta(event);
  const previous = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "prev",
  )?.[1];
  const forkedFrom = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "forked-from",
  )?.[1];
  try {
    return (
      meta.z === "file" &&
      meta.action === "fork" &&
      meta.folderId === folderId &&
      meta.relativePath === relativePath &&
      !previous &&
      typeof forkedFrom === "string" &&
      (!sourceNodeId || forkedFrom === sourceNodeId) &&
      operationIdFromNode(event) === operationId
    );
  } catch {
    return false;
  }
}

/** A recovered node may repair an absent membership, replace the exact node it
 * extends, or confirm itself. It must never roll a path back from a later or
 * unrelated immutable file node. */
export function fileStepCanRepairMembership(
  event: import("nostr-tools").Event,
  currentMemberNodeId: string | null,
): boolean {
  if (!currentMemberNodeId || currentMemberNodeId === event.id) return true;
  const previousNodeId = event.tags.find(
    (tag) => tag[0] === "e" && tag[3] === "prev",
  )?.[1];
  return previousNodeId === currentMemberNodeId;
}

/** Permit recursive delete recovery to consume folder checkpoints that this
 * same gesture derived while removing deeper descendants. Every node between
 * the journaled member and the current member must carry the gesture's exact
 * operation id; an unrelated concurrent checkpoint therefore still fails
 * closed. `nodes` must already have passed fixed-owner folder verification. */
export function folderCheckpointExtendsExpectedForOperation(
  nodes: readonly import("nostr-tools").Event[],
  currentNodeId: string,
  expectedNodeId: string,
  operationId: string,
): boolean {
  const byId = new Map(nodes.map((event) => [event.id, event]));
  const seen = new Set<string>();
  let cursor = currentNodeId;
  while (cursor !== expectedNodeId) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    const event = byId.get(cursor);
    if (!event) return false;
    try {
      if (operationIdFromNode(event) !== operationId) return false;
    } catch {
      return false;
    }
    const previous = event.tags.find(
      (tag) => tag[0] === "e" && tag[3] === "prev",
    )?.[1];
    if (!previous) return false;
    cursor = previous;
  }
  return byId.has(expectedNodeId);
}

export interface FolderStepRun<T> {
  tail: Promise<unknown>;
  operations: Map<string, Promise<T>>;
}

/** Coalesce duplicate calls for one logical operation and serialize a later,
 * distinct operation behind it so concurrent gestures cannot create siblings. */
export function runFolderStepSingleFlight<T>(
  runs: Map<string, FolderStepRun<T>>,
  folderId: string,
  operationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const queue = runs.get(folderId) ?? {
    tail: Promise.resolve(),
    operations: new Map<string, Promise<T>>(),
  };
  const existing = queue.operations.get(operationId);
  if (existing) return existing;
  const promise = queue.operations.size === 0
    ? task()
    : queue.tail.catch(() => undefined).then(task);
  queue.tail = promise;
  queue.operations.set(operationId, promise);
  runs.set(folderId, queue);
  const cleanup = () => {
    if (queue.operations.get(operationId) === promise) {
      queue.operations.delete(operationId);
    }
    if (queue.operations.size === 0 && runs.get(folderId) === queue) {
      runs.delete(folderId);
    }
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

/** Serialize all mutations to one local resource. The first task starts
 * synchronously so it captures its staged state before another caller can
 * replace it; later tasks continue even when a predecessor fails. */
export function runResourceSerialized<T>(
  runs: Map<string, Promise<unknown>>,
  resourceId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = runs.get(resourceId);
  let run: Promise<T>;
  if (previous) {
    run = previous.catch(() => undefined).then(task);
  } else {
    try {
      run = Promise.resolve(task());
    } catch (error) {
      run = Promise.reject(error);
    }
  }
  runs.set(resourceId, run);
  const cleanup = () => {
    if (runs.get(resourceId) === run) runs.delete(resourceId);
  };
  void run.then(cleanup, cleanup);
  return run;
}

/** A new gesture may not replace an earlier gesture's durable recovery
 * record. Finish the prior exact signed Step (including folder propagation)
 * before the caller is allowed to stage different bytes. */
export async function stageFileStepAfterPendingRecovery<T>(
  pendingOperationId: string | undefined,
  recover: () => Promise<unknown>,
  stage: () => Promise<T>,
): Promise<T> {
  if (pendingOperationId) await recover();
  return stage();
}

export interface RootMutationRun {
  tail: Promise<unknown>;
  operations: Map<string, Promise<unknown>>;
}

/** Serialize every persisted mutation for one Root behind the same barrier.
 * Paths are mutable presentation state, so they cannot safely define separate
 * causal queues from moves, renames, or deletes that rewrite those paths. */
export function runRootMutationSerialized<T>(
  runs: Map<string, RootMutationRun>,
  rootId: string,
  operationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const queue = runs.get(rootId) ?? {
    tail: Promise.resolve(),
    operations: new Map<string, Promise<unknown>>(),
  };
  const existing = queue.operations.get(operationId);
  if (existing) return existing as Promise<T>;
  let promise: Promise<T>;
  if (queue.operations.size === 0) {
    try {
      promise = Promise.resolve(task());
    } catch (error) {
      promise = Promise.reject(error);
    }
  } else {
    promise = queue.tail.catch(() => undefined).then(task);
  }
  queue.tail = promise;
  queue.operations.set(operationId, promise);
  runs.set(rootId, queue);
  const cleanup = () => {
    if (queue.operations.get(operationId) === promise) {
      queue.operations.delete(operationId);
    }
    if (queue.operations.size === 0 && runs.get(rootId) === queue) {
      runs.delete(rootId);
    }
  };
  void promise.then(cleanup, cleanup);
  return promise;
}

/** Admit a normal Root mutation only after every durable structural journal
 * has finished recovery in the same queue slot. A failed recovery rejects the
 * new mutation; its next attempt runs recovery again before doing new work. */
export function runRootMutationAfterRecovery<T>(
  runs: Map<string, RootMutationRun>,
  rootId: string,
  operationId: string,
  recover: () => Promise<void>,
  task: () => Promise<T>,
): Promise<T> {
  return runRootMutationSerialized(runs, rootId, operationId, async () => {
    await recover();
    return task();
  });
}

export type StructuralOperationRun = RootMutationRun;

/** Structural gestures share a root-wide queue because different operation
 * ids can still overlap paths. Duplicate recovery calls for one journal
 * coalesce while distinct journals complete in order. */
export function runStructuralOperationSerialized(
  runs: Map<string, StructuralOperationRun>,
  rootId: string,
  operationId: string,
  task: () => Promise<void>,
): Promise<void> {
  return runRootMutationSerialized(runs, rootId, operationId, task);
}

/** Persist the exact signed node before any mutable manifest propagation. A
 * retry receives that immutable node and cannot append a sibling replacement. */
export async function completeDurableFileStep<T>(
  existing: T | null,
  append: () => Promise<T>,
  persist: (node: T) => void | Promise<void>,
  propagate: (node: T) => Promise<void>,
): Promise<T> {
  const node = existing ?? await append();
  if (!existing) await persist(node);
  await propagate(node);
  return node;
}

/** A file body and direct membership may already be durable after a crash.
 * Resolve that direct folder head and repair every ancestor before local
 * pending state is allowed to clear. */
export async function completeRecoveredFilePropagation<T>(
  directHead: () => Promise<T>,
  propagate: (head: T) => Promise<void>,
): Promise<T> {
  const head = await directHead();
  await propagate(head);
  return head;
}

function rememberLocalTreeFolderHead(
  tree: LocalFolderTree,
  folderPath: string,
  folderId: string,
  head: import("nostr-tools").Event,
): void {
  if (folderPath === tree.storagePath) {
    if (!saveLocalFolderHead(tree.storageRootId, head.id)) {
      throw new Error(`cannot persist Root folder head ${head.id}`);
    }
    return;
  }
  const existing = loadLocalFolder(tree.storageRootId)?.files[folderPath];
  saveLocalFileDurably("folder head", tree.storageRootId, folderPath, {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: head.id,
    traceId: existing?.traceId ?? folderId,
  });
}

/** Bubble one changed folder snapshot to the root of its local tree. For Root
 *  that boundary is the install root itself; for Scan it is the private Scan
 *  folder, so Scan can never become an accidental member of Root. */
export async function propagateLocalTreeFolderHead(
  tree: LocalFolderTree,
  changedFolderPath: string,
  changedFolderId: string,
  changedHead: import("nostr-tools").Event,
  signer: Uint8Array,
  localOnly?: boolean,
  verifyAcceptedOperation?: boolean,
): Promise<void> {
  if (!isPathInsideTree(tree, changedFolderPath)) {
    throw new Error(
      `folder ${changedFolderPath} escapes ${tree.storagePath || "Root"}`,
    );
  }
  let folderPath = changedFolderPath;
  let folderId = changedFolderId;
  let head = changedHead;
  let operationId = operationIdFromNode(changedHead);
  rememberLocalTreeFolderHead(tree, folderPath, folderId, head);

  while (folderPath !== tree.storagePath) {
    const childName = basename(folderPath);
    const parentPath = dirname(folderPath);
    const parentId = parentPath === tree.storagePath
      ? tree.folderId
      : localTreeFolderCoordinate(tree, `${parentPath}/_`).folderId;
    const parentOwner = await fetchFolderOwner(parentId);
    const parentSigner = folderWriteSigner(parentOwner, signer);
    if (!parentSigner) {
      throw new Error(`cannot update ancestor folder ${parentId}; its owner key is unavailable`);
    }
    head = await upsertManifestEntry(
      parentId,
      {
        kind: "folder",
        relativePath: childName,
        latestNodeId: head.id,
        contentHash: folderNodeContentHash(head),
      },
      parentSigner,
      { localOnly, operationId, monotonicFolderId: folderId },
    );
    if (verifyAcceptedOperation) {
      head = await requireAcceptedCurrentFolderCheckpoint(
        parentId,
        head,
        getPublicKey(parentSigner),
        { localOnly },
      );
    }
    operationId = operationIdFromNode(head);
    folderPath = parentPath;
    folderId = parentId;
    rememberLocalTreeFolderHead(tree, folderPath, folderId, head);
  }
}

/** Ensure that every segment of `folderPath` has its own folder trace. Existing
 *  relay membership wins over a stale/missing local placeholder, which also
 *  makes a scan resumable after a crash between the signed parent update and
 *  local cache persistence. */
export async function ensureLocalTreeFolderPath(
  tree: LocalFolderTree,
  folderPath: string,
  signer: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<{ folderId: string; folderPath: string }> {
  if (!isPathInsideTree(tree, folderPath)) {
    throw new Error(`folder ${folderPath} escapes ${tree.storagePath || "Root"}`);
  }
  if (folderPath === tree.storagePath) {
    return { folderId: tree.folderId, folderPath };
  }

  const suffix = tree.storagePath
    ? folderPath.slice(tree.storagePath.length + 1)
    : folderPath;
  const segments = suffix.split("/").filter(Boolean);
  let currentId = tree.folderId;
  let currentPath = tree.storagePath;

  for (const segment of segments) {
    const nextPath = currentPath ? `${currentPath}/${segment}` : segment;
    const manifest = await fetchManifest(currentId);
    const existing = manifest.find(
      (entry) => entry.kind === "folder" && entry.relativePath === segment,
    );
    if (existing) {
      const traceId = await resolveVerifiedFolderTraceIdentityAtHead(
        await fetchEventById(existing.latestNodeId),
      );
      if (!traceId) {
        throw new Error(`cannot resolve folder identity for ${nextPath}`);
      }
      saveLocalFileDurably("existing folder path", tree.storageRootId, nextPath, {
        kind: "folder",
        content: "",
        tags: [],
        nodeId: existing.latestNodeId,
        traceId,
      });
      currentId = traceId;
      currentPath = nextPath;
      continue;
    }

    const currentOwner = await fetchFolderOwner(currentId);
    const currentSigner = folderWriteSigner(currentOwner, signer);
    if (!currentSigner) {
      throw new Error(`cannot create a folder through foreign folder ${currentId}`);
    }
    const operationId = opts?.operationId ?? createTraceOperationId();
    const genesisId = await createFolderGenesis({
      signer: currentSigner,
      localOnly: opts?.localOnly,
      operationId,
    });
    const currentHead = await upsertManifestEntry(
      currentId,
      {
        kind: "folder",
        relativePath: segment,
        latestNodeId: genesisId,
        contentHash: await sha256Hex("[]"),
      },
      currentSigner,
      { localOnly: opts?.localOnly, operationId },
    );
    await propagateLocalTreeFolderHead(
      tree,
      currentPath,
      currentId,
      currentHead,
      currentSigner,
      opts?.localOnly,
    );
    saveLocalFileDurably("created folder path", tree.storageRootId, nextPath, {
      kind: "folder",
      content: "",
      tags: [],
      nodeId: genesisId,
      traceId: genesisId,
    });
    currentId = genesisId;
    currentPath = nextPath;
  }

  return { folderId: currentId, folderPath: currentPath };
}

/** Fork one exact source node into a path-indexed local tree, creating real
 *  recursive parent folders and bubbling every changed folder head. */
export async function forkFileIntoLocalTree(
  tree: LocalFolderTree,
  sourceNodeId: string,
  storagePath: string,
  signer: Uint8Array,
  opts?: { localOnly?: boolean; operationId?: string },
): Promise<import("nostr-tools").Event> {
  const operationId = opts?.operationId ?? createTraceOperationId();
  await ensureLocalTreeFolderPath(tree, dirname(storagePath), signer, {
    ...opts,
    operationId,
  });
  const coordinate = localTreeFolderCoordinate(tree, storagePath);
  const owner = await fetchFolderOwner(coordinate.folderId);
  const manifestSigner = folderWriteSigner(owner, signer);
  if (!manifestSigner) {
    throw new Error(`cannot fork into foreign folder ${coordinate.folderId}`);
  }
  const event = await forkFileFromNode(
    sourceNodeId,
    coordinate.folderId,
    coordinate.relativePath,
    {
      signer,
      localOnly: opts?.localOnly,
      operationId,
    },
  );
  const parsed = JSON.parse(event.content) as { contentHash?: unknown };
  if (typeof parsed.contentHash !== "string") {
    throw new Error(`fork ${event.id} has no content hash`);
  }
  const folderHead = await upsertManifestEntry(
    coordinate.folderId,
    {
      kind: "file",
      relativePath: coordinate.relativePath,
      latestNodeId: event.id,
      contentHash: parsed.contentHash,
    },
    manifestSigner,
    {
      localOnly: opts?.localOnly,
      operationId,
    },
  );
  await propagateLocalTreeFolderHead(
    tree,
    coordinate.folderPath,
    coordinate.folderId,
    folderHead,
    manifestSigner,
    opts?.localOnly,
  );
  return event;
}

/** Read the previous Step's citation set only after its immutable history has
 *  been recovered. Continuing from an unknown prior snapshot would create a
 *  dishonest full-document delta, so an unavailable prior node fails with a
 *  useful recovery error instead of passing undefined into eventMeta. */
export function previousStepCitationTargets(
  relativePath: string,
  previousNodeId: string | null,
  chain: Awaited<ReturnType<typeof fetchChain>>,
): string[] {
  if (chain.length === 0) {
    if (previousNodeId) {
      throw new Error(
        `cannot load the previous Step for ${relativePath} at ${previousNodeId}; ` +
          "retry when the home relay is available",
      );
    }
    return [];
  }
  return eventMeta(chain[chain.length - 1]).citationTargets;
}

// Multiple Workspace facades can address the same persisted Root in one
// process. Coalesce at module scope so the complete recursive cascade, not
// merely the selected folder node, remains one causal operation across them.
const recursiveFolderStepFlights = new Map<string, Promise<string>>();
const workspaceRootMutationRuns = new Map<string, RootMutationRun>();

export function createLocalWorkspace(options: LocalWorkspaceOptions = {}): Workspace {
  let ref: FolderRef | null = null;
  const resolveFileSigner = options.signerForVoice ?? localFileSigner;

  function requireId(): string {
    if (!ref) throw new Error("workspace not attached — call attach() first");
    return ref.id;
  }

  // Per-file debounce timers for relay pushes. Local writes are instant; the
  // relay push is coalesced so a burst of typing produces one step, not N.
  const pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const fileStepRuns = new Map<string, Promise<unknown>>();
  const rootMutationRuns = workspaceRootMutationRuns;
  const PUSH_DEBOUNCE_MS = 1200;

  const pushTimerKey = (rootId: string, relativePath: string) =>
    JSON.stringify([rootId, relativePath]);

  /** Schedule a background relay push for a file (debounced). Never throws —
   *  relay failures are non-fatal; the local write already succeeded. */
  function schedulePush(
    relativePath: string,
    onPublished?: (path: string, file: FileState | null) => void,
    scheduledRootId?: string,
  ): void {
    const id = scheduledRootId ?? requireId();
    const timerKey = pushTimerKey(id, relativePath);
    const existing = pushTimers.get(timerKey);
    if (existing) clearTimeout(existing);
    pushTimers.set(
      timerKey,
      setTimeout(() => {
        pushTimers.delete(timerKey);
        const operationId = loadLocalFolder(id)?.files[relativePath]?.pendingOperationId ??
          createTraceOperationId();
        void completeBackgroundPush(
          () => runWorkspaceRootMutation(
            id,
            operationId,
            () => runResourceSerialized(
              fileStepRuns,
              `${id}:${relativePath}`,
              () => pushToRelay(id, relativePath),
            ),
          ),
          () => {
            const persisted = loadLocalFolder(id);
            return persisted ? localToFiles(persisted)[relativePath] ?? null : null;
          },
          (file) => onPublished?.(relativePath, file),
        ).catch((e) => {
          console.warn(`[local] relay push failed for ${relativePath}:`, e);
          // Movement has a durable journal and must converge without requiring
          // another edit or app restart. Retry while this folder remains
          // attached; switching away leaves attach() to resume the journal.
          const pendingFile = loadLocalFolder(id)?.files[relativePath];
          if (
            (
              pendingFile?.pendingMove ||
              pendingFile?.pendingEmptyGenesis ||
              pendingFile?.pendingOperationId
            ) &&
            ref?.id === id
          ) {
            setTimeout(() => {
              if (ref?.id === id) schedulePush(relativePath, onPublished, id);
            }, 5_000);
          }
        });
      }, PUSH_DEBOUNCE_MS),
    );
  }

  /** Bubble one changed direct folder snapshot through its ancestors. Each
   * parent stores the child's newest folder nucleus and canonical body hash;
   * the recursive projection therefore stays reconstructable from Root. */
  async function propagateFolderHead(
    rootId: string,
    changedFolderPath: string,
    changedFolderId: string,
    changedHead: import("nostr-tools").Event,
    signer: Uint8Array,
    localOnly?: boolean,
    verifyAcceptedOperation?: boolean,
  ): Promise<void> {
    await propagateLocalTreeFolderHead(
      { storageRootId: rootId, folderId: rootId, storagePath: "" },
      changedFolderPath,
      changedFolderId,
      changedHead,
      signer,
      localOnly,
      verifyAcceptedOperation,
    );
  }

  async function pushToRelay(rootId: string, storagePath: string): Promise<string> {
    const local = loadLocalFolder(rootId);
    if (!local) return "";
    const file = local.files[storagePath];
    if (!file) return ""; // was deleted locally — deletePath handles its own push
    if (file.kind === "folder") return file.nodeId;
    const content = file.content;
    const contentHash = await sha256Hex(content);
    const operationId = file.pendingOperationId ?? createTraceOperationId();
    if (!file.pendingOperationId) {
      // Persist before the first network write so recovery reuses the same
      // causal id instead of presenting a partial gesture as a new one.
      saveLocalFileDurably("pending file operation", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: file.nodeId,
        traceId: file.traceId,
        pendingMove: file.pendingMove,
        runs: file.runs,
        voicePubkey: file.voicePubkey,
        pendingReplyingTo: file.pendingReplyingTo,
        citationIds: file.citationIds,
        pendingLocalOnly: file.pendingLocalOnly,
        pendingForce: file.pendingForce,
        pendingKedits: file.pendingKedits,
        pendingEmptyGenesis: file.pendingEmptyGenesis,
        pendingOperationId: operationId,
      });
    }
    if (file.pendingSignedEvent) {
      if (operationIdFromNode(file.pendingSignedEvent) !== operationId) {
        throw new Error(`pending signed Step for ${storagePath} has the wrong operation id`);
      }
      await republishSignedEdit(file.pendingSignedEvent, !!file.pendingLocalOnly);
    }

    if (file.pendingMove?.kind === "to-oblivion") {
      const fromPath = file.pendingMove.fromPath;
      const source = localFolderCoordinate(rootId, fromPath);
      const manifest = await fetchManifest(source.folderId);
      const entry = manifest.find(
        (candidate) => candidate.relativePath === source.relativePath,
      );
      const traceId =
        file.traceId ??
        (file.nodeId ? await resolveTraceIdentity(file.nodeId) : null) ??
        (entry ? await resolveTraceIdentity(entry.latestNodeId) : null);
      const signer = resolveFileSigner(file.voicePubkey);
      if (!signer) throw new Error(`cannot resolve a local signer for ${fromPath}`);
      const folderOwner = await fetchFolderOwner(source.folderId);
      const folderSigner = folderWriteSigner(folderOwner, signer);
      if (!folderSigner) {
        throw new Error(`cannot write through foreign folder ${source.folderId}; fork the folder first`);
      }
      const emptyHash = await sha256Hex("");
      const persistedNode = file.pendingOperationId && file.nodeId
        ? file.pendingSignedEvent ?? await fetchEventById(file.nodeId)
        : null;
      let landedDelete = isFileStepForOperation(
        persistedNode,
        operationId,
        "",
        emptyHash,
      ) && eventMeta(persistedNode).action === "delete"
        ? persistedNode
        : null;
      if (!landedDelete && !entry && traceId) {
        const resolution = await resolveTraceChain(traceId);
        const head = resolution.status === "resolved"
          ? resolution.chain[resolution.chain.length - 1]
          : undefined;
        landedDelete = isFileStepForOperation(head ?? null, operationId, "", emptyHash) &&
            eventMeta(head!).action === "delete"
          ? head!
          : null;
      }
      if (!entry && !landedDelete) {
        throw new Error(`move to Oblivion from ${fromPath} is not yet verifiable`);
      }
      const persistDelete = (event: import("nostr-tools").Event) => {
        saveLocalFileDurably("signed delete Step", rootId, storagePath, {
          content,
          tags: file.tags,
          nodeId: event.id,
          traceId: traceId ?? event.id,
          pendingMove: file.pendingMove,
          runs: file.runs,
          voicePubkey: file.voicePubkey,
          citationIds: file.citationIds,
          pendingLocalOnly: file.pendingLocalOnly,
          pendingOperationId: operationId,
          pendingSignedEvent: event,
        });
      };
      const removeAndPropagate = async () => {
        const sourceHead = await removeManifestEntry(
          source.folderId,
          source.relativePath,
          folderSigner,
          {
            localOnly: file.pendingLocalOnly,
            operationId,
            expectedNodeId: entry?.latestNodeId,
          },
        ) ?? await fetchLatestFolderNode(source.folderId, { complete: true });
        if (!sourceHead) {
          throw new Error(`cannot recover the source folder Step for ${fromPath}`);
        }
        await propagateFolderHead(
          rootId,
          source.folderPath,
          source.folderId,
          sourceHead,
          folderSigner,
          file.pendingLocalOnly,
        );
      };
      const event = await completeDurableFileStep(
        landedDelete,
        async () => {
          if (!entry) {
            throw new Error(`cannot append an unanchored delete for ${fromPath}`);
          }
          const priorEvent = await fetchEventById(entry.latestNodeId);
          if (!priorEvent) {
            throw new Error(`cannot fetch the current source Step ${entry.latestNodeId}`);
          }
          const priorParsed = JSON.parse(priorEvent.content) as { snapshot?: unknown };
          if (typeof priorParsed.snapshot !== "string") {
            throw new Error(`source Step ${entry.latestNodeId} has no text snapshot`);
          }
          return publishEdit({
            prevEventId: entry.latestNodeId,
            previousSnapshot: priorParsed.snapshot,
            ...(traceId ? { traceId } : {}),
            relativePath: source.relativePath,
            folderId: source.folderId,
            deltas: [],
            snapshot: "",
            contentHash: emptyHash,
            action: "delete",
            ...(file.pendingLocalOnly ? { localOnly: true } : {}),
            operationId,
            onSigned: persistDelete,
            signer,
            kedits: synthesizeKEditTransition(
              priorParsed.snapshot,
              "",
              getPublicKey(signer),
            ),
          });
        },
        persistDelete,
        removeAndPropagate,
      );
      saveLocalFileDurably("completed delete Step", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: event.id,
        traceId: traceId ?? event.id,
        voicePubkey: file.voicePubkey,
        citationIds: file.citationIds,
        ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
      });
      return event.id;
    }

    const target = localFolderCoordinate(rootId, storagePath);
    const { folderId, folderPath, relativePath } = target;
    // prevEventId from the last stepped node (relay chain head). Reading the
    // relay here keeps the chain linear across authors/devices.
    const manifest = await fetchManifest(folderId);
    const entry = manifest.find((m) => m.relativePath === relativePath);
    const moveSource = file.pendingMove?.kind === "move"
      ? localFolderCoordinate(rootId, file.pendingMove.fromPath)
      : null;
    const fromManifest = moveSource
      ? moveSource.folderId === folderId
        ? manifest
        : await fetchManifest(moveSource.folderId)
      : [];
    const fromEntry = moveSource
      ? fromManifest.find(
          (candidate) => candidate.relativePath === moveSource.relativePath,
        )
      : undefined;
    let prevId: string | null = entry?.latestNodeId ?? (file.nodeId || fromEntry?.latestNodeId || null);

    let traceId =
      file.traceId ??
      (prevId ? await resolveTraceIdentity(prevId) : null);

    // Diff against relay's last-known content so the node carries a real delta.
    let chain = [] as Awaited<ReturnType<typeof fetchChain>>;
    if (traceId) {
      const resolved = await resolveTraceChain(traceId, prevId ?? undefined);
      if (resolved.status === "conflict") {
        throw new Error(`trace ${traceId} has multiple current heads`);
      }
      if (resolved.status === "resolved") chain = resolved.chain;
    }
    let prevContent = prevId && chain.length > 0 ? reconstructFromChain(chain) : "";
    const persistPendingFileNode = (event: import("nostr-tools").Event) => {
      saveLocalFileDurably("signed file Step", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: event.id,
        traceId: traceId ?? event.id,
        pendingMove: file.pendingMove,
        runs: file.runs,
        voicePubkey: file.voicePubkey,
        pendingReplyingTo: file.pendingReplyingTo,
        citationIds: file.citationIds,
        pendingLocalOnly: file.pendingLocalOnly,
        pendingForce: file.pendingForce,
        pendingKedits: file.pendingKedits,
        pendingEmptyGenesis: file.pendingEmptyGenesis,
        pendingOperationId: operationId,
        pendingSignedEvent: event,
      });
    };

    // The onboarding demo is deliberately a two-node trace: blank genesis is
    // Step 0, and the preloaded prose is the first insert at Step 1. Persist
    // the genesis before continuing so a failed second publish resumes the
    // same chain. Ordinary new/imported files skip this marker-only branch.
    const emptyGenesis = await publishEmptyGenesisIfNeeded(
      file.pendingEmptyGenesis,
      prevId,
      async () => {
        const genesisSigner = resolveFileSigner(file.voicePubkey);
        if (!genesisSigner) {
          throw new Error(`cannot resolve a local signer for ${relativePath}`);
        }
        return publishEdit({
          prevEventId: null,
          previousSnapshot: "",
          relativePath,
          folderId,
          deltas: [],
          snapshot: "",
          contentHash: await sha256Hex(""),
          action: "import",
          ...(file.pendingLocalOnly ? { localOnly: true } : {}),
          signer: genesisSigner,
          kedits: [],
          operationId,
          onSigned: persistPendingFileNode,
        });
      },
      (genesis) => {
        saveLocalFileDurably("empty genesis", rootId, storagePath, {
          content,
          tags: file.tags,
          nodeId: genesis.id,
          traceId: genesis.id,
          pendingMove: file.pendingMove,
          runs: file.runs,
          voicePubkey: file.voicePubkey,
          pendingReplyingTo: file.pendingReplyingTo,
          citationIds: file.citationIds,
          pendingLocalOnly: file.pendingLocalOnly,
          pendingForce: file.pendingForce,
          pendingKedits: file.pendingKedits,
          pendingEmptyGenesis: true,
          pendingOperationId: operationId,
        });
      },
    );
    if (emptyGenesis) {
      prevId = emptyGenesis.id;
      traceId = emptyGenesis.id;
      chain = [emptyGenesis];
      prevContent = "";
    }

    // Skip if nothing changed since the last push. The no-op test covers
    // content hash, topical tags, AND the citation set (body brackets + reply
    // source + tagged traces) — otherwise a pure tag-add on an unchanged doc
    // would be swallowed and never reach the relay.
    const prevTags = headUserTags(chain);
    const tagsUnchanged =
      prevTags.length === file.tags.length && prevTags.every((t, i) => t === file.tags[i]);
    const prevCitations = previousStepCitationTargets(relativePath, prevId, chain);
    const citationIds = file.citationIds ?? [];
    const nextCitations = [
      ...findResolvedBrackets(content).map((b) => b.nodeId),
      ...(file.pendingReplyingTo ? [file.pendingReplyingTo] : []),
      ...citationIds,
    ];
    const citationsUnchanged =
      prevCitations.length === nextCitations.length &&
      prevCitations.every((c, i) => c === nextCitations[i]);
    // File authorship and folder ownership are separate capabilities. Resolve
    // both before the no-op recovery branch because an already-landed direct
    // membership may still need its ancestor cascade repaired.
    const signer = resolveFileSigner(file.voicePubkey);
    if (!signer) throw new Error(`cannot resolve a local signer for ${relativePath}`);
    const signerPubkey = getPublicKey(signer);
    const folderOwner = await fetchFolderOwner(folderId);
    const folderSigner = folderWriteSigner(folderOwner, signer);
    if (!folderSigner) {
      throw new Error(`cannot write through foreign folder ${folderId}; fork the folder first`);
    }
    const propagateFileNode = async (event: import("nostr-tools").Event) => {
      if (moveSource && fromEntry && moveSource.folderId === folderId) {
        const folderHead = await renameManifestEntry(
          folderId,
          moveSource.relativePath,
          relativePath,
          event.id,
          folderSigner,
          {
            localOnly: file.pendingLocalOnly,
            operationId,
            expectedCurrentNodeId: fromEntry.latestNodeId,
          },
        );
        await propagateFolderHead(
          rootId,
          folderPath,
          folderId,
          folderHead,
          folderSigner,
          file.pendingLocalOnly,
        );
        return;
      }

      const folderHead = await upsertManifestEntry(folderId, {
        kind: "file",
        relativePath,
        latestNodeId: event.id,
        contentHash,
      }, folderSigner, { localOnly: file.pendingLocalOnly, operationId });
      await propagateFolderHead(
        rootId,
        folderPath,
        folderId,
        folderHead,
        folderSigner,
        file.pendingLocalOnly,
      );
      if (moveSource && fromEntry) {
        const sourceOwner = await fetchFolderOwner(moveSource.folderId);
        const sourceSigner = folderWriteSigner(sourceOwner, signer);
        if (!sourceSigner) {
          throw new Error(
            `cannot remove the old membership from foreign folder ${moveSource.folderId}`,
          );
        }
        const sourceHead = await removeManifestEntry(
          moveSource.folderId,
          moveSource.relativePath,
          sourceSigner,
          {
            localOnly: file.pendingLocalOnly,
            operationId,
            expectedNodeId: fromEntry.latestNodeId,
          },
        );
        if (sourceHead) {
          await propagateFolderHead(
            rootId,
            moveSource.folderPath,
            moveSource.folderId,
            sourceHead,
            sourceSigner,
            file.pendingLocalOnly,
          );
        }
      }
    };
    const finalizeFileNode = (event: import("nostr-tools").Event) => {
      saveLocalFileDurably("completed file Step", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: event.id,
        traceId: traceId ?? event.id,
        voicePubkey: file.voicePubkey,
        citationIds: file.citationIds,
        ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
      });
    };
    const persistedNode = file.pendingOperationId && file.nodeId
      ? file.pendingSignedEvent ?? await fetchEventById(file.nodeId)
      : null;
    const recoveredEvent = isFileStepForOperation(
      persistedNode,
      operationId,
      content,
      contentHash,
    ) ? persistedNode : null;
    if (recoveredEvent) {
      if (!fileStepCanRepairMembership(recoveredEvent, entry?.latestNodeId ?? null)) {
        throw new Error(`folder membership for ${relativePath} advanced beyond the recovered file Step`);
      }
      const event = await completeDurableFileStep(
        recoveredEvent,
        async () => {
          throw new Error("recovered file Step unexpectedly attempted to append");
        },
        persistPendingFileNode,
        propagateFileNode,
      );
      finalizeFileNode(event);
      return event.id;
    }
    // A forced checkpoint (explicit Step gesture) appends a node even when
    // nothing changed — the deliberate rhythm path (§8). The non-forced path keeps the
    // no-op collapse so the trailing debounce after an edit doesn't re-publish.
    if (entry && !file.pendingMove && entry.contentHash === contentHash && tagsUnchanged && citationsUnchanged && !file.pendingForce) {
      // A crash can land the body Step + direct manifest before an ancestor.
      // Re-read the direct head and resume the idempotent cascade before local
      // pending state clears, so Root never advertises a stale frontier as done.
      await completeRecoveredFilePropagation(
        () => upsertManifestEntry(
          folderId,
          {
            kind: "file",
            relativePath,
            latestNodeId: entry.latestNodeId,
            contentHash,
          },
          folderSigner,
          { localOnly: file.pendingLocalOnly, operationId },
        ),
        (folderHead) => propagateFolderHead(
          rootId,
          folderPath,
          folderId,
          folderHead,
          folderSigner,
          file.pendingLocalOnly,
        ),
      );
      saveLocalFileDurably("recovered file Step", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: entry.latestNodeId,
        traceId: traceId ?? entry.latestNodeId,
        runs: file.runs,
        voicePubkey: file.voicePubkey,
        citationIds: file.citationIds,
      });
      return entry.latestNodeId;
    }

    const completedBootstrapHead = completedEmptyGenesisBootstrapHead(
      file.pendingEmptyGenesis,
      entry?.latestNodeId ?? null,
      chain,
      prevContent,
      content,
    );
    if (completedBootstrapHead) {
      const folderHead = await upsertManifestEntry(
        folderId,
        {
          kind: "file",
          relativePath,
          latestNodeId: completedBootstrapHead,
          contentHash,
        },
        folderSigner,
        { localOnly: file.pendingLocalOnly, operationId },
      );
      await propagateFolderHead(
        rootId,
        folderPath,
        folderId,
        folderHead,
        folderSigner,
        file.pendingLocalOnly,
      );
      saveLocalFileDurably("completed bootstrap Step", rootId, storagePath, {
        content,
        tags: file.tags,
        nodeId: completedBootstrapHead,
        traceId: traceId ?? chain[0]?.id ?? completedBootstrapHead,
        runs: file.runs,
        voicePubkey: file.voicePubkey,
        citationIds: file.citationIds,
      });
      return completedBootstrapHead;
    }

    // Shallow folder forks deliberately cite foreign file members. The first
    // edit must seed an owned genesis from that exact source node, repoint the
    // membership, and only then append the requested edit to the owned chain.
    if (entry) {
      const disposition = ownershipDisposition(
        await fetchNodeOwner(entry.latestNodeId),
        signerPubkey,
      );
      if (disposition === "unverifiable") {
        throw new Error(`cannot verify owner of ${relativePath} at ${entry.latestNodeId}`);
      }
      let fork = persistedNode?.pubkey === signerPubkey &&
          isForkStepForOperation(
            persistedNode,
            operationId,
            folderId,
            relativePath,
            disposition === "foreign" ? entry.latestNodeId : undefined,
          ) &&
          (disposition === "foreign" || persistedNode.id === entry.latestNodeId)
        ? persistedNode
        : null;
      if (!fork && disposition === "foreign") {
        fork = await forkFileFromNode(
          entry.latestNodeId,
          folderId,
          relativePath,
          {
            signer,
            localOnly: file.pendingLocalOnly,
            operationId,
            onSigned: persistPendingFileNode,
          },
        );
        // The fork genesis is a distinct immutable phase. Save its exact id and
        // trace identity before the mutable manifest pointer moves, so either
        // failure window reuses this node instead of minting a second fork.
        saveLocalFileDurably("owned fork genesis", rootId, storagePath, {
          content,
          tags: file.tags,
          nodeId: fork.id,
          traceId: fork.id,
          pendingMove: file.pendingMove,
          runs: file.runs,
          voicePubkey: file.voicePubkey,
          pendingReplyingTo: file.pendingReplyingTo,
          citationIds: file.citationIds,
          pendingLocalOnly: file.pendingLocalOnly,
          pendingForce: file.pendingForce,
          pendingKedits: file.pendingKedits,
          pendingEmptyGenesis: file.pendingEmptyGenesis,
          pendingOperationId: operationId,
        });
      }
      if (fork) {
        // A retry may find either side of the manifest write. Repoint only when
        // the foreign member is still current; otherwise adopt the exact fork.
        if (entry.latestNodeId !== fork.id) {
          await upsertManifestEntry(
            folderId,
            {
              kind: "file",
              relativePath,
              latestNodeId: fork.id,
              contentHash: entry.contentHash,
            },
            folderSigner,
            { localOnly: file.pendingLocalOnly, operationId },
          );
        }
        prevId = fork.id;
        traceId = fork.id;
        chain = [fork];
        prevContent = reconstructFromChain(chain);
      } else if (disposition === "owned") {
        // A previously completed manifest write may be newer than the local
        // cache. Adopt the immutable member's actual trace before diffing.
        const ownedTraceId = await resolveTraceIdentity(entry.latestNodeId);
        if (!ownedTraceId) {
          throw new Error(`cannot resolve owned trace for ${relativePath} at ${entry.latestNodeId}`);
        }
        if (traceId !== ownedTraceId || chain[chain.length - 1]?.id !== entry.latestNodeId) {
          const ownedResolution = await resolveTraceChain(
            ownedTraceId,
            entry.latestNodeId,
          );
          if (ownedResolution.status !== "resolved") {
            throw new Error(`cannot resolve one owned trace head for ${relativePath}`);
          }
          prevId = entry.latestNodeId;
          traceId = ownedTraceId;
          chain = ownedResolution.chain;
          prevContent = reconstructFromChain(chain);
        }
      }
    }

    const deltas = diffToDeltas(prevContent, content);
    const stepKEdits = resolveStepKEdits(
      prevContent,
      content,
      file.pendingKedits,
      signerPubkey,
      file.updatedAt,
    );
    const event = await completeDurableFileStep(null, () => publishEdit({
      prevEventId: prevId,
      previousSnapshot: prevContent,
      ...(traceId ? { traceId } : {}),
      relativePath,
      folderId,
      // A forced checkpoint with no content change mints a clean `deltas: []`
      // node (§8: the rhythm-layer gesture — nothing changed, but the author
      // chose to checkpoint). The synthesized-insert fallback is only for the
      // non-forced path where content is identical but tags/citations changed.
      deltas: deltas.length > 0
        ? deltas
        : file.pendingForce
          ? []
          : [{ type: "insert", positionStart: 0, positionEnd: 0, newValue: content, timestamp: Date.now() }],
      snapshot: content,
      contentHash,
      action: prevId ? "edit" : "import",
      tags: file.tags,
      // Per-character attribution: carry the live run list into the node's
      // `authors` field so it survives reload from the chain (the durable,
      // cross-device carrier) instead of collapsing to the signer on attach.
      // publishEdit validates the map against `snapshot` and drops it if stale.
      ...(file.runs && file.runs.length > 0 ? { authors: file.runs } : {}),
      // Cite every minted span this doc contains (spec:189). `content` is the
      // localStorage string; resolved `[[ phrase | nodeId ]]` live in it.
      citations: findResolvedBrackets(content).map((b) => b.nodeId),
      inlineCitations: findAddedInlineCitations(prevContent, content),
      ...(file.pendingReplyingTo ? { replyingTo: file.pendingReplyingTo } : {}),
      ...(citationIds.length > 0 ? { citationIds } : {}),
      kedits: stepKEdits.kedits,
      ...(file.pendingLocalOnly ? { localOnly: true } : {}),
      signer,
      operationId,
      onSigned: persistPendingFileNode,
    }), persistPendingFileNode, propagateFileNode);
    // Reflect the stepped node id back into local state so the next push's
    // prevId is correct. Preserve voicePubkey so re-pushes stay correctly signed,
    // and runs so the local record keeps the per-char attribution it just stepped
    // (avoids a needless reload-from-chain on next open). `pendingReplyingTo`,
    // `pendingKedits`, `pendingLocalOnly`, and `pendingForce` are deliberately
    // NOT carried: all four are one-shot, consumed by this push.
    // `citationIds` IS carried — tags are persistent across steps.
    finalizeFileNode(event);
    return event.id;
  }

  /** Flush one explicitly-staged gesture now. Background retry remains armed
   *  on failure, but callers only observe completion after provenance is
   *  durable, which gives live replay a reliable refresh boundary. */
  async function flushStagedFileUnlocked(
    rootId: string,
    relativePath: string,
  ): Promise<string> {
    const timerKey = pushTimerKey(rootId, relativePath);
    const timer = pushTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      pushTimers.delete(timerKey);
    }
    return completeStagedWrite(
      () => pushToRelay(rootId, relativePath),
      () => {
        if (ref?.id === rootId) schedulePush(relativePath, undefined, rootId);
      },
    );
  }

  async function flushStagedFileWithinRoot(
    rootId: string,
    relativePath: string,
  ): Promise<string> {
    return runResourceSerialized(
      fileStepRuns,
      `${rootId}:${relativePath}`,
      () => flushStagedFileUnlocked(rootId, relativePath),
    );
  }

  async function flushStagedFile(relativePath: string): Promise<string> {
    const rootId = requireId();
    const operationId = loadLocalFolder(rootId)?.files[relativePath]?.pendingOperationId ??
      createTraceOperationId();
    return runWorkspaceRootMutation(
      rootId,
      operationId,
      () => flushStagedFileWithinRoot(rootId, relativePath),
    );
  }

  async function tombstoneStagedFile(
    rootId: string,
    storagePath: string,
    operationId: string,
  ): Promise<void> {
    const coordinate = localFolderCoordinate(rootId, storagePath);
    const manifest = await fetchManifest(coordinate.folderId);
    const entry = manifest.find(
      (candidate) => candidate.relativePath === coordinate.relativePath,
    );
    const localFile = loadLocalFolder(rootId)?.files[storagePath];
    const signer = resolveFileSigner(localFile?.voicePubkey);
    if (!signer) throw new Error(`cannot resolve a local signer for ${storagePath}`);
    const folderOwner = await fetchFolderOwner(coordinate.folderId);
    const folderSigner = folderWriteSigner(folderOwner, signer);
    if (!folderSigner) {
      throw new Error(`cannot delete through foreign folder ${coordinate.folderId}`);
    }
    const traceId = localFile?.traceId ??
      (localFile?.nodeId ? await resolveTraceIdentity(localFile.nodeId) : null) ??
      (entry ? await resolveTraceIdentity(entry.latestNodeId) : null);
    if (!traceId) throw new Error(`cannot resolve the file trace for ${storagePath}`);
    const emptyHash = await sha256Hex("");
    const persistedNode = localFile?.nodeId
      ? localFile.pendingSignedEvent ?? await fetchEventById(localFile.nodeId)
      : null;
    let landedDelete = isFileStepForOperation(
      persistedNode,
      operationId,
      "",
      emptyHash,
    ) && eventMeta(persistedNode).action === "delete"
      ? persistedNode
      : null;
    if (!landedDelete && entry) {
      const resolution = await resolveTraceChain(traceId);
      if (resolution.status !== "resolved") {
        throw new Error(`cannot resolve one current file head for ${storagePath}`);
      }
      const resolvedHead = resolution.chain[resolution.chain.length - 1];
      landedDelete = isFileStepForOperation(
        resolvedHead ?? null,
        operationId,
        "",
        emptyHash,
      ) && eventMeta(resolvedHead!).action === "delete"
        ? resolvedHead!
        : null;
      if (resolvedHead && resolvedHead.id !== entry.latestNodeId && !landedDelete) {
        throw new Error(`folder membership for ${storagePath} is behind its file trace`);
      }
    }
    if (!entry && !landedDelete) {
      throw new Error(`delete of ${storagePath} is not yet verifiable`);
    }
    if (landedDelete && localFile?.pendingSignedEvent?.id === landedDelete.id) {
      await republishSignedEdit(landedDelete, true);
    }
    if (!landedDelete) {
      const priorEvent = await fetchEventById(entry!.latestNodeId);
      if (!priorEvent) throw new Error(`cannot fetch the current Step ${entry!.latestNodeId}`);
      const priorParsed = JSON.parse(priorEvent.content) as { snapshot?: unknown };
      if (typeof priorParsed.snapshot !== "string") {
        throw new Error(`current Step ${entry!.latestNodeId} has no text snapshot`);
      }
      const persistDelete = (event: import("nostr-tools").Event) => {
        saveLocalFileDurably("signed delete Step", rootId, storagePath, {
          content: localFile?.content ?? "",
          tags: localFile?.tags ?? [],
          nodeId: event.id,
          traceId,
          pendingOperationId: operationId,
          pendingSignedEvent: event,
          runs: localFile?.runs,
          voicePubkey: localFile?.voicePubkey,
          citationIds: localFile?.citationIds,
        });
      };
      landedDelete = await publishEdit({
        prevEventId: entry!.latestNodeId,
        previousSnapshot: priorParsed.snapshot,
        traceId,
        relativePath: coordinate.relativePath,
        folderId: coordinate.folderId,
        deltas: [],
        snapshot: "",
        contentHash: emptyHash,
        action: "delete",
        localOnly: true,
        operationId,
        onSigned: persistDelete,
        signer,
        kedits: synthesizeKEditTransition(
          priorParsed.snapshot,
          "",
          getPublicKey(signer),
        ),
      });
      persistDelete(landedDelete);
    }
    const folderHead = await removeManifestEntry(
      coordinate.folderId,
      coordinate.relativePath,
      folderSigner,
      {
        localOnly: true,
        operationId,
        expectedNodeId: entry?.latestNodeId,
      },
    ) ?? await fetchLatestFolderNode(coordinate.folderId, { complete: true });
    if (folderHead) {
      await propagateFolderHead(
        rootId,
        coordinate.folderPath,
        coordinate.folderId,
        folderHead,
        folderSigner,
        true,
      );
    }
  }

  async function removeStagedFolder(
    rootId: string,
    storagePath: string,
    operation: PendingStructuralOperation,
    expected: PendingFolderMemberExpectation,
  ): Promise<void> {
    const folderNodes = await fetchFolderNodes(expected.traceId, { complete: true });
    const expectedNode = folderNodes.find((node) => node.id === expected.nodeId) ??
      await fetchEventById(expected.nodeId);
    if (!expectedNode) throw new Error(`cannot fetch expected folder head ${expected.nodeId}`);
    const loadedFolderNodes = folderNodes.some((node) => node.id === expectedNode.id)
      ? folderNodes
      : [...folderNodes, expectedNode];
    const expectedTraceId = await resolveVerifiedFolderTraceIdentityAtHead(
      expectedNode,
      async () => loadedFolderNodes,
    );
    if (expectedTraceId !== expected.traceId) {
      const reason = `cannot delete ${storagePath}: its journaled folder identity is invalid`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }
    const coordinate = localFolderCoordinate(rootId, storagePath);
    const currentEntry = (await fetchManifest(coordinate.folderId)).find(
      (entry) => entry.relativePath === coordinate.relativePath,
    );
    if (!currentEntry) return;
    const currentNode = currentEntry.kind === "folder"
      ? loadedFolderNodes.find((node) => node.id === currentEntry.latestNodeId) ??
        await fetchEventById(currentEntry.latestNodeId)
      : null;
    const verificationNodes = currentNode &&
      !loadedFolderNodes.some((node) => node.id === currentNode.id)
      ? [...loadedFolderNodes, currentNode]
      : loadedFolderNodes;
    const currentTraceId = currentNode
      ? await resolveVerifiedFolderTraceIdentityAtHead(
          currentNode,
          async () => verificationNodes,
        )
      : null;
    const authorizedCurrentCheckpoint = !!currentNode &&
      currentTraceId === expected.traceId &&
      currentEntry.contentHash === folderNodeContentHash(currentNode) &&
      folderCheckpointExtendsExpectedForOperation(
        verificationNodes,
        currentNode.id,
        expected.nodeId,
        operation.operationId,
      );
    if (currentEntry.kind !== "folder" || !authorizedCurrentCheckpoint) {
      const reason = `cannot delete ${storagePath}: its folder membership was replaced`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }
    const signer = resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${storagePath}`);
    const folderOwner = await fetchFolderOwner(coordinate.folderId);
    const folderSigner = folderWriteSigner(folderOwner, signer);
    if (!folderSigner) {
      throw new Error(`cannot remove a folder through foreign folder ${coordinate.folderId}`);
    }
    const folderHead = await removeManifestEntry(
      coordinate.folderId,
      coordinate.relativePath,
      folderSigner,
      {
        localOnly: true,
        operationId: operation.operationId,
        expectedNodeId: currentEntry.latestNodeId,
      },
    ) ?? await fetchLatestFolderNode(coordinate.folderId, { complete: true });
    if (folderHead) {
      await propagateFolderHead(
        rootId,
        coordinate.folderPath,
        coordinate.folderId,
        folderHead,
        folderSigner,
        true,
      );
    }
  }

  async function moveStagedFolder(
    rootId: string,
    operation: Extract<PendingStructuralOperation, { kind: "move" }>,
  ): Promise<void> {
    const { sourcePath, targetPath, operationId } = operation;
    const expected = operation.expectedFolder;
    const expectedNode = await fetchEventById(expected.nodeId);
    if (!expectedNode) throw new Error(`cannot fetch expected folder head ${expected.nodeId}`);
    const expectedTraceId = await resolveVerifiedFolderTraceIdentityAtHead(expectedNode);
    if (expectedTraceId !== expected.traceId) {
      const reason = `cannot move ${sourcePath}: its journaled folder identity is invalid`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }
    const expectedContentHash = folderNodeContentHash(expectedNode);
    const source = localFolderCoordinate(rootId, sourcePath);
    const target = localFolderCoordinate(rootId, targetPath);
    const [sourceManifest, targetManifest] = await Promise.all([
      fetchManifest(source.folderId),
      source.folderId === target.folderId
        ? fetchManifest(source.folderId)
        : fetchManifest(target.folderId),
    ]);
    const sourceEntry = sourceManifest.find(
      (entry) => entry.relativePath === source.relativePath,
    );
    const targetEntry = targetManifest.find(
      (entry) => entry.relativePath === target.relativePath,
    );
    if (
      (sourceEntry && !folderEntryMatchesStructuralExpectation(
        sourceEntry,
        expected,
        expectedContentHash,
      )) ||
      (targetEntry && !folderEntryMatchesStructuralExpectation(
        targetEntry,
        expected,
        expectedContentHash,
      ))
    ) {
      const reason = `cannot move ${sourcePath}: source or target folder identity changed`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }
    if (!sourceEntry && !targetEntry) {
      throw new Error(`cannot find folder membership for ${sourcePath} or ${targetPath}`);
    }
    if (source.folderId === target.folderId && sourceEntry && targetEntry) {
      const reason = `cannot move ${sourcePath}: target ${targetPath} already exists`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }

    const signer = resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${sourcePath}`);
    const targetSigner = folderWriteSigner(
      await fetchFolderOwner(target.folderId),
      signer,
    );
    if (!targetSigner) throw new Error(`cannot write through foreign folder ${target.folderId}`);

    if (source.folderId === target.folderId) {
      const parentHead = sourceEntry
        ? await renameManifestEntry(
            target.folderId,
            source.relativePath,
            target.relativePath,
            sourceEntry.latestNodeId,
            targetSigner,
            {
              localOnly: true,
              operationId,
              expectedCurrentNodeId: expected.nodeId,
            },
          )
        : await fetchLatestFolderNode(target.folderId, { complete: true });
      if (!parentHead) throw new Error(`cannot recover the parent Step for ${targetPath}`);
      await propagateFolderHead(
        rootId,
        target.folderPath,
        target.folderId,
        parentHead,
        targetSigner,
        true,
      );
      return;
    }

    const targetHead = targetEntry
      ? await fetchLatestFolderNode(target.folderId, { complete: true })
      : await upsertManifestEntry(
          target.folderId,
          { ...sourceEntry!, relativePath: target.relativePath },
          targetSigner,
          { localOnly: true, operationId, monotonicFolderId: expected.traceId },
        );
    if (!targetHead) throw new Error(`cannot recover the target Step for ${targetPath}`);
    await propagateFolderHead(
      rootId,
      target.folderPath,
      target.folderId,
      targetHead,
      targetSigner,
      true,
    );

    const sourceSigner = folderWriteSigner(
      await fetchFolderOwner(source.folderId),
      signer,
    );
    if (!sourceSigner) throw new Error(`cannot write through foreign folder ${source.folderId}`);
    const sourceHead = sourceEntry
      ? await removeManifestEntry(
          source.folderId,
          source.relativePath,
          sourceSigner,
          { localOnly: true, operationId, expectedNodeId: expected.nodeId },
        )
      : await fetchLatestFolderNode(source.folderId, { complete: true });
    if (sourceHead) {
      await propagateFolderHead(
        rootId,
        source.folderPath,
        source.folderId,
        sourceHead,
        sourceSigner,
        true,
      );
    }
  }

  async function attachStagedFolder(
    rootId: string,
    targetPath: string,
    folder: LocalFile,
    operationId: string,
    expected: PendingFolderMemberExpectation,
  ): Promise<void> {
    const target = localFolderCoordinate(rootId, targetPath);
    const head = await fetchEventById(folder.nodeId);
    if (!head) throw new Error(`cannot fetch folder nucleus ${folder.nodeId}`);
    const traceId = await resolveVerifiedFolderTraceIdentityAtHead(head);
    if (!traceId) throw new Error(`cannot resolve folder identity for ${targetPath}`);
    if (
      head.id !== expected.nodeId ||
      traceId !== expected.traceId ||
      (folder.traceId && folder.traceId !== traceId)
    ) {
      throw new Error(`cached folder identity for ${targetPath} does not match its signed head`);
    }
    const signer = resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${targetPath}`);
    const parentSigner = folderWriteSigner(
      await fetchFolderOwner(target.folderId),
      signer,
    );
    if (!parentSigner) throw new Error(`cannot write through foreign folder ${target.folderId}`);
    const parentHead = await upsertManifestEntry(
      target.folderId,
      {
        kind: "folder",
        relativePath: target.relativePath,
        latestNodeId: head.id,
        contentHash: folderNodeContentHash(head),
      },
      parentSigner,
      { localOnly: true, operationId, monotonicFolderId: traceId },
    );
    await propagateFolderHead(
      rootId,
      target.folderPath,
      target.folderId,
      parentHead,
      parentSigner,
      true,
    );
  }

  async function completeStagedFolderCreation(
    rootId: string,
    operation: Extract<PendingStructuralOperation, { kind: "create-folder" }>,
  ): Promise<void> {
    let head = await fetchEventById(operation.genesisId);
    if (!head) {
      // The journal and outbox are separate durable stores. If the process
      // stopped after the atomic journal write but before outbox insertion,
      // restore the exact signed genesis instead of minting a replacement.
      enqueueLocalEvent(operation.genesisEvent);
      head = operation.genesisEvent;
    }
    const traceId = await resolveVerifiedFolderTraceIdentityAtHead(head);
    if (!head || traceId !== operation.genesisId) {
      throw new Error(`cannot recover folder genesis ${operation.genesisId}`);
    }
    if (folderNodeContentHash(head) !== operation.contentHash) {
      throw new Error(`folder genesis hash changed for ${operation.sourcePath}`);
    }
    const target = localFolderCoordinate(rootId, operation.sourcePath);
    const manifest = await fetchManifest(target.folderId);
    const existing = manifest.find((entry) => entry.relativePath === target.relativePath);
    if (
      existing &&
      (
        existing.kind !== "folder" ||
        existing.latestNodeId !== operation.genesisId ||
        existing.contentHash !== operation.contentHash
      )
    ) {
      const reason = `cannot create ${operation.sourcePath}: target already exists`;
      failStructuralOperation(rootId, operation, reason);
      throw new Error(reason);
    }
    const signer = resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${operation.sourcePath}`);
    const parentSigner = folderWriteSigner(
      await fetchFolderOwner(target.folderId),
      signer,
    );
    if (!parentSigner) {
      throw new Error(`cannot create through foreign folder ${target.folderId}`);
    }
    const parentHead = existing
      ? await fetchLatestFolderNode(target.folderId, { complete: true })
      : await upsertManifestEntry(
          target.folderId,
          {
            kind: "folder",
            relativePath: target.relativePath,
            latestNodeId: operation.genesisId,
            contentHash: operation.contentHash,
          },
          parentSigner,
          { localOnly: true, operationId: operation.operationId },
        );
    if (!parentHead) throw new Error(`cannot recover parent Step for ${operation.sourcePath}`);
    await propagateFolderHead(
      rootId,
      target.folderPath,
      target.folderId,
      parentHead,
      parentSigner,
      true,
    );
    // `fetchManifest` deliberately includes the durable outbox, so finding the
    // exact membership above proves only that it was signed, not that the home
    // relay accepted it. A top-level folder has no ancestor propagation to
    // trigger another append/drain. Flush explicitly and retain the structural
    // journal until both exact recovery dependencies have left the outbox.
    await flushLocalEventOutbox();
    const unaccepted = [operation.genesisId, parentHead.id]
      .filter((eventId) => pendingLocalEventById(eventId));
    if (unaccepted.length > 0) {
      throw new Error(
        `cannot finish folder recovery before home accepts ${unaccepted.join(", ")}`,
      );
    }
    saveLocalFileDurably("new folder", rootId, operation.sourcePath, {
      kind: "folder",
      content: "",
      tags: [],
      nodeId: operation.genesisId,
      traceId: operation.genesisId,
    });
  }

  function runStructuralOperation(
    rootId: string,
    operation: PendingStructuralOperation,
    task: () => Promise<void>,
  ): Promise<void> {
    return runStructuralOperationSerialized(
      rootMutationRuns,
      rootId,
      operation.operationId,
      task,
    );
  }

  async function completePendingStructuralOperationWithinRoot(
    rootId: string,
    operation: PendingStructuralOperation,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    if (operation.kind === "create-folder") {
      await completeStagedFolderCreation(rootId, operation);
      clearStructuralOperation(rootId, operation.operationId);
      const file = loadLocalFolder(rootId)?.files[operation.sourcePath];
      onReconciled?.(
        operation.sourcePath,
        file ? localToFiles(loadLocalFolder(rootId)!)[operation.sourcePath] ?? null : null,
      );
      return;
    }
    if (operation.kind === "delete") {
      for (const path of operation.affectedPaths) {
        const entry = loadLocalFolder(rootId)?.files[path];
        if (entry?.kind === "folder") {
          const expected = operation.expectedFolders[path];
          if (!expected) {
            const reason = `cannot recover delete: missing folder identity for ${path}`;
            failStructuralOperation(rootId, operation, reason);
            throw new Error(reason);
          }
          await removeStagedFolder(rootId, path, operation, expected);
        } else if (entry) {
          await tombstoneStagedFile(rootId, path, operation.operationId);
        }
      }
      for (const path of operation.affectedPaths) deleteLocalFileDurably(rootId, path);
      clearStructuralOperation(rootId, operation.operationId);
      for (const path of operation.affectedPaths) onReconciled?.(path, null);
      return;
    }

    const current = () => loadLocalFolder(rootId)?.files ?? {};
    const completeLocalMoves = () => {
      for (const { oldRel, newRel } of operation.moves) {
        if (current()[oldRel] && !current()[newRel]) moveLocalFileDurably(rootId, oldRel, newRel);
      }
    };

    if (isOblivionPath(operation.targetPath)) {
      const fileMoves = operation.moves.filter(({ oldRel, newRel }) =>
        (current()[oldRel] ?? current()[newRel])?.kind !== "folder",
      );
      for (const { oldRel, newRel } of fileMoves) {
        const file = current()[oldRel] ?? current()[newRel];
        if (!file) continue;
        if (current()[oldRel] && !current()[newRel]) {
          moveLocalFileDurably(
            rootId,
            oldRel,
            newRel,
            pendingMoveForPath(oldRel, newRel, file.pendingMove),
            file.pendingOperationId ?? operation.operationId,
            true,
          );
        }
        await flushStagedFileWithinRoot(rootId, newRel);
      }
      const folderMoves = operation.moves
        .filter(({ oldRel, newRel }) =>
          (current()[oldRel] ?? current()[newRel])?.kind === "folder",
        )
        .sort((left, right) => right.oldRel.split("/").length - left.oldRel.split("/").length);
      // Folder paths move locally only after every remote removal lands. If
      // all old paths are already absent, a crash happened after that barrier.
      if (!folderMoves.every(({ oldRel, newRel }) => !current()[oldRel] && !!current()[newRel])) {
        for (const { oldRel } of folderMoves) {
          if (current()[oldRel]) {
            const expected = operation.expectedFolders[oldRel];
            if (!expected) {
              const reason = `cannot recover move: missing folder identity for ${oldRel}`;
              failStructuralOperation(rootId, operation, reason);
              throw new Error(reason);
            }
            await removeStagedFolder(rootId, oldRel, operation, expected);
          }
        }
        for (const { oldRel, newRel } of folderMoves) {
          if (current()[oldRel] && !current()[newRel]) moveLocalFileDurably(rootId, oldRel, newRel);
        }
      }
    } else if (isOblivionPath(operation.sourcePath)) {
      const folderMoves = operation.moves
        .filter(({ oldRel, newRel }) =>
          (current()[oldRel] ?? current()[newRel])?.kind === "folder",
        )
        .sort((left, right) => left.oldRel.split("/").length - right.oldRel.split("/").length);
      for (const { oldRel, newRel } of folderMoves) {
        const folder = current()[oldRel] ?? current()[newRel];
        if (!folder) continue;
        if (current()[oldRel] && !current()[newRel]) moveLocalFileDurably(rootId, oldRel, newRel);
        const expected = operation.expectedFolders[oldRel];
        if (!expected) {
          const reason = `cannot recover move: missing folder identity for ${oldRel}`;
          failStructuralOperation(rootId, operation, reason);
          throw new Error(reason);
        }
        await attachStagedFolder(rootId, newRel, folder, operation.operationId, expected);
      }
      const fileMoves = operation.moves.filter(({ oldRel, newRel }) =>
        (current()[oldRel] ?? current()[newRel])?.kind !== "folder",
      );
      for (const { oldRel, newRel } of fileMoves) {
        const file = current()[oldRel] ?? current()[newRel];
        if (!file) continue;
        if (current()[oldRel] && !current()[newRel]) {
          moveLocalFileDurably(
            rootId,
            oldRel,
            newRel,
            pendingMoveForPath(oldRel, newRel, file.pendingMove),
            file.pendingOperationId ?? operation.operationId,
            true,
          );
        }
        await flushStagedFileWithinRoot(rootId, newRel);
      }
    } else {
      await moveStagedFolder(rootId, operation);
      completeLocalMoves();
    }

    clearStructuralOperation(rootId, operation.operationId);
    const persisted = loadLocalFolder(rootId);
    const files = persisted ? localToFiles(persisted) : {};
    for (const { oldRel, newRel } of operation.moves) {
      onReconciled?.(oldRel, null);
      onReconciled?.(newRel, files[newRel] ?? null);
    }
  }

  async function completePendingStructuralOperation(
    rootId: string,
    operation: PendingStructuralOperation,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    await runStructuralOperation(rootId, operation, () =>
      completePendingStructuralOperationWithinRoot(rootId, operation, onReconciled),
    );
  }

  async function resumePendingStructuralOperations(
    rootId: string,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    for (const operation of pendingStructuralOperations(rootId)) {
      await completePendingStructuralOperation(rootId, operation, onReconciled);
    }
  }

  async function resumePendingStructuralOperationsWithinRoot(
    rootId: string,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    for (const operation of pendingStructuralOperations(rootId)) {
      await completePendingStructuralOperationWithinRoot(rootId, operation, onReconciled);
    }
  }

  async function stepFolderWithinRoot(
    rootId: string,
    relativePath: string,
    operationId: string,
    requestedSigner?: Uint8Array,
  ): Promise<string> {
    const signer = requestedSigner ?? resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${relativePath || "Root"}`);
    const folderId = relativePath === ""
      ? rootId
      : (() => {
          const folder = loadLocalFolder(rootId)?.files[relativePath];
          const id = folder?.traceId ?? folder?.nodeId;
          if (folder?.kind !== "folder" || !id) {
            throw new Error(`cannot resolve folder trace for ${relativePath}`);
          }
          return id;
        })();
    const folderSigner = folderWriteSigner(await fetchFolderOwner(folderId), signer);
    if (!folderSigner) {
      throw new Error(`cannot Step foreign folder ${relativePath || "Root"}`);
    }
    const head = await stepFolderManifest(folderId, folderSigner, {
      localOnly: true,
      operationId,
    });
    if (relativePath === "") {
      rememberLocalTreeFolderHead(
        { storageRootId: rootId, folderId: rootId, storagePath: "" },
        "",
        rootId,
        head,
      );
    } else {
      rememberLocalTreeFolderHead(
        { storageRootId: rootId, folderId: rootId, storagePath: "" },
        relativePath,
        folderId,
        head,
      );
      await propagateFolderHead(
        rootId,
        relativePath,
        folderId,
        head,
        folderSigner,
        true,
        true,
      );
    }
    return head.id;
  }

  /** Complete one durable explicit-folder gesture while already holding the
   * Root lane. Folder Steps precede structural path changes so their journaled
   * path cannot be orphaned by a later rename/move/delete. */
  async function completePendingFolderStepWithinRoot(
    rootId: string,
    relativePath: string,
    operationId: string,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    const pad = loadPad(rootId) ?? {};
    const descendants = Object.keys(pad)
      .filter((path) => relativePath === "" || path.startsWith(`${relativePath}/`))
      .sort((left, right) => left.localeCompare(right));
    for (const path of descendants) {
      const draft = pad[path];
      if (!draft || draft.kind === "folder") continue;
      const existing = loadLocalFolder(rootId)?.files[path];
      saveLocalFileDurably("recovered folder Step descendant", rootId, path, {
        content: draft.content,
        tags: draft.tags,
        nodeId: existing?.nodeId ?? draft.nodeId,
        traceId: existing?.traceId ?? draft.traceId,
        runs: draft.runs,
        voicePubkey: draft.voicePubkey,
        citationIds: draft.citationIds,
        pendingKedits: draft.kedits,
        pendingLocalOnly: true,
        pendingOperationId: operationId,
      });
      await flushStagedFileWithinRoot(rootId, path);
      clearPadPath(rootId, path);
      const reconciled = loadLocalFolder(rootId);
      onReconciled?.(path, reconciled ? localToFiles(reconciled)[path] ?? null : null);
    }
    const staged = Object.entries(loadLocalFolder(rootId)?.files ?? {})
      .filter(([path, file]) =>
        file.kind !== "folder" &&
        file.pendingOperationId === operationId &&
        (relativePath === "" || path.startsWith(`${relativePath}/`))
      )
      .map(([path]) => path)
      .sort((left, right) => left.localeCompare(right));
    for (const path of staged) {
      await flushStagedFileWithinRoot(rootId, path);
      const reconciled = loadLocalFolder(rootId);
      onReconciled?.(path, reconciled ? localToFiles(reconciled)[path] ?? null : null);
    }
    await stepFolderWithinRoot(rootId, relativePath, operationId);
    clearFolderStepOperation(rootId, relativePath);
    if (relativePath) {
      const reconciled = loadLocalFolder(rootId);
      onReconciled?.(
        relativePath,
        reconciled ? localToFiles(reconciled)[relativePath] ?? null : null,
      );
    }
  }

  async function completePendingFolderStepsWithinRoot(
    rootId: string,
    onReconciled?: (path: string, file: FileState | null) => void,
    excludeOperationId?: string,
  ): Promise<void> {
    for (const { relativePath, operationId } of pendingFolderStepOperations(rootId)) {
      if (operationId === excludeOperationId) continue;
      await completePendingFolderStepWithinRoot(
        rootId,
        relativePath,
        operationId,
        onReconciled,
      );
    }
  }

  async function resumePendingFolderSteps(
    rootId: string,
    onReconciled?: (path: string, file: FileState | null) => void,
  ): Promise<void> {
    for (const { relativePath, operationId } of pendingFolderStepOperations(rootId)) {
      await runRootMutationSerialized(rootMutationRuns, rootId, operationId, () =>
        completePendingFolderStepWithinRoot(
          rootId,
          relativePath,
          operationId,
          onReconciled,
        )
      );
    }
  }

  function runWorkspaceRootMutation<T>(
    rootId: string,
    operationId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return runRootMutationAfterRecovery(
      rootMutationRuns,
      rootId,
      operationId,
      async () => {
        await completePendingFolderStepsWithinRoot(rootId, undefined, operationId);
        await resumePendingStructuralOperationsWithinRoot(rootId);
      },
      task,
    );
  }

  return {
    get ref(): FolderRef | null {
      return ref ? { ...ref } : null;
    },

    /**
     * Instant boot from localStorage, then background relay pull.
     *
     * Returns the local file set synchronously-derived (step 1) so the editor
     * renders immediately. The relay pull (step 2) runs in the background and
     * calls `onRemoteUpdate` for any file the relay has newer than local —
     * the caller merges those into editor state without blocking.
     */
    async attach(folderRef: FolderRef, onReconciled?: (path: string, file: FileState | null) => void): Promise<AttachResult> {
      ref = { ...folderRef };
      if (options.requireRelayOnAttach) {
        const genesis = await fetchEventById(ref.id);
        if (!genesis || genesis.kind !== 4290 || eventMeta(genesis).z !== "folder") {
          throw new Error(`folder genesis ${ref.id} is unavailable on the configured relay`);
        }
      }
      rememberLocalFolder(ref);
      const attachedRootId = ref.id;
      let local = loadLocalFolder(attachedRootId);
      let files = local ? localToFiles(local) : {};
      const resumeLocalWork = async () => {
        await resumePendingFolderSteps(attachedRootId, onReconciled);
        await resumePendingStructuralOperations(attachedRootId, onReconciled);
        const resumed = loadLocalFolder(attachedRootId);
        for (const [path, file] of Object.entries(resumed?.files ?? {})) {
          // Resume interrupted file moves and first-time files only after the
          // structural journal has restored their final local paths.
          if (
            file.pendingMove ||
            file.pendingEmptyGenesis ||
            file.pendingOperationId ||
            (file.kind !== "folder" && !file.nodeId)
          ) {
            schedulePush(path, onReconciled, attachedRootId);
          }
        }
      };
      if (options.requireRelayOnAttach) {
        await resumeLocalWork();
        const pulled = await pullFromRelay(attachedRootId, { strict: true });
        options.onPullResult?.(pulled);
        local = loadLocalFolder(attachedRootId);
        files = local ? localToFiles(local) : {};
        for (const path of pulled.updated) onReconciled?.(path, files[path] ?? null);
        return { files, reconciled: Promise.resolve() };
      }
      // The GUI remains local-first and renders immediately, but expose the
      // real synchronization barrier to callers that choose to observe it.
      const reconciled = resumeLocalWork()
        .then(() => pullFromRelay(attachedRootId))
        .then((pulled) => {
          options.onPullResult?.(pulled);
          const latest = loadLocalFolder(attachedRootId);
          const latestFiles = latest ? localToFiles(latest) : {};
          for (const path of pulled.updated) onReconciled?.(path, latestFiles[path] ?? null);
        })
        .then(() => undefined);
      return { files, reconciled };
    },

    async readFile(relativePath: string): Promise<string> {
      const id = requireId();
      const local = loadLocalFolder(id);
      return local?.files[relativePath]?.content ?? "";
    },

    async writeFile(
      relativePath,
      content,
      tags = [],
      signer?: Uint8Array,
      runs?: Run[],
      replyingTo?: string,
      citationIds?: string[],
      kedits?: KEdit[],
      localOnly?: boolean,
      force?: boolean,
      requestedOperationId?: string,
    ): Promise<string> {
      relativePath = ensureMdExt(relativePath);
      const id = requireId();
      const operationId = requestedOperationId ?? createTraceOperationId();
      return runWorkspaceRootMutation(id, operationId, () =>
        runResourceSerialized(fileStepRuns, `${id}:${relativePath}`, async () => {
          const pendingOperationId = loadLocalFolder(id)?.files[relativePath]
            ?.pendingOperationId;
          return stageFileStepAfterPendingRecovery(
            pendingOperationId,
            () => flushStagedFileUnlocked(id, relativePath),
            async () => {
              // Reload after recovery: the prior exact signed Step and its
              // folder cascade may have advanced both node and trace identity.
              // Capture the voice for this new edit only after that boundary.
              const voicePubkey = signer ? getPublicKey(signer) : authorVoice();
              const local = loadLocalFolder(id);
              const existing = local?.files[relativePath];
              const prevNodeId = existing?.nodeId ?? "";
              saveLocalFileDurably("staged file Step", id, relativePath, {
                content,
                tags,
                nodeId: prevNodeId,
                traceId: existing?.traceId,
                pendingMove: existing?.pendingMove,
                runs,
                voicePubkey,
                pendingReplyingTo: replyingTo,
                citationIds: citationIds,
                pendingKedits: kedits,
                pendingLocalOnly: localOnly || undefined,
                pendingForce: force || undefined,
                pendingEmptyGenesis: existing?.pendingEmptyGenesis,
                pendingOperationId: operationId,
              });
              return flushStagedFileUnlocked(id, relativePath);
            },
          );
        }),
      );
    },

    async acceptMerge(input): Promise<{ id: string; content: string }> {
      const id = requireId();
      const operationId = createTraceOperationId();
      const relativePath = ensureMdExt(input.relativePath);
      return runWorkspaceRootMutation(id, operationId, () =>
        runResourceSerialized(fileStepRuns, `${id}:${relativePath}`, async () => {
          const local = loadLocalFolder(id);
          const existing = local?.files[relativePath];
          const draft = crashPadDraftForPull(existing, loadPad(id)?.[relativePath]);
          if (
            !existing ||
            existing.kind === "folder" ||
            existing.nodeId !== input.expectedNodeId ||
            (draft ?? existing).content !== input.expectedContent
          ) {
            throw new Error(
              `Cannot accept merge for ${relativePath}: local work changed after it was staged.`,
            );
          }

          const coordinate = localFolderCoordinate(id, relativePath);
          const traceId = existing.traceId ?? await resolveTraceIdentity(input.expectedNodeId);
          const fileOwner = traceId ? await fetchNodeOwner(traceId) : null;
          const signer = fileOwner ? resolveFileSigner(fileOwner) : null;
          if (!signer || getPublicKey(signer) !== fileOwner) {
            throw new Error(`cannot resolve the fixed trace owner for ${relativePath}`);
          }
          const folderOwner = await fetchFolderOwner(coordinate.folderId);
          const folderSigner = folderWriteSigner(folderOwner, signer);
          if (!folderSigner) {
            throw new Error(`cannot write through foreign folder ${coordinate.folderId}`);
          }
          const tags = input.tags ?? existing.tags;
          const citationIds = input.citationIds ?? existing.citationIds;
          const runs = input.runs ?? (
            input.snapshot.length > 0
              ? [{
                  voice: getPublicKey(signer),
                  text: input.snapshot,
                }]
              : []
          );
          const persistSignedMerge = (event: import("nostr-tools").Event) => {
            const latestDraft = crashPadDraftForPull(
              loadLocalFolder(id)?.files[relativePath],
              loadPad(id)?.[relativePath],
            );
            saveLocalFileDurably("signed merge Step", id, relativePath, {
              content: input.snapshot,
              tags,
              nodeId: event.id,
              traceId: traceId ?? event.id,
              runs,
              voicePubkey: event.pubkey,
              citationIds,
              pendingSignedEvent: event,
              pendingOperationId: operationId,
              pendingLocalOnly: true,
            });
            if (latestDraft && latestDraft.content !== input.expectedContent) {
              mirrorPad(id, relativePath, {
                ...latestDraft,
                nodeId: event.id,
                traceId: traceId ?? event.id,
              });
            }
          };
          const event = await publishMergeFile({
            folderId: coordinate.folderId,
            relativePath: coordinate.relativePath,
            prevEventId: input.expectedNodeId,
            mergeParentIds: [input.mergeParentId],
            snapshot: input.snapshot,
            authors: runs,
            tags,
            citations: findResolvedBrackets(input.snapshot).map((bracket) => bracket.nodeId),
            inlineCitations: findAddedInlineCitations(input.expectedContent, input.snapshot),
            citationIds,
            summary: input.summary,
            signer,
            localOnly: true,
            operationId,
            onSigned: persistSignedMerge,
          });
          const folderHead = await upsertManifestEntry(
            coordinate.folderId,
            {
              kind: "file",
              relativePath: coordinate.relativePath,
              latestNodeId: event.id,
              contentHash: await sha256Hex(input.snapshot),
            },
            folderSigner,
            { operationId, localOnly: true },
          );
          if (folderHead) {
            await propagateFolderHead(
              id,
              coordinate.folderPath,
              coordinate.folderId,
              folderHead,
              folderSigner,
              true,
            );
          }
          saveLocalFileDurably("completed merge Step", id, relativePath, {
            content: input.snapshot,
            tags,
            nodeId: event.id,
            traceId: traceId ?? event.id,
            runs,
            voicePubkey: event.pubkey,
            citationIds,
          });
          const latestDraft = loadPad(id)?.[relativePath];
          if (latestDraft && latestDraft.content !== input.expectedContent) {
            mirrorPad(id, relativePath, {
              ...latestDraft,
              nodeId: event.id,
              traceId: traceId ?? event.id,
            });
          } else {
            clearPadPath(id, relativePath);
          }
          return { id: event.id, content: event.content };
        }),
      );
    },

    async flushFile(relativePath: string): Promise<string> {
      return flushStagedFile(relativePath);
    },

    async createFile(relativePath: string): Promise<string> {
      relativePath = ensureMdExt(relativePath);
      const id = requireId();
      const operationId = createTraceOperationId();
      return runWorkspaceRootMutation(id, operationId, () =>
        runResourceSerialized(fileStepRuns, `${id}:${relativePath}`, async () => {
          const local = loadLocalFolder(id);
          if (local?.files[relativePath]) return local.files[relativePath].nodeId;
          saveLocalFileDurably("new file", id, relativePath, {
            content: "",
            tags: [],
            nodeId: "",
            pendingOperationId: operationId,
          });
          return flushStagedFileUnlocked(id, relativePath);
        }),
      );
    },

    async createFolder(relativePath: string): Promise<string> {
      const id = requireId();
      const operationId = createTraceOperationId();
      return runWorkspaceRootMutation(id, operationId, async () => {
        const existing = loadLocalFolder(id)?.files[relativePath];
        if (existing?.kind === "folder" && (existing.traceId || existing.nodeId)) {
          return existing.traceId ?? existing.nodeId;
        }

        const parent = localFolderCoordinate(id, relativePath);
        const signer = resolveFileSigner(authorVoice());
        if (!signer) throw new Error(`cannot resolve a local signer for ${relativePath}`);
        const folderOwner = await fetchFolderOwner(parent.folderId);
        const parentSigner = folderWriteSigner(folderOwner, signer);
        if (!parentSigner) {
          throw new Error(
            `cannot create a folder through foreign folder ${parent.folderId}; fork it first`,
          );
        }

        // Sign the immutable genesis, persist its exact identity before any
        // relay write, then let the structural recovery path attach and
        // propagate that same nucleus. A crash can never make retry mint G2.
        const genesisId = await createFolderGenesis({
          signer,
          localOnly: true,
          operationId,
          onSigned: (event) => {
            const creation: Extract<PendingStructuralOperation, { kind: "create-folder" }> = {
              version: 1,
              kind: "create-folder",
              operationId,
              sourcePath: relativePath,
              isFolder: true,
              genesisId: event.id,
              contentHash: folderNodeContentHash(event),
              genesisEvent: event,
            };
            stageStructuralOperation(id, creation);
          },
        });
        const creation = pendingStructuralOperations(id).find(
          (candidate): candidate is Extract<PendingStructuralOperation, { kind: "create-folder" }> =>
            candidate.operationId === operationId && candidate.kind === "create-folder",
        );
        if (!creation || creation.genesisId !== genesisId) {
          throw new Error(`cannot recover signed folder genesis for ${relativePath}`);
        }
        await completePendingStructuralOperationWithinRoot(id, creation);
        return genesisId;
      });
    },

    async stepFolder(
      relativePath: string,
      requestedSigner?: Uint8Array,
      requestedOperationId?: string,
    ): Promise<string> {
      const rootId = requireId();
      const operationId = requestedOperationId ?? createTraceOperationId();
      // Coalesce the complete selected-folder + ancestor cascade before it
      // enters the shared Root lane, so duplicate callers cannot race only the
      // ancestors or append a second explicit checkpoint.
      const flightKey = JSON.stringify([rootId, relativePath, operationId]);
      const existing = recursiveFolderStepFlights.get(flightKey);
      if (existing) return existing;

      const pending = runWorkspaceRootMutation(rootId, operationId, async () => {
        return stepFolderWithinRoot(rootId, relativePath, operationId, requestedSigner);
      });
      recursiveFolderStepFlights.set(flightKey, pending);
      try {
        return await pending;
      } finally {
        if (recursiveFolderStepFlights.get(flightKey) === pending) {
          recursiveFolderStepFlights.delete(flightKey);
        }
      }
    },

    async deletePath(relativePath: string, isFolder: boolean): Promise<void> {
      const id = requireId();
      const operationId = createTraceOperationId();
      await runWorkspaceRootMutation(id, operationId, async () => {
        await completePendingFolderStepsWithinRoot(id);
        const local = loadLocalFolder(id);
        if (!local) return;
        const affected = (isFolder
          ? Object.keys(local.files).filter(
              (path) => path === relativePath || path.startsWith(`${relativePath}/`),
            )
          : [relativePath])
          .sort((left, right) => right.split("/").length - left.split("/").length);
        const operation: PendingStructuralOperation = {
          version: 2,
          kind: "delete",
          operationId,
          sourcePath: relativePath,
          isFolder,
          affectedPaths: affected,
          expectedFolders: Object.fromEntries(
            affected.flatMap((path) => {
              const entry = local.files[path];
              return entry?.kind === "folder"
                ? [[path, pendingFolderMemberExpectation(entry, path)] as const]
                : [];
            }),
          ),
          ...structuralShieldJournal(
            local.shieldedPaths ?? [],
            relativePath,
            null,
            isFolder,
          ),
        };
        stageStructuralOperation(id, operation);
        await completePendingStructuralOperationWithinRoot(id, operation);
        // The structural completion deletes each descendant FILE via
        // deleteLocalFile (which clears its own pad entry). Pad-ONLY entries
        // (a brand-new MODEL-created file with no LocalFolder.files entry)
        // would otherwise survive and resurrect the deleted buffer on next
        // boot. Subtree-clear the whole deleted prefix once to catch them.
        deletePadPath(id, relativePath, isFolder);
      });
    },

    async movePath(src, destFolder, isFolder, _tagsByPath = {}): Promise<void> {
      const id = requireId();
      const operationId = createTraceOperationId();
      await runWorkspaceRootMutation(id, operationId, async () => {
        await completePendingFolderStepsWithinRoot(id);
        const local = loadLocalFolder(id);
        if (!local) return;
        const name = basename(src);
        const destPath = destFolder === "" ? name : `${destFolder}/${name}`;
        const moves: { oldRel: string; newRel: string }[] = [];
        for (const path of Object.keys(local.files)) {
          if (path === src) moves.push({ oldRel: path, newRel: destPath });
          else if (path.startsWith(`${src}/`)) {
            moves.push({ oldRel: path, newRel: destPath + path.slice(src.length) });
          }
        }
        if (isFolder) {
          const expectedFolders = Object.fromEntries(
            moves.flatMap(({ oldRel }) => {
              const entry = local.files[oldRel];
              return entry?.kind === "folder"
                ? [[oldRel, pendingFolderMemberExpectation(entry, oldRel)] as const]
                : [];
            }),
          );
          const operation: PendingStructuralOperation = {
            version: 2,
            kind: "move",
            operationId,
            sourcePath: src,
            targetPath: destPath,
            isFolder: true,
            moves,
            expectedFolder: pendingFolderMemberExpectation(local.files[src], src),
            expectedFolders,
            ...structuralShieldJournal(
              local.shieldedPaths ?? [],
              src,
              destPath,
              true,
            ),
          };
          stageStructuralOperation(id, operation);
          await completePendingStructuralOperationWithinRoot(id, operation);
          // The structural completion moves each descendant FILE via
          // moveLocalFile (which rebases its own pad entry). Pad-ONLY entries
          // (a brand-new MODEL-created file with no LocalFolder.files entry
          // yet) would otherwise be left keyed at the old prefix and
          // resurrected as a ghost on the next boot. Subtree-rebase the whole
          // moved prefix once to catch them.
          movePadPath(id, src, destPath);
          return;
        }
        const fileShieldJournal = structuralShieldJournal(
          local.shieldedPaths ?? [],
          src,
          destPath,
          false,
        );
        for (const { oldRel, newRel } of moves) {
          const file = loadLocalFolder(id)?.files[oldRel];
          if (!file || file.kind === "folder") continue;
          const pendingMove = pendingMoveForPath(oldRel, newRel, file.pendingMove);
          moveLocalFileDurably(
            id,
            oldRel,
            newRel,
            pendingMove,
            file.pendingOperationId ?? operationId,
            true,
            fileShieldJournal.shieldedPathsAfter,
          );
        }
        for (let index = 0; index < moves.length; index++) {
          try {
            await flushStagedFileWithinRoot(id, moves[index].newRel);
          } catch (error) {
            for (let pending = index + 1; pending < moves.length; pending++) {
              schedulePush(moves[pending].newRel, undefined, id);
            }
            throw error;
          }
        }
      });
    },

    async renamePath(src, newName, isFolder): Promise<void> {
      const id = requireId();
      const operationId = createTraceOperationId();
      await runWorkspaceRootMutation(id, operationId, async () => {
        await completePendingFolderStepsWithinRoot(id);
        const local = loadLocalFolder(id);
        if (!local) return;
        const slash = src.lastIndexOf("/");
        const destPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;
        const moves: { oldRel: string; newRel: string }[] = [];
        for (const path of Object.keys(local.files)) {
          if (path === src) moves.push({ oldRel: path, newRel: destPath });
          else if (path.startsWith(`${src}/`)) {
            moves.push({ oldRel: path, newRel: destPath + path.slice(src.length) });
          }
        }
        if (isFolder) {
          const expectedFolders = Object.fromEntries(
            moves.flatMap(({ oldRel }) => {
              const entry = local.files[oldRel];
              return entry?.kind === "folder"
                ? [[oldRel, pendingFolderMemberExpectation(entry, oldRel)] as const]
                : [];
            }),
          );
          const operation: PendingStructuralOperation = {
            version: 2,
            kind: "move",
            operationId,
            sourcePath: src,
            targetPath: destPath,
            isFolder: true,
            moves,
            expectedFolder: pendingFolderMemberExpectation(local.files[src], src),
            expectedFolders,
            ...structuralShieldJournal(
              local.shieldedPaths ?? [],
              src,
              destPath,
              true,
            ),
          };
          stageStructuralOperation(id, operation);
          await completePendingStructuralOperationWithinRoot(id, operation);
          // The structural completion moves each descendant FILE via
          // moveLocalFile (which rebases its own pad entry). Pad-ONLY entries
          // (a brand-new MODEL-created file with no LocalFolder.files entry
          // yet) would otherwise be left keyed at the old prefix and
          // resurrected as a ghost on the next boot. Subtree-rebase the whole
          // moved prefix once to catch them.
          movePadPath(id, src, destPath);
          return;
        }
        const fileShieldJournal = structuralShieldJournal(
          local.shieldedPaths ?? [],
          src,
          destPath,
          false,
        );
        for (const { oldRel, newRel } of moves) {
          const file = loadLocalFolder(id)?.files[oldRel];
          if (!file || file.kind === "folder") continue;
          moveLocalFileDurably(id, oldRel, newRel, {
            kind: "move",
            fromPath: file.pendingMove?.fromPath ?? oldRel,
          }, file.pendingOperationId ?? operationId, true, fileShieldJournal.shieldedPathsAfter);
        }
        for (let index = 0; index < moves.length; index++) {
          try {
            await flushStagedFileWithinRoot(id, moves[index].newRel);
          } catch (error) {
            for (let pending = index + 1; pending < moves.length; pending++) {
              schedulePush(moves[pending].newRel, undefined, id);
            }
            throw error;
          }
        }
      });
    },

    async readFolderTags(): Promise<Record<string, string[]>> {
      return loadLocalFolderTags(requireId());
    },

    async writeFolderTags(tags: Record<string, string[]>): Promise<void> {
      saveLocalFolderTags(requireId(), tags);
    },
  };
}

// --- background relay pull ------------------------------------------------

/**
 * A clean auto-merge from background pull — held for user review, not applied.
 * Local storage is NOT modified while a merge is staged: applying it is what
 * writes the merged snapshot and steps the merge node, so an edit between
 * stage and review can't silently lose provenance or clobber the draft.
 */
export interface StagedMerge {
  path: string;
  /** Common-ancestor snapshot (fork point body). */
  base: string;
  /** Local head body — what's in the editor right now. */
  ours: string;
  /** Remote head body — what the peer stepped. */
  theirs: string;
  /** Reconciled body produced by a clean diff3 (outcome === "clean"). */
  merged: string;
  /** Local node id at pull time; the merge node's `prev`. */
  localNodeId: string;
  /** Remote head event id; the merge node's `merge-parent`. */
  remoteHeadId: string;
  /** Pubkey of the remote head's signer, for attribution on step. */
  remoteOwnerPubkey: string;
}

/** Structured outcome of a background pull. */
export interface PullResult {
  /** Stable Root identity whose pull produced this result. Async consumers use
   * it to reject results from a workspace that has since been detached. */
  rootId: string;
  /** Fast-forwards: silent overwrites (local was at the ancestor). Refresh UI. */
  updated: Set<string>;
  /** Clean merges awaiting review. Local untouched. */
  staged: StagedMerge[];
  /** Textual conflicts: local untouched; surfaced via the activation banner. */
  conflicts: Set<string>;
}

/** An unstepped crash-pad body is the local side of pull reconciliation. The
 * primary LocalFile is only the last completed Step and must not authorize a
 * fast-forward over a newer editor buffer. */
export function crashPadDraftForPull(
  existing: LocalFile | undefined,
  pad: LocalFile | undefined,
): LocalFile | undefined {
  if (pad?.kind !== "file") return undefined;
  return !existing ||
      existing.kind !== "file" ||
      pad.content !== existing.content ||
      (pad.kedits?.length ?? 0) > 0
    ? pad
    : undefined;
}

/** Same bytes can still carry a later immutable checkpoint. Adopt only when
 * the local head is on the remote chain and no crash-pad draft shadows it. */
export function sameBodyDescendantCanFastForward(
  chain: readonly import("nostr-tools").Event[],
  localNodeId: string | undefined,
  remoteHeadId: string,
  hasDraft: boolean,
): boolean {
  return !hasDraft &&
    Boolean(localNodeId) &&
    localNodeId !== remoteHeadId &&
    chain.some((event) => event.id === localNodeId);
}

/** An exact clean member does not block adopting a newer Root checkpoint that
 * changed only its siblings. Pending recovery or a divergent file body does. */
export function localManifestProjectionMatches(
  local: LocalFile | undefined,
  entry: ManifestFileEntry,
  expectedFileContent?: string,
): boolean {
  if (
    !local ||
    local.pendingOperationId ||
    local.pendingMove ||
    local.pendingEmptyGenesis ||
    local.nodeId !== entry.latestNodeId ||
    local.kind !== entry.kind
  ) return false;
  return entry.kind === "folder" || local.content === expectedFileContent;
}

export function folderEntryMatchesStructuralExpectation(
  entry: ManifestFileEntry | undefined,
  expected: PendingFolderMemberExpectation,
  expectedContentHash: string,
): boolean {
  return !!entry &&
    entry.kind === "folder" &&
    entry.latestNodeId === expected.nodeId &&
    entry.contentHash === expectedContentHash;
}

function pathTouchesSubtree(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`) || root.startsWith(`${path}/`);
}

export function structuralShieldJournal(
  shieldedPaths: readonly string[],
  sourcePath: string,
  targetPath: string | null,
  isFolder: boolean,
): {
  shieldedPathsBefore: string[];
  shieldedPathsDuring: string[];
  shieldedPathsAfter: string[];
} {
  const before = [...new Set(shieldedPaths)].sort();
  let inherited = false;
  const after = targetPath === null
    ? before.filter((path) =>
        path !== sourcePath && !(isFolder && path.startsWith(`${sourcePath}/`))
      )
    : before.map((path) => {
        if (path === sourcePath) return targetPath;
        if (isFolder && path.startsWith(`${sourcePath}/`)) {
          return targetPath + path.slice(sourcePath.length);
        }
        if (sourcePath.startsWith(`${path}/`)) inherited = true;
        return path;
      });
  if (targetPath !== null && inherited) after.push(targetPath);
  return {
    shieldedPathsBefore: before,
    // Until the durable path transition and journal clear land atomically,
    // exclude both coordinates so either crash projection remains private.
    shieldedPathsDuring: [...new Set([...before, ...after])].sort(),
    shieldedPathsAfter: [...new Set(after)].sort(),
  };
}

/** Replacing a recursive folder identity prunes the old clean projection, but
 * never at the cost of an unstepped file or a durable structural journal. */
export function localFolderReplacementIsSafe(
  local: LocalFolder | null,
  storagePath: string,
  pad: Readonly<Record<string, LocalFile>> | null = null,
): boolean {
  if (!local) return !pad || !Object.keys(pad).some((path) =>
    path === storagePath || path.startsWith(`${storagePath}/`)
  );
  if (Object.keys(local.pendingFolderSteps ?? {}).some((path) =>
    path === storagePath ||
    path.startsWith(`${storagePath}/`) ||
    storagePath.startsWith(`${path}/`)
  )) return false;
  const subtree = Object.entries(local.files).filter(([path]) =>
    path === storagePath || path.startsWith(`${storagePath}/`),
  );
  if (subtree.some(([, file]) =>
    (file.kind === "file" && !file.nodeId) ||
    file.pendingMove ||
    file.pendingEmptyGenesis ||
    file.pendingOperationId ||
    file.pendingReplyingTo ||
    file.pendingLocalOnly ||
    file.pendingForce ||
    file.pendingKedits ||
    file.kedits,
  )) return false;
  const sameBufferedVersion = (primary: LocalFile | undefined, buffered: LocalFile) =>
    !!primary &&
    primary.kind === buffered.kind &&
    primary.content === buffered.content &&
    primary.nodeId === buffered.nodeId &&
    primary.traceId === buffered.traceId &&
    JSON.stringify(primary.tags) === JSON.stringify(buffered.tags) &&
    JSON.stringify(primary.runs ?? []) === JSON.stringify(buffered.runs ?? []) &&
    JSON.stringify(primary.citationIds ?? []) === JSON.stringify(buffered.citationIds ?? []) &&
    JSON.stringify(primary.kedits ?? []) === JSON.stringify(buffered.kedits ?? []);
  if (Object.entries(pad ?? {}).some(([path, buffered]) =>
    (path === storagePath || path.startsWith(`${storagePath}/`)) &&
    !sameBufferedVersion(local.files[path], buffered)
  )) return false;
  return Object.values(local.pendingStructuralOperations ?? {}).every((operation) => {
    const paths = operation.kind === "delete"
      ? operation.affectedPaths
      : operation.kind === "move"
        ? operation.moves.flatMap((move) => [move.oldRel, move.newRel])
        : [operation.sourcePath];
    return paths.every((path) => !pathTouchesSubtree(path, storagePath));
  });
}

export interface LocalFolderIdentityDecision {
  replacement: boolean;
  metadataRepair: boolean;
}

export function extendFolderTraversal(
  activeAncestors: readonly string[],
  folderId: string,
): string[] {
  if (activeAncestors.includes(folderId)) {
    throw new Error(`recursive folder cycle reaches ${folderId}`);
  }
  return [...activeAncestors, folderId];
}

export const PULL_MAX_FOLDER_OCCURRENCES = 4_096;
export const PULL_MAX_FOLDER_DEPTH = 64;
export const PULL_MAX_MEMBERS = 32_768;
export const PULL_MAX_SIGNED_BYTES = 64 * 1024 * 1024;

export interface RecursivePullBudget {
  folderOccurrences: number;
  members: number;
  signedBytes: number;
}

export interface RecursivePullLimits {
  maxFolderOccurrences?: number;
  maxDepth?: number;
  maxMembers?: number;
  maxSignedBytes?: number;
}

/** Charge recursive attach work before the corresponding relay traversal or
 * local projection proceeds. The state mutates only when the whole charge is
 * admitted, making an overflow terminal and deterministic for that branch. */
export function consumeRecursivePullBudget(
  budget: RecursivePullBudget,
  charge: {
    folderOccurrences?: number;
    members?: number;
    signedBytes?: number;
    depth?: number;
  },
  limits: RecursivePullLimits = {},
): string | null {
  const nextFolders = budget.folderOccurrences + (charge.folderOccurrences ?? 0);
  const nextMembers = budget.members + (charge.members ?? 0);
  const nextBytes = budget.signedBytes + (charge.signedBytes ?? 0);
  const maxFolders = limits.maxFolderOccurrences ?? PULL_MAX_FOLDER_OCCURRENCES;
  const maxDepth = limits.maxDepth ?? PULL_MAX_FOLDER_DEPTH;
  const maxMembers = limits.maxMembers ?? PULL_MAX_MEMBERS;
  const maxBytes = limits.maxSignedBytes ?? PULL_MAX_SIGNED_BYTES;
  if ((charge.depth ?? 0) > maxDepth) {
    return `recursive folder depth ${charge.depth} exceeds ${maxDepth}`;
  }
  if (nextFolders > maxFolders) {
    return `recursive folder occurrences exceed ${maxFolders}`;
  }
  if (nextMembers > maxMembers) {
    return `recursive folder members exceed ${maxMembers}`;
  }
  if (nextBytes > maxBytes) {
    return `recursive folder signed bytes exceed ${maxBytes}`;
  }
  budget.folderOccurrences = nextFolders;
  budget.members = nextMembers;
  budget.signedBytes = nextBytes;
  return null;
}

/** Charge the complete signed wire representation of each immutable event at
 * most once per recursive pull. Repeated folder/file aliases reuse the same
 * verified history without either refetching it or hiding tag/signature bytes
 * from the aggregate ceiling. */
export function consumeUniqueRecursivePullSignedEvents(
  budget: RecursivePullBudget,
  chargedEventIds: Set<string>,
  events: readonly import("nostr-tools").Event[],
  limits: RecursivePullLimits = {},
): string | null {
  const newIds = new Set<string>();
  const newlyCharged = events.filter((event) => {
    if (chargedEventIds.has(event.id) || newIds.has(event.id)) return false;
    newIds.add(event.id);
    return true;
  });
  const error = consumeRecursivePullBudget(budget, {
    signedBytes: newlyCharged.reduce(
      (total, event) => total + traceSignedEventBytes(event),
      0,
    ),
  }, limits);
  if (error) return error;
  for (const event of newlyCharged) chargedEventIds.add(event.id);
  return null;
}

/** Distinguish an immutable folder-trace replacement from an ordinary head
 * advance. The signed cached node wins over stale local trace metadata. */
export function classifyLocalFolderIdentity(
  existing: LocalFile | undefined,
  remoteNodeId: string,
  remoteTraceId: string,
  cachedNodeTraceId: string | null,
): LocalFolderIdentityDecision {
  if (!existing) return { replacement: false, metadataRepair: false };
  if (existing.kind !== "folder") {
    return { replacement: true, metadataRepair: false };
  }
  const effectiveTraceId = existing.nodeId === remoteNodeId
    ? remoteTraceId
    : cachedNodeTraceId;
  return {
    replacement: effectiveTraceId !== null
      ? effectiveTraceId !== remoteTraceId
      : existing.nodeId !== remoteNodeId,
    metadataRepair: existing.traceId !== remoteTraceId,
  };
}

export interface RemoteAbsenceIndex {
  /** Every projected path in ordinal order, so one subtree is one contiguous
   * range that can be found without rescanning the workspace. */
  paths: readonly string[];
  directPathsByParent: ReadonlyMap<string, readonly string[]>;
  dirtyPaths: ReadonlySet<string>;
  sortedDirtyPaths: readonly string[];
}

/** Build the immutable path index shared by every verified folder snapshot in
 * one recursive pull. Construction reads the flattened workspace once. */
export function buildRemoteAbsenceIndex(
  local: LocalFolder | null,
  pad: Readonly<Record<string, LocalFile>> = {},
  pendingFolderPaths: readonly string[] = [],
): RemoteAbsenceIndex {
  const paths = Object.keys(local?.files ?? {}).sort();
  const directPathsByParent = new Map<string, string[]>();
  const dirtyPaths = new Set<string>([
    ...Object.keys(pad),
    ...pendingFolderPaths,
  ]);
  for (const path of paths) {
    const parent = dirname(path);
    const direct = directPathsByParent.get(parent) ?? [];
    direct.push(path);
    directPathsByParent.set(parent, direct);
    const file = local?.files[path];
    if (
      file?.pendingOperationId ||
      file?.pendingMove ||
      file?.pendingEmptyGenesis ||
      pad[path]
    ) dirtyPaths.add(path);
  }
  for (const direct of directPathsByParent.values()) {
    direct.sort((left, right) => left.localeCompare(right));
  }
  return {
    paths,
    directPathsByParent,
    dirtyPaths,
    sortedDirtyPaths: [...dirtyPaths].sort(),
  };
}

function ordinalLowerBound(paths: readonly string[], target: string): number {
  let low = 0;
  let high = paths.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((paths[middle] ?? "") < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function indexedSubtreePaths(
  index: RemoteAbsenceIndex,
  root: string,
): string[] {
  const start = ordinalLowerBound(index.paths, root);
  const paths: string[] = [];
  for (let cursor = start; cursor < index.paths.length; cursor++) {
    const path = index.paths[cursor]!;
    if (path !== root && !path.startsWith(`${root}/`)) break;
    paths.push(path);
  }
  return paths;
}

function indexedDirtyStateTouches(
  index: RemoteAbsenceIndex,
  root: string,
): boolean {
  if (index.dirtyPaths.has("")) return true;
  for (let ancestor = root; ancestor; ancestor = dirname(ancestor)) {
    if (index.dirtyPaths.has(ancestor)) return true;
  }
  const start = ordinalLowerBound(index.sortedDirtyPaths, root);
  const dirty = index.sortedDirtyPaths[start];
  return dirty === root || Boolean(dirty?.startsWith(`${root}/`));
}

export function planRemoteAbsenceReconciliation(
  local: LocalFolder | null,
  prefix: string,
  remoteRelativePaths: ReadonlySet<string>,
  pad: Readonly<Record<string, LocalFile>> = {},
  pendingFolderPaths: readonly string[] = [],
  index: RemoteAbsenceIndex = buildRemoteAbsenceIndex(local, pad, pendingFolderPaths),
): { deletions: string[]; conflicts: string[] } {
  const deletions = new Set<string>();
  const conflicts: string[] = [];
  const directLocalPaths = [...(index.directPathsByParent.get(prefix) ?? [])]
    .filter((path) => !isMintPath(path) && !isScanPath(path) && !isOblivionPath(path))
    .filter((path) => !remoteRelativePaths.has(basename(path)))
    .sort((left, right) => left.localeCompare(right));
  for (const localPath of directLocalPaths) {
    const localMember = local?.files[localPath];
    if (!localMember) continue;
    const affected = localMember.kind === "folder"
      ? indexedSubtreePaths(index, localPath)
      : [localPath];
    const hasPendingState = indexedDirtyStateTouches(index, localPath);
    if (hasPendingState) {
      conflicts.push(localPath);
      continue;
    }
    for (const path of affected) deletions.add(path);
  }
  return {
    deletions: [...deletions].sort(
      (left, right) => right.split("/").length - left.split("/").length,
    ),
    conflicts,
  };
}

/**
 * Fetch the relay manifest + chains for the attached folder and reconcile each
 * remote entry against local. Called on attach (non-blocking). Mutates
 * localStorage directly for fast-forwards only; clean merges are staged and
 * left for the caller to surface.
 *
 * Reconciliation is a 3-way merge keyed on the chain's common ancestor:
 *   noop / fastforward / clean (staged) / conflict (untouched). See the module
 * header. The 5-second "recent local draft" guard from `isLocalNewer` still
 * defers any pull decision for a file mid-edit.
 */
async function pullFromRelayUnlocked(
  folderId: string,
  options: { strict?: boolean } = {},
): Promise<PullResult> {
  const result: PullResult = {
    rootId: folderId,
    updated: new Set<string>(),
    staged: [],
    conflicts: new Set<string>(),
  };
  const manifestByHead = new Map<string, ManifestFileEntry[]>();
  const remoteRelativePathsByPrefix = new Map<string, ReadonlySet<string>>();
  const traversalBudget: RecursivePullBudget = {
    folderOccurrences: 0,
    members: 0,
    signedBytes: 0,
  };
  const chargedSignedEventIds = new Set<string>();
  const folderNodesByTrace = new Map<
    string,
    Promise<import("nostr-tools").Event[]>
  >();
  const folderIdentityByHead = new Map<string, Promise<string | null>>();
  const traceEventById = new Map<
    string,
    Promise<import("nostr-tools").Event | null>
  >();
  const fileResolutionByHead = new Map<
    string,
    Promise<Awaited<ReturnType<typeof resolveTraceChainAtHead>> | null>
  >();

  const chargeSignedEvents = (events: readonly import("nostr-tools").Event[]) => {
    const error = consumeUniqueRecursivePullSignedEvents(
      traversalBudget,
      chargedSignedEventIds,
      events,
    );
    if (error) throw new Error(error);
  };
  const loadPullFolderNodes = (
    traceId: string,
  ): Promise<import("nostr-tools").Event[]> => {
    const existing = folderNodesByTrace.get(traceId);
    if (existing) return existing;
    const loaded = fetchFolderNodes(traceId).then((events) => {
      chargeSignedEvents(events);
      return events;
    });
    folderNodesByTrace.set(traceId, loaded);
    return loaded;
  };
  const latestPullFolderNode = async (
    traceId: string,
  ): Promise<import("nostr-tools").Event | null> => {
    const heads = listUncitedHeads([...(await loadPullFolderNodes(traceId))]);
    if (heads.length > 1) {
      throw new Error(`folder trace ${traceId} has ${heads.length} current heads`);
    }
    return heads[0] ?? null;
  };
  const resolvePullFolderIdentity = (
    head: import("nostr-tools").Event | null,
  ): Promise<string | null> => {
    if (!head) return Promise.resolve(null);
    const existing = folderIdentityByHead.get(head.id);
    if (existing) return existing;
    const resolved = resolveVerifiedFolderTraceIdentityAtHead(
      head,
      loadPullFolderNodes,
    );
    folderIdentityByHead.set(head.id, resolved);
    return resolved;
  };
  const loadPullTraceEvents = async (
    ids: readonly string[],
  ): Promise<import("nostr-tools").Event[]> => {
    const events = await Promise.all(ids.map((id) => {
      const existing = traceEventById.get(id);
      if (existing) return existing;
      const loaded = fetchEventById(id);
      traceEventById.set(id, loaded);
      return loaded;
    }));
    const present = events.filter(
      (event): event is import("nostr-tools").Event => event !== null,
    );
    chargeSignedEvents(present);
    return present;
  };
  const resolvePullFileChain = (
    headId: string,
  ): Promise<Awaited<ReturnType<typeof resolveTraceChainAtHead>> | null> => {
    const existing = fileResolutionByHead.get(headId);
    if (existing) return existing;
    const resolved = (async () => {
      const traceId = await resolveTraceIdentity(headId, loadPullTraceEvents);
      return traceId
        ? resolveTraceChainAtHead(traceId, headId, loadPullTraceEvents)
        : null;
    })();
    fileResolutionByHead.set(headId, resolved);
    return resolved;
  };
  let observedRootHeadId: string | null = null;
  let projectionMatchesRoot = true;
  async function pullFolder(
    currentFolderId: string,
    prefix: string,
    pinnedHead: import("nostr-tools").Event | null = null,
    activeAncestors: readonly string[] = [],
  ): Promise<void> {
    const budgetError = consumeRecursivePullBudget(traversalBudget, {
      folderOccurrences: 1,
      depth: activeAncestors.length,
    });
    if (budgetError) {
      projectionMatchesRoot = false;
      if (prefix) result.conflicts.add(prefix);
      if (options.strict) throw new Error(budgetError);
      return;
    }
    let active: string[];
    try {
      active = extendFolderTraversal(activeAncestors, currentFolderId);
    } catch (error) {
      projectionMatchesRoot = false;
      if (prefix) result.conflicts.add(prefix);
      if (options.strict) throw error;
      return;
    }
    let manifest: ManifestFileEntry[];
    try {
      const folderHead = pinnedHead ?? await latestPullFolderNode(currentFolderId);
      if (!folderHead) return;
      const verifiedId = await resolvePullFolderIdentity(folderHead);
      if (verifiedId !== currentFolderId) {
        throw new Error(`cannot verify folder head ${folderHead.id} for ${currentFolderId}`);
      }
      manifest = manifestByHead.get(folderHead.id) ?? membersFromNode(folderHead);
      const folderBudgetError = consumeRecursivePullBudget(traversalBudget, {
        members: manifest.length,
      });
      if (folderBudgetError) throw new Error(folderBudgetError);
      manifestByHead.set(folderHead.id, manifest);
      remoteRelativePathsByPrefix.set(
        prefix,
        new Set(manifest.map((entry) => entry.relativePath)),
      );
      if (prefix === "") observedRootHeadId = folderHead.id;
    } catch (error) {
      if (options.strict) throw error;
      projectionMatchesRoot = false;
      if (prefix) result.conflicts.add(prefix);
      return;
    }

    for (const entry of manifest) {
      const storagePath = prefix
        ? `${prefix}/${entry.relativePath}`
        : entry.relativePath;
      if (entry.kind === "folder") {
        const folderNode = await fetchEventById(entry.latestNodeId);
        const traceId = await resolvePullFolderIdentity(folderNode);
        if (!folderNode || !traceId || signedNodeContentHash(folderNode) !== entry.contentHash) {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          if (options.strict) {
            throw new Error(`cannot verify pinned folder identity at ${entry.latestNodeId}`);
          }
          continue;
        }
        if (active.includes(traceId)) {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          if (options.strict) {
            throw new Error(`recursive folder cycle reaches ${traceId} at ${storagePath}`);
          }
          continue;
        }
        const beforeCacheRead = loadLocalFolder(folderId);
        const existingBeforeCacheRead = beforeCacheRead?.files[storagePath];
        const cachedNode = existingBeforeCacheRead?.kind === "folder" && existingBeforeCacheRead.nodeId
          ? existingBeforeCacheRead.nodeId === entry.latestNodeId
            ? folderNode
            : await fetchEventById(existingBeforeCacheRead.nodeId)
          : null;
        const cachedTraceId = cachedNode
          ? await resolvePullFolderIdentity(cachedNode)
          : null;
        // Re-read after relay I/O. This snapshot is used only until the next
        // await, and the whole pull holds the Root mutation lane.
        const local = loadLocalFolder(folderId);
        const existing = local?.files[storagePath];
        const identity = classifyLocalFolderIdentity(
          existing,
          entry.latestNodeId,
          traceId,
          cachedTraceId,
        );
        if (
          identity.replacement &&
          !localFolderReplacementIsSafe(local, storagePath, loadPad(folderId))
        ) {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          if (options.strict) {
            throw new Error(`cannot replace locally modified folder identity at ${storagePath}`);
          }
          continue;
        }
        if (identity.replacement) {
          const oldPaths = Object.keys(local?.files ?? {})
            .filter((path) => path === storagePath || path.startsWith(`${storagePath}/`))
            .sort((left, right) => right.split("/").length - left.split("/").length);
          for (const oldPath of oldPaths) {
            deleteLocalFileDurably(folderId, oldPath);
            result.updated.add(oldPath);
          }
        }
        const localFolderIsNewer = isLocalNewer(local, entry, storagePath);
        const exactFolderProjection = localManifestProjectionMatches(existing, entry);
        if (
          identity.replacement ||
          identity.metadataRepair ||
          !localFolderIsNewer
        ) {
          saveLocalFileDurably("pulled folder", folderId, storagePath, {
            kind: "folder",
            content: "",
            tags: [],
            nodeId: entry.latestNodeId,
            traceId,
          });
          result.updated.add(storagePath);
        } else if (!exactFolderProjection) {
          projectionMatchesRoot = false;
        }
        await pullFolder(traceId, storagePath, folderNode, active);
        continue;
      }

      // Remote may have moved (or local doesn't have it) → pull + decide.
      try {
        const resolution = await resolvePullFileChain(entry.latestNodeId);
        if (resolution?.status !== "resolved") {
          throw new Error(`cannot resolve pinned file trace at ${entry.latestNodeId}`);
        }
        const chain = resolution.chain;
        const head = chain[chain.length - 1] ?? null;
        if (
          !head ||
          head.id !== entry.latestNodeId ||
          signedNodeContentHash(head) !== entry.contentHash
        ) {
          throw new Error(`file membership hash does not match ${entry.latestNodeId}`);
        }
        const conformance = await verifyFileTraceChain(chain, {
          expectedNucleusId: entry.latestNodeId,
          expectedTraceId: resolution.traceId,
        });
        if (conformance.status === "invalid") {
          throw new Error(
            `file membership pin ${entry.latestNodeId} is invalid: ${
              conformance.issues[0]?.message ?? "nonconforming chain"
            }`,
          );
        }
        const content = reconstructFromChain(chain);
        const remoteHeadId = head.id;
        // Pull is serialized, but load only after remote I/O so replacement and
        // merge decisions never rely on the attach-time snapshot.
        const local = loadLocalFolder(folderId);
        const existing = local?.files[storagePath];
        const padBeforeDecision = loadPad(folderId)?.[storagePath];
        const replacingFolder = existing?.kind === "folder";
        if (
          replacingFolder &&
          !localFolderReplacementIsSafe(local, storagePath, loadPad(folderId))
        ) {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          if (options.strict) {
            throw new Error(`cannot replace locally modified folder with file at ${storagePath}`);
          }
          continue;
        }
        const padDraft = replacingFolder
          ? undefined
          : crashPadDraftForPull(existing, padBeforeDecision);
        const exactFileProjection = localManifestProjectionMatches(
          existing,
          entry,
          content,
        );
        if (
          !replacingFolder &&
          !padDraft &&
          isLocalNewer(local, entry, storagePath) &&
          !exactFileProjection
        ) {
          projectionMatchesRoot = false;
          continue;
        }
        const lf = replacingFolder ? undefined : padDraft ?? existing;
        const localContent = lf?.content ?? "";

        // Decide how to reconcile against local. base = the snapshot at local's
        // nodeId on the fetched chain (the common ancestor), if present; else
        // empty (independent roots → diff3 will flag a conflict, which is safe).
        const base = ancestorSnapshot(chain, lf?.nodeId);
        const localHeadIsOnRemoteChain = !!lf?.nodeId &&
          chain.some((event) => event.id === lf.nodeId);
        const decision = !lf
          ? { outcome: "fastforward" as const }
          : !localHeadIsOnRemoteChain && localContent !== content
            ? { outcome: "conflict" as const }
            : decidePullMerge(base, localContent, content);

        if (decision.outcome === "noop") {
          if (
            sameBodyDescendantCanFastForward(
              chain,
              lf?.nodeId,
              remoteHeadId,
              Boolean(padDraft),
            )
          ) {
            const current = loadLocalFolder(folderId)?.files[storagePath];
            const currentPad = loadPad(folderId)?.[storagePath];
            if (
              !sameLocalFileVersion(existing, current) ||
              !sameLocalFileVersion(padBeforeDecision, currentPad)
            ) {
              result.conflicts.add(storagePath);
              projectionMatchesRoot = false;
              continue;
            }
            // Identical body does not mean identical provenance. Metadata-only
            // and explicit-checkpoint descendants still advance tags, runs,
            // citations, and the immutable head represented by the projection.
            applyFastForward(
              folderId,
              storagePath,
              chain,
              content,
              head,
              remoteHeadId,
            );
            result.updated.add(storagePath);
            continue;
          }
          if (padDraft) result.conflicts.add(storagePath);
          if (lf?.nodeId !== remoteHeadId) projectionMatchesRoot = false;
          continue;
        }
        if (decision.outcome === "conflict") {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          continue;
        }
        if (decision.outcome === "clean") {
          projectionMatchesRoot = false;
          result.staged.push({
            path: storagePath,
            base,
            ours: localContent,
            theirs: content,
            merged: decision.merged!,
            localNodeId: lf?.nodeId ?? "",
            remoteHeadId,
            remoteOwnerPubkey: head.pubkey,
          });
          continue;
        }

        const current = loadLocalFolder(folderId)?.files[storagePath];
        const currentPad = loadPad(folderId)?.[storagePath];
        if (
          !sameLocalFileVersion(existing, current) ||
          !sameLocalFileVersion(padBeforeDecision, currentPad) ||
          padDraft
        ) {
          result.conflicts.add(storagePath);
          projectionMatchesRoot = false;
          continue;
        }
        if (replacingFolder) {
          const oldPaths = Object.keys(local?.files ?? {})
            .filter((path) => path === storagePath || path.startsWith(`${storagePath}/`))
            .sort((left, right) => right.split("/").length - left.split("/").length);
          for (const oldPath of oldPaths) {
            deleteLocalFileDurably(folderId, oldPath);
            result.updated.add(oldPath);
          }
        }
        applyFastForward(
          folderId,
          storagePath,
          chain,
          content,
          head,
          remoteHeadId,
        );
        result.updated.add(storagePath);
      } catch (error) {
        if (options.strict) throw error;
        result.conflicts.add(storagePath);
        projectionMatchesRoot = false;
      }
    }

  }

  await pullFolder(folderId, "");
  // Every successfully verified recursive snapshot is authoritative for its
  // direct membership, including absence. Reconcile them together from one
  // final local snapshot and one shared index, then persist all clean removals
  // in a single storage transaction. Dirty/pending subtrees remain conflicts
  // and deliberately prevent Root-head advancement.
  const localAfterTraversal = loadLocalFolder(folderId);
  const padAfterTraversal = loadPad(folderId) ?? {};
  const pendingFolderPaths = pendingFolderStepOperations(folderId)
    .map((operation) => operation.relativePath);
  const absenceIndex = buildRemoteAbsenceIndex(
    localAfterTraversal,
    padAfterTraversal,
    pendingFolderPaths,
  );
  const absenceDeletions = new Set<string>();
  const absenceConflicts = new Set<string>();
  for (const [prefix, remoteRelativePaths] of remoteRelativePathsByPrefix) {
    const absence = planRemoteAbsenceReconciliation(
      localAfterTraversal,
      prefix,
      remoteRelativePaths,
      padAfterTraversal,
      pendingFolderPaths,
      absenceIndex,
    );
    for (const conflict of absence.conflicts) {
      absenceConflicts.add(conflict);
      result.conflicts.add(conflict);
      projectionMatchesRoot = false;
    }
    for (const path of absence.deletions) absenceDeletions.add(path);
  }
  if (options.strict && absenceConflicts.size > 0) {
    throw new Error(
      `remote removal conflicts with local work at ${[...absenceConflicts].sort()[0]}`,
    );
  }
  const orderedAbsenceDeletions = [...absenceDeletions].sort(
    (left, right) => right.split("/").length - left.split("/").length,
  );
  deleteLocalFilesDurably(folderId, orderedAbsenceDeletions);
  for (const path of orderedAbsenceDeletions) result.updated.add(path);
  if (
    observedRootHeadId &&
    projectionMatchesRoot &&
    result.conflicts.size === 0 &&
    result.staged.length === 0 &&
    !saveLocalFolderHead(folderId, observedRootHeadId)
  ) {
    throw new Error(`cannot persist pulled Root head ${observedRootHeadId}`);
  }
  return result;
}

/** Pull participates in the same Root lane as writes and structural recovery.
 * This prevents relay waits from racing a local edit or replacement decision. */
export function pullFromRelay(
  folderId: string,
  options: { strict?: boolean } = {},
): Promise<PullResult> {
  return runRootMutationSerialized(
    workspaceRootMutationRuns,
    folderId,
    createTraceOperationId(),
    () => pullFromRelayUnlocked(folderId, options),
  );
}

/** Snapshot at `localNodeId` on the chain, or "" if the node isn't on it
 *  (true fork / multi-device split — caller falls back to best-effort). */
function ancestorSnapshot(chain: import("nostr-tools").Event[], localNodeId: string | undefined): string {
  if (!localNodeId || localNodeId === "" || chain.length === 0) return "";
  const idx = chain.findIndex((e) => e.id === localNodeId);
  if (idx === -1) return "";
  // Nodes are self-sufficient (spec §3.1): reconstructing the prefix up to the
  // ancestor yields its snapshot. (Slice copies; reconstructFromChain reads it.)
  return reconstructFromChain(chain.slice(0, idx + 1));
}

function sameLocalFileVersion(
  left: LocalFile | undefined,
  right: LocalFile | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Apply a fast-forward: overwrite local with the remote tip, reconstructing
 *  tags / runs / tagged-traces exactly as the pre-merge pull did. */
function applyFastForward(
  folderId: string,
  relativePath: string,
  chain: import("nostr-tools").Event[],
  content: string,
  head: import("nostr-tools").Event | null,
  remoteHeadId: string,
): void {
  const tags = headUserTags(chain);
  const citationIds = headCitationIds(
    chain,
    findResolvedBrackets(content).map((b) => b.nodeId),
  );
  const runs = chain.length > 0 ? reconstructRunsFromChain(chain) : [];
  saveLocalFileDurably("pulled file", folderId, relativePath, {
    kind: "file",
    content,
    tags,
    nodeId: head?.id ?? remoteHeadId,
    ...(chain[0]?.id ? { traceId: chain[0].id } : {}),
    ...(runs.length > 0 ? { runs } : {}),
    ...(citationIds.length > 0 ? { citationIds } : {}),
  });
}

/** True if the local copy is newer than (or equal to) the relay entry. */
function isLocalNewer(
  local: { files: Record<string, LocalFile> } | null,
  entry: ManifestFileEntry,
  storagePath = entry.relativePath,
): boolean {
  if (!local) return false;
  const lf = local.files[storagePath];
  if (!lf) return false;
  if (
    lf.pendingOperationId ||
    lf.pendingMove ||
    lf.pendingEmptyGenesis
  ) return true;
  const sameHead = lf.nodeId !== "" && lf.nodeId === entry.latestNodeId;
  const recentLocal = Date.now() - lf.updatedAt < 5000;
  return sameHead || recentLocal;
}
