import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
} from "@noble/hashes/utils.js";
import {
  canonicalBytes,
  isEditorSelectionState,
  type CanonicalJsonValue,
} from "@zine/protocol";

import { REPLAY_SPEEDS } from "../replay/replay-speed.js";
import {
  STAGE_VERSION,
  type StageControlTransfer,
  type StageSessionSnapshot,
  type StageViewState,
} from "./stage-types.js";

const HEX_32 = /^[0-9a-f]{64}$/;
const HEX_64 = /^[0-9a-f]{128}$/;
const HEX_NONCE = /^[0-9a-f]{32}$/;

interface StageCommandBase {
  version: typeof STAGE_VERSION;
  stageId: string;
  collaborationId: string;
  nonce: string;
  participantPubkey: string;
  timestamp: number;
  /**
   * Optimistic concurrency against `snapshot.view.revision`. Every accepted
   * command, including controller lifecycle changes, advances that revision.
   */
  expectedRevision: number;
  /**
   * Cryptographic identity of the exact shared snapshot this command extends.
   * Concurrent commands may occupy the same revision, so the revision alone
   * is not a sufficient parent pointer.
   */
  expectedStateHash: string | null;
}

export type StageCommandBody =
  | StageCommandBase & {
      kind: "stage.start";
      payload: { view: StageViewState };
    }
  | StageCommandBase & {
      kind: "stage.view.update";
      payload: { view: StageViewState };
    }
  | StageCommandBase & {
      kind: "stage.control.request";
      payload: {
        transferId: string;
        toPubkey: string;
      };
    }
  | StageCommandBase & {
      kind: "stage.control.accept";
      payload: { transferId: string };
    }
  | StageCommandBase & {
      kind: "stage.control.cancel";
      payload: { transferId: string };
    }
  | StageCommandBase & {
      kind: "stage.recover";
      payload: Record<string, never>;
    }
  | StageCommandBase & {
      kind: "stage.end";
      payload: Record<string, never>;
    };

export type SignedStageCommand<Body extends StageCommandBody> =
  Body extends StageCommandBody
    ? Body & {
        commandId: string;
        signature: string;
      }
    : never;

export type StageSignedCommand = SignedStageCommand<StageCommandBody>;

export type StageSignedCommandOf<Kind extends StageCommandBody["kind"]> =
  Extract<StageSignedCommand, { kind: Kind }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function isPubkey(value: unknown): value is string {
  return typeof value === "string" && HEX_32.test(value);
}

function isResource(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["entryId", "kind"]) &&
    typeof value.entryId === "string" &&
    value.entryId.length > 0 &&
    (value.kind === "file" || value.kind === "folder")
  );
}

function isWorkingPresentation(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["kind", "resource", "mode"]) &&
    value.kind === "working" &&
    isResource(value.resource) &&
    (
      value.mode === "preview" ||
      value.mode === "markdown" ||
      value.mode === "diff"
    )
  );
}

function isReplayPresentation(value: unknown): boolean {
  const playhead = isRecord(value) && isRecord(value.playhead)
    ? value.playhead
    : null;
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["kind", "replayId", "traces", "playhead", "returnTo"],
    ) ||
    value.kind !== "replay" ||
    typeof value.replayId !== "string" ||
    value.replayId.length === 0 ||
    !Array.isArray(value.traces) ||
    value.traces.length === 0 ||
    playhead === null ||
    !hasExactKeys(playhead, ["status", "at", "speed"]) ||
    (
      playhead.status !== "paused" &&
      playhead.status !== "playing"
    ) ||
    !isFiniteNonNegative(playhead.at) ||
    !REPLAY_SPEEDS.some((speed) => speed === playhead.speed) ||
    !isWorkingPresentation(value.returnTo)
  ) return false;

  const traceIds = new Set<string>();
  for (const trace of value.traces) {
    if (
      !isRecord(trace) ||
      !hasExactKeys(trace, ["entryId", "traceId"]) ||
      typeof trace.entryId !== "string" ||
      trace.entryId.length === 0 ||
      typeof trace.traceId !== "string" ||
      trace.traceId.length === 0 ||
      traceIds.has(trace.traceId)
    ) return false;
    traceIds.add(trace.traceId);
  }
  return true;
}

function isPresentation(value: unknown): boolean {
  return isWorkingPresentation(value) || isReplayPresentation(value);
}

