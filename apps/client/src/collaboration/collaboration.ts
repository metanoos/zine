import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  isEditorTransaction,
  validateEditorTransactionTransition,
  type EditorSelectionState,
  type EditorTransaction,
} from "@zine/protocol";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness.js";
import * as Y from "yjs";

import {
  containsMountedPath,
  normalizeMountScope,
  pathInMountScope,
  type MountScope,
} from "../workspace/mount-scope.js";
import {
  createCollaborationNonce,
  signCollaborationBootstrap,
  signCollaborationOperation,
  verifyCollaborationBootstrap,
  verifyCollaborationOperation,
} from "./collaboration-crypto.js";
import {
  permitsCollaborationAction,
  permitsCollaborationRead,
  type CollaborationPermissionDirectory,
} from "./collaboration-permissions.js";
import {
  COLLABORATION_VERSION,
  type CollaborationAcceptedPrefix,
  type CollaborationAcceptedOperation,
  type CollaborationEntry,
  type CollaborationOperationBody,
  type CollaborationPresenceState,
  type CollaborationPrivateTextPatch,
  type CollaborationRelativeSelection,
  type CollaborationSeedEntry,
  type CollaborationBootstrap,
  type CollaborationBootstrapBody,
  type CollaborationDefinition,
  type CollaborationSignedOperation,
  type CollaborationSignedOperationOf,
} from "./collaboration-types.js";

const DIRECTORY_TYPE = "entries";
const FILE_TEXT_TYPE = "content";
const ENTRY_KEYS = new Set(["kind", "parentId", "name", "deleted"]);
const COLLABORATION_PERMISSION_ACTIONS = new Set([
  "collaboration.join",
  "presence.write",
  "file.read",
  "file.edit",
  "folder.create",
  "entry.rename",
  "entry.move",
  "entry.delete",
  "stage.view",
  "stage.start",
  "stage.control",
  "stage.end",
  "access.manage",
]);

type OperationListener = (accepted: CollaborationAcceptedOperation) => void;
type OutgoingListener = (operation: CollaborationSignedOperation) => void;
type BeforeRemoteOperationListener = (operation: CollaborationSignedOperation) => void;
type AwarenessOutgoingListener = (update: Uint8Array) => void;
type PresenceListener = (presence: CollaborationPresenceState | null) => void;

interface DirectoryEntryState extends CollaborationEntry {
  deleted: boolean;
}

interface PreparedEditRecord {
  edit: CollaborationPreparedEdit;
  batchId: string;
  beforeText: string;
  afterText: string;
}

interface PreparedEditBatchRecord {
  id: string;
  key: string;
  fileId: string;
  actorPubkey: string;
  baseSnapshot: string;
  baseText: string;
  currentText: string;
  preparationIds: string[];
  origin: unknown;
}

export interface CollaborationHostInput {
  definition: CollaborationDefinition;
  participantPubkey: string;
  entries: readonly CollaborationSeedEntry[];
}

export interface CollaborationEditBatchSubmission {
  fileId: string;
  actorPubkey: string;
  secretKey: Uint8Array;
  editorTransactions: readonly EditorTransaction[];
  /** Origin ignored by the submitting CodeMirror binding's Y.Text observer. */
  origin?: unknown;
}

export interface CollaborationEditPreparationInput {
  fileId: string;
  actorPubkey: string;
  secretKey: Uint8Array;
  editorTransaction: EditorTransaction;
  /** Origin ignored by the submitting CodeMirror binding's Y.Text observer. */
  origin?: unknown;
}

export interface CollaborationPreparedEdit {
  preparationId: string;
  fileId: string;
  actorPubkey: string;
  editorTransaction: EditorTransaction;
}

export interface CollaborationPreparedEditBatchSubmission {
  edits: readonly CollaborationPreparedEdit[];
  secretKey: Uint8Array;
}

export interface CollaborationPresenceSubmission {
  activeFileId: string | null;
  selection: EditorSelectionState | null;
  actorPubkey: string;
  secretKey: Uint8Array;
}

export interface CollaborationPrivatePatchSubmission {
  fileId: string;
  actorPubkey: string;
  baseText: string;
  editorTransaction: EditorTransaction;
  reason?: CollaborationPrivateTextPatch["reason"];
}

export interface CollaborationRemoteYjsOrigin {
  kind: "collaboration-operation";
  source: "remote";
  operation: CollaborationSignedOperation;
}

export function collaborationOperationFromYjsOrigin(
  origin: unknown,
): CollaborationSignedOperation | null {
  if (
    !origin ||
    typeof origin !== "object" ||
    !("kind" in origin) ||
    !("source" in origin) ||
    !("operation" in origin)
  ) return null;
  const candidate = origin as Partial<CollaborationRemoteYjsOrigin>;
  return candidate.kind === "collaboration-operation" &&
    candidate.source === "remote" &&
    verifyCollaborationOperation(candidate.operation)
    ? candidate.operation
    : null;
}

export class CollaborationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollaborationError";
  }
}

function cloneDefinition(definition: CollaborationDefinition): CollaborationDefinition {
  return {
    version: definition.version,
    collaborationId: definition.collaborationId,
    ownerPubkey: definition.ownerPubkey,
    mount: normalizeMountScope(definition.mount),
    capabilities: definition.capabilities.map((capability) => ({
      ...capability,
      resource: { ...capability.resource },
      actions: [...capability.actions],
      ...(capability.actorPubkeys
        ? { actorPubkeys: [...capability.actorPubkeys] }
        : {}),
    })),
  };
}

function assertDefinition(definition: CollaborationDefinition): void {
  if (
    definition.version !== COLLABORATION_VERSION ||
    definition.collaborationId.length === 0 ||
    !/^[0-9a-f]{64}$/.test(definition.ownerPubkey)
  ) {
    throw new CollaborationError("invalid Collaboration definition");
  }
  if (!definition.mount.mount) {
    throw new CollaborationError("a Collaboration must have one mounted file or folder");
  }
  const capabilityIds = new Set<string>();
  for (const capability of definition.capabilities) {
    if (
      capability.id.length === 0 ||
      capabilityIds.has(capability.id) ||
      !/^[0-9a-f]{64}$/.test(capability.subjectPubkey) ||
      capability.actions.length === 0 ||
      capability.actions.some((action) => !COLLABORATION_PERMISSION_ACTIONS.has(action)) ||
      (
        capability.actions.includes("access.manage") &&
        capability.subjectPubkey !== definition.ownerPubkey
      ) ||
      capability.actorPubkeys?.some((actor) => !/^[0-9a-f]{64}$/.test(actor))
    ) {
      throw new CollaborationError("invalid or duplicate Collaboration capability");
    }
    capabilityIds.add(capability.id);
  }
}

function assertParticipant(
  definition: CollaborationDefinition,
  participantPubkey: string,
): void {
  if (!/^[0-9a-f]{64}$/.test(participantPubkey)) {
    throw new CollaborationError("invalid local participant pubkey");
  }
  if (
    participantPubkey !== definition.ownerPubkey &&
    !definition.capabilities.some(
      (capability) =>
        capability.subjectPubkey === participantPubkey &&
        capability.actions.includes("collaboration.join"),
    )
  ) {
    throw new CollaborationError("local participant lacks collaboration.join permission");
  }
}

function assertEntryName(name: string): void {
  if (
    name.trim().length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\0")
  ) {
    throw new CollaborationError("entry name is not a valid workspace segment");
  }
}

function seedPaths(entries: readonly CollaborationSeedEntry[]): {
  rootId: string;
  byId: Map<string, CollaborationSeedEntry>;
  paths: Map<string, string>;
} {
  const byId = new Map<string, CollaborationSeedEntry>();
  for (const entry of entries) {
    if (entry.id.length === 0 || byId.has(entry.id)) {
      throw new CollaborationError("seed entries require unique stable ids");
    }
    if (entry.parentId !== null) assertEntryName(entry.name);
    if (entry.kind === "folder" && entry.text !== undefined) {
      throw new CollaborationError("folder seed entries cannot contain text");
    }
    byId.set(entry.id, entry);
  }
  const roots = entries.filter((entry) => entry.parentId === null);
  if (roots.length !== 1 || roots[0].kind !== "folder") {
    throw new CollaborationError("seed entries require exactly one folder root");
  }
  const rootId = roots[0].id;
  const paths = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (entryId: string): string => {
    const cached = paths.get(entryId);
    if (cached !== undefined) return cached;
    const entry = byId.get(entryId);
    if (!entry) throw new CollaborationError(`seed entry ${entryId} has no parent`);
    if (resolving.has(entryId)) throw new CollaborationError("seed directory contains a cycle");
    resolving.add(entryId);
    const path = entry.parentId === null
      ? ""
      : [resolve(entry.parentId), entry.name].filter(Boolean).join("/");
    resolving.delete(entryId);
    paths.set(entryId, path);
    return path;
  };
  for (const entry of entries) resolve(entry.id);
  return { rootId, byId, paths };
}

/**
 * Strip a workspace seed down to one mount. Ancestor folders are retained only
 * as coordinates; shielded branches and unrelated siblings never enter the
 * Collaboration CRDT.
 */
