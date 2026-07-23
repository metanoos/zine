import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import {
  canonicalBytes,
  isEditorTransaction,
  type CanonicalJsonValue,
  type EditorTransaction,
} from "@zine/protocol";

import {
  COLLABORATION_VERSION,
  type CollaborationOperationBody,
  type CollaborationBootstrap,
  type CollaborationBootstrapBody,
  type CollaborationSignedOperation,
  type SignedCollaborationOperation,
} from "./collaboration-types.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const HEX_BYTES = /^(?:[0-9a-f]{2})*$/;
const HEX_NONCE = /^[0-9a-f]{32}$/;

function hasExactKeys(
  value: object,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBaseBody(value: Record<string, unknown>): boolean {
  return (
    value.version === COLLABORATION_VERSION &&
    typeof value.collaborationId === "string" &&
    value.collaborationId.length > 0 &&
    typeof value.nonce === "string" &&
    HEX_NONCE.test(value.nonce) &&
    typeof value.participantPubkey === "string" &&
    HEX_32.test(value.participantPubkey) &&
    typeof value.actorPubkey === "string" &&
    HEX_32.test(value.actorPubkey) &&
    typeof value.timestamp === "number" &&
    Number.isFinite(value.timestamp) &&
    value.timestamp >= 0
  );
}

function isUpdate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && HEX_BYTES.test(value);
}

function isEditorTransactionBatch(value: unknown): value is EditorTransaction[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every(isEditorTransaction)
  ) return false;
  return value.every(
    (transaction, index) =>
      index === 0 ||
      transaction.sequence > value[index - 1].sequence,
  );
}

function isCollaborationPayload(kind: CollaborationOperationBody["kind"], value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (kind) {
    case "file.edit.batch":
      return (
        hasExactKeys(
          value,
          ["fileId", "baseSnapshot", "update", "editorTransactions"],
        ) &&
        typeof value.fileId === "string" &&
        value.fileId.length > 0 &&
        isUpdate(value.baseSnapshot) &&
        isUpdate(value.update) &&
        isEditorTransactionBatch(value.editorTransactions)
      );
    case "entry.create":
      return (
        hasExactKeys(
          value,
          ["entryId", "parentId", "entryKind", "name", "update"],
          ["fileUpdate"],
        ) &&
        typeof value.entryId === "string" &&
        value.entryId.length > 0 &&
        typeof value.parentId === "string" &&
        value.parentId.length > 0 &&
        (value.entryKind === "file" || value.entryKind === "folder") &&
        typeof value.name === "string" &&
        isUpdate(value.update) &&
        (value.fileUpdate === undefined || isUpdate(value.fileUpdate)) &&
        ((value.entryKind === "file") === (value.fileUpdate !== undefined))
      );
    case "entry.rename":
      return (
        hasExactKeys(value, ["entryId", "name", "update"]) &&
        typeof value.entryId === "string" &&
        value.entryId.length > 0 &&
        typeof value.name === "string" &&
        isUpdate(value.update)
      );
    case "entry.move":
      return (
        hasExactKeys(value, ["entryId", "parentId", "update"]) &&
        typeof value.entryId === "string" &&
        value.entryId.length > 0 &&
        typeof value.parentId === "string" &&
        value.parentId.length > 0 &&
        isUpdate(value.update)
      );
    case "entry.delete":
      return (
        hasExactKeys(value, ["entryId", "update"]) &&
        typeof value.entryId === "string" &&
        value.entryId.length > 0 &&
        isUpdate(value.update)
      );
  }
}

export function isCollaborationOperationBody(value: unknown): value is CollaborationOperationBody {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(
    value,
    [
      "version",
      "collaborationId",
      "nonce",
      "participantPubkey",
      "actorPubkey",
      "timestamp",
      "kind",
      "payload",
    ],
  )) return false;
  if (!isBaseBody(value)) return false;
  if (
    value.kind !== "file.edit.batch" &&
    value.kind !== "entry.create" &&
    value.kind !== "entry.rename" &&
    value.kind !== "entry.move" &&
    value.kind !== "entry.delete"
  ) return false;
  if (!isCollaborationPayload(value.kind, value.payload)) return false;
  return value.kind !== "file.edit.batch" ||
    (value.payload as { editorTransactions: EditorTransaction[] })
      .editorTransactions.every(
        (transaction) => transaction.actor === value.actorPubkey,
      );
}

export function isCollaborationSignedOperation(value: unknown): value is CollaborationSignedOperation {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(
    value,
    [
      "version",
      "collaborationId",
      "nonce",
      "participantPubkey",
      "actorPubkey",
      "timestamp",
      "kind",
      "payload",
      "operationId",
      "signature",
    ],
  )) return false;
  const { operationId, signature, ...body } = value;
  return (
    isCollaborationOperationBody(body) &&
    typeof operationId === "string" &&
    HEX_32.test(operationId) &&
    typeof signature === "string" &&
    HEX_64.test(signature)
  );
}

function operationDigest(body: CollaborationOperationBody): Uint8Array {
  return sha256(canonicalBytes(body as unknown as CanonicalJsonValue));
}

/**
 * Stable identity for one collaboration mutation, independent of transport
 * retry entropy and wall-clock time.
 */
