import {
  validateSelectedTraceContextManifestV1,
  type SelectedTraceContextManifestV1,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import type { ChatMessage } from "./llm.js";
import type { ProviderProtocol } from "./models-store.js";
import type { OpInputs } from "./op-prompts.js";
import {
  computePreparedOperationRequestHashV1,
  type PreparedOperation,
  type PreparedTargetRevision,
} from "./prepared-operation.js";
import {
  traceSourceRangeForOperationV1,
  type PreparedTraceAuthoringV1,
} from "./trace-authoring-adapter.js";

const encoder = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DIAGNOSTIC_REF_PATTERN = /^diag:[0-9a-f]{64}$/;

export const DESKTOP_OPERATION_ENVELOPE_VERSION = 1;
export const DESKTOP_OPERATION_MAX_ENVELOPE_BYTES = 2 * 1_024 * 1_024;
export const DESKTOP_OPERATION_MAX_RESPONSE_BYTES = 1 * 1_024 * 1_024;
export const DESKTOP_OPERATION_MAX_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DESKTOP_OPERATION_DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const DESKTOP_OPERATION_MAX_TRANSITIONS = 64;

export type DesktopOperationStatusV1 =
  | "prepared"
  | "approved"
  | "dispatch-intent"
  | "provider-io"
  | "response-completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "accepted"
  | "stale"
  | "rejected"
  | "abandoned";

export type OperationExecutionCertaintyV1 =
  | "known-not-dispatched"
  | "may-have-dispatched"
  | "provider-completed-without-result"
  | "response-recorded";

export type OperationRetryPolicyV1 =
  | "not-eligible"
  | "safe-new-attempt"
  | "operator-confirmation-required";

export type OperationFaultCodeV1 =
  | "PREPARATION_INVALID"
  | "APPROVAL_INVALID"
  | "LOCAL_PERSISTENCE_FAILED"
  | "PROVIDER_REJECTED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RESPONSE_INVALID"
  | "TARGET_STALE"
  | "OPERATOR_CANCELLED"
  | "DISPATCH_OUTCOME_UNKNOWN"
  | "PRIVATE_ENVELOPE_EXPIRED";

export type OperationFaultStageV1 =
  | "prepare"
  | "approve"
  | "persist"
  | "dispatch"
  | "response"
  | "review"
  | "apply"
  | "retention";

/**
 * Deliberately excludes arbitrary exception text, request URLs, headers, and
 * provider payloads. `diagnosticRef` is an opaque local lookup key, never raw
 * diagnostics. Consumers derive user-facing copy from `code`.
 */
export interface OperationFaultV1 {
  version: 1;
  code: OperationFaultCodeV1;
  stage: OperationFaultStageV1;
  observedAtMs: number;
  diagnosticRef?: string;
}

export interface DesktopProviderIdentityV1 {
  version: 1;
  providerId: string;
  providerFingerprint: string;
  protocol: ProviderProtocol;
  modelId: string;
  /** Hash of transport-affecting configuration after credentials are removed. */
  transportConfigSha256: string;
}

export interface DesktopPreparedRequestV1 {
  version: 1;
  requestId: string;
  operation: "extend";
  operationInputs: Readonly<OpInputs>;
  /** Exact apply contract; directive authority is still valid only this mount. */
  traceAuthoring: PreparedTraceAuthoringV1;
  messages: readonly ChatMessage[];
  /** Approved public provenance identity. Never a credential or signing key. */
  modelVoicePubkey: string;
  provider: DesktopProviderIdentityV1;
  maxOutputTokens: number;
  targetRevision: PreparedTargetRevision;
  upstreamPreparedRequestHash: string;
  /** Domain-separated hash of every exact provider-neutral request field above. */
  requestSha256: string;
}

export interface DesktopSelectedContextV1 {
  version: 1;
  manifest: SelectedTraceContextManifestV1;
  /** Package-owned identity from `selectTraceContextV1`. */
  manifestSha256: string;
  /** Exact private rendered bytes selected for this request. */
  renderedContext: string;
  renderedContextSha256: string;
  /** Exact UTF-16 locus occupied by `renderedContext` in the prepared messages. */
  placement: {
    messageIndex: number;
    fromUtf16: number;
    toUtf16: number;
  };
}

export interface DesktopPrivateRetentionV1 {
  version: 1;
  classification: "vault-local-private";
  startedAtMs: number;
  deleteByMs: number;
  /** Privacy deadline wins even if an operation remains incomplete. */
  deadlineBehavior: "delete-entire-private-envelope";
  deleteAfterTerminal: true;
}

export interface DesktopOperationAttemptV1 {
  attemptId: string;
  retryOfAttemptId: string | null;
  createdAtMs: number;
  possibleDuplicateAcknowledgedAtMs: number | null;
}

export interface DesktopOperationResponseV1 {
  version: 1;
  text: string;
  responseSha256: string;
  completedAtMs: number;
}

export interface AcceptedArtifactIntentV1 {
  version: 1;
  intentId: string;
  kind: "apply-extend-result";
  operationId: string;
  attemptId: string;
  acceptedAtMs: number;
  targetRevision: PreparedTargetRevision;
  applyRange: { fromUtf16: number; toUtf16: number };
  preparedRequestSha256: string;
  selectedContextManifestSha256: string;
  responseSha256: string;
}

export interface LocalArtifactReceiptV1 {
  version: 1;
  receiptId: string;
  recordedAtMs: number;
  resultingContentHash: string;
}

export type DesktopOperationTransitionTypeV1 =
  | "approve"
  | "record-dispatch-intent"
  | "record-provider-io-may-have-started"
  | "record-response"
  | "record-failure"
  | "cancel"
  | "mark-dispatch-unknown"
  | "accept-result"
  | "mark-target-stale"
  | "reject-result"
  | "abandon"
  | "record-artifact-applied";

export interface AppliedOperationTransitionV1 {
  transitionId: string;
  transitionType: DesktopOperationTransitionTypeV1;
  fromStatus: DesktopOperationStatusV1;
  toStatus: DesktopOperationStatusV1;
  actionSha256: string;
  appliedAtMs: number;
}

export interface DesktopOperationEnvelopeV1 {
  version: 1;
  contract: "desktop-operation-private-local-v1";
  operationId: string;
  attempt: DesktopOperationAttemptV1;
  prepared: DesktopPreparedRequestV1;
  selectedContext: DesktopSelectedContextV1;
  lifecycle: {
    status: DesktopOperationStatusV1;
    executionCertainty: OperationExecutionCertaintyV1;
    retryPolicy: OperationRetryPolicyV1;
  };
  response: DesktopOperationResponseV1 | null;
  fault: OperationFaultV1 | null;
  artifactIntent: AcceptedArtifactIntentV1 | null;
  artifactReceipt: LocalArtifactReceiptV1 | null;
  retention: DesktopPrivateRetentionV1;
  appliedTransitions: readonly AppliedOperationTransitionV1[];
  updatedAtMs: number;
}

export interface CreateDesktopOperationEnvelopeV1Input {
  operationId: string;
  attemptId: string;
  prepared: PreparedOperation;
  provider: Omit<DesktopProviderIdentityV1, "version" | "providerId" | "providerFingerprint">;
  selectedContext: {
    manifest: SelectedTraceContextManifestV1;
    manifestSha256: string;
    renderedContext: string;
    placement: DesktopSelectedContextV1["placement"];
  };
  maxOutputTokens: number;
  createdAtMs: number;
  retainForMs?: number;
}

export class DesktopOperationEnvelopeError extends Error {
  constructor(message: string) {
    super(`Desktop operation envelope: ${message}`);
    this.name = "DesktopOperationEnvelopeError";
  }
}

export function createDesktopOperationEnvelopeV1(
  input: CreateDesktopOperationEnvelopeV1Input,
): DesktopOperationEnvelopeV1 {
  requireId(input.operationId, "operationId");
  requireId(input.attemptId, "attemptId");
  requireTimestamp(input.createdAtMs, "createdAtMs");
  if (input.prepared.version !== 1) fail("prepared operation version is unsupported");
  if (input.prepared.operation !== "extend") {
    fail("the first durable desktop contract supports Extend only");
  }
  requireHash(input.prepared.preparedRequestHash, "prepared preparedRequestHash");
  if (
    input.prepared.preparedRequestHash
    !== computePreparedOperationRequestHashV1({
      requestId: input.prepared.requestId,
      operation: input.prepared.operation,
      operationInputs: input.prepared.operationInputs,
      messages: input.prepared.messages,
      traceAuthoring: input.prepared.traceAuthoring,
      providerFingerprint: input.prepared.providerFingerprint,
      targetRevision: input.prepared.targetRevision,
      dependencyFingerprint: input.prepared.provenance.dependencyFingerprint,
      createdAt: input.prepared.createdAt,
    })
  ) {
    fail("prepared preparedRequestHash does not match its exact bytes");
  }
  requireHash(input.prepared.providerFingerprint, "prepared providerFingerprint");
  requireHash(input.provider.transportConfigSha256, "provider transportConfigSha256");
  if (input.provider.protocol !== "openai" && input.provider.protocol !== "anthropic") {
    fail("provider protocol is invalid");
  }
  requireNonEmptyText(input.provider.modelId, "provider modelId", 512);
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens <= 0) {
    fail("maxOutputTokens must be a positive safe integer");
  }
  validateSelectedContext(input.prepared, input.selectedContext);
  validateExtendOperationInputs(
    input.prepared.operationInputs,
    input.selectedContext.manifest.operation.target.currentText,
  );
  validateSelectedContextPlacement(
    input.prepared.messages,
    input.selectedContext.renderedContext,
    input.selectedContext.placement,
  );

  const provider: DesktopProviderIdentityV1 = {
    version: 1,
    providerId: requireNonEmptyText(input.prepared.providerId, "providerId", 512),
    providerFingerprint: input.prepared.providerFingerprint,
    protocol: input.provider.protocol,
    modelId: input.provider.modelId,
    transportConfigSha256: input.provider.transportConfigSha256,
  };
  const requestWithoutHash = {
    version: 1 as const,
    requestId: requireNonEmptyText(input.prepared.requestId, "requestId", 512),
    operation: "extend" as const,
    operationInputs: cloneJson(input.prepared.operationInputs),
    traceAuthoring: cloneJson(requireExtendTraceAuthoring(input.prepared.traceAuthoring)),
    messages: input.prepared.messages.map((message) => ({ ...message })),
    modelVoicePubkey: requireHash(
      input.prepared.provenance.modelVoicePubkey,
      "prepared modelVoicePubkey",
    ),
    provider,
    maxOutputTokens: input.maxOutputTokens,
    targetRevision: { ...input.prepared.targetRevision },
    upstreamPreparedRequestHash: input.prepared.preparedRequestHash,
  };
  const prepared: DesktopPreparedRequestV1 = {
    ...requestWithoutHash,
    requestSha256: hashCanonicalV1("zine.desktop-operation.request.v1", requestWithoutHash),
  };
  const retainForMs = input.retainForMs ?? DESKTOP_OPERATION_DEFAULT_RETENTION_MS;
  if (
    !Number.isSafeInteger(retainForMs)
    || retainForMs <= 0
    || retainForMs > DESKTOP_OPERATION_MAX_RETENTION_MS
  ) {
    fail(`retainForMs must be between 1 and ${DESKTOP_OPERATION_MAX_RETENTION_MS}`);
  }
  const renderedContextSha256 = hashTextV1(
    "zine.trace-context.rendered-selection.v1",
    input.selectedContext.renderedContext,
  );
  const envelope: DesktopOperationEnvelopeV1 = {
    version: DESKTOP_OPERATION_ENVELOPE_VERSION,
    contract: "desktop-operation-private-local-v1",
    operationId: input.operationId,
    attempt: {
      attemptId: input.attemptId,
      retryOfAttemptId: null,
      createdAtMs: input.createdAtMs,
      possibleDuplicateAcknowledgedAtMs: null,
    },
    prepared,
    selectedContext: {
      version: 1,
      manifest: cloneJson(input.selectedContext.manifest),
      manifestSha256: input.selectedContext.manifestSha256,
      renderedContext: input.selectedContext.renderedContext,
      renderedContextSha256,
      placement: { ...input.selectedContext.placement },
    },
    lifecycle: {
      status: "prepared",
      executionCertainty: "known-not-dispatched",
      retryPolicy: "not-eligible",
    },
    response: null,
    fault: null,
    artifactIntent: null,
    artifactReceipt: null,
    retention: {
      version: 1,
      classification: "vault-local-private",
      startedAtMs: input.createdAtMs,
      deleteByMs: input.createdAtMs + retainForMs,
      deadlineBehavior: "delete-entire-private-envelope",
      deleteAfterTerminal: true,
    },
    appliedTransitions: [],
    updatedAtMs: input.createdAtMs,
  };
  return validateAndFreezeEnvelope(envelope);
}