export function entriesForCollaborationMount(
  entries: readonly CollaborationSeedEntry[],
  mount: MountScope,
): CollaborationSeedEntry[] {
  const normalized = normalizeMountScope(mount);
  const mounted = normalized.mount;
  if (!mounted) return [];
  const { rootId, paths } = seedPaths(entries);
  const included = entries.filter((entry) => {
    const path = paths.get(entry.id)!;
    if (entry.id === rootId || pathInMountScope(normalized, path)) return true;
    return (
      entry.kind === "folder" &&
      containsMountedPath(path, mounted.path)
    );
  });
  const includedIds = new Set(included.map((entry) => entry.id));
  for (const entry of included) {
    if (entry.parentId !== null && !includedIds.has(entry.parentId)) {
      throw new CollaborationError("mounted seed lost an ancestor folder");
    }
  }
  return included.map((entry) => ({
    ...entry,
    ...(entry.text === undefined ? {} : { text: entry.text }),
  }));
}

function createEntryMap(entry: CollaborationEntry): Y.Map<unknown> {
  const value = new Y.Map<unknown>();
  value.set("kind", entry.kind);
  value.set("parentId", entry.parentId);
  value.set("name", entry.name);
  value.set("deleted", false);
  return value;
}

function decodeEntry(entryId: string, value: unknown): DirectoryEntryState {
  if (!(value instanceof Y.Map)) {
    throw new CollaborationError(`directory entry ${entryId} is not a Y.Map`);
  }
  for (const key of value.keys()) {
    if (!ENTRY_KEYS.has(key)) {
      throw new CollaborationError(`directory entry ${entryId} has an unknown field`);
    }
  }
  const kind = value.get("kind");
  const parentId = value.get("parentId");
  const name = value.get("name");
  const deleted = value.get("deleted");
  if (
    (kind !== "file" && kind !== "folder") ||
    (parentId !== null && typeof parentId !== "string") ||
    typeof name !== "string" ||
    typeof deleted !== "boolean"
  ) {
    throw new CollaborationError(`directory entry ${entryId} is malformed`);
  }
  return { id: entryId, kind, parentId, name, deleted };
}

function captureYjsUpdate(
  doc: Y.Doc,
  origin: unknown,
  mutate: () => void,
): string {
  const updates: Uint8Array[] = [];
  const collect = (update: Uint8Array, updateOrigin: unknown) => {
    if (updateOrigin === origin) updates.push(update);
  };
  doc.on("update", collect);
  try {
    doc.transact(mutate, origin);
  } finally {
    doc.off("update", collect);
  }
  return bytesToHex(updates.length === 0 ? new Uint8Array() : Y.mergeUpdates(updates));
}

function directorySnapshot(doc: Y.Doc): Map<string, string> {
  const shareKeys = [...doc.share.keys()];
  if (shareKeys.some((key) => key !== DIRECTORY_TYPE)) {
    throw new CollaborationError("directory update introduced an unknown shared type");
  }
  const snapshot = new Map<string, string>();
  for (const [entryId, value] of doc.getMap(DIRECTORY_TYPE)) {
    snapshot.set(entryId, JSON.stringify(decodeEntry(entryId, value)));
  }
  return snapshot;
}

function cloneWithUpdate(doc: Y.Doc, update: string): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  if (update.length > 0) Y.applyUpdate(clone, hexToBytes(update));
  return clone;
}

function encodedSnapshot(doc: Y.Doc): string {
  return bytesToHex(Y.encodeSnapshot(Y.snapshot(doc)));
}

function decodeSnapshot(value: string): Y.Snapshot {
  try {
    return Y.decodeSnapshot(hexToBytes(value));
  } catch {
    throw new CollaborationError("file edit batch has an invalid base snapshot");
  }
}

function deleteSetContains(
  superset: Y.Snapshot["ds"],
  subset: Y.Snapshot["ds"],
): boolean {
  for (const [client, required] of subset.clients) {
    const available = superset.clients.get(client) ?? [];
    for (const item of required) {
      const requiredEnd = item.clock + item.len;
      let coveredUntil = item.clock;
      for (const candidate of available) {
        const candidateEnd = candidate.clock + candidate.len;
        if (candidateEnd <= coveredUntil) continue;
        if (candidate.clock > coveredUntil) break;
        coveredUntil = Math.max(coveredUntil, candidateEnd);
        if (coveredUntil >= requiredEnd) break;
      }
      if (coveredUntil < requiredEnd) return false;
    }
  }
  return true;
}

function validateEditBatchMaterialization(
  doc: Y.Doc,
  baseSnapshotValue: string,
  update: string,
  editorTransactions: readonly EditorTransaction[],
): void {
  if (doc.gc) {
    throw new CollaborationError(
      "file edit verification requires retained Yjs history",
    );
  }
  const baseSnapshot = decodeSnapshot(baseSnapshotValue);
  const currentSnapshot = Y.snapshot(doc);
  const currentState = currentSnapshot.sv;
  for (const [client, clock] of baseSnapshot.sv) {
    if ((currentState.get(client) ?? 0) < clock) {
      throw new CollaborationError(
        "file edit batch depends on unavailable causal history",
      );
    }
  }
  for (const [client, deleted] of baseSnapshot.ds.clients) {
    const baseClock = baseSnapshot.sv.get(client) ?? 0;
    if (deleted.some((item) => item.clock + item.len > baseClock)) {
      throw new CollaborationError(
        "file edit base snapshot contains impossible deletion history",
      );
    }
  }
  if (!deleteSetContains(currentSnapshot.ds, baseSnapshot.ds)) {
    throw new CollaborationError(
      "file edit base snapshot contains unavailable deletion history",
    );
  }
  let base: Y.Doc | null = null;
  try {
    base = Y.createDocFromSnapshot(
      doc,
      baseSnapshot,
      new Y.Doc({ gc: false }),
    );
    if ([...base.share.keys()].some((key) => key !== FILE_TEXT_TYPE)) {
      throw new CollaborationError(
        "file edit base introduced an unknown shared type",
      );
    }
    const text = base.getText(FILE_TEXT_TYPE);
    const before = text.toString();
    const expected = textAfterTransactions(before, editorTransactions);
    const verdict = validateEditorTransactionTransition(
      before,
      expected,
      editorTransactions,
    );
    if (!verdict.valid) {
      throw new CollaborationError(
        verdict.reason ?? "invalid editor transaction batch",
      );
    }
    let formatted = false;
    const observe = (event: Y.YTextEvent) => {
      formatted ||= event.delta.some(
        (part) =>
          "attributes" in part &&
          part.attributes !== undefined &&
          Object.keys(part.attributes).length > 0,
      );
    };
    text.observe(observe);
    try {
      Y.applyUpdate(base, hexToBytes(update));
    } finally {
      text.unobserve(observe);
    }
    if (
      formatted ||
      [...base.share.keys()].some((key) => key !== FILE_TEXT_TYPE) ||
      text.toString() !== expected
    ) {
      throw new CollaborationError(
        "file edit update disagrees with its signed editor transactions",
      );
    }
  } catch (error) {
    if (error instanceof CollaborationError) throw error;
    throw new CollaborationError(
      "file edit batch cannot reconstruct its signed causal base",
    );
  } finally {
    base?.destroy();
  }
}

function changedDirectoryEntries(
  before: Map<string, string>,
  after: Map<string, string>,
): Set<string> {
  const changed = new Set<string>();
  for (const entryId of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(entryId) !== after.get(entryId)) changed.add(entryId);
  }
  return changed;
}

function textAfterTransaction(before: string, transaction: EditorTransaction): string {
  let current = before;
  const descending = [...transaction.changes].sort(
    (left, right) => right.from - left.from || right.to - left.to,
  );
  for (const change of descending) {
    current = `${current.slice(0, change.from)}${change.text}${current.slice(change.to)}`;
  }
  return current;
}

function textAfterTransactions(
  before: string,
  transactions: readonly EditorTransaction[],
): string {
  return transactions.reduce(textAfterTransaction, before);
}

function applyEditorTransactions(
  text: Y.Text,
  transactions: readonly EditorTransaction[],
): void {
  for (const transaction of transactions) {
    const descending = [...transaction.changes].sort(
      (left, right) => right.from - left.from || right.to - left.to,
    );
    for (const change of descending) {
      if (change.to > change.from) {
        text.delete(change.from, change.to - change.from);
      }
      if (change.text.length > 0) text.insert(change.from, change.text);
    }
  }
}

function cloneEditorTransaction(
  transaction: EditorTransaction,
): EditorTransaction {
  const cloneSelection = (
    selection: EditorSelectionState | null,
  ): EditorSelectionState | null => selection === null
    ? null
    : {
        ranges: selection.ranges.map((range) => ({ ...range })),
        main: selection.main,
      };
  return {
    sequence: transaction.sequence,
    timestamp: transaction.timestamp,
    actor: transaction.actor,
    changes: transaction.changes.map((change) => ({ ...change })),
    selectionBefore: cloneSelection(transaction.selectionBefore),
    selectionAfter: cloneSelection(transaction.selectionAfter),
    ...(transaction.intent ? { intent: transaction.intent } : {}),
  };
}

function preparedBatchKey(fileId: string, actorPubkey: string): string {
  return `${fileId}\0${actorPubkey}`;
}

function collisionDigest(entryId: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(entryId)));
}

function materializedCollisionName(
  name: string,
  entryId: string,
  collidingIds: readonly string[],
): string {
  const hashes = new Map(
    collidingIds.map((id) => [id, collisionDigest(id)]),
  );
  const hash = hashes.get(entryId)!;
  let prefixLength = 8;
  while (
    prefixLength < hash.length &&
    collidingIds.some(
      (id) =>
        id !== entryId &&
        hashes.get(id)!.slice(0, prefixLength) ===
          hash.slice(0, prefixLength),
    )
  ) {
    prefixLength += 1;
  }
  const suffix = `~${hash.slice(0, prefixLength)}`;
  const extension = name.lastIndexOf(".");
  return extension > 0
    ? `${name.slice(0, extension)}${suffix}${name.slice(extension)}`
    : `${name}${suffix}`;
}