export function collaborationOperationSemanticId(
  operation: CollaborationSignedOperation,
): string {
  if (!verifyCollaborationOperation(operation)) {
    throw new TypeError(
      "cannot fingerprint a malformed Collaboration operation",
    );
  }
  const {
    nonce: _nonce,
    timestamp: _timestamp,
    operationId: _operationId,
    signature: _signature,
    ...semanticBody
  } = operation;
  return bytesToHex(
    sha256(
      canonicalBytes(semanticBody as unknown as CanonicalJsonValue),
    ),
  );
}

export function createCollaborationNonce(): string {
  return bytesToHex(randomBytes(16));
}

export function signCollaborationOperation<Body extends CollaborationOperationBody>(
  body: Body,
  secretKey: Uint8Array,
): SignedCollaborationOperation<Body> {
  if (!isCollaborationOperationBody(body)) {
    throw new TypeError("refusing to sign a malformed Collaboration operation");
  }
  const publicKey = bytesToHex(schnorr.getPublicKey(secretKey));
  if (publicKey !== body.participantPubkey) {
    throw new Error("Collaboration signer does not match participantPubkey");
  }
  const digest = operationDigest(body);
  return {
    ...body,
    operationId: bytesToHex(digest),
    signature: bytesToHex(schnorr.sign(digest, secretKey)),
  } as SignedCollaborationOperation<Body>;
}

export function verifyCollaborationOperation(value: unknown): value is CollaborationSignedOperation {
  if (!isCollaborationSignedOperation(value)) return false;
  const {
    operationId,
    signature,
    ...body
  } = value;
  const digest = operationDigest(body as CollaborationOperationBody);
  return (
    bytesToHex(digest) === operationId &&
    schnorr.verify(
      hexToBytes(signature),
      digest,
      hexToBytes(value.participantPubkey),
    )
  );
}

function isBootstrapBody(value: unknown): value is CollaborationBootstrapBody {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(
    value,
    [
      "recipientPubkey",
      "nonce",
      "timestamp",
      "definition",
      "directoryUpdate",
      "fileUpdates",
      "operationHistory",
      "acceptedOperations",
    ],
  )) return false;
  const definition = value.definition;
  if (
    typeof value.recipientPubkey !== "string" ||
    !HEX_32.test(value.recipientPubkey) ||
    typeof value.nonce !== "string" ||
    !HEX_NONCE.test(value.nonce) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    value.timestamp < 0 ||
    !isRecord(definition) ||
    definition.version !== COLLABORATION_VERSION ||
    typeof definition.collaborationId !== "string" ||
    definition.collaborationId.length === 0 ||
    typeof definition.ownerPubkey !== "string" ||
    !HEX_32.test(definition.ownerPubkey) ||
    !isUpdate(value.directoryUpdate) ||
    !isRecord(value.fileUpdates) ||
    Object.entries(value.fileUpdates).some(
      ([fileId, update]) => fileId.length === 0 || !isUpdate(update),
    ) ||
    !Array.isArray(value.operationHistory) ||
    !value.operationHistory.every(verifyCollaborationOperation) ||
    !Array.isArray(value.acceptedOperations) ||
    !value.acceptedOperations.every(verifyCollaborationOperation)
  ) return false;
  const collaborationId = definition.collaborationId;
  return [...value.operationHistory, ...value.acceptedOperations].every(
    (operation) => operation.collaborationId === collaborationId,
  );
}

function bootstrapDigest(body: CollaborationBootstrapBody): Uint8Array {
  return sha256(canonicalBytes(body as unknown as CanonicalJsonValue));
}

export function signCollaborationBootstrap(
  body: CollaborationBootstrapBody,
  ownerSecretKey: Uint8Array,
): CollaborationBootstrap {
  if (!isBootstrapBody(body)) {
    throw new TypeError("refusing to sign a malformed Collaboration bootstrap");
  }
  const publicKey = bytesToHex(schnorr.getPublicKey(ownerSecretKey));
  if (publicKey !== body.definition.ownerPubkey) {
    throw new Error("Collaboration bootstrap signer is not the collaboration owner");
  }
  const digest = bootstrapDigest(body);
  return {
    ...body,
    bootstrapId: bytesToHex(digest),
    signature: bytesToHex(schnorr.sign(digest, ownerSecretKey)),
  };
}

export function verifyCollaborationBootstrap(
  value: unknown,
): value is CollaborationBootstrap {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(
    value,
    [
      "recipientPubkey",
      "nonce",
      "timestamp",
      "definition",
      "directoryUpdate",
      "fileUpdates",
      "operationHistory",
      "acceptedOperations",
      "bootstrapId",
      "signature",
    ],
  )) return false;
  const { bootstrapId, signature, ...body } = value;
  if (
    !isBootstrapBody(body) ||
    typeof bootstrapId !== "string" ||
    !HEX_32.test(bootstrapId) ||
    typeof signature !== "string" ||
    !HEX_64.test(signature)
  ) return false;
  const digest = bootstrapDigest(body);
  return (
    bytesToHex(digest) === bootstrapId &&
    schnorr.verify(
      hexToBytes(signature),
      digest,
      hexToBytes(body.definition.ownerPubkey),
    )
  );
}
