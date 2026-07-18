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
  fetchFolderOwner,
  fetchManifest,
  fetchNodeOwner,
  forkFileFromNode,
  eventMeta,
  headUserTags,
  headCitationIds,
  operationIdFromNode,
  publishEdit,
  requireAcceptedCurrentFolderCheckpoint,
  resolveTraceChain,
  resolveTraceIdentity,
  reconstructFromChain,
  reconstructRunsFromChain,
  removeManifestEntry,
  renameManifestEntry,
  stepFolderManifest,
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
  deleteLocalFile,
  loadLocalFolder,
  loadLocalFolderTags,
  moveLocalFile,
  rememberLocalFolder,
  saveLocalFile,
  saveLocalFolderTags,
  type LocalFile,
} from "./local-store.js";
import { isOblivionPath } from "./generated-paths.js";

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

function folderNodeContentHash(event: import("nostr-tools").Event): string {
  try {
    const parsed = JSON.parse(event.content) as { contentHash?: unknown };
    if (typeof parsed.contentHash === "string" && /^[0-9a-f]{64}$/.test(parsed.contentHash)) {
      return parsed.contentHash;
    }
  } catch {
    // Fall through to the invariant error below.
  }
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
function localToFiles(
  local: {
    files: Record<string, {
      kind: "file" | "folder";
      content: string;
      tags: string[];
      nodeId: string;
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

function rememberLocalTreeFolderHead(
  tree: LocalFolderTree,
  folderPath: string,
  folderId: string,
  head: import("nostr-tools").Event,
): void {
  if (folderPath === tree.storagePath) return;
  const existing = loadLocalFolder(tree.storageRootId)?.files[folderPath];
  saveLocalFile(tree.storageRootId, folderPath, {
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
  const operationId = operationIdFromNode(changedHead);
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
      { localOnly, operationId },
    );
    if (verifyAcceptedOperation) {
      head = await requireAcceptedCurrentFolderCheckpoint(
        parentId,
        head,
        getPublicKey(parentSigner),
      );
    }
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
      const local = loadLocalFolder(tree.storageRootId)?.files[nextPath];
      const traceId = folderTraceIdentityFromNode(
        await fetchEventById(existing.latestNodeId),
      ) ?? (local?.kind === "folder" ? local.traceId ?? null : null);
      if (!traceId) {
        throw new Error(`cannot resolve folder identity for ${nextPath}`);
      }
      saveLocalFile(tree.storageRootId, nextPath, {
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
    saveLocalFile(tree.storageRootId, nextPath, {
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
  opts?: { localOnly?: boolean },
): Promise<import("nostr-tools").Event> {
  await ensureLocalTreeFolderPath(tree, dirname(storagePath), signer, opts);
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
      operationId: createTraceOperationId(),
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
      operationId: operationIdFromNode(event),
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
  const PUSH_DEBOUNCE_MS = 1200;

  /** Schedule a background relay push for a file (debounced). Never throws —
   *  relay failures are non-fatal; the local write already succeeded. */
  function schedulePush(
    relativePath: string,
    onPublished?: (path: string, file: FileState | null) => void,
  ): void {
    const id = requireId();
    const existing = pushTimers.get(relativePath);
    if (existing) clearTimeout(existing);
    pushTimers.set(
      relativePath,
      setTimeout(() => {
        pushTimers.delete(relativePath);
        void completeBackgroundPush(
          () => pushToRelay(id, relativePath),
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
          if ((pendingFile?.pendingMove || pendingFile?.pendingEmptyGenesis) && ref?.id === id) {
            setTimeout(() => {
              if (ref?.id === id) schedulePush(relativePath, onPublished);
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
      saveLocalFile(rootId, storagePath, {
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

    if (file.pendingMove?.kind === "to-oblivion") {
      const fromPath = file.pendingMove.fromPath;
      const source = localFolderCoordinate(rootId, fromPath);
      const manifest = await fetchManifest(source.folderId);
      const entry = manifest.find(
        (candidate) => candidate.relativePath === source.relativePath,
      );
      // A missing membership can mean either "the prior move to Oblivion already
      // landed" or merely "the relay observation is empty/offline". Clear the
      // durable journal only after the signed trace head proves action:delete;
      // otherwise throw so attach/debounce retries instead of silently leaving
      // the source socially active.
      if (!entry) {
        const traceId =
          file.traceId ?? (file.nodeId ? await resolveTraceIdentity(file.nodeId) : null);
        const resolution = traceId ? await resolveTraceChain(traceId) : null;
        const head = resolution?.status === "resolved"
          ? resolution.chain[resolution.chain.length - 1]
          : undefined;
        if (!head || eventMeta(head).action !== "delete") {
          throw new Error(`move to Oblivion from ${fromPath} is not yet verifiable`);
        }
        saveLocalFile(rootId, storagePath, {
          content,
          tags: file.tags,
          nodeId: head.id,
          traceId: traceId ?? head.id,
          voicePubkey: file.voicePubkey,
          citationIds: file.citationIds,
          ...(file.runs && file.runs.length > 0 ? { runs: file.runs } : {}),
        });
        return file.nodeId;
      }
      const traceId =
        file.traceId ??
        (file.nodeId ? await resolveTraceIdentity(file.nodeId) : null) ??
        (await resolveTraceIdentity(entry.latestNodeId));
      const signer = resolveFileSigner(file.voicePubkey);
      if (!signer) throw new Error(`cannot resolve a local signer for ${fromPath}`);
      const folderOwner = await fetchFolderOwner(source.folderId);
      const folderSigner = folderWriteSigner(folderOwner, signer);
      if (!folderSigner) {
        throw new Error(`cannot write through foreign folder ${source.folderId}; fork the folder first`);
      }
      const priorEvent = await fetchEventById(entry.latestNodeId);
      if (!priorEvent) {
        throw new Error(`cannot fetch the current source Step ${entry.latestNodeId}`);
      }
      const priorParsed = JSON.parse(priorEvent.content) as { snapshot?: unknown };
      if (typeof priorParsed.snapshot !== "string") {
        throw new Error(`source Step ${entry.latestNodeId} has no text snapshot`);
      }
      const event = await publishEdit({
        prevEventId: entry.latestNodeId,
        previousSnapshot: priorParsed.snapshot,
        ...(traceId ? { traceId } : {}),
        relativePath: source.relativePath,
        folderId: source.folderId,
        deltas: [],
        snapshot: "",
        contentHash: await sha256Hex(""),
        action: "delete",
        operationId,
        signer,
        kedits: synthesizeKEditTransition(
          priorParsed.snapshot,
          "",
          getPublicKey(signer),
        ),
      });
      const sourceHead = await removeManifestEntry(
        source.folderId,
        source.relativePath,
        folderSigner,
        { localOnly: file.pendingLocalOnly, operationId },
      );
      if (sourceHead) {
        await propagateFolderHead(
          rootId,
          source.folderPath,
          source.folderId,
          sourceHead,
          folderSigner,
          file.pendingLocalOnly,
        );
      }
      saveLocalFile(rootId, storagePath, {
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
        });
      },
      (genesis) => {
        saveLocalFile(rootId, storagePath, {
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
    // A forced checkpoint (explicit Step gesture) appends a node even when
    // nothing changed — the deliberate rhythm path (§8). The non-forced path keeps the
    // no-op collapse so the trailing debounce after an edit doesn't re-publish.
    if (entry && !file.pendingMove && entry.contentHash === contentHash && tagsUnchanged && citationsUnchanged && !file.pendingForce) {
      // A crash can land the body Step + manifest before the final local save.
      // Adopt that head and clear only the bootstrap marker so attach does not
      // keep retrying an already-complete two-node starter.
      saveLocalFile(rootId, storagePath, {
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

    // Resolve the voice that authored this edit to its secret key, so the file
    // Step signs as that voice. Folder membership is a separate chain: keep it
    // under the folder's original locally-held owner even when the file Step
    // uses another voice.
    const signer = resolveFileSigner(file.voicePubkey);
    if (!signer) throw new Error(`cannot resolve a local signer for ${relativePath}`);
    const signerPubkey = getPublicKey(signer);
    const folderOwner = await fetchFolderOwner(folderId);
    const folderSigner = folderWriteSigner(folderOwner, signer);
    if (!folderSigner) {
      throw new Error(`cannot write through foreign folder ${folderId}; fork the folder first`);
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
      saveLocalFile(rootId, storagePath, {
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
      if (disposition === "foreign") {
        const fork = await forkFileFromNode(
          entry.latestNodeId,
          folderId,
          relativePath,
          { signer, localOnly: file.pendingLocalOnly, operationId },
        );
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
        prevId = fork.id;
        traceId = fork.id;
        chain = [fork];
        prevContent = reconstructFromChain(chain);
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
    const event = await publishEdit({
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
    });
    if (moveSource && fromEntry && moveSource.folderId === folderId) {
      const folderHead = await renameManifestEntry(
        folderId,
        moveSource.relativePath,
        relativePath,
        event.id,
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
    } else {
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
          { localOnly: file.pendingLocalOnly, operationId },
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
    }
    // Reflect the stepped node id back into local state so the next push's
    // prevId is correct. Preserve voicePubkey so re-pushes stay correctly signed,
    // and runs so the local record keeps the per-char attribution it just stepped
    // (avoids a needless reload-from-chain on next open). `pendingReplyingTo`,
    // `pendingKedits`, `pendingLocalOnly`, and `pendingForce` are deliberately
    // NOT carried: all four are one-shot, consumed by this push.
    // `citationIds` IS carried — tags are persistent across steps.
    saveLocalFile(rootId, storagePath, {
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

  /** Flush one explicitly-staged gesture now. Background retry remains armed
   *  on failure, but callers only observe completion after provenance is
   *  durable, which gives live replay a reliable refresh boundary. */
  async function flushStagedFile(relativePath: string): Promise<string> {
    const timer = pushTimers.get(relativePath);
    if (timer) {
      clearTimeout(timer);
      pushTimers.delete(relativePath);
    }
    return completeStagedWrite(
      () => pushToRelay(requireId(), relativePath),
      () => schedulePush(relativePath),
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
    if (!entry) return;
    const localFile = loadLocalFolder(rootId)?.files[storagePath];
    const signer = resolveFileSigner(localFile?.voicePubkey);
    if (!signer) throw new Error(`cannot resolve a local signer for ${storagePath}`);
    const folderOwner = await fetchFolderOwner(coordinate.folderId);
    const folderSigner = folderWriteSigner(folderOwner, signer);
    if (!folderSigner) {
      throw new Error(`cannot delete through foreign folder ${coordinate.folderId}`);
    }
    const traceId = await resolveTraceIdentity(entry.latestNodeId);
    const priorEvent = await fetchEventById(entry.latestNodeId);
    if (!priorEvent) throw new Error(`cannot fetch the current Step ${entry.latestNodeId}`);
    const priorParsed = JSON.parse(priorEvent.content) as { snapshot?: unknown };
    if (typeof priorParsed.snapshot !== "string") {
      throw new Error(`current Step ${entry.latestNodeId} has no text snapshot`);
    }
    await publishEdit({
      prevEventId: entry.latestNodeId,
      previousSnapshot: priorParsed.snapshot,
      ...(traceId ? { traceId } : {}),
      relativePath: coordinate.relativePath,
      folderId: coordinate.folderId,
      deltas: [],
      snapshot: "",
      contentHash: await sha256Hex(""),
      action: "delete",
      operationId,
      signer,
      kedits: synthesizeKEditTransition(
        priorParsed.snapshot,
        "",
        getPublicKey(signer),
      ),
    });
    const folderHead = await removeManifestEntry(
      coordinate.folderId,
      coordinate.relativePath,
      folderSigner,
      { operationId },
    );
    if (folderHead) {
      await propagateFolderHead(
        rootId,
        coordinate.folderPath,
        coordinate.folderId,
        folderHead,
        folderSigner,
      );
    }
  }

  async function removeStagedFolder(
    rootId: string,
    storagePath: string,
    operationId: string,
  ): Promise<void> {
    const coordinate = localFolderCoordinate(rootId, storagePath);
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
      { operationId },
    );
    if (folderHead) {
      await propagateFolderHead(
        rootId,
        coordinate.folderPath,
        coordinate.folderId,
        folderHead,
        folderSigner,
      );
    }
  }

  async function moveStagedFolder(
    rootId: string,
    sourcePath: string,
    targetPath: string,
    operationId: string,
  ): Promise<void> {
    const source = localFolderCoordinate(rootId, sourcePath);
    const target = localFolderCoordinate(rootId, targetPath);
    const sourceManifest = await fetchManifest(source.folderId);
    const sourceEntry = sourceManifest.find(
      (entry) => entry.kind === "folder" && entry.relativePath === source.relativePath,
    );
    if (!sourceEntry) throw new Error(`cannot find folder membership for ${sourcePath}`);

    const signer = resolveFileSigner(authorVoice());
    if (!signer) throw new Error(`cannot resolve a local signer for ${sourcePath}`);
    const targetSigner = folderWriteSigner(
      await fetchFolderOwner(target.folderId),
      signer,
    );
    if (!targetSigner) throw new Error(`cannot write through foreign folder ${target.folderId}`);

    if (source.folderId === target.folderId) {
      const parentHead = await renameManifestEntry(
        target.folderId,
        source.relativePath,
        target.relativePath,
        sourceEntry.latestNodeId,
        targetSigner,
        { operationId },
      );
      await propagateFolderHead(
        rootId,
        target.folderPath,
        target.folderId,
        parentHead,
        targetSigner,
      );
      return;
    }

    const targetHead = await upsertManifestEntry(
      target.folderId,
      { ...sourceEntry, relativePath: target.relativePath },
      targetSigner,
      { operationId },
    );
    await propagateFolderHead(
      rootId,
      target.folderPath,
      target.folderId,
      targetHead,
      targetSigner,
    );

    const sourceSigner = folderWriteSigner(
      await fetchFolderOwner(source.folderId),
      signer,
    );
    if (!sourceSigner) throw new Error(`cannot write through foreign folder ${source.folderId}`);
    const sourceHead = await removeManifestEntry(
      source.folderId,
      source.relativePath,
      sourceSigner,
      { operationId },
    );
    if (sourceHead) {
      await propagateFolderHead(
        rootId,
        source.folderPath,
        source.folderId,
        sourceHead,
        sourceSigner,
      );
    }
  }

  async function attachStagedFolder(
    rootId: string,
    targetPath: string,
    folder: LocalFile,
    operationId: string,
  ): Promise<void> {
    const target = localFolderCoordinate(rootId, targetPath);
    const head = await fetchEventById(folder.nodeId);
    if (!head) throw new Error(`cannot fetch folder nucleus ${folder.nodeId}`);
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
      { operationId },
    );
    await propagateFolderHead(
      rootId,
      target.folderPath,
      target.folderId,
      parentHead,
      parentSigner,
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
      let local = loadLocalFolder(ref.id);
      let files = local ? localToFiles(local) : {};
      for (const [path, file] of Object.entries(local?.files ?? {})) {
        // Resume interrupted structural moves and first-time files that were
        // stored locally before their genesis reached the relay (including a
        // newly loaded onboarding demo).
        if (
          file.pendingMove ||
          file.pendingEmptyGenesis ||
          (file.kind !== "folder" && !file.nodeId)
        ) {
          schedulePush(path, onReconciled);
        }
      }
      if (options.requireRelayOnAttach) {
        await pullFromRelay(ref.id, { strict: true });
        local = loadLocalFolder(ref.id);
        files = local ? localToFiles(local) : {};
        return { files, reconciled: Promise.resolve() };
      }
      // The GUI remains local-first and renders immediately, but expose the
      // real synchronization barrier to callers that choose to observe it.
      const reconciled = pullFromRelay(ref.id).then(() => undefined);
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
      // Capture the voice (by pubkey) that authored this edit, so the debounced
      // relay push signs with the correct key — not just the AUTHOR default.
      // This closes the per-voice signer gap that previously affected Send/zine
      // and that fork-on-write needs. The pubkey is persisted (never the
      // secret); pushToRelay resolves it to bytes via keys-store at push time.
      // A missing signer uses the current AUTHOR voice.
      const voicePubkey = signer ? getPublicKey(signer) : authorVoice();
      const id = requireId();
      // 1. Local write — synchronous, instant, survives reload/offline.
      const local = loadLocalFolder(id);
      const existing = local?.files[relativePath];
      const prevNodeId = existing?.nodeId ?? "";
      const operationId = requestedOperationId ?? existing?.pendingOperationId ?? createTraceOperationId();
      saveLocalFile(id, relativePath, {
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
      // 2. An explicit write is a completed Step. The old implementation
      // returned prevNodeId and queued the publish, which made Step/Send point
      // at stale history. Retain local-first durability by scheduling a retry
      // if the synchronous relay barrier fails, but surface that failure now.
      return flushStagedFile(relativePath);
    },

    async flushFile(relativePath: string): Promise<string> {
      return flushStagedFile(relativePath);
    },

    async createFile(relativePath: string): Promise<string> {
      relativePath = ensureMdExt(relativePath);
      const id = requireId();
      const local = loadLocalFolder(id);
      if (local?.files[relativePath]) return local.files[relativePath].nodeId;
      saveLocalFile(id, relativePath, {
        content: "",
        tags: [],
        nodeId: "",
        pendingOperationId: createTraceOperationId(),
      });
      return flushStagedFile(relativePath);
    },

    async createFolder(relativePath: string): Promise<string> {
      const id = requireId();
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

      // A directory is a trace from the moment it exists. Mint the empty
      // folder genesis first, then cite that nucleus from the attached parent.
      // The canonical body of an empty folder is the compact JSON array `[]`.
      const operationId = createTraceOperationId();
      const genesisId = await createFolderGenesis({
        signer,
        localOnly: true,
        operationId,
      });
      const parentHead = await upsertManifestEntry(
        parent.folderId,
        {
          kind: "folder",
          relativePath: parent.relativePath,
          latestNodeId: genesisId,
          contentHash: await sha256Hex("[]"),
        },
        parentSigner,
        { localOnly: true, operationId },
      );
      await propagateFolderHead(
        id,
        parent.folderPath,
        parent.folderId,
        parentHead,
        parentSigner,
        true,
      );
      saveLocalFile(id, relativePath, {
        kind: "folder",
        content: "",
        tags: [],
        nodeId: genesisId,
        traceId: genesisId,
      });
      return genesisId;
    },

    async stepFolder(
      relativePath: string,
      requestedSigner?: Uint8Array,
      requestedOperationId?: string,
    ): Promise<string> {
      const rootId = requireId();
      const operationId = requestedOperationId ?? createTraceOperationId();
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
      // The caller's requested signer is not the folder-chain identity: two
      // callers can both resolve to the same held owner key. Key the entire
      // selected-folder + ancestor cascade by its stable persisted identity so
      // those callers share one flight instead of racing only the ancestors.
      const flightKey = JSON.stringify([rootId, relativePath, folderId, operationId]);
      const existing = recursiveFolderStepFlights.get(flightKey);
      if (existing) return existing;

      const pending = (async () => {
        const head = await stepFolderManifest(folderId, folderSigner, {
          localOnly: true,
          operationId,
        });
        if (relativePath !== "") {
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
      })();
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
      const local = loadLocalFolder(id);
      if (!local) return;
      const affected = (isFolder
        ? Object.keys(local.files).filter(
            (p) => p === relativePath || p.startsWith(relativePath + "/"),
          )
        : [relativePath])
        .sort((a, b) => b.split("/").length - a.split("/").length);
      const operationId = createTraceOperationId();
      // The gesture is complete only after every signed tombstone and manifest
      // removal lands. Perform remote work first so a failure leaves the local
      // copy retryable instead of silently orphaning provenance.
      for (const path of affected) {
        const entry = loadLocalFolder(id)?.files[path];
        if (entry?.kind === "folder") await removeStagedFolder(id, path, operationId);
        else await tombstoneStagedFile(id, path, operationId);
      }
      for (const path of affected) deleteLocalFile(id, path);
    },

    async movePath(src, destFolder, isFolder, _tagsByPath = {}): Promise<void> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (!local) return;
      const operationId = createTraceOperationId();
      const name = basename(src);
      const destPath = destFolder === "" ? name : `${destFolder}/${name}`;
      // Move every descendant too.
      const moves: { oldRel: string; newRel: string }[] = [];
      for (const p of Object.keys(local.files)) {
        if (p === src) moves.push({ oldRel: p, newRel: destPath });
        else if (p.startsWith(src + "/")) moves.push({ oldRel: p, newRel: destPath + p.slice(src.length) });
      }
      if (isFolder) {
        if (isOblivionPath(destPath)) {
          const fileMoves = moves.filter(
            ({ oldRel }) => loadLocalFolder(id)?.files[oldRel]?.kind !== "folder",
          );
          for (const { oldRel, newRel } of fileMoves) {
            const file = loadLocalFolder(id)?.files[oldRel];
            if (!file) continue;
            moveLocalFile(
              id,
              oldRel,
              newRel,
              pendingMoveForPath(oldRel, newRel, file.pendingMove),
              file.pendingOperationId ?? operationId,
            );
            await flushStagedFile(newRel);
          }
          const folderMoves = moves
            .filter(({ oldRel }) => loadLocalFolder(id)?.files[oldRel]?.kind === "folder")
            .sort((a, b) => b.oldRel.split("/").length - a.oldRel.split("/").length);
          for (const { oldRel } of folderMoves) {
            await removeStagedFolder(id, oldRel, operationId);
          }
          for (const { oldRel, newRel } of folderMoves) moveLocalFile(id, oldRel, newRel);
          return;
        }
        if (isOblivionPath(src)) {
          const folderMoves = moves
            .filter(({ oldRel }) => loadLocalFolder(id)?.files[oldRel]?.kind === "folder")
            .sort((a, b) => a.oldRel.split("/").length - b.oldRel.split("/").length);
          for (const { oldRel, newRel } of folderMoves) {
            const folder = loadLocalFolder(id)?.files[oldRel];
            if (!folder) continue;
            moveLocalFile(id, oldRel, newRel);
            await attachStagedFolder(id, newRel, folder, operationId);
          }
          const fileMoves = moves.filter(
            ({ oldRel }) => loadLocalFolder(id)?.files[oldRel]?.kind !== "folder",
          );
          for (const { oldRel, newRel } of fileMoves) {
            const file = loadLocalFolder(id)?.files[oldRel];
            if (!file) continue;
            moveLocalFile(
              id,
              oldRel,
              newRel,
              pendingMoveForPath(oldRel, newRel, file.pendingMove),
              file.pendingOperationId ?? operationId,
            );
            await flushStagedFile(newRel);
          }
          return;
        }
        await moveStagedFolder(id, src, destPath, operationId);
        for (const { oldRel, newRel } of moves) moveLocalFile(id, oldRel, newRel);
        return;
      }
      for (const { oldRel, newRel } of moves) {
        const file = loadLocalFolder(id)?.files[oldRel];
        if (!file || file.kind === "folder") continue;
        const pendingMove = pendingMoveForPath(oldRel, newRel, file.pendingMove);
        moveLocalFile(
          id,
          oldRel,
          newRel,
          pendingMove,
          file.pendingOperationId ?? operationId,
        );
      }
      // The App updates paths optimistically, but this promise resolves only
      // after each resulting file/folder Step is queryable by replay. If one
      // flush fails, it schedules itself and every not-yet-attempted descendant
      // so the durable movement journal still converges in the background.
      for (let i = 0; i < moves.length; i++) {
        try {
          await flushStagedFile(moves[i].newRel);
        } catch (error) {
          for (let j = i + 1; j < moves.length; j++) schedulePush(moves[j].newRel);
          throw error;
        }
      }
    },

    async renamePath(src, newName, isFolder): Promise<void> {
      const id = requireId();
      const local = loadLocalFolder(id);
      if (!local) return;
      const operationId = createTraceOperationId();
      const slash = src.lastIndexOf("/");
      const destPath = slash === -1 ? newName : src.slice(0, slash + 1) + newName;
      // Rename every descendant too.
      const moves: { oldRel: string; newRel: string }[] = [];
      for (const p of Object.keys(local.files)) {
        if (p === src) moves.push({ oldRel: p, newRel: destPath });
        else if (p.startsWith(src + "/")) moves.push({ oldRel: p, newRel: destPath + p.slice(src.length) });
      }
      if (isFolder) {
        await moveStagedFolder(id, src, destPath, operationId);
        for (const { oldRel, newRel } of moves) moveLocalFile(id, oldRel, newRel);
        return;
      }
      for (const { oldRel, newRel } of moves) {
        const file = loadLocalFolder(id)?.files[oldRel];
        if (!file || file.kind === "folder") continue;
        moveLocalFile(id, oldRel, newRel, {
          kind: "move",
          fromPath: file.pendingMove?.fromPath ?? oldRel,
        }, file.pendingOperationId ?? operationId);
      }
      for (let i = 0; i < moves.length; i++) {
        try {
          await flushStagedFile(moves[i].newRel);
        } catch (error) {
          for (let j = i + 1; j < moves.length; j++) schedulePush(moves[j].newRel);
          throw error;
        }
      }
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
  /** Fast-forwards: silent overwrites (local was at the ancestor). Refresh UI. */
  updated: Set<string>;
  /** Clean merges awaiting review. Local untouched. */
  staged: StagedMerge[];
  /** Textual conflicts: local untouched; surfaced via the activation banner. */
  conflicts: Set<string>;
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
export async function pullFromRelay(
  folderId: string,
  options: { strict?: boolean } = {},
): Promise<PullResult> {
  const result: PullResult = {
    updated: new Set<string>(),
    staged: [],
    conflicts: new Set<string>(),
  };
  const visited = new Set<string>();
  async function pullFolder(currentFolderId: string, prefix: string): Promise<void> {
    if (visited.has(currentFolderId)) return;
    visited.add(currentFolderId);
    let manifest: ManifestFileEntry[];
    try {
      manifest = await fetchManifest(currentFolderId);
    } catch (error) {
      if (options.strict) throw error;
      return;
    }

    for (const entry of manifest) {
      const storagePath = prefix
        ? `${prefix}/${entry.relativePath}`
        : entry.relativePath;
      const local = loadLocalFolder(folderId);
      if (entry.kind === "folder") {
        const existing = local?.files[storagePath];
        const traceId = existing?.traceId
          ?? await resolveTraceIdentity(entry.latestNodeId)
          ?? entry.latestNodeId;
        if (!isLocalNewer(local, entry, storagePath)) {
          saveLocalFile(folderId, storagePath, {
            kind: "folder",
            content: "",
            tags: [],
            nodeId: entry.latestNodeId,
            traceId,
          });
          result.updated.add(storagePath);
        }
        await pullFolder(traceId, storagePath);
        continue;
      }
      if (isLocalNewer(local, entry, storagePath)) continue;

      // Remote may have moved (or local doesn't have it) → pull + decide.
      try {
        const chain = await fetchChain(currentFolderId, entry.relativePath);
        const content = chain.length > 0 ? reconstructFromChain(chain) : "";
        const head = chain.length > 0 ? chain[chain.length - 1] : null;
        const remoteHeadId = head?.id ?? entry.latestNodeId;
        const lf = local?.files[storagePath];
        const localContent = lf?.content ?? "";

        // Decide how to reconcile against local. base = the snapshot at local's
        // nodeId on the fetched chain (the common ancestor), if present; else
        // empty (independent roots → diff3 will flag a conflict, which is safe).
        const base = ancestorSnapshot(chain, lf?.nodeId);
        const decision = localContent.length === 0
          ? { outcome: "fastforward" as const }
          : decidePullMerge(base, localContent, content);

        if (decision.outcome === "noop") continue;
        if (decision.outcome === "conflict") {
          result.conflicts.add(storagePath);
          continue;
        }
        if (decision.outcome === "clean") {
          result.staged.push({
            path: storagePath,
            base,
            ours: localContent,
            theirs: content,
            merged: decision.merged!,
            localNodeId: lf?.nodeId ?? "",
            remoteHeadId,
            remoteOwnerPubkey: await safeOwnerPubkey(remoteHeadId),
          });
          continue;
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
      }
    }
  }

  await pullFolder(folderId, "");
  return result;
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

/** Best-effort remote-owner lookup; never throws (merge staging must not fail
 *  on a key-resolution blip — attribution falls back to the author voice). */
async function safeOwnerPubkey(remoteHeadId: string): Promise<string> {
  try {
    const owner = await fetchNodeOwner(remoteHeadId);
    return owner || authorVoice();
  } catch {
    return authorVoice();
  }
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
  saveLocalFile(folderId, relativePath, {
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
  local: { files: Record<string, { nodeId: string; updatedAt: number }> } | null,
  entry: ManifestFileEntry,
  storagePath = entry.relativePath,
): boolean {
  if (!local) return false;
  const lf = local.files[storagePath];
  if (!lf) return false;
  const sameHead = lf.nodeId !== "" && lf.nodeId === entry.latestNodeId;
  const recentLocal = Date.now() - lf.updatedAt < 5000;
  return sameHead || recentLocal;
}