function relativePositionHex(text: Y.Text, index: number): string {
  return bytesToHex(
    Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, index)),
  );
}

function absolutePosition(
  doc: Y.Doc,
  value: string,
): number | null {
  const absolute = Y.createAbsolutePositionFromRelativePosition(
    Y.decodeRelativePosition(hexToBytes(value)),
    doc,
  );
  return absolute?.index ?? null;
}

export class CollaborationReplica implements CollaborationPermissionDirectory {
  readonly definition: CollaborationDefinition;
  readonly participantPubkey: string;
  readonly directoryDoc: Y.Doc;
  readonly awareness: Awareness;

  private readonly entries: Y.Map<unknown>;
  private readonly fileDocs: Map<string, Y.Doc>;
  private readonly pendingAccepted = new Map<string, CollaborationSignedOperation>();
  private readonly operationHistory = new Map<string, CollaborationSignedOperation>();
  private readonly preparedEdits = new Map<string, PreparedEditRecord>();
  private readonly preparedEditBatches = new Map<string, PreparedEditBatchRecord>();
  private readonly privatePatchLog: CollaborationPrivateTextPatch[] = [];
  private readonly acceptedListeners = new Set<OperationListener>();
  private readonly outgoingListeners = new Set<OutgoingListener>();
  private readonly beforeRemoteOperationListeners =
    new Set<BeforeRemoteOperationListener>();
  private readonly awarenessOutgoingListeners = new Set<AwarenessOutgoingListener>();
  private readonly presenceListeners = new Set<PresenceListener>();
  private readonly rootId: string;

  private constructor(
    definitionInput: CollaborationDefinition,
    participantPubkey: string,
    directoryDoc: Y.Doc,
    fileDocs: Map<string, Y.Doc>,
    historicalOperations: readonly CollaborationSignedOperation[],
    pendingOperations: readonly CollaborationSignedOperation[],
  ) {
    assertDefinition(definitionInput);
    this.definition = cloneDefinition(definitionInput);
    assertParticipant(this.definition, participantPubkey);
    this.participantPubkey = participantPubkey;
    this.directoryDoc = directoryDoc;
    this.entries = directoryDoc.getMap(DIRECTORY_TYPE);
    this.fileDocs = fileDocs;
    directorySnapshot(directoryDoc);
    const roots = this.rawEntries().filter((entry) => entry.parentId === null);
    if (roots.length !== 1 || roots[0].kind !== "folder" || roots[0].deleted) {
      throw new CollaborationError("Collaboration directory requires one mounted root");
    }
    this.rootId = roots[0].id;
    for (const capability of this.definition.capabilities) {
      if (
        capability.resource.kind === "entry" &&
        !this.entries.has(capability.resource.entryId)
      ) {
        throw new CollaborationError(
          `capability ${capability.id} targets an entry outside the collaboration mount`,
        );
      }
    }
    for (const [fileId, doc] of this.fileDocs) {
      const entry = this.rawEntry(fileId);
      if (
        entry.kind !== "file" ||
        this.isEffectivelyDeleted(fileId) ||
        !pathInMountScope(this.definition.mount, this.pathForEntry(fileId)) ||
        !permitsCollaborationRead(
          this.definition,
          this,
          this.participantPubkey,
          fileId,
        ) ||
        [...doc.share.keys()].some((key) => key !== FILE_TEXT_TYPE)
      ) {
        throw new CollaborationError(
          `bootstrap materialized unreadable or unknown file ${fileId}`,
        );
      }
    }
    for (const operation of historicalOperations) {
      if (
        !verifyCollaborationOperation(operation) ||
        operation.collaborationId !== this.definition.collaborationId
      ) {
        throw new CollaborationError("bootstrap contains an invalid operation");
      }
      this.operationHistory.set(operation.operationId, operation);
    }
    for (const operation of pendingOperations) {
      if (
        !verifyCollaborationOperation(operation) ||
        operation.collaborationId !== this.definition.collaborationId ||
        !this.operationHistory.has(operation.operationId)
      ) {
        throw new CollaborationError(
          "bootstrap contains an invalid pending operation",
        );
      }
      this.pendingAccepted.set(operation.operationId, operation);
    }
    this.awareness = new Awareness(directoryDoc);
    this.awareness.on("change", this.handleAwarenessChange);
    this.awareness.on("update", this.handleAwarenessUpdate);
    this.awareness.setLocalState(null);
  }

  static createHost(input: CollaborationHostInput): CollaborationReplica {
    assertDefinition(input.definition);
    if (input.participantPubkey !== input.definition.ownerPubkey) {
      throw new CollaborationError("only the collaboration owner can create a host bootstrap");
    }
    const mounted = entriesForCollaborationMount(input.entries, input.definition.mount);
    if (mounted.length === 0) {
      throw new CollaborationError("Collaboration mount resolved to no entries");
    }
    const directoryDoc = new Y.Doc({
      guid: `${input.definition.collaborationId}:directory`,
      gc: false,
    });
    const entries = directoryDoc.getMap<unknown>(DIRECTORY_TYPE);
    const fileDocs = new Map<string, Y.Doc>();
    directoryDoc.transact(() => {
      for (const entry of mounted) entries.set(entry.id, createEntryMap(entry));
    }, "collaboration-bootstrap");
    for (const entry of mounted) {
      if (entry.kind !== "file") continue;
      const doc = new Y.Doc({
        guid: `${input.definition.collaborationId}:file:${entry.id}`,
        gc: false,
      });
      if (entry.text) doc.getText(FILE_TEXT_TYPE).insert(0, entry.text);
      fileDocs.set(entry.id, doc);
    }
    return new CollaborationReplica(
      input.definition,
      input.participantPubkey,
      directoryDoc,
      fileDocs,
      [],
      [],
    );
  }

  static fromBootstrap(
    participantPubkey: string,
    bootstrap: CollaborationBootstrap,
  ): CollaborationReplica {
    if (
      !verifyCollaborationBootstrap(bootstrap) ||
      bootstrap.recipientPubkey !== participantPubkey
    ) {
      throw new CollaborationError(
        "Collaboration bootstrap is not owner-authenticated for this participant",
      );
    }
    assertDefinition(bootstrap.definition);
    assertParticipant(bootstrap.definition, participantPubkey);
    const directoryDoc = new Y.Doc({
      guid: `${bootstrap.definition.collaborationId}:directory`,
      gc: false,
    });
    Y.applyUpdate(directoryDoc, hexToBytes(bootstrap.directoryUpdate));
    const entries = directoryDoc.getMap<unknown>(DIRECTORY_TYPE);
    const permissionDirectory: CollaborationPermissionDirectory = {
      hasEntry(entryId) {
        try {
          return decodeEntry(entryId, entries.get(entryId)).deleted === false;
        } catch {
          return false;
        }
      },
      isDescendantOrSelf(entryId, ancestorId) {
        const seen = new Set<string>();
        let current: string | null = entryId;
        while (current !== null) {
          if (current === ancestorId) return true;
          if (seen.has(current)) return false;
          seen.add(current);
          try {
            const entry = decodeEntry(current, entries.get(current));
            if (entry.deleted) return false;
            current = entry.parentId;
          } catch {
            return false;
          }
        }
        return false;
      },
    };
    const fileDocs = new Map<string, Y.Doc>();
    for (const [fileId, update] of Object.entries(bootstrap.fileUpdates)) {
      let entry: DirectoryEntryState;
      try {
        entry = decodeEntry(fileId, entries.get(fileId));
      } catch {
        directoryDoc.destroy();
        throw new CollaborationError(
          `bootstrap supplied an unknown file snapshot ${fileId}`,
        );
      }
      if (
        entry.kind !== "file" ||
        entry.deleted ||
        !permitsCollaborationRead(
          bootstrap.definition,
          permissionDirectory,
          participantPubkey,
          fileId,
        )
      ) {
        directoryDoc.destroy();
        throw new CollaborationError(
          `bootstrap supplied an unreadable file snapshot ${fileId}`,
        );
      }
      const doc = new Y.Doc({
        guid: `${bootstrap.definition.collaborationId}:file:${fileId}`,
        gc: false,
      });
      Y.applyUpdate(doc, hexToBytes(update));
      if ([...doc.share.keys()].some((key) => key !== FILE_TEXT_TYPE)) {
        doc.destroy();
        directoryDoc.destroy();
        for (const prior of fileDocs.values()) prior.destroy();
        throw new CollaborationError(
          `bootstrap file ${fileId} introduced an unknown shared type`,
        );
      }
      fileDocs.set(fileId, doc);
    }
    return new CollaborationReplica(
      bootstrap.definition,
      participantPubkey,
      directoryDoc,
      fileDocs,
      bootstrap.operationHistory,
      bootstrap.acceptedOperations,
    );
  }

  private rawEntries(doc: Y.Doc = this.directoryDoc): DirectoryEntryState[] {
    return [...doc.getMap(DIRECTORY_TYPE)].map(([entryId, value]) =>
      decodeEntry(entryId, value),
    );
  }