function isPanel(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "panelId",
        "presentation",
        "selection",
        "scrollAnchor",
        "folds",
        "previewAnchor",
      ],
    ) ||
    typeof value.panelId !== "string" ||
    value.panelId.length === 0 ||
    !isPresentation(value.presentation) ||
    (
      value.selection !== null &&
      !isEditorSelectionState(value.selection)
    ) ||
    !Array.isArray(value.folds)
  ) return false;

  if (value.scrollAnchor !== null) {
    if (
      !isRecord(value.scrollAnchor) ||
      !hasExactKeys(value.scrollAnchor, ["position", "offset"]) ||
      !isNonNegativeInteger(value.scrollAnchor.position) ||
      !isFiniteNonNegative(value.scrollAnchor.offset)
    ) return false;
  }

  let previousTo = -1;
  for (const fold of value.folds) {
    if (
      !isRecord(fold) ||
      !hasExactKeys(fold, ["from", "to"]) ||
      !isNonNegativeInteger(fold.from) ||
      !isNonNegativeInteger(fold.to) ||
      fold.to <= fold.from ||
      fold.from < previousTo
    ) return false;
    previousTo = fold.to;
  }

  return (
    value.previewAnchor === null ||
    (
      isRecord(value.previewAnchor) &&
      hasExactKeys(value.previewAnchor, ["key", "offset"]) &&
      typeof value.previewAnchor.key === "string" &&
      value.previewAnchor.key.length > 0 &&
      isFiniteNonNegative(value.previewAnchor.offset)
    )
  );
}

/** Strict, closed validation for the only Stage view version we understand. */
export function isStageViewState(value: unknown): value is StageViewState {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ["version", "revision", "panels", "activePanelId", "arrangement"],
    ) ||
    value.version !== STAGE_VERSION ||
    !isNonNegativeInteger(value.revision) ||
    !Array.isArray(value.panels) ||
    (value.panels.length !== 1 && value.panels.length !== 2) ||
    !value.panels.every(isPanel) ||
    typeof value.activePanelId !== "string"
  ) return false;

  const panelIds = value.panels.map((panel) => panel.panelId);
  if (
    new Set(panelIds).size !== panelIds.length ||
    !panelIds.includes(value.activePanelId)
  ) return false;

  if (value.panels.length === 1) return value.arrangement === null;
  return (
    isRecord(value.arrangement) &&
    hasExactKeys(value.arrangement, ["direction", "primaryRatio"]) &&
    (
      value.arrangement.direction === "row" ||
      value.arrangement.direction === "column"
    ) &&
    typeof value.arrangement.primaryRatio === "number" &&
    Number.isFinite(value.arrangement.primaryRatio) &&
    value.arrangement.primaryRatio > 0 &&
    value.arrangement.primaryRatio < 1
  );
}

function isTransfer(value: unknown): value is StageControlTransfer {
  return (
    isRecord(value) &&
    hasExactKeys(
      value,
      ["transferId", "fromPubkey", "toPubkey", "requestedAt"],
    ) &&
    typeof value.transferId === "string" &&
    HEX_NONCE.test(value.transferId) &&
    isPubkey(value.fromPubkey) &&
    isPubkey(value.toPubkey) &&
    value.fromPubkey !== value.toPubkey &&
    isFiniteNonNegative(value.requestedAt)
  );
}

/**
 * Validate a locally persisted current snapshot. Snapshots are not a wire
 * authentication substitute: remote peers must exchange signed commands.
 */
export function isStageSessionSnapshot(
  value: unknown,
): value is StageSessionSnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "version",
        "stageId",
        "collaborationId",
        "ownerPubkey",
        "controllerPubkey",
        "status",
        "view",
        "pendingControlTransfer",
        "controllerDisconnectedAt",
        "updatedAt",
      ],
    ) ||
    value.version !== STAGE_VERSION ||
    typeof value.stageId !== "string" ||
    value.stageId.length === 0 ||
    typeof value.collaborationId !== "string" ||
    value.collaborationId.length === 0 ||
    !isPubkey(value.ownerPubkey) ||
    (
      value.controllerPubkey !== null &&
      !isPubkey(value.controllerPubkey)
    ) ||
    (
      value.status !== "active" &&
      value.status !== "vacant" &&
      value.status !== "ended"
    ) ||
    !isStageViewState(value.view) ||
    (
      value.pendingControlTransfer !== null &&
      !isTransfer(value.pendingControlTransfer)
    ) ||
    (
      value.controllerDisconnectedAt !== null &&
      !isFiniteNonNegative(value.controllerDisconnectedAt)
    ) ||
    !isFiniteNonNegative(value.updatedAt)
  ) return false;

  if (value.status === "active" && value.controllerPubkey === null) return false;
  if (value.status !== "active" && value.controllerPubkey !== null) return false;
  if (
    value.pendingControlTransfer !== null &&
    (
      value.status !== "active" ||
      value.pendingControlTransfer.fromPubkey !== value.controllerPubkey
    )
  ) return false;
  return (
    value.controllerDisconnectedAt === null ||
    value.status === "active"
  );
}