export function serializeDesktopOperationEnvelopeV1(envelope: DesktopOperationEnvelopeV1): string {
  validateDesktopOperationEnvelopeV1(envelope);
  const serialized = canonicalJsonV1(envelope);
  if (encoder.encode(serialized).length > DESKTOP_OPERATION_MAX_ENVELOPE_BYTES) {
    fail(`serialized envelope exceeds ${DESKTOP_OPERATION_MAX_ENVELOPE_BYTES} bytes`);
  }
  return serialized;
}

export function parseDesktopOperationEnvelopeV1(serialized: string): DesktopOperationEnvelopeV1 {
  if (encoder.encode(serialized).length > DESKTOP_OPERATION_MAX_ENVELOPE_BYTES) {
    fail(`serialized envelope exceeds ${DESKTOP_OPERATION_MAX_ENVELOPE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    fail("serialized envelope is not valid JSON");
  }
  validateDesktopOperationEnvelopeV1(parsed);
  return deepFreeze(parsed as DesktopOperationEnvelopeV1);
}

export function hashDesktopOperationEnvelopeV1(envelope: DesktopOperationEnvelopeV1): string {
  validateDesktopOperationEnvelopeV1(envelope);
  return hashCanonicalV1("zine.desktop-operation.envelope.v1", envelope);
}

export function validateDesktopOperationEnvelopeV1(value: unknown): asserts value is DesktopOperationEnvelopeV1 {
  const envelope = requireRecord(value, "envelope");
  requireExactKeys(envelope, [
    "version", "contract", "operationId", "attempt", "prepared", "selectedContext", "lifecycle",
    "response", "fault", "artifactIntent", "artifactReceipt", "retention", "appliedTransitions", "updatedAtMs",
  ], "envelope");
  if (envelope.version !== 1 || envelope.contract !== "desktop-operation-private-local-v1") {
    fail("unsupported envelope version or contract");
  }
  requireId(envelope.operationId, "operationId");
  const attempt = requireRecord(envelope.attempt, "attempt");
  requireExactKeys(attempt, [
    "attemptId", "retryOfAttemptId", "createdAtMs", "possibleDuplicateAcknowledgedAtMs",
  ], "attempt");
  requireId(attempt.attemptId, "attempt.attemptId");
  if (attempt.retryOfAttemptId !== null) requireId(attempt.retryOfAttemptId, "attempt.retryOfAttemptId");
  if (attempt.retryOfAttemptId === attempt.attemptId) fail("attempt cannot retry itself");
  requireTimestamp(attempt.createdAtMs, "attempt.createdAtMs");
  if (attempt.possibleDuplicateAcknowledgedAtMs !== null) {
    requireTimestamp(attempt.possibleDuplicateAcknowledgedAtMs, "attempt.possibleDuplicateAcknowledgedAtMs");
  }
  if (attempt.retryOfAttemptId === null && attempt.possibleDuplicateAcknowledgedAtMs !== null) {
    fail("an initial attempt cannot acknowledge a possible duplicate");
  }

  const prepared = requireRecord(envelope.prepared, "prepared");
  requireExactKeys(prepared, [
    "version", "requestId", "operation", "operationInputs", "traceAuthoring", "messages",
    "modelVoicePubkey", "provider", "maxOutputTokens",
    "targetRevision", "upstreamPreparedRequestHash", "requestSha256",
  ], "prepared");
  if (prepared.version !== 1 || prepared.operation !== "extend") fail("prepared request is unsupported");
  requireNonEmptyText(prepared.requestId, "prepared.requestId", 512);
  requireHash(prepared.upstreamPreparedRequestHash, "prepared.upstreamPreparedRequestHash");
  requireHash(prepared.requestSha256, "prepared.requestSha256");
  requireHash(prepared.modelVoicePubkey, "prepared.modelVoicePubkey");
  if (!Array.isArray(prepared.messages) || prepared.messages.length === 0) fail("prepared.messages must be non-empty");
  for (const [index, raw] of prepared.messages.entries()) {
    const message = requireRecord(raw, `prepared.messages[${index}]`);
    requireExactKeys(message, ["role", "content"], `prepared.messages[${index}]`);
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      fail(`prepared.messages[${index}].role is invalid`);
    }
    requireText(message.content, `prepared.messages[${index}].content`);
  }
  if (!Number.isSafeInteger(prepared.maxOutputTokens) || (prepared.maxOutputTokens as number) <= 0) {
    fail("prepared.maxOutputTokens must be positive");
  }
  const target = requireTargetRevision(prepared.targetRevision, "prepared.targetRevision");
  const operationInputs = requireRecord(prepared.operationInputs, "prepared.operationInputs");

  const provider = requireRecord(prepared.provider, "prepared.provider");
  requireExactKeys(provider, [
    "version", "providerId", "providerFingerprint", "protocol", "modelId", "transportConfigSha256",
  ], "prepared.provider");
  if (provider.version !== 1) fail("prepared.provider version is unsupported");
  requireNonEmptyText(provider.providerId, "prepared.provider.providerId", 512);
  requireHash(provider.providerFingerprint, "prepared.provider.providerFingerprint");
  if (provider.protocol !== "openai" && provider.protocol !== "anthropic") fail("provider protocol is invalid");
  requireNonEmptyText(provider.modelId, "prepared.provider.modelId", 512);
  requireHash(provider.transportConfigSha256, "prepared.provider.transportConfigSha256");
  const requestWithoutHash = { ...prepared };
  delete requestWithoutHash.requestSha256;
  if (prepared.requestSha256 !== hashCanonicalV1("zine.desktop-operation.request.v1", requestWithoutHash)) {
    fail("prepared request hash does not match its exact bytes");
  }

  const selected = requireRecord(envelope.selectedContext, "selectedContext");
  requireExactKeys(selected, [
    "version", "manifest", "manifestSha256", "renderedContext", "renderedContextSha256", "placement",
  ], "selectedContext");
  if (selected.version !== 1) fail("selectedContext version is unsupported");
  requireHash(selected.manifestSha256, "selectedContext.manifestSha256");
  const renderedContext = requireText(selected.renderedContext, "selectedContext.renderedContext");
  validatePackageManifest(selected.manifest, renderedContext);
  requireHash(selected.renderedContextSha256, "selectedContext.renderedContextSha256");
  if (
    selected.renderedContextSha256
    !== hashTextV1("zine.trace-context.rendered-selection.v1", selected.renderedContext as string)
  ) {
    fail("selected rendered-context hash does not match its exact bytes");
  }
  if (
    selected.manifestSha256
    !== hashCanonicalV1("zine.trace-context.package-manifest.v1", selected.manifest)
  ) {
    fail("selected manifest hash does not match its exact bytes");
  }
  const manifest = selected.manifest as unknown as Record<string, unknown>;
  const manifestOperation = requireRecord(manifest.operation, "selectedContext.manifest.operation");
  if (manifestOperation.operation !== "extend") fail("selected context is not for Extend");
  const manifestTarget = requireRecord(manifestOperation.target, "selectedContext.manifest.operation.target");
  const manifestCurrentText = requireText(manifestTarget.currentText, "manifest target currentText");
  validatePreparedTraceAuthoringV1(
    prepared.traceAuthoring,
    operationInputs,
    target,
    manifestCurrentText,
  );
  validateSelectedOperationRange(manifestOperation.range, operationInputs, manifestCurrentText);
  const manifestHashes = requireRecord(manifest.hashes, "selectedContext.manifest.hashes");
  requireHash(manifestHashes.frozenInputsSha256, "selectedContext.manifest.hashes.frozenInputsSha256");
  if (manifestHashes.renderedContextSha256 !== selected.renderedContextSha256) {
    fail("selected manifest does not identify the exact rendered context");
  }
  const manifestBudget = requireRecord(manifest.budget, "selectedContext.manifest.budget");
  if (manifestBudget.usedRenderedBytes !== encoder.encode(selected.renderedContext as string).length) {
    fail("selected manifest rendered byte count does not match the exact context");
  }
  if (
    manifestTarget.traceId !== target.traceId
    || manifestTarget.headId !== target.headId
    || manifestTarget.contentHash !== target.contentHash
    || (manifestTarget.chosenPath !== undefined && manifestTarget.chosenPath !== target.path)
  ) {
    fail("selected context target does not match the prepared target");
  }
  validateSelectedContextPlacement(
    prepared.messages as Array<{ role: ChatMessage["role"]; content: string }>,
    selected.renderedContext as string,
    selected.placement,
  );
  if (contentFingerprint(manifestCurrentText) !== target.contentHash) {
    fail("selected current text does not match the prepared target content hash");
  }
  validateExtendOperationInputs(operationInputs, manifestCurrentText);

  const lifecycle = requireRecord(envelope.lifecycle, "lifecycle");
  requireExactKeys(lifecycle, ["status", "executionCertainty", "retryPolicy"], "lifecycle");
  const status = requireStatus(lifecycle.status);
  const certainty = requireCertainty(lifecycle.executionCertainty);
  const retryPolicy = requireRetryPolicy(lifecycle.retryPolicy);
  validateLifecycleInvariant(status, certainty, retryPolicy, envelope);

  if (envelope.response !== null) {
    const response = requireRecord(envelope.response, "response");
    requireExactKeys(response, ["version", "text", "responseSha256", "completedAtMs"], "response");
    if (response.version !== 1) fail("response version is unsupported");
    const text = requireText(response.text, "response.text");
    if (encoder.encode(text).length > DESKTOP_OPERATION_MAX_RESPONSE_BYTES) fail("response exceeds its byte limit");
    requireHash(response.responseSha256, "response.responseSha256");
    if (response.responseSha256 !== hashTextV1("zine.desktop-operation.response.v1", text)) {
      fail("response hash does not match its exact bytes");
    }
    requireTimestamp(response.completedAtMs, "response.completedAtMs");
  }
  if (envelope.fault !== null) validateOperationFaultV1(envelope.fault);
  if (envelope.artifactIntent !== null) validateArtifactIntent(envelope.artifactIntent, envelope);
  if (envelope.artifactReceipt !== null) validateArtifactReceipt(envelope.artifactReceipt);

  const retention = requireRecord(envelope.retention, "retention");
  requireExactKeys(retention, [
    "version", "classification", "startedAtMs", "deleteByMs", "deadlineBehavior", "deleteAfterTerminal",
  ], "retention");
  if (
    retention.version !== 1
    || retention.classification !== "vault-local-private"
    || retention.deadlineBehavior !== "delete-entire-private-envelope"
    || retention.deleteAfterTerminal !== true
  ) {
    fail("retention policy is unsupported");
  }
  requireTimestamp(retention.startedAtMs, "retention.startedAtMs");
  requireTimestamp(retention.deleteByMs, "retention.deleteByMs");
  if (
    (retention.deleteByMs as number) <= (retention.startedAtMs as number)
    || (retention.deleteByMs as number) - (retention.startedAtMs as number) > DESKTOP_OPERATION_MAX_RETENTION_MS
  ) {
    fail("retention deadline is not positively bounded");
  }
  if (!Array.isArray(envelope.appliedTransitions)) fail("appliedTransitions must be an array");
  if (envelope.appliedTransitions.length > DESKTOP_OPERATION_MAX_TRANSITIONS) fail("too many applied transitions");
  const transitionIds = new Set<string>();
  let receiptStatus: DesktopOperationStatusV1 = "prepared";
  let receiptTime = attempt.createdAtMs as number;
  let finalTransitionFromStatus: DesktopOperationStatusV1 | null = null;
  let artifactApplicationRecorded = false;
  let artifactApplicationTransition: {
    transitionId: string;
    actionSha256: string;
    appliedAtMs: number;
  } | null = null;
  for (const [index, raw] of envelope.appliedTransitions.entries()) {
    const transition = requireRecord(raw, `appliedTransitions[${index}]`);
    requireExactKeys(
      transition,
      ["transitionId", "transitionType", "fromStatus", "toStatus", "actionSha256", "appliedAtMs"],
      `appliedTransitions[${index}]`,
    );
    const id = requireId(transition.transitionId, `appliedTransitions[${index}].transitionId`);
    if (transitionIds.has(id)) fail("applied transition ids must be unique");
    transitionIds.add(id);
    if (!TRANSITION_TYPES.has(transition.transitionType as DesktopOperationTransitionTypeV1)) {
      fail(`appliedTransitions[${index}].transitionType is unsupported`);
    }
    const fromStatus = requireStatus(transition.fromStatus);
    const toStatus = requireStatus(transition.toStatus);
    if (fromStatus !== receiptStatus) {
      fail(`appliedTransitions[${index}] does not continue from ${receiptStatus}`);
    }
    const transitionType = transition.transitionType as DesktopOperationTransitionTypeV1;
    if (transitionType === "record-artifact-applied") {
      if (artifactApplicationRecorded) fail("artifact application may be recorded only once");
      artifactApplicationRecorded = true;
    }
    if (transitionType === "mark-target-stale" && fromStatus === "accepted" && artifactApplicationRecorded) {
      fail("an applied artifact cannot later be marked target-stale");
    }
    const expectedToStatus = transitionTargetStatus(transitionType, fromStatus);
    if (toStatus !== expectedToStatus) {
      fail(`appliedTransitions[${index}] must transition to ${expectedToStatus}`);
    }
    const actionSha256 = requireHash(
      transition.actionSha256,
      `appliedTransitions[${index}].actionSha256`,
    );
    const appliedAtMs = requireTimestamp(
      transition.appliedAtMs,
      `appliedTransitions[${index}].appliedAtMs`,
    );
    if (appliedAtMs < receiptTime) fail("applied transition times must be monotonic");
    if (transitionType === "record-artifact-applied") {
      artifactApplicationTransition = { transitionId: id, actionSha256, appliedAtMs };
    }
    finalTransitionFromStatus = fromStatus;
    receiptStatus = toStatus;
    receiptTime = appliedAtMs;
  }
  const updatedAtMs = requireTimestamp(envelope.updatedAtMs, "updatedAtMs");
  if (receiptStatus !== status) fail("applied transition chain does not reach the lifecycle status");
  if (updatedAtMs !== receiptTime) fail("updatedAtMs does not match the applied transition chain");
  if (artifactApplicationRecorded !== (envelope.artifactReceipt !== null)) {
    fail("artifact application receipt does not match the applied transition chain");
  }
  if (envelope.artifactReceipt !== null) {
    if (!artifactApplicationTransition) fail("artifact application transition is missing");
    const receipt = requireRecord(envelope.artifactReceipt, "artifactReceipt");
    if (receipt.recordedAtMs !== artifactApplicationTransition.appliedAtMs) {
      fail("artifact receipt time does not match its transition");
    }
    const exactAction = {
      version: 1 as const,
      type: "record-artifact-applied" as const,
      transitionId: artifactApplicationTransition.transitionId,
      atMs: artifactApplicationTransition.appliedAtMs,
      receiptId: receipt.receiptId,
      resultingContentHash: receipt.resultingContentHash,
    };
    if (
      artifactApplicationTransition.actionSha256
      !== hashCanonicalV1("zine.desktop-operation.transition.v1", exactAction)
    ) {
      fail("artifact receipt does not match its exact transition action");
    }
  }
  if (status === "stale") {
    const staleFault = requireRecord(envelope.fault, "fault");
    const expectedStage = finalTransitionFromStatus === "accepted"
      ? "apply"
      : finalTransitionFromStatus === "prepared" || finalTransitionFromStatus === "approved"
        ? "approve"
        : "review";
    if (staleFault.stage !== expectedStage) {
      fail(`TARGET_STALE stage must be ${expectedStage} for its transition chain`);
    }
  }
  if (status === "abandoned") {
    const expectedCertainty = finalTransitionFromStatus === "unknown"
      ? "may-have-dispatched"
      : "known-not-dispatched";
    if (certainty !== expectedCertainty) {
      fail(`abandoned certainty must be ${expectedCertainty} for its transition chain`);
    }
  }
  canonicalJsonV1(envelope);
  const size = encoder.encode(canonicalJsonV1(envelope)).length;
  if (size > DESKTOP_OPERATION_MAX_ENVELOPE_BYTES) fail("envelope exceeds its byte limit");
}

export function validateOperationFaultV1(value: unknown): asserts value is OperationFaultV1 {
  const fault = requireRecord(value, "fault");
  if (fault.version !== 1 || !FAULT_CODES.has(fault.code as OperationFaultCodeV1)) {
    fail("fault code or version is unsupported");
  }
  if (!FAULT_STAGES.has(fault.stage as OperationFaultStageV1)) fail("fault stage is unsupported");
  requireTimestamp(fault.observedAtMs, "fault.observedAtMs");
  if (fault.diagnosticRef !== undefined) requireDiagnosticRef(fault.diagnosticRef);
  const allowed = new Set(["version", "code", "stage", "observedAtMs", "diagnosticRef"]);
  for (const key of Object.keys(fault)) {
    if (!allowed.has(key)) fail(`fault field ${key} could contain unredacted diagnostics`);
  }
}

export function canonicalJsonV1(value: unknown): string {
  return serialize(value, "$", new Set<object>());
}

export function hashCanonicalV1(domain: string, value: unknown): string {
  requireNonEmptyText(domain, "hash domain", 256);
  if (domain.includes("\0")) fail("hash domain cannot contain the domain separator");
  return contentFingerprint(`${domain}\0${canonicalJsonV1(value)}`);
}

export function hashTextV1(domain: string, value: string): string {
  requireNonEmptyText(domain, "hash domain", 256);
  if (domain.includes("\0")) fail("hash domain cannot contain the domain separator");
  requireText(value, "hashed text");
  return contentFingerprint(`${domain}\0${value}`);
}

export function cloneAndFreezeDesktopOperationEnvelopeV1(
  envelope: DesktopOperationEnvelopeV1,
): DesktopOperationEnvelopeV1 {
  return validateAndFreezeEnvelope(cloneJson(envelope));
}

function validateSelectedContext(
  prepared: PreparedOperation,
  selected: CreateDesktopOperationEnvelopeV1Input["selectedContext"],
): void {
  requireHash(selected.manifestSha256, "selectedContext manifestSha256");
  requireText(selected.renderedContext, "selectedContext renderedContext");
  validatePackageManifest(selected.manifest, selected.renderedContext);
  if (
    selected.manifestSha256
    !== hashCanonicalV1("zine.trace-context.package-manifest.v1", selected.manifest)
  ) {
    fail("selected manifest identity does not match its exact bytes");
  }
  if (
    selected.manifest.hashes.renderedContextSha256
    !== hashTextV1("zine.trace-context.rendered-selection.v1", selected.renderedContext)
  ) {
    fail("selected rendered-context identity does not match its exact bytes");
  }
  const target = selected.manifest.operation.target;
  if (
    selected.manifest.version !== 1
    || selected.manifest.contract !== "package-local-non-normative-v1"
    || selected.manifest.operation.operation !== "extend"
    || target.traceId !== prepared.targetRevision.traceId
    || target.headId !== prepared.targetRevision.headId
    || target.contentHash !== prepared.targetRevision.contentHash
    || (target.chosenPath !== undefined && target.chosenPath !== prepared.targetRevision.path)
  ) {
    fail("selected context is not bound to the exact prepared Extend target");
  }
  if (contentFingerprint(target.currentText) !== prepared.targetRevision.contentHash) {
    fail("selected current text does not match the prepared target content hash");
  }
  validateSelectedOperationRange(
    selected.manifest.operation.range,
    prepared.operationInputs,
    target.currentText,
  );
}

function validateSelectedOperationRange(
  value: unknown,
  operationInputs: Record<string, unknown>,
  currentText: string,
): void {
  const range = requireRecord(value, "selectedContext.manifest.operation.range");
  requireExactKeys(range, ["fromUtf16", "toUtf16"], "selectedContext.manifest.operation.range");
  requireRange(range.fromUtf16, range.toUtf16, "selectedContext.manifest.operation.range");
  const expected = traceSourceRangeForOperationV1(
    "extend",
    operationInputs,
    currentText,
  );
  if (range.fromUtf16 !== expected.fromUtf16 || range.toUtf16 !== expected.toUtf16) {
    fail("selected operation range does not match the prepared Extend source range");
  }
}

function requireExtendTraceAuthoring(
  value: PreparedOperation["traceAuthoring"],
): PreparedTraceAuthoringV1 {
  if (!value || value.operation !== "extend") {
    fail("prepared Extend must carry its exact trace-authoring apply contract");
  }
  return value;
}

function validatePreparedTraceAuthoringV1(
  value: unknown,
  operationInputs: Record<string, unknown>,
  target: PreparedTargetRevision,
  currentText: string,
): asserts value is PreparedTraceAuthoringV1 {
  const authoring = requireRecord(value, "prepared.traceAuthoring");
  requireExactKeys(authoring, [
    "version", "kernelVersion", "authorityPersistence", "operation", "operationRange",
    "operationText", "compiled", "instructionSection", "quotedExcerptSection",
    "promptTargetText", "protectedTokens", "stagedDirectiveDeletions",
  ], "prepared.traceAuthoring");
  if (
    authoring.version !== 1
    || authoring.kernelVersion !== 1
    || authoring.authorityPersistence !== "current-editor-session-only"
    || authoring.operation !== "extend"
  ) fail("prepared trace authoring contract is unsupported");
  const operationRange = requireUtf16Range(
    authoring.operationRange,
    "prepared.traceAuthoring.operationRange",
  );
  const expectedRange = traceSourceRangeForOperationV1("extend", operationInputs, currentText);
  if (
    operationRange.fromUtf16 !== expectedRange.fromUtf16
    || operationRange.toUtf16 !== expectedRange.toUtf16
  ) fail("prepared trace authoring range does not match the exact Extend source range");
  if (
    requireText(authoring.operationText, "prepared.traceAuthoring.operationText")
    !== currentText.slice(operationRange.fromUtf16, operationRange.toUtf16)
  ) fail("prepared trace authoring text does not match the selected target bytes");
  requireText(authoring.instructionSection, "prepared.traceAuthoring.instructionSection");
  requireText(authoring.quotedExcerptSection, "prepared.traceAuthoring.quotedExcerptSection");
  requireText(authoring.promptTargetText, "prepared.traceAuthoring.promptTargetText");
  if (!Array.isArray(authoring.protectedTokens) || authoring.protectedTokens.length !== 0) {
    fail("prepared Extend trace authoring must not carry Settle protected tokens");
  }

  const compiled = requireRecord(authoring.compiled, "prepared.traceAuthoring.compiled");
  requireExactKeys(compiled, [
    "version", "ok", "operationRange", "scan", "decisions", "directives", "excerpts",
    "renderedText", "errors",
  ], "prepared.traceAuthoring.compiled");
  if (compiled.version !== 1 || compiled.ok !== true) fail("prepared trace authoring compile failed");
  const compiledRange = requireUtf16Range(
    compiled.operationRange,
    "prepared.traceAuthoring.compiled.operationRange",
  );
  if (canonicalJsonV1(compiledRange) !== canonicalJsonV1(operationRange)) {
    fail("compiled trace authoring range does not match its operation range");
  }
  requireText(compiled.renderedText, "prepared.traceAuthoring.compiled.renderedText");
  if (!Array.isArray(compiled.errors) || compiled.errors.length !== 0) {
    fail("prepared trace authoring must not carry compile errors");
  }
  validateAuthoringScan(compiled.scan);
  validateAuthoringDecisions(compiled.decisions);
  validateAuthoringExcerpts(compiled.excerpts, currentText);
  if (!Array.isArray(compiled.directives)) fail("prepared trace authoring directives must be an array");
  const directiveRanges = compiled.directives.map((raw, index) => (
    validateCompiledDirective(raw, index, operationRange, target, currentText)
  ));
  if (!Array.isArray(authoring.stagedDirectiveDeletions)) {
    fail("prepared trace authoring staged deletions must be an array");
  }
  const deletions = authoring.stagedDirectiveDeletions.map((raw, index) =>
    requireUtf16Range(raw, `prepared.traceAuthoring.stagedDirectiveDeletions[${index}]`));
  if (canonicalJsonV1(deletions) !== canonicalJsonV1(directiveRanges)) {
    fail("prepared trace authoring staged deletions must exactly match its directives");
  }
}

function validateAuthoringScan(value: unknown): void {
  const scan = requireRecord(value, "prepared.traceAuthoring.compiled.scan");
  requireExactKeys(scan, ["version", "protectedRanges", "directiveCandidates", "errors"], "prepared.traceAuthoring.compiled.scan");
  if (scan.version !== 1) fail("prepared trace authoring scan version is unsupported");
  if (!Array.isArray(scan.protectedRanges) || !Array.isArray(scan.directiveCandidates) || !Array.isArray(scan.errors)) {
    fail("prepared trace authoring scan arrays are invalid");
  }
  scan.protectedRanges.forEach((raw, index) => {
    const item = requireRecord(raw, `prepared.traceAuthoring.compiled.scan.protectedRanges[${index}]`);
    requireExactKeys(item, ["version", "id", "range", "text"], `prepared.traceAuthoring.compiled.scan.protectedRanges[${index}]`);
    if (item.version !== 1) fail("prepared protected range version is unsupported");
    requireNonEmptyText(item.id, "prepared protected range id", 512);
    requireUtf16Range(item.range, "prepared protected range range");
    requireText(item.text, "prepared protected range text");
  });
  scan.directiveCandidates.forEach((raw, index) => validateDirectiveCandidate(raw, `prepared.traceAuthoring.compiled.scan.directiveCandidates[${index}]`));
  scan.errors.forEach((raw, index) => validateTraceContextError(raw, `prepared.traceAuthoring.compiled.scan.errors[${index}]`));
}

function validateAuthoringDecisions(value: unknown): void {
  if (!Array.isArray(value)) fail("prepared trace authoring decisions must be an array");
  value.forEach((raw, index) => {
    const subject = `prepared.traceAuthoring.compiled.decisions[${index}]`;
    const decision = requireRecord(raw, subject);
    requireExactKeys(decision, ["version", "candidate", "reason", "authoritySpanIds"], subject);
    if (decision.version !== 1) fail(`${subject} version is unsupported`);
    validateDirectiveCandidate(decision.candidate, `${subject}.candidate`);
    requireNonEmptyText(decision.reason, `${subject}.reason`, 128);
    if (!Array.isArray(decision.authoritySpanIds) || !decision.authoritySpanIds.every((id) => typeof id === "string")) {
      fail(`${subject}.authoritySpanIds must be strings`);
    }
  });
}

function validateAuthoringExcerpts(value: unknown, currentText: string): void {
  if (!Array.isArray(value)) fail("prepared trace authoring excerpts must be an array");
  value.forEach((raw, index) => {
    const subject = `prepared.traceAuthoring.compiled.excerpts[${index}]`;
    const excerpt = requireRecord(raw, subject);
    requireExactKeys(excerpt, [
      "version", "id", "sourceRange", "text", "byteLength", "mode", "omittedBefore", "omittedAfter",
    ], subject);
    if (excerpt.version !== 1) fail(`${subject} version is unsupported`);
    requireNonEmptyText(excerpt.id, `${subject}.id`, 512);
    const range = requireUtf16Range(excerpt.sourceRange, `${subject}.sourceRange`);
    if (range.toUtf16 > currentText.length) fail(`${subject} is outside the target text`);
    const text = requireText(excerpt.text, `${subject}.text`);
    if (!Number.isSafeInteger(excerpt.byteLength) || excerpt.byteLength !== encoder.encode(text).length) {
      fail(`${subject}.byteLength does not match its text`);
    }
    requireNonEmptyText(excerpt.mode, `${subject}.mode`, 128);
    if (typeof excerpt.omittedBefore !== "boolean" || typeof excerpt.omittedAfter !== "boolean") {
      fail(`${subject} omission flags must be booleans`);
    }
  });
}

function validateCompiledDirective(
  value: unknown,
  index: number,
  operationRange: { fromUtf16: number; toUtf16: number },
  target: PreparedTargetRevision,
  currentText: string,
): { fromUtf16: number; toUtf16: number } {
  const subject = `prepared.traceAuthoring.compiled.directives[${index}]`;
  const directive = requireRecord(value, subject);
  requireExactKeys(directive, [
    "version", "id", "ordinal", "marker", "instruction", "operation", "sourceRevision",
    "sourceRange", "instructionRange", "authority", "lifecycle", "localAnchor",
  ], subject);
  if (directive.version !== 1 || directive.operation !== "extend" || directive.ordinal !== index + 1) {
    fail(`${subject} identity is invalid`);
  }
  requireNonEmptyText(directive.id, `${subject}.id`, 512);
  requireNonEmptyText(directive.marker, `${subject}.marker`, 4_096);
  requireNonEmptyText(directive.instruction, `${subject}.instruction`, 64 * 1_024);
  const sourceRange = requireUtf16Range(directive.sourceRange, `${subject}.sourceRange`);
  const instructionRange = requireUtf16Range(directive.instructionRange, `${subject}.instructionRange`);
  if (
    sourceRange.fromUtf16 < operationRange.fromUtf16
    || sourceRange.toUtf16 > operationRange.toUtf16
    || instructionRange.fromUtf16 < sourceRange.fromUtf16
    || instructionRange.toUtf16 > sourceRange.toUtf16
    || sourceRange.toUtf16 > currentText.length
  ) fail(`${subject} ranges are outside the exact operation bytes`);
  const revision = requireRecord(directive.sourceRevision, `${subject}.sourceRevision`);
  requireExactKeys(revision, ["traceId", "headId", "path", "contentHash"], `${subject}.sourceRevision`);
  if (
    revision.traceId !== target.traceId || revision.headId !== target.headId
    || revision.path !== target.path || revision.contentHash !== target.contentHash
  ) fail(`${subject} source revision does not match the durable target`);
  const authority = requireRecord(directive.authority, `${subject}.authority`);
  requireExactKeys(authority, ["kind", "actorId", "origin", "spanIds"], `${subject}.authority`);
  if (authority.kind !== "acting-author-current-target-v1") fail(`${subject} authority kind is unsupported`);
  requireNonEmptyText(authority.actorId, `${subject}.authority.actorId`, 512);
  requireNonEmptyText(authority.origin, `${subject}.authority.origin`, 512);
  if (!Array.isArray(authority.spanIds) || authority.spanIds.length === 0 || !authority.spanIds.every((id) => typeof id === "string")) {
    fail(`${subject} authority span ids are invalid`);
  }
  const lifecycle = requireRecord(directive.lifecycle, `${subject}.lifecycle`);
  requireExactKeys(lifecycle, ["mode", "state"], `${subject}.lifecycle`);
  if (lifecycle.mode !== "one-shot" || lifecycle.state !== "pending") fail(`${subject} lifecycle is unsupported`);
  const anchor = requireRecord(directive.localAnchor, `${subject}.localAnchor`);
  requireExactKeys(anchor, ["version", "containingRange", "relation", "excerptId"], `${subject}.localAnchor`);
  if (anchor.version !== 1) fail(`${subject} local anchor version is unsupported`);
  requireUtf16Range(anchor.containingRange, `${subject}.localAnchor.containingRange`);
  requireNonEmptyText(anchor.relation, `${subject}.localAnchor.relation`, 128);
  requireNonEmptyText(anchor.excerptId, `${subject}.localAnchor.excerptId`, 512);
  return sourceRange;
}

function validateDirectiveCandidate(value: unknown, subject: string): void {
  const candidate = requireRecord(value, subject);
  requireExactKeys(candidate, ["version", "id", "ordinal", "range", "instructionRange", "instruction"], subject);
  if (candidate.version !== 1 || !Number.isSafeInteger(candidate.ordinal) || (candidate.ordinal as number) <= 0) {
    fail(`${subject} identity is invalid`);
  }
  requireNonEmptyText(candidate.id, `${subject}.id`, 512);
  requireUtf16Range(candidate.range, `${subject}.range`);
  requireUtf16Range(candidate.instructionRange, `${subject}.instructionRange`);
  requireText(candidate.instruction, `${subject}.instruction`);
}

function validateTraceContextError(value: unknown, subject: string): void {
  const error = requireRecord(value, subject);
  requireExactKeys(error, ["version", "code", "message", "range", "relatedRange"], subject);
  if (error.version !== 1) fail(`${subject} version is unsupported`);
  requireNonEmptyText(error.code, `${subject}.code`, 128);
  requireText(error.message, `${subject}.message`);
  requireUtf16Range(error.range, `${subject}.range`);
  if (error.relatedRange !== undefined) requireUtf16Range(error.relatedRange, `${subject}.relatedRange`);
}

function requireUtf16Range(
  value: unknown,
  subject: string,
): { fromUtf16: number; toUtf16: number } {
  const range = requireRecord(value, subject);
  requireExactKeys(range, ["fromUtf16", "toUtf16"], subject);
  requireRange(range.fromUtf16, range.toUtf16, subject);
  return range as { fromUtf16: number; toUtf16: number };
}

function validateSelectedContextPlacement(
  messages: readonly ChatMessage[],
  renderedContext: string,
  value: unknown,
): void {
  const placement = requireRecord(value, "selectedContext.placement");
  requireExactKeys(placement, ["messageIndex", "fromUtf16", "toUtf16"], "selectedContext.placement");
  if (!Number.isSafeInteger(placement.messageIndex) || (placement.messageIndex as number) < 0) {
    fail("selectedContext.placement.messageIndex must be a non-negative safe integer");
  }
  const message = messages[placement.messageIndex as number];
  if (!message) fail("selectedContext.placement.messageIndex is outside the prepared messages");
  if (message.role !== "user") fail("selectedContext.placement must identify a user message");
  requireRange(placement.fromUtf16, placement.toUtf16, "selectedContext.placement range");
  const from = placement.fromUtf16 as number;
  const to = placement.toUtf16 as number;
  if (to > message.content.length) fail("selectedContext.placement range is outside its prepared message");
  if (!isUtf16Boundary(message.content, from) || !isUtf16Boundary(message.content, to)) {
    fail("selectedContext.placement range splits a Unicode scalar value");
  }
  if (message.content.slice(from, to) !== renderedContext) {
    fail("selectedContext.placement does not identify the exact rendered context");
  }
  const occurrences: Array<{ messageIndex: number; fromUtf16: number }> = [];
  for (const [messageIndex, candidate] of messages.entries()) {
    let cursor = 0;
    while (cursor <= candidate.content.length - renderedContext.length) {
      const found = candidate.content.indexOf(renderedContext, cursor);
      if (found < 0) break;
      occurrences.push({ messageIndex, fromUtf16: found });
      cursor = found + 1;
    }
  }
  if (
    occurrences.length !== 1
    || occurrences[0]!.messageIndex !== placement.messageIndex
    || occurrences[0]!.fromUtf16 !== from
  ) {
    fail("selected rendered context must occur exactly once in the prepared user messages");
  }
}

function validatePackageManifest(
  value: unknown,
  renderedContext?: string,
): asserts value is SelectedTraceContextManifestV1 {
  try {
    validateSelectedTraceContextManifestV1(value, renderedContext);
  } catch (error) {
    fail(`selected context manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateLifecycleInvariant(
  status: DesktopOperationStatusV1,
  certainty: OperationExecutionCertaintyV1,
  retryPolicy: OperationRetryPolicyV1,
  envelope: Record<string, unknown>,
): void {
  const response = envelope.response;
  const artifactIntent = envelope.artifactIntent;
  const artifactReceipt = envelope.artifactReceipt;
  const fault = envelope.fault;
  const ambiguousAbandon = status === "abandoned" && certainty === "may-have-dispatched";
  if (["prepared", "approved", "dispatch-intent", "cancelled"].includes(status)) {
    if (certainty !== "known-not-dispatched") fail(`${status} must remain known-not-dispatched`);
  } else if (status === "abandoned") {
    if (certainty !== "known-not-dispatched" && certainty !== "may-have-dispatched") {
      fail("abandoned certainty is invalid");
    }
  } else if (["provider-io", "unknown"].includes(status)) {
    if (certainty !== "may-have-dispatched") fail(`${status} must remain may-have-dispatched`);
  } else if (status === "failed") {
    if (certainty !== "known-not-dispatched" && certainty !== "provider-completed-without-result") {
      fail("failed certainty is invalid");
    }
  } else if (status === "stale") {
    if (certainty !== "known-not-dispatched" && certainty !== "response-recorded") {
      fail("stale certainty is invalid");
    }
  } else if (certainty !== "response-recorded") {
    fail(`${status} requires a recorded response`);
  }
  const requiresResponse = ["response-completed", "accepted", "rejected"].includes(status)
    || (status === "stale" && certainty === "response-recorded");
  if (requiresResponse !== (response !== null)) fail(`${status} response presence is inconsistent`);
  if (status === "accepted" !== (artifactIntent !== null)) fail("accepted status alone may carry artifact intent");
  if (artifactReceipt !== null && (status !== "accepted" || artifactIntent === null)) {
    fail("artifact receipt requires an accepted artifact intent");
  }
  if (["failed", "cancelled", "unknown", "stale"].includes(status) || ambiguousAbandon) {
    if (fault === null) fail(`${status} fault presence is inconsistent`);
  } else if (fault !== null) {
    fail(`${status} fault presence is inconsistent`);
  }
  if (status === "stale") {
    const staleFault = requireRecord(fault, "fault");
    if (
      staleFault.code !== "TARGET_STALE"
      || !["approve", "review", "apply"].includes(staleFault.stage as string)
    ) fail("stale requires a TARGET_STALE fault at approve, review, or apply");
    if ((staleFault.stage === "approve") !== (certainty === "known-not-dispatched")) {
      fail("pre-dispatch stale state must remain known-not-dispatched");
    }
  }
  if (ambiguousAbandon) {
    const abandonFault = requireRecord(fault, "fault");
    if (abandonFault.code !== "DISPATCH_OUTCOME_UNKNOWN" || abandonFault.stage !== "dispatch") {
      fail("ambiguous abandonment must retain its dispatch-unknown fault");
    }
  }
  const expectedRetry = status === "cancelled" || status === "stale" || status === "rejected"
    || (status === "failed" && certainty === "known-not-dispatched")
    ? "safe-new-attempt"
    : status === "unknown" || (status === "failed" && certainty === "provider-completed-without-result")
      ? "operator-confirmation-required"
      : "not-eligible";
  if (retryPolicy !== expectedRetry) fail(`retry policy for ${status} must be ${expectedRetry}`);
}

function validateArtifactIntent(value: unknown, envelope: Record<string, unknown>): void {
  const intent = requireRecord(value, "artifactIntent");
  requireExactKeys(intent, [
    "version", "intentId", "kind", "operationId", "attemptId", "acceptedAtMs", "targetRevision", "applyRange",
    "preparedRequestSha256", "selectedContextManifestSha256", "responseSha256",
  ], "artifactIntent");
  if (intent.version !== 1 || intent.kind !== "apply-extend-result") fail("artifact intent is unsupported");
  requireId(intent.intentId, "artifactIntent.intentId");
  if (intent.operationId !== envelope.operationId) fail("artifact intent operationId mismatch");
  const attempt = requireRecord(envelope.attempt, "attempt");
  if (intent.attemptId !== attempt.attemptId) fail("artifact intent attemptId mismatch");
  requireTimestamp(intent.acceptedAtMs, "artifactIntent.acceptedAtMs");
  const target = requireTargetRevision(intent.targetRevision, "artifactIntent.targetRevision");
  const range = requireRecord(intent.applyRange, "artifactIntent.applyRange");
  requireExactKeys(range, ["fromUtf16", "toUtf16"], "artifactIntent.applyRange");
  requireRange(range.fromUtf16, range.toUtf16, "artifactIntent.applyRange");
  requireHash(intent.preparedRequestSha256, "artifactIntent.preparedRequestSha256");
  requireHash(intent.selectedContextManifestSha256, "artifactIntent.selectedContextManifestSha256");
  requireHash(intent.responseSha256, "artifactIntent.responseSha256");
  const prepared = requireRecord(envelope.prepared, "prepared");
  const preparedTarget = requireTargetRevision(prepared.targetRevision, "prepared.targetRevision");
  if (canonicalJsonV1(target) !== canonicalJsonV1(preparedTarget)) fail("artifact intent target revision mismatch");
  const inputs = requireRecord(prepared.operationInputs, "prepared.operationInputs");
  if (range.fromUtf16 !== inputs.rangeFrom || range.toUtf16 !== inputs.rangeTo) {
    fail("artifact intent apply range mismatch");
  }
  const selected = requireRecord(envelope.selectedContext, "selectedContext");
  const response = requireRecord(envelope.response, "response");
  if (
    intent.preparedRequestSha256 !== prepared.requestSha256
    || intent.selectedContextManifestSha256 !== selected.manifestSha256
    || intent.responseSha256 !== response.responseSha256
  ) {
    fail("artifact intent binding mismatch");
  }
}

function validateArtifactReceipt(value: unknown): void {
  const receipt = requireRecord(value, "artifactReceipt");
  requireExactKeys(receipt, ["version", "receiptId", "recordedAtMs", "resultingContentHash"], "artifactReceipt");
  if (receipt.version !== 1) fail("artifact receipt version is unsupported");
  requireId(receipt.receiptId, "artifactReceipt.receiptId");
  requireTimestamp(receipt.recordedAtMs, "artifactReceipt.recordedAtMs");
  requireHash(receipt.resultingContentHash, "artifactReceipt.resultingContentHash");
}

function requireExtendRange(inputs: Record<string, unknown>, currentText: string): void {
  const from = inputs.rangeFrom;
  const to = inputs.rangeTo;
  requireRange(from, to, "prepared.operationInputs apply range");
  if ((to as number) > currentText.length) fail("Extend apply range is outside the selected current text");
  if (!isUtf16Boundary(currentText, from as number) || !isUtf16Boundary(currentText, to as number)) {
    fail("Extend apply range splits a Unicode scalar value");
  }
}

function validateExtendOperationInputs(value: unknown, currentText: string): void {
  const inputs = requireRecord(value, "prepared.operationInputs");
  requireExactKeys(inputs, [
    "seed", "hasSelection", "rangeFrom", "rangeTo", "sourceFrom", "sourceTo",
  ], "prepared.operationInputs");
  if (inputs.seed !== undefined) requireText(inputs.seed, "prepared.operationInputs.seed");
  if (inputs.hasSelection !== undefined && typeof inputs.hasSelection !== "boolean") {
    fail("prepared.operationInputs.hasSelection must be a boolean");
  }
  requireExtendRange(inputs, currentText);
  const hasSourceFrom = inputs.sourceFrom !== undefined;
  const hasSourceTo = inputs.sourceTo !== undefined;
  if (hasSourceFrom !== hasSourceTo) fail("prepared.operationInputs source range must be complete");
  if (hasSourceFrom) {
    requireRange(inputs.sourceFrom, inputs.sourceTo, "prepared.operationInputs source range");
    if ((inputs.sourceTo as number) > currentText.length) {
      fail("Extend source range is outside the selected current text");
    }
    if (
      !isUtf16Boundary(currentText, inputs.sourceFrom as number)
      || !isUtf16Boundary(currentText, inputs.sourceTo as number)
    ) {
      fail("Extend source range splits a Unicode scalar value");
    }
  }
}

function requireRange(from: unknown, to: unknown, subject: string): void {
  if (
    !Number.isSafeInteger(from)
    || !Number.isSafeInteger(to)
    || (from as number) < 0
    || (to as number) < (from as number)
  ) {
    fail(`${subject} must be an ordered non-negative UTF-16 range`);
  }
}

function requireTargetRevision(value: unknown, subject: string): PreparedTargetRevision {
  const target = requireRecord(value, subject);
  requireExactKeys(target, ["folderId", "path", "traceId", "headId", "contentHash"], subject);
  requireHash(target.folderId, `${subject}.folderId`);
  requireNonEmptyText(target.path, `${subject}.path`, 4_096);
  requireHash(target.traceId, `${subject}.traceId`);
  requireHash(target.headId, `${subject}.headId`);
  requireHash(target.contentHash, `${subject}.contentHash`);
  return target as unknown as PreparedTargetRevision;
}

function validateAndFreezeEnvelope(envelope: DesktopOperationEnvelopeV1): DesktopOperationEnvelopeV1 {
  validateDesktopOperationEnvelopeV1(envelope);
  return deepFreeze(envelope);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalJsonV1(value)) as T;
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    requireUnicode(value, path);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) fail(`${path} must be a safe I-JSON integer`);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value !== "object") fail(`${path} contains non-JSON ${typeof value}`);
  if (seen.has(value)) fail(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => serialize(entry, `${path}[${index}]`, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort(compareUtf8);
    for (const key of keys) {
      requireUnicode(key, `${path} object key`);
      if (record[key] === undefined) fail(`${path}.${key} is undefined`);
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key], `${path}.${key}`, seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function requireUnicode(value: string, subject: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${subject} contains an unpaired high surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(`${subject} contains an unpaired low surrogate`);
    }
  }
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${subject} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  subject: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${subject}.${key} is not part of the versioned contract`);
  }
}

function requireText(value: unknown, subject: string): string {
  if (typeof value !== "string") fail(`${subject} must be a string`);
  requireUnicode(value, subject);
  return value;
}

function requireNonEmptyText(value: unknown, subject: string, maxLength: number): string {
  const text = requireText(value, subject);
  if (text.length === 0 || text.length > maxLength) fail(`${subject} length is invalid`);
  return text;
}

function requireId(value: unknown, subject: string): string {
  const id = requireText(value, subject);
  if (!ID_PATTERN.test(id)) fail(`${subject} must be 8-128 portable id characters`);
  return id;
}

function requireHash(value: unknown, subject: string): string {
  const hash = requireText(value, subject);
  if (!SHA256_PATTERN.test(hash)) fail(`${subject} must be lowercase SHA-256 hex`);
  return hash;
}

function requireDiagnosticRef(value: unknown): string {
  const ref = requireText(value, "fault.diagnosticRef");
  if (!DIAGNOSTIC_REF_PATTERN.test(ref)) {
    fail("fault.diagnosticRef must be an opaque diag-prefixed local identifier");
  }
  return ref;
}

function requireTimestamp(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(`${subject} must be a non-negative safe integer`);
  return value as number;
}

function requireStatus(value: unknown): DesktopOperationStatusV1 {
  if (!STATUSES.has(value as DesktopOperationStatusV1)) fail("lifecycle status is unsupported");
  return value as DesktopOperationStatusV1;
}

function requireCertainty(value: unknown): OperationExecutionCertaintyV1 {
  if (!CERTAINTIES.has(value as OperationExecutionCertaintyV1)) fail("execution certainty is unsupported");
  return value as OperationExecutionCertaintyV1;
}

function requireRetryPolicy(value: unknown): OperationRetryPolicyV1 {
  if (!RETRY_POLICIES.has(value as OperationRetryPolicyV1)) fail("retry policy is unsupported");
  return value as OperationRetryPolicyV1;
}

function transitionTargetStatus(
  type: DesktopOperationTransitionTypeV1,
  fromStatus: DesktopOperationStatusV1,
): DesktopOperationStatusV1 {
  switch (type) {
    case "approve":
      if (fromStatus === "prepared") return "approved";
      break;
    case "record-dispatch-intent":
      if (fromStatus === "approved") return "dispatch-intent";
      break;
    case "record-provider-io-may-have-started":
      if (fromStatus === "dispatch-intent") return "provider-io";
      break;
    case "record-response":
      if (fromStatus === "provider-io") return "response-completed";
      break;
    case "record-failure":
      if (["approved", "dispatch-intent", "provider-io"].includes(fromStatus)) return "failed";
      break;
    case "cancel":
      if (["prepared", "approved", "dispatch-intent"].includes(fromStatus)) return "cancelled";
      break;
    case "mark-dispatch-unknown":
      if (fromStatus === "dispatch-intent" || fromStatus === "provider-io") return "unknown";
      break;
    case "accept-result":
      if (fromStatus === "response-completed") return "accepted";
      break;
    case "mark-target-stale":
      if (["prepared", "approved", "response-completed", "accepted"].includes(fromStatus)) return "stale";
      break;
    case "reject-result":
      if (fromStatus === "response-completed" || fromStatus === "stale") return "rejected";
      break;
    case "abandon":
      if (["prepared", "approved", "dispatch-intent", "unknown"].includes(fromStatus)) return "abandoned";
      break;
    case "record-artifact-applied":
      if (fromStatus === "accepted") return "accepted";
      break;
  }
  fail(`${type} is illegal from ${fromStatus} in the applied transition chain`);
}

function fail(message: string): never {
  throw new DesktopOperationEnvelopeError(message);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const STATUSES = new Set<DesktopOperationStatusV1>([
  "prepared", "approved", "dispatch-intent", "provider-io", "response-completed",
  "failed", "cancelled", "unknown", "accepted", "stale", "rejected", "abandoned",
]);
const CERTAINTIES = new Set<OperationExecutionCertaintyV1>([
  "known-not-dispatched", "may-have-dispatched", "provider-completed-without-result", "response-recorded",
]);
const RETRY_POLICIES = new Set<OperationRetryPolicyV1>([
  "not-eligible", "safe-new-attempt", "operator-confirmation-required",
]);
const FAULT_CODES = new Set<OperationFaultCodeV1>([
  "PREPARATION_INVALID", "APPROVAL_INVALID", "LOCAL_PERSISTENCE_FAILED", "PROVIDER_REJECTED",
  "PROVIDER_UNAVAILABLE", "PROVIDER_RESPONSE_INVALID", "TARGET_STALE", "OPERATOR_CANCELLED",
  "DISPATCH_OUTCOME_UNKNOWN", "PRIVATE_ENVELOPE_EXPIRED",
]);
const FAULT_STAGES = new Set<OperationFaultStageV1>([
  "prepare", "approve", "persist", "dispatch", "response", "review", "apply", "retention",
]);
const TRANSITION_TYPES = new Set<DesktopOperationTransitionTypeV1>([
  "approve", "record-dispatch-intent", "record-provider-io-may-have-started", "record-response",
  "record-failure", "cancel", "mark-dispatch-unknown", "accept-result", "mark-target-stale",
  "reject-result", "abandon",
  "record-artifact-applied",
]);