  private rawEntry(entryId: string, doc: Y.Doc = this.directoryDoc): DirectoryEntryState {
    const value = doc.getMap(DIRECTORY_TYPE).get(entryId);
    if (value === undefined) throw new CollaborationError(`unknown entry ${entryId}`);
    return decodeEntry(entryId, value);
  }

  private isEffectivelyDeleted(entryId: string, doc: Y.Doc = this.directoryDoc): boolean {
    const seen = new Set<string>();
    let current: string | null = entryId;
    while (current !== null) {
      if (seen.has(current)) throw new CollaborationError("directory contains a cycle");
      seen.add(current);
      const entry = this.rawEntry(current, doc);
      if (entry.deleted) return true;
      current = entry.parentId;
    }
    return false;
  }

  hasEntry(entryId: string): boolean {
    try {
      return !this.isEffectivelyDeleted(entryId);
    } catch {
      return false;
    }
  }

  isDescendantOrSelf(entryId: string, ancestorId: string): boolean {
    if (!this.hasEntry(entryId) || !this.hasEntry(ancestorId)) return false;
    const seen = new Set<string>();
    let current: string | null = entryId;
    while (current !== null) {
      if (current === ancestorId) return true;
      if (seen.has(current)) throw new CollaborationError("directory contains a cycle");
      seen.add(current);
      current = this.rawEntry(current).parentId;
    }
    return false;
  }

  private materializedEntryName(
    entryId: string,
    doc: Y.Doc = this.directoryDoc,
  ): string {
    const entry = this.rawEntry(entryId, doc);
    if (entry.parentId === null) return entry.name;
    const colliding = this.rawEntries(doc)
      .filter(
        (candidate) =>
          candidate.parentId === entry.parentId &&
          candidate.name === entry.name &&
          !this.isEffectivelyDeleted(candidate.id, doc),
      )
      .map((candidate) => candidate.id)
      .sort();
    if (colliding.length <= 1 || colliding[0] === entryId) return entry.name;
    return materializedCollisionName(entry.name, entryId, colliding);
  }

  pathForEntry(entryId: string, doc: Y.Doc = this.directoryDoc): string {
    const parts: string[] = [];
    const seen = new Set<string>();
    let current = this.rawEntry(entryId, doc);
    while (current.parentId !== null) {
      if (seen.has(current.id)) throw new CollaborationError("directory contains a cycle");
      seen.add(current.id);
      parts.unshift(this.materializedEntryName(current.id, doc));
      current = this.rawEntry(current.parentId, doc);
    }
    return parts.join("/");
  }

  listEntries(): CollaborationEntry[] {
    return this.rawEntries()
      .filter((entry) => !this.isEffectivelyDeleted(entry.id))
      .map(({ deleted: _deleted, ...entry }) => ({
        ...entry,
        name: this.materializedEntryName(entry.id),
      }))
      .sort((left, right) =>
        this.pathForEntry(left.id).localeCompare(this.pathForEntry(right.id)),
      );
  }

  fileText(fileId: string): Y.Text {
    const entry = this.rawEntry(fileId);
    if (entry.kind !== "file" || this.isEffectivelyDeleted(fileId)) {
      throw new CollaborationError(`${fileId} is not a collaboration file`);
    }
    if (!pathInMountScope(this.definition.mount, this.pathForEntry(fileId))) {
      throw new CollaborationError(`${fileId} is outside the Collaboration mount`);
    }
    if (
      !permitsCollaborationRead(
        this.definition,
        this,
        this.participantPubkey,
        fileId,
      )
    ) {
      throw new CollaborationError(
        `file ${fileId} is not readable by this participant`,
      );
    }
    const doc = this.fileDocs.get(fileId);
    if (!doc) throw new CollaborationError(`file ${fileId} is not readable by this participant`);
    return doc.getText(FILE_TEXT_TYPE);
  }

  canEditFile(fileId: string, actorPubkey: string): boolean {
    return (
      this.hasEntry(fileId) &&
      pathInMountScope(this.definition.mount, this.pathForEntry(fileId)) &&
      permitsCollaborationAction(
        this.definition,
        this,
        this.participantPubkey,
        actorPubkey,
        "file.edit",
        fileId,
      )
    );
  }

  canReadEntry(
    entryId: string,
    participantPubkey = this.participantPubkey,
  ): boolean {
    return (
      this.hasEntry(entryId) &&
      pathInMountScope(this.definition.mount, this.pathForEntry(entryId)) &&
      permitsCollaborationRead(
        this.definition,
        this,
        participantPubkey,
        entryId,
      )
    );
  }

  /**
   * Collaboration layers such as Stage authenticate the participant identity itself;
   * a writing voice never grants presentation or access authority.
   */
  canPerformAction(
    action: Parameters<typeof permitsCollaborationAction>[4],
    entryId: string | null = null,
    participantPubkey = this.participantPubkey,
  ): boolean {
    return permitsCollaborationAction(
      this.definition,
      this,
      participantPubkey,
      participantPubkey,
      action,
      entryId,
    );
  }

  /** Access-list changes are owner-only in the first release. */
  canManageAccess(participantPubkey = this.participantPubkey): boolean {
    return participantPubkey === this.definition.ownerPubkey;
  }

  private parsePresenceState(value: unknown): CollaborationPresenceState | null {
    if (!value || typeof value !== "object" || !("live" in value)) return null;
    const live = (value as { live?: unknown }).live;
    if (!live || typeof live !== "object") return null;
    const candidate = live as Partial<CollaborationPresenceState>;
    if (
      typeof candidate.participantPubkey !== "string" ||
      typeof candidate.actorPubkey !== "string" ||
      typeof candidate.timestamp !== "number" ||
      !Number.isFinite(candidate.timestamp) ||
      (candidate.activeFileId !== null &&
        typeof candidate.activeFileId !== "string") ||
      (candidate.selection !== null &&
        (
          !candidate.selection ||
          !Array.isArray(candidate.selection.ranges) ||
          candidate.selection.ranges.length === 0 ||
          !Number.isInteger(candidate.selection.main) ||
          candidate.selection.main < 0 ||
          candidate.selection.main >= candidate.selection.ranges.length ||
          candidate.selection.ranges.some(
            (range) =>
              !/^(?:[0-9a-f]{2})*$/.test(range.anchor) ||
              !/^(?:[0-9a-f]{2})*$/.test(range.head),
          )
        ))
    ) return null;
    if (
      !permitsCollaborationAction(
        this.definition,
        this,
        candidate.participantPubkey,
        candidate.actorPubkey,
        "presence.write",
        null,
      )
    ) return null;
    if (candidate.activeFileId !== null) {
      if (
        !this.hasEntry(candidate.activeFileId) ||
        !pathInMountScope(
          this.definition.mount,
          this.pathForEntry(candidate.activeFileId),
        ) ||
        !permitsCollaborationRead(
          this.definition,
          this,
          candidate.participantPubkey,
          candidate.activeFileId,
        )
      ) return null;
    } else if (candidate.selection !== null) {
      return null;
    }
    return candidate as CollaborationPresenceState;
  }