/** Stable identity for the complete shared state a Stage command extends. */
export function stageSessionSnapshotHash(
  snapshot: StageSessionSnapshot,
): string {
  return bytesToHex(
    sha256(canonicalBytes(snapshot as unknown as CanonicalJsonValue)),
  );
}

function isPayload(
  kind: StageCommandBody["kind"],
  value: unknown,
): boolean {
  if (!isRecord(value)) return false;
  switch (kind) {
    case "stage.start":
    case "stage.view.update":
      return (
        hasExactKeys(value, ["view"]) &&
        isStageViewState(value.view)
      );
    case "stage.control.request":
      return (
        hasExactKeys(value, ["transferId", "toPubkey"]) &&
        typeof value.transferId === "string" &&
        HEX_NONCE.test(value.transferId) &&
        isPubkey(value.toPubkey)
      );
    case "stage.control.accept":
    case "stage.control.cancel":
      return (
        hasExactKeys(value, ["transferId"]) &&
        typeof value.transferId === "string" &&
        HEX_NONCE.test(value.transferId)
      );
    case "stage.recover":
    case "stage.end":
      return hasExactKeys(value, []);
  }
}

export function isStageCommandBody(value: unknown): value is StageCommandBody {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "version",
        "stageId",
        "collaborationId",
        "nonce",
        "participantPubkey",
        "timestamp",
        "expectedRevision",
        "expectedStateHash",
        "kind",
        "payload",
      ],
    ) ||
    value.version !== STAGE_VERSION ||
    typeof value.stageId !== "string" ||
    value.stageId.length === 0 ||
    typeof value.collaborationId !== "string" ||
    value.collaborationId.length === 0 ||
    typeof value.nonce !== "string" ||
    !HEX_NONCE.test(value.nonce) ||
    !isPubkey(value.participantPubkey) ||
    !isFiniteNonNegative(value.timestamp) ||
    typeof value.expectedRevision !== "number" ||
    !Number.isInteger(value.expectedRevision) ||
    (
      value.expectedStateHash !== null &&
      (
        typeof value.expectedStateHash !== "string" ||
        !HEX_32.test(value.expectedStateHash)
      )
    ) ||
    (
      value.kind !== "stage.start" &&
      value.kind !== "stage.view.update" &&
      value.kind !== "stage.control.request" &&
      value.kind !== "stage.control.accept" &&
      value.kind !== "stage.control.cancel" &&
      value.kind !== "stage.recover" &&
      value.kind !== "stage.end"
    ) ||
    !isPayload(value.kind, value.payload)
  ) return false;

  return value.kind === "stage.start"
    ? value.expectedRevision === -1 &&
        value.expectedStateHash === null &&
        (value.payload as { view: StageViewState }).view.revision === 0
    : value.expectedRevision >= 0 && value.expectedStateHash !== null;
}

export function isStageSignedCommand(
  value: unknown,
): value is StageSignedCommand {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [
        "version",
        "stageId",
        "collaborationId",
        "nonce",
        "participantPubkey",
        "timestamp",
        "expectedRevision",
        "expectedStateHash",
        "kind",
        "payload",
        "commandId",
        "signature",
      ],
    )
  ) return false;
  const { commandId, signature, ...body } = value;
  return (
    isStageCommandBody(body) &&
    typeof commandId === "string" &&
    HEX_32.test(commandId) &&
    typeof signature === "string" &&
    HEX_64.test(signature)
  );
}

function commandDigest(body: StageCommandBody): Uint8Array {
  return sha256(canonicalBytes(body as unknown as CanonicalJsonValue));
}

export function createStageNonce(): string {
  return bytesToHex(randomBytes(16));
}

export function signStageCommand<Body extends StageCommandBody>(
  body: Body,
  secretKey: Uint8Array,
): SignedStageCommand<Body> {
  if (!isStageCommandBody(body)) {
    throw new TypeError("refusing to sign a malformed Stage command");
  }
  const publicKey = bytesToHex(schnorr.getPublicKey(secretKey));
  if (publicKey !== body.participantPubkey) {
    throw new Error("Stage signer does not match participantPubkey");
  }
  const digest = commandDigest(body);
  return {
    ...body,
    commandId: bytesToHex(digest),
    signature: bytesToHex(schnorr.sign(digest, secretKey)),
  } as SignedStageCommand<Body>;
}

export function verifyStageCommand(value: unknown): value is StageSignedCommand {
  if (!isStageSignedCommand(value)) return false;
  const { commandId, signature, ...body } = value;
  const digest = commandDigest(body as StageCommandBody);
  return (
    bytesToHex(digest) === commandId &&
    schnorr.verify(
      hexToBytes(signature),
      digest,
      hexToBytes(value.participantPubkey),
    )
  );
}