  private handleAwarenessChange = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const authenticatedParticipant =
      origin &&
      typeof origin === "object" &&
      "authenticatedParticipantPubkey" in origin
        ? (origin as { authenticatedParticipantPubkey: unknown })
            .authenticatedParticipantPubkey
        : this.participantPubkey;
    for (const clientId of [...change.added, ...change.updated]) {
      const presence = this.parsePresenceState(this.awareness.getStates().get(clientId));
      if (
        !presence ||
        presence.participantPubkey !== authenticatedParticipant
      ) continue;
      for (const listener of this.presenceListeners) listener(presence);
    }
    if (change.removed.length > 0) {
      for (const listener of this.presenceListeners) listener(null);
    }
  };

  private handleAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin !== "local") return;
    const update = encodeAwarenessUpdate(
      this.awareness,
      [...change.added, ...change.updated, ...change.removed],
    );
    for (const listener of this.awarenessOutgoingListeners) listener(update);
  };

  presenceFor(participantPubkey: string): CollaborationPresenceState | null {
    for (const value of this.awareness.getStates().values()) {
      const presence = this.parsePresenceState(value);
      if (presence?.participantPubkey === participantPubkey) return presence;
    }
    return null;
  }

  allPresence(): CollaborationPresenceState[] {
    const byParticipant = new Map<string, CollaborationPresenceState>();
    for (const value of this.awareness.getStates().values()) {
      const presence = this.parsePresenceState(value);
      if (!presence) continue;
      const prior = byParticipant.get(presence.participantPubkey);
      if (!prior || prior.timestamp <= presence.timestamp) {
        byParticipant.set(presence.participantPubkey, presence);
      }
    }
    return [...byParticipant.values()];
  }

  acceptedOperations(): CollaborationSignedOperation[] {
    return [...this.pendingAccepted.values()];
  }

  /** Complete collaboration history retained for reconnect replay and deduplication. */
  replayOperations(): CollaborationSignedOperation[] {
    return [...this.operationHistory.values()];
  }

  subscribeAccepted(listener: OperationListener): () => void {
    this.acceptedListeners.add(listener);
    return () => this.acceptedListeners.delete(listener);
  }

  subscribeOutgoing(listener: OutgoingListener): () => void {
    this.outgoingListeners.add(listener);
    return () => this.outgoingListeners.delete(listener);
  }

  subscribeBeforeRemoteOperation(
    listener: BeforeRemoteOperationListener,
  ): () => void {
    this.beforeRemoteOperationListeners.add(listener);
    return () => this.beforeRemoteOperationListeners.delete(listener);
  }

  subscribeAwarenessOutgoing(listener: AwarenessOutgoingListener): () => void {
    this.awarenessOutgoingListeners.add(listener);
    return () => this.awarenessOutgoingListeners.delete(listener);
  }

  subscribePresence(listener: PresenceListener): () => void {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  }

  receiveAwarenessUpdate(
    update: Uint8Array,
    authenticatedParticipantPubkey: string,
  ): void {
    assertParticipant(this.definition, authenticatedParticipantPubkey);
    const changed = new Set<number>();
    const origin = { authenticatedParticipantPubkey };
    const collect = (
      change: { added: number[]; updated: number[]; removed: number[] },
      changeOrigin: unknown,
    ) => {
      if (changeOrigin !== origin) return;
      for (const clientId of [...change.added, ...change.updated]) {
        changed.add(clientId);
      }
    };
    this.awareness.on("change", collect);
    try {
      applyAwarenessUpdate(this.awareness, update, origin);
    } finally {
      this.awareness.off("change", collect);
    }
    const invalid = [...changed].filter((clientId) => {
      const state = this.parsePresenceState(this.awareness.getStates().get(clientId));
      return state?.participantPubkey !== authenticatedParticipantPubkey;
    });
    if (invalid.length > 0) {
      removeAwarenessStates(this.awareness, invalid, "invalid-awareness");
      throw new CollaborationError("awareness identity does not match its authenticated peer");
    }
  }

  captureAcceptedPrefix(limit = Number.POSITIVE_INFINITY): CollaborationAcceptedPrefix {
    const operations = this.acceptedOperations().slice(0, limit);
    return {
      operationIds: operations.map((operation) => operation.operationId),
      operations,
    };
  }

  /**
   * A successful Step acknowledges exactly the prefix it signed. Operations
   * accepted while that Step was in flight remain pending for the next Step.
   */
  acknowledgeAcceptedPrefix(prefix: CollaborationAcceptedPrefix): void {
    const currentIds = this.acceptedOperations()
      .slice(0, prefix.operationIds.length)
      .map((operation) => operation.operationId);
    if (
      currentIds.length !== prefix.operationIds.length ||
      currentIds.some((operationId, index) =>
        operationId !== prefix.operationIds[index]
      )
    ) {
      throw new CollaborationError("cannot acknowledge a non-current operation prefix");
    }
    for (const operationId of prefix.operationIds) {
      this.pendingAccepted.delete(operationId);
    }
  }

  preservePrivateTextPatch(
    input: CollaborationPrivatePatchSubmission,
  ): CollaborationPrivateTextPatch {
    const reason = input.reason ?? "permission-denied";
    const previous = this.privatePatchLog[this.privatePatchLog.length - 1];
    const continuesPrivateFork =
      previous?.fileId === input.fileId &&
      previous.actorPubkey === input.actorPubkey &&
      previous.reason === reason;
    if (
      this.canEditFile(input.fileId, input.actorPubkey) &&
      !continuesPrivateFork
    ) {
      throw new CollaborationError("authorized edits belong in the shared Yjs document");
    }
    if (
      !isEditorTransaction(input.editorTransaction) ||
      input.editorTransaction.actor !== input.actorPubkey ||
      input.editorTransaction.changes.length === 0
    ) {
      throw new CollaborationError("private patch requires one actor-matching text transaction");
    }
    const after = textAfterTransaction(input.baseText, input.editorTransaction);
    const verdict = validateEditorTransactionTransition(
      input.baseText,
      after,
      [input.editorTransaction],
    );
    if (!verdict.valid) {
      throw new CollaborationError(verdict.reason ?? "invalid private patch transaction");
    }
    if (
      continuesPrivateFork &&
      previous
    ) {
      previous.editorTransactions.push(
        cloneEditorTransaction(input.editorTransaction),
      );
      return {
        ...previous,
        editorTransactions: [...previous.editorTransactions],
      };
    }
    const patch: CollaborationPrivateTextPatch = {
      patchId: createCollaborationNonce(),
      fileId: input.fileId,
      participantPubkey: this.participantPubkey,
      actorPubkey: input.actorPubkey,
      createdAt: Date.now(),
      reason,
      baseText: input.baseText,
      editorTransactions: [cloneEditorTransaction(input.editorTransaction)],
    };
    this.privatePatchLog.push(patch);
    return {
      ...patch,
      editorTransactions: [...patch.editorTransactions],
    };
  }

  privateTextPatches(): CollaborationPrivateTextPatch[] {
    return this.privatePatchLog.map((patch) => ({
      ...patch,
      editorTransactions: [...patch.editorTransactions],
    }));
  }

  private assertLocalSigner(secretKey: Uint8Array): void {
    if (bytesToHex(schnorr.getPublicKey(secretKey)) !== this.participantPubkey) {
      throw new CollaborationError("secret key does not belong to the local participant");
    }
  }

  private makeBody<K extends CollaborationOperationBody["kind"]>(
    kind: K,
    actorPubkey: string,
    payload: Extract<CollaborationOperationBody, { kind: K }>["payload"],
  ): Extract<CollaborationOperationBody, { kind: K }> {
    return {
      version: COLLABORATION_VERSION,
      collaborationId: this.definition.collaborationId,
      nonce: createCollaborationNonce(),
      participantPubkey: this.participantPubkey,
      actorPubkey,
      timestamp: Date.now(),
      kind,
      payload,
    } as Extract<CollaborationOperationBody, { kind: K }>;
  }

  private acceptLocal<Operation extends CollaborationSignedOperation>(
    operation: Operation,
  ): Operation {
    this.operationHistory.set(operation.operationId, operation);
    this.pendingAccepted.set(operation.operationId, operation);
    const accepted = { operation, source: "local" as const };
    for (const listener of this.acceptedListeners) listener(accepted);
    for (const listener of this.outgoingListeners) listener(operation);
    return operation;
  }

  private acceptRemote(operation: CollaborationSignedOperation): void {
    this.operationHistory.set(operation.operationId, operation);
    this.pendingAccepted.set(operation.operationId, operation);
    const accepted = { operation, source: "remote" as const };
    for (const listener of this.acceptedListeners) listener(accepted);
  }

  private assertMounted(entryId: string): void {
    if (
      !this.hasEntry(entryId) ||
      !pathInMountScope(this.definition.mount, this.pathForEntry(entryId))
    ) {
      throw new CollaborationError(`entry ${entryId} is outside the Collaboration mount`);
    }
  }

  private assertMutableMountedEntry(entryId: string, action: string): void {
    this.assertMounted(entryId);
    if (
      entryId === this.rootId ||
      this.pathForEntry(entryId) === this.definition.mount.mount?.path
    ) {
      throw new CollaborationError(
        `${action} the Collaboration mount root requires a new collaboration`,
      );
    }
  }

  private assertPermission(
    participantPubkey: string,
    actorPubkey: string,
    action: Parameters<typeof permitsCollaborationAction>[4],
    entryId: string | null,
  ): void {
    if (
      !permitsCollaborationAction(
        this.definition,
        this,
        participantPubkey,
        actorPubkey,
        action,
        entryId,
      )
    ) {
      throw new CollaborationError(`${participantPubkey} lacks ${action} permission`);
    }
  }

  private assertSiblingAvailable(
    parentId: string,
    name: string,
    exceptEntryId?: string,
  ): void {
    if (
      this.rawEntries().some(
        (entry) =>
          !entry.deleted &&
          entry.id !== exceptEntryId &&
          entry.parentId === parentId &&
          entry.name === name,
      )
    ) {
      throw new CollaborationError(`entry ${name} already exists in ${parentId}`);
    }
  }

  private assertCreate(
    participant: string,
    actor: string,
    parentId: string,
    name: string,
    requireAvailableName = true,
  ): void {
    assertEntryName(name);
    const parent = this.rawEntry(parentId);
    if (parent.kind !== "folder" || this.isEffectivelyDeleted(parentId)) {
      throw new CollaborationError("new entries require a collaboration folder parent");
    }
    this.assertMounted(parentId);
    this.assertPermission(participant, actor, "folder.create", parentId);
    if (requireAvailableName) this.assertSiblingAvailable(parentId, name);
    const path = [this.pathForEntry(parentId), name].filter(Boolean).join("/");
    if (!pathInMountScope(this.definition.mount, path)) {
      throw new CollaborationError("new entry would be outside the Collaboration mount");
    }
  }

  private assertEditBatch(
    fileId: string,
    actorPubkey: string,
    editorTransactions: readonly EditorTransaction[],
  ): void {
    this.assertMounted(fileId);
    this.assertPermission(
      this.participantPubkey,
      actorPubkey,
      "file.edit",
      fileId,
    );
    if (
      editorTransactions.length === 0 ||
      editorTransactions.some(
        (transaction) =>
          !isEditorTransaction(transaction) ||
          transaction.actor !== actorPubkey ||
          transaction.changes.length === 0,
      ) ||
      editorTransactions.some(
        (transaction, index) =>
          index > 0 &&
          transaction.sequence <= editorTransactions[index - 1].sequence,
      )
    ) {
      throw new CollaborationError(
        "file.edit.batch requires ordered actor-matching text transactions",
      );
    }
  }

  submitEditBatch(
    input: CollaborationEditBatchSubmission,
  ): CollaborationSignedOperationOf<"file.edit.batch"> {
    this.assertLocalSigner(input.secretKey);
    const editorTransactions = input.editorTransactions.map(
      cloneEditorTransaction,
    );
    this.assertEditBatch(
      input.fileId,
      input.actorPubkey,
      editorTransactions,
    );
    const text = this.fileText(input.fileId);
    const before = text.toString();
    const after = textAfterTransactions(before, editorTransactions);
    const verdict = validateEditorTransactionTransition(
      before,
      after,
      editorTransactions,
    );
    if (!verdict.valid) {
      throw new CollaborationError(
        verdict.reason ?? "invalid editor transaction batch",
      );
    }
    const origin = input.origin ?? Symbol("collaboration-local-edit-batch");
    const baseSnapshot = encodedSnapshot(text.doc!);
    const draft = cloneWithUpdate(text.doc!, "");
    try {
      const update = captureYjsUpdate(draft, origin, () => {
        applyEditorTransactions(
          draft.getText(FILE_TEXT_TYPE),
          editorTransactions,
        );
      });
      const operation = signCollaborationOperation(
        this.makeBody("file.edit.batch", input.actorPubkey, {
          fileId: input.fileId,
          baseSnapshot,
          update,
          editorTransactions,
        }),
        input.secretKey,
      );
      validateEditBatchMaterialization(
        text.doc!,
        operation.payload.baseSnapshot,
        operation.payload.update,
        operation.payload.editorTransactions,
      );
      Y.applyUpdate(text.doc!, hexToBytes(update), origin);
      return this.acceptLocal(operation);
    } finally {
      draft.destroy();
    }
  }

  /**
   * Validate one local transaction in an isolated logical draft. The shared
   * Y.Text is not touched until the complete batch has been signed, so a
   * failed or revoked commit cannot leave unsigned collaborative state.
   */
  prepareEditTransaction(
    input: CollaborationEditPreparationInput,
  ): CollaborationPreparedEdit {
    this.assertLocalSigner(input.secretKey);
    const editorTransaction = cloneEditorTransaction(input.editorTransaction);
    this.assertEditBatch(
      input.fileId,
      input.actorPubkey,
      [editorTransaction],
    );
    const text = this.fileText(input.fileId);
    const key = preparedBatchKey(input.fileId, input.actorPubkey);
    let batch = this.preparedEditBatches.get(key);
    const isNewBatch = batch === undefined;
    if (!batch) {
      batch = {
        id: createCollaborationNonce(),
        key,
        fileId: input.fileId,
        actorPubkey: input.actorPubkey,
        baseSnapshot: encodedSnapshot(text.doc!),
        baseText: text.toString(),
        currentText: text.toString(),
        preparationIds: [],
        origin: input.origin ?? Symbol("collaboration-prepared-edit"),
      };
    }
    const beforeText = batch.currentText;
    const afterText = textAfterTransaction(
      beforeText,
      editorTransaction,
    );
    const verdict = validateEditorTransactionTransition(
      beforeText,
      afterText,
      [editorTransaction],
    );
    if (!verdict.valid) {
      throw new CollaborationError(
        verdict.reason ?? "invalid prepared editor transaction",
      );
    }
    if (isNewBatch) this.preparedEditBatches.set(key, batch);
    const edit: CollaborationPreparedEdit = {
      preparationId: createCollaborationNonce(),
      fileId: input.fileId,
      actorPubkey: input.actorPubkey,
      editorTransaction,
    };
    this.preparedEdits.set(edit.preparationId, {
      edit,
      batchId: batch.id,
      beforeText,
      afterText,
    });
    batch.currentText = afterText;
    batch.preparationIds.push(edit.preparationId);
    return {
      ...edit,
      editorTransaction: cloneEditorTransaction(edit.editorTransaction),
    };
  }

  commitPreparedEditBatch(
    input: CollaborationPreparedEditBatchSubmission,
  ): CollaborationSignedOperationOf<"file.edit.batch"> {
    this.assertLocalSigner(input.secretKey);
    if (input.edits.length === 0) {
      throw new CollaborationError("cannot commit an empty prepared edit batch");
    }
    const records = input.edits.map((edit) => {
      const record = this.preparedEdits.get(edit.preparationId);
      if (
        !record ||
        record.edit.fileId !== edit.fileId ||
        record.edit.actorPubkey !== edit.actorPubkey ||
        JSON.stringify(record.edit.editorTransaction) !==
          JSON.stringify(edit.editorTransaction)
      ) {
        throw new CollaborationError("prepared edit is unknown or was altered");
      }
      return record;
    });
    const first = records[0];
    const batch = this.preparedEditBatches.get(
      preparedBatchKey(first.edit.fileId, first.edit.actorPubkey),
    );
    if (
      !batch ||
      records.some((record) => record.batchId !== batch.id) ||
      JSON.stringify(batch.preparationIds) !==
        JSON.stringify(input.edits.map((edit) => edit.preparationId))
    ) {
      throw new CollaborationError(
        "prepared edit commit must contain one complete isolated batch",
      );
    }
    this.assertEditBatch(
      first.edit.fileId,
      first.edit.actorPubkey,
      records.map((record) => record.edit.editorTransaction),
    );
    if (
      records.some(
        (record, index) =>
          record.edit.fileId !== first.edit.fileId ||
          record.edit.actorPubkey !== first.edit.actorPubkey ||
          (
            index > 0 &&
            record.beforeText !== records[index - 1].afterText
          ),
      )
    ) {
      throw new CollaborationError(
        "prepared edit batch crosses a file, actor, or intervening document state",
      );
    }
    const editorTransactions = records.map(
      (record) => record.edit.editorTransaction,
    );
    const verdict = validateEditorTransactionTransition(
      first.beforeText,
      records[records.length - 1].afterText,
      editorTransactions,
    );
    if (!verdict.valid) {
      throw new CollaborationError(
        verdict.reason ?? "invalid prepared editor transaction batch",
      );
    }
    const text = this.fileText(first.edit.fileId);
    if (
      !Y.equalSnapshots(
        Y.snapshot(text.doc!),
        decodeSnapshot(batch.baseSnapshot),
      )
    ) {
      throw new CollaborationError(
        "prepared edit base changed before the batch could be signed",
      );
    }
    const draft = cloneWithUpdate(text.doc!, "");
    try {
      const update = captureYjsUpdate(draft, batch.origin, () => {
        applyEditorTransactions(
          draft.getText(FILE_TEXT_TYPE),
          editorTransactions,
        );
      });
      const operation = signCollaborationOperation(
        this.makeBody("file.edit.batch", first.edit.actorPubkey, {
          fileId: first.edit.fileId,
          baseSnapshot: batch.baseSnapshot,
          update,
          editorTransactions: editorTransactions.map(cloneEditorTransaction),
        }),
        input.secretKey,
      );
      validateEditBatchMaterialization(
        text.doc!,
        operation.payload.baseSnapshot,
        operation.payload.update,
        operation.payload.editorTransactions,
      );
      Y.applyUpdate(text.doc!, hexToBytes(update), batch.origin);
      for (const edit of input.edits) {
        this.preparedEdits.delete(edit.preparationId);
      }
      this.preparedEditBatches.delete(batch.key);
      return this.acceptLocal(operation);
    } finally {
      draft.destroy();
    }
  }

  /**
   * Move an uncommitted isolated batch into participant-private patch state.
   * This is the failure path for revocation or a causal-base conflict.
   */
  abandonPreparedEditBatch(
    edits: readonly CollaborationPreparedEdit[],
    reason: CollaborationPrivateTextPatch["reason"],
  ): CollaborationPrivateTextPatch {
    if (edits.length === 0) {
      throw new CollaborationError("cannot abandon an empty prepared edit batch");
    }
    const records = edits.map((edit) => {
      const record = this.preparedEdits.get(edit.preparationId);
      if (
        !record ||
        record.edit.fileId !== edit.fileId ||
        record.edit.actorPubkey !== edit.actorPubkey ||
        JSON.stringify(record.edit.editorTransaction) !==
          JSON.stringify(edit.editorTransaction)
      ) {
        throw new CollaborationError("prepared edit is unknown or was altered");
      }
      return record;
    });
    const first = records[0];
    const batch = this.preparedEditBatches.get(
      preparedBatchKey(first.edit.fileId, first.edit.actorPubkey),
    );
    if (
      !batch ||
      records.some((record) => record.batchId !== batch.id) ||
      JSON.stringify(batch.preparationIds) !==
        JSON.stringify(edits.map((edit) => edit.preparationId))
    ) {
      throw new CollaborationError(
        "prepared edit abandonment must contain one complete isolated batch",
      );
    }
    const patch: CollaborationPrivateTextPatch = {
      patchId: createCollaborationNonce(),
      fileId: batch.fileId,
      participantPubkey: this.participantPubkey,
      actorPubkey: batch.actorPubkey,
      createdAt: Date.now(),
      reason,
      baseText: batch.baseText,
      editorTransactions: records.map((record) =>
        cloneEditorTransaction(record.edit.editorTransaction)
      ),
    };
    for (const edit of edits) this.preparedEdits.delete(edit.preparationId);
    this.preparedEditBatches.delete(batch.key);
    this.privatePatchLog.push(patch);
    return {
      ...patch,
      editorTransactions: patch.editorTransactions.map(cloneEditorTransaction),
    };
  }

  submitPresence(input: CollaborationPresenceSubmission): CollaborationPresenceState {
    this.assertLocalSigner(input.secretKey);
    this.assertPermission(
      this.participantPubkey,
      input.actorPubkey,
      "presence.write",
      null,
    );
    let selection: CollaborationRelativeSelection | null = null;
    if (input.activeFileId !== null) {
      this.assertMounted(input.activeFileId);
      if (
        !permitsCollaborationRead(
          this.definition,
          this,
          this.participantPubkey,
          input.activeFileId,
        )
      ) {
        throw new CollaborationError("presence cannot reveal an unreadable file");
      }
      if (input.selection) {
        const text = this.fileText(input.activeFileId);
        if (
          input.selection.ranges.some(
            (range) =>
              range.anchor > text.length ||
              range.head > text.length,
          )
        ) {
          throw new CollaborationError("presence selection is outside the file");
        }
        selection = {
          ranges: input.selection.ranges.map((range) => ({
            anchor: relativePositionHex(text, range.anchor),
            head: relativePositionHex(text, range.head),
          })),
          main: input.selection.main,
        };
      }
    } else if (input.selection !== null) {
      throw new CollaborationError("presence selection requires an active file");
    }
    const presence: CollaborationPresenceState = {
      participantPubkey: this.participantPubkey,
      actorPubkey: input.actorPubkey,
      timestamp: Date.now(),
      activeFileId: input.activeFileId,
      selection,
    };
    this.awareness.setLocalState({ live: presence });
    return presence;
  }

  resolvePresenceSelection(
    state: CollaborationPresenceState,
  ): EditorSelectionState | null {
    if (state.activeFileId === null || state.selection === null) return null;
    const doc = this.fileDocs.get(state.activeFileId);
    if (!doc) return null;
    const ranges = state.selection.ranges.map((range) => {
      const anchor = absolutePosition(doc, range.anchor);
      const head = absolutePosition(doc, range.head);
      return anchor === null || head === null ? null : { anchor, head };
    });
    if (ranges.some((range) => range === null)) return null;
    return {
      ranges: ranges as Array<{ anchor: number; head: number }>,
      main: state.selection.main,
    };
  }

  createEntry(
    parentId: string,
    entry: { id: string; kind: "file" | "folder"; name: string; text?: string },
    actorPubkey: string,
    secretKey: Uint8Array,
  ): CollaborationSignedOperation {
    this.assertLocalSigner(secretKey);
    if (this.entries.has(entry.id)) throw new CollaborationError(`entry ${entry.id} already exists`);
    this.assertCreate(this.participantPubkey, actorPubkey, parentId, entry.name);
    if (entry.kind === "folder" && entry.text !== undefined) {
      throw new CollaborationError("folders cannot contain initial text");
    }
    const origin = Symbol("collaboration-local-create");
    const update = captureYjsUpdate(this.directoryDoc, origin, () => {
      this.entries.set(entry.id, createEntryMap({
        id: entry.id,
        kind: entry.kind,
        parentId,
        name: entry.name,
      }));
    });
    let fileUpdate: string | undefined;
    if (entry.kind === "file") {
      const doc = new Y.Doc({
        guid: `${this.definition.collaborationId}:file:${entry.id}`,
        gc: false,
      });
      if (entry.text) doc.getText(FILE_TEXT_TYPE).insert(0, entry.text);
      this.fileDocs.set(entry.id, doc);
      fileUpdate = bytesToHex(Y.encodeStateAsUpdate(doc));
    }
    const operation = signCollaborationOperation(
      this.makeBody("entry.create", actorPubkey, {
        entryId: entry.id,
        parentId,
        entryKind: entry.kind,
        name: entry.name,
        update,
        ...(fileUpdate === undefined ? {} : { fileUpdate }),
      }),
      secretKey,
    );
    return this.acceptLocal(operation);
  }

  renameEntry(
    entryId: string,
    name: string,
    actorPubkey: string,
    secretKey: Uint8Array,
  ): CollaborationSignedOperation {
    this.assertLocalSigner(secretKey);
    assertEntryName(name);
    this.assertMutableMountedEntry(entryId, "renaming");
    this.assertPermission(this.participantPubkey, actorPubkey, "entry.rename", entryId);
    const entry = this.rawEntry(entryId);
    this.assertSiblingAvailable(entry.parentId!, name, entryId);
    const parentPath = this.pathForEntry(entry.parentId!);
    const nextPath = [parentPath, name].filter(Boolean).join("/");
    if (!pathInMountScope(this.definition.mount, nextPath)) {
      throw new CollaborationError("rename would move the entry outside the Collaboration mount");
    }
    const origin = Symbol("collaboration-local-rename");
    const update = captureYjsUpdate(this.directoryDoc, origin, () => {
      (this.entries.get(entryId) as Y.Map<unknown>).set("name", name);
    });
    const operation = signCollaborationOperation(
      this.makeBody("entry.rename", actorPubkey, { entryId, name, update }),
      secretKey,
    );
    return this.acceptLocal(operation);
  }

  moveEntry(
    entryId: string,
    parentId: string,
    actorPubkey: string,
    secretKey: Uint8Array,
  ): CollaborationSignedOperation {
    this.assertLocalSigner(secretKey);
    this.assertMutableMountedEntry(entryId, "moving");
    this.assertMounted(parentId);
    const entry = this.rawEntry(entryId);
    const parent = this.rawEntry(parentId);
    if (parent.kind !== "folder" || this.isEffectivelyDeleted(parentId)) {
      throw new CollaborationError("move destination must be a collaboration folder");
    }
    if (this.isDescendantOrSelf(parentId, entryId)) {
      throw new CollaborationError("cannot move an entry into its own subtree");
    }
    this.assertPermission(this.participantPubkey, actorPubkey, "entry.move", entryId);
    this.assertPermission(this.participantPubkey, actorPubkey, "folder.create", parentId);
    this.assertSiblingAvailable(parentId, entry.name, entryId);
    const nextPath = [this.pathForEntry(parentId), entry.name].filter(Boolean).join("/");
    if (!pathInMountScope(this.definition.mount, nextPath)) {
      throw new CollaborationError("move would place the entry outside the Collaboration mount");
    }
    const origin = Symbol("collaboration-local-move");
    const update = captureYjsUpdate(this.directoryDoc, origin, () => {
      (this.entries.get(entryId) as Y.Map<unknown>).set("parentId", parentId);
    });
    const operation = signCollaborationOperation(
      this.makeBody("entry.move", actorPubkey, { entryId, parentId, update }),
      secretKey,
    );
    return this.acceptLocal(operation);
  }

  deleteEntry(
    entryId: string,
    actorPubkey: string,
    secretKey: Uint8Array,
  ): CollaborationSignedOperation {
    this.assertLocalSigner(secretKey);
    this.assertMutableMountedEntry(entryId, "deleting");
    this.assertPermission(this.participantPubkey, actorPubkey, "entry.delete", entryId);
    const origin = Symbol("collaboration-local-delete");
    const update = captureYjsUpdate(this.directoryDoc, origin, () => {
      (this.entries.get(entryId) as Y.Map<unknown>).set("deleted", true);
    });
    const operation = signCollaborationOperation(
      this.makeBody("entry.delete", actorPubkey, { entryId, update }),
      secretKey,
    );
    return this.acceptLocal(operation);
  }

  private validateDirectoryOperation(operation: CollaborationSignedOperation): void {
    if (
      operation.kind !== "entry.create" &&
      operation.kind !== "entry.rename" &&
      operation.kind !== "entry.move" &&
      operation.kind !== "entry.delete"
    ) {
      throw new CollaborationError("operation is not a directory mutation");
    }
    const before = directorySnapshot(this.directoryDoc);
    const next = cloneWithUpdate(this.directoryDoc, operation.payload.update);
    try {
      const after = directorySnapshot(next);
      const changed = changedDirectoryEntries(before, after);
      const targetId = operation.payload.entryId;
      if (changed.size !== 1 || !changed.has(targetId)) {
        throw new CollaborationError(
          "directory update must mutate exactly its signed target",
        );
      }
      if (operation.kind === "entry.create") {
        if (before.has(targetId)) {
          throw new CollaborationError("directory create target already exists");
        }
        const created = this.rawEntry(targetId, next);
        if (
          created.deleted ||
          created.parentId !== operation.payload.parentId ||
          created.kind !== operation.payload.entryKind ||
          created.name !== operation.payload.name
        ) {
          throw new CollaborationError("directory create update disagrees with its payload");
        }
      } else {
        if (!before.has(targetId)) {
          throw new CollaborationError("directory mutation target does not exist");
        }
        const prior = JSON.parse(before.get(targetId)!) as DirectoryEntryState;
        const result = this.rawEntry(targetId, next);
        const expected = operation.kind === "entry.rename"
          ? { ...prior, name: operation.payload.name }
          : operation.kind === "entry.move"
            ? { ...prior, parentId: operation.payload.parentId }
            : { ...prior, deleted: true };
        if (JSON.stringify(result) !== JSON.stringify(expected)) {
          throw new CollaborationError("directory update disagrees with its typed payload");
        }
      }
    } finally {
      next.destroy();
    }
  }

  private authorizeIncoming(operation: CollaborationSignedOperation): void {
    if (operation.collaborationId !== this.definition.collaborationId) {
      throw new CollaborationError("operation belongs to another Collaboration");
    }
    assertParticipant(this.definition, operation.participantPubkey);
    switch (operation.kind) {
      case "file.edit.batch":
        this.assertMounted(operation.payload.fileId);
        this.assertPermission(
          operation.participantPubkey,
          operation.actorPubkey,
          "file.edit",
          operation.payload.fileId,
        );
        if (
          operation.payload.editorTransactions.some(
            (transaction) => transaction.actor !== operation.actorPubkey,
          )
        ) {
          throw new CollaborationError(
            "file edit batch actor does not match its envelope",
          );
        }
        return;
      case "entry.create":
        if (this.entries.has(operation.payload.entryId)) {
          throw new CollaborationError("entry id already exists");
        }
        this.assertCreate(
          operation.participantPubkey,
          operation.actorPubkey,
          operation.payload.parentId,
          operation.payload.name,
          false,
        );
        return;
      case "entry.rename": {
        this.assertMutableMountedEntry(operation.payload.entryId, "renaming");
        this.assertPermission(
          operation.participantPubkey,
          operation.actorPubkey,
          "entry.rename",
          operation.payload.entryId,
        );
        const entry = this.rawEntry(operation.payload.entryId);
        assertEntryName(operation.payload.name);
        const nextPath = [
          this.pathForEntry(entry.parentId!),
          operation.payload.name,
        ].filter(Boolean).join("/");
        if (!pathInMountScope(this.definition.mount, nextPath)) {
          throw new CollaborationError("rename would leave the Collaboration mount");
        }
        return;
      }
      case "entry.move": {
        this.assertMutableMountedEntry(operation.payload.entryId, "moving");
        this.assertMounted(operation.payload.parentId);
        this.assertPermission(
          operation.participantPubkey,
          operation.actorPubkey,
          "entry.move",
          operation.payload.entryId,
        );
        this.assertPermission(
          operation.participantPubkey,
          operation.actorPubkey,
          "folder.create",
          operation.payload.parentId,
        );
        const entry = this.rawEntry(operation.payload.entryId);
        const parent = this.rawEntry(operation.payload.parentId);
        if (
          parent.kind !== "folder" ||
          this.isDescendantOrSelf(operation.payload.parentId, operation.payload.entryId)
        ) {
          throw new CollaborationError("invalid directory move");
        }
        const nextPath = [
          this.pathForEntry(operation.payload.parentId),
          entry.name,
        ].filter(Boolean).join("/");
        if (!pathInMountScope(this.definition.mount, nextPath)) {
          throw new CollaborationError("move would leave the Collaboration mount");
        }
        return;
      }
      case "entry.delete":
        this.assertMutableMountedEntry(operation.payload.entryId, "deleting");
        this.assertPermission(
          operation.participantPubkey,
          operation.actorPubkey,
          "entry.delete",
          operation.payload.entryId,
        );
        return;
    }
  }

  canReceive(operation: CollaborationSignedOperation): boolean {
    return operation.kind !== "file.edit.batch" ||
      permitsCollaborationRead(
        this.definition,
        this,
        this.participantPubkey,
        operation.payload.fileId,
      );
  }

  receive(value: unknown): boolean {
    if (!verifyCollaborationOperation(value)) {
      throw new CollaborationError("rejected an invalid Collaboration signature");
    }
    const operation = value;
    if (this.operationHistory.has(operation.operationId)) return false;
    this.authorizeIncoming(operation);
    if (!this.canReceive(operation)) return false;

    if (operation.kind === "file.edit.batch") {
      const text = this.fileText(operation.payload.fileId);
      validateEditBatchMaterialization(
        text.doc!,
        operation.payload.baseSnapshot,
        operation.payload.update,
        operation.payload.editorTransactions,
      );
      for (const listener of this.beforeRemoteOperationListeners) {
        listener(operation);
      }
      const origin: CollaborationRemoteYjsOrigin = {
        kind: "collaboration-operation",
        source: "remote",
        operation,
      };
      Y.applyUpdate(text.doc!, hexToBytes(operation.payload.update), origin);
    } else {
      this.validateDirectoryOperation(operation);
      let createdFileDoc: Y.Doc | null = null;
      if (
        operation.kind === "entry.create" &&
        operation.payload.entryKind === "file"
      ) {
        createdFileDoc = new Y.Doc({
          guid: `${this.definition.collaborationId}:file:${operation.payload.entryId}`,
          gc: false,
        });
        Y.applyUpdate(
          createdFileDoc,
          hexToBytes(operation.payload.fileUpdate!),
        );
        if (
          [...createdFileDoc.share.keys()].some((key) => key !== FILE_TEXT_TYPE)
        ) {
          createdFileDoc.destroy();
          throw new CollaborationError(
            "new file update introduced an unknown shared type",
          );
        }
      }
      const origin: CollaborationRemoteYjsOrigin = {
        kind: "collaboration-operation",
        source: "remote",
        operation,
      };
      Y.applyUpdate(
        this.directoryDoc,
        hexToBytes(operation.payload.update),
        origin,
      );
      if (operation.kind === "entry.create" && createdFileDoc) {
        if (
          permitsCollaborationRead(
            this.definition,
            this,
            this.participantPubkey,
            operation.payload.entryId,
          )
        ) {
          this.fileDocs.set(operation.payload.entryId, createdFileDoc);
        } else {
          createdFileDoc.destroy();
        }
      }
    }
    this.acceptRemote(operation);
    return true;
  }

  bootstrapFor(
    participantPubkey: string,
    ownerSecretKey: Uint8Array,
  ): CollaborationBootstrap {
    if (this.participantPubkey !== this.definition.ownerPubkey) {
      throw new CollaborationError("only the collaboration owner can issue a bootstrap");
    }
    this.assertLocalSigner(ownerSecretKey);
    assertParticipant(this.definition, participantPubkey);
    const fileUpdates: Record<string, string> = {};
    for (const entry of this.listEntries()) {
      if (
        entry.kind !== "file" ||
        !permitsCollaborationRead(this.definition, this, participantPubkey, entry.id)
      ) continue;
      const doc = this.fileDocs.get(entry.id);
      if (doc) fileUpdates[entry.id] = bytesToHex(Y.encodeStateAsUpdate(doc));
    }
    const canShareOperation = (operation: CollaborationSignedOperation) =>
      operation.kind !== "file.edit.batch" ||
      permitsCollaborationRead(
        this.definition,
        this,
        participantPubkey,
        operation.payload.fileId,
      );
    const operationHistory = this.replayOperations().filter(canShareOperation);
    const acceptedOperations = this.acceptedOperations().filter(canShareOperation);
    const body: CollaborationBootstrapBody = {
      recipientPubkey: participantPubkey,
      nonce: createCollaborationNonce(),
      timestamp: Date.now(),
      definition: cloneDefinition(this.definition),
      directoryUpdate: bytesToHex(Y.encodeStateAsUpdate(this.directoryDoc)),
      fileUpdates,
      operationHistory,
      acceptedOperations,
    };
    return signCollaborationBootstrap(body, ownerSecretKey);
  }

  destroy(): void {
    this.awareness.off("change", this.handleAwarenessChange);
    this.awareness.off("update", this.handleAwarenessUpdate);
    this.awareness.destroy();
    this.directoryDoc.destroy();
    for (const doc of this.fileDocs.values()) doc.destroy();
    this.preparedEdits.clear();
    this.preparedEditBatches.clear();
    this.acceptedListeners.clear();
    this.outgoingListeners.clear();
    this.beforeRemoteOperationListeners.clear();
    this.awarenessOutgoingListeners.clear();
    this.presenceListeners.clear();
  }
}

/**
 * Test/local transport for the same signed operations a WebRTC or relay
 * provider would carry. It synchronizes collaboration data only; no panel/layout
 * object is accepted or observed.
 */
export function connectCollaborationReplicas(
  left: CollaborationReplica,
  right: CollaborationReplica,
): () => void {
  if (left.definition.collaborationId !== right.definition.collaborationId) {
    throw new CollaborationError("cannot connect replicas from different collaborations");
  }
  const leftToRight = left.subscribeOutgoing((operation) => {
    if (right.canReceive(operation)) right.receive(operation);
  });
  const rightToLeft = right.subscribeOutgoing((operation) => {
    if (left.canReceive(operation)) left.receive(operation);
  });
  const leftAwarenessToRight = left.subscribeAwarenessOutgoing((update) => {
    right.receiveAwarenessUpdate(update, left.participantPubkey);
  });
  const rightAwarenessToLeft = right.subscribeAwarenessOutgoing((update) => {
    left.receiveAwarenessUpdate(update, right.participantPubkey);
  });
  // Reconnect catch-up replays signed actor boundaries rather than
  // exchanging one merged update whose authors could no longer be recovered.
  for (const operation of left.replayOperations()) {
    if (right.canReceive(operation)) right.receive(operation);
  }
  for (const operation of right.replayOperations()) {
    if (left.canReceive(operation)) left.receive(operation);
  }
  if (left.awareness.getLocalState() !== null) {
    right.receiveAwarenessUpdate(
      encodeAwarenessUpdate(left.awareness, [left.awareness.clientID]),
      left.participantPubkey,
    );
  }
  if (right.awareness.getLocalState() !== null) {
    left.receiveAwarenessUpdate(
      encodeAwarenessUpdate(right.awareness, [right.awareness.clientID]),
      right.participantPubkey,
    );
  }
  return () => {
    leftToRight();
    rightToLeft();
    leftAwarenessToRight();
    rightAwarenessToLeft();
    removeAwarenessStates(
      right.awareness,
      [left.awareness.clientID],
      "peer-disconnect",
    );
    removeAwarenessStates(
      left.awareness,
      [right.awareness.clientID],
      "peer-disconnect",
    );
  };
}
