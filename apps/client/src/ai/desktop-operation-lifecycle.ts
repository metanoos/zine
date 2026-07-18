import {
  DESKTOP_OPERATION_MAX_RESPONSE_BYTES,
  DESKTOP_OPERATION_MAX_RETENTION_MS,
  DESKTOP_OPERATION_MAX_TRANSITIONS,
  cloneAndFreezeDesktopOperationEnvelopeV1,
  createDesktopOperationEnvelopeV1,
  hashCanonicalV1,
  hashTextV1,
  validateOperationFaultV1,
  type AcceptedArtifactIntentV1,
  type CreateDesktopOperationEnvelopeV1Input,
  type DesktopOperationEnvelopeV1,
  type DesktopOperationStatusV1,
  type DesktopOperationTransitionTypeV1,
  type OperationFaultV1,
} from "./desktop-operation-envelope.js";

const encoder = new TextEncoder();

interface OperationTransitionBaseV1 {
  version: 1;
  transitionId: string;
  atMs: number;
}

export type DesktopOperationTransitionV1 =
  | (OperationTransitionBaseV1 & { type: "approve" })
  | (OperationTransitionBaseV1 & { type: "record-dispatch-intent" })
  | (OperationTransitionBaseV1 & { type: "record-provider-io-may-have-started" })
  | (OperationTransitionBaseV1 & { type: "record-response"; responseText: string })
  | (OperationTransitionBaseV1 & {
      type: "record-failure";
      certainty: "known-not-dispatched" | "provider-completed-without-result";
      fault: OperationFaultV1;
    })
  | (OperationTransitionBaseV1 & { type: "cancel"; diagnosticRef?: string })
  | (OperationTransitionBaseV1 & { type: "mark-dispatch-unknown"; diagnosticRef?: string })
  | (OperationTransitionBaseV1 & { type: "accept-result"; artifactIntentId: string })
  | (OperationTransitionBaseV1 & { type: "mark-target-stale"; diagnosticRef?: string })
  | (OperationTransitionBaseV1 & { type: "reject-result" })
  | (OperationTransitionBaseV1 & { type: "abandon" })
  | (OperationTransitionBaseV1 & {
      type: "record-artifact-applied";
      receiptId: string;
      resultingContentHash: string;
    });

export type DesktopOperationEffectV1 =
  | {
      version: 1;
      kind: "dispatch-provider-request";
      operationId: string;
      attemptId: string;
      requestSha256: string;
    }
  | {
      version: 1;
      kind: "present-result-for-review";
      operationId: string;
      attemptId: string;
      responseSha256: string;
    }
  | {
      version: 1;
      kind: "apply-artifact-intent";
      operationId: string;
      attemptId: string;
      intent: AcceptedArtifactIntentV1;
    }
  | {
      version: 1;
      kind: "record-attempt-unknown";
      operationId: string;
      attemptId: string;
    }
  | {
      version: 1;
      kind: "delete-expired-private-envelope";
      operationId: string;
      attemptId: string;
    };

export interface DesktopOperationReductionV1 {
  version: 1;
  envelope: DesktopOperationEnvelopeV1;
  effects: readonly DesktopOperationEffectV1[];
  replayed: boolean;
  /** Store `envelope` durably before interpreting any returned effect. */
  mustPersistBeforeEffects: true;
}

export class DesktopOperationTransitionError extends Error {
  constructor(message: string) {
    super(`Desktop operation transition: ${message}`);
    this.name = "DesktopOperationTransitionError";
  }
}

/**
 * Pure transition reducer. It never reads time, storage, provider state, or the
 * editor. The caller supplies stable ids/timestamps, persists the returned
 * envelope, and only then interprets effects.
 */
export function reduceDesktopOperationV1(
  envelope: DesktopOperationEnvelopeV1,
  transition: DesktopOperationTransitionV1,
): DesktopOperationReductionV1 {
  if (transition.version !== 1) fail("transition version is unsupported");
  const actionSha256 = hashCanonicalV1("zine.desktop-operation.transition.v1", transition);
  const applied = envelope.appliedTransitions.find(
    (candidate) => candidate.transitionId === transition.transitionId,
  );
  if (applied) {
    if (applied.actionSha256 !== actionSha256) {
      fail(`transition id ${transition.transitionId} was reused with different bytes`);
    }
    return reduction(envelope, [], true);
  }
  if (!Number.isSafeInteger(transition.atMs) || transition.atMs < envelope.updatedAtMs) {
    fail("transition time must be a monotonic non-negative safe integer");
  }
  if (envelope.appliedTransitions.length >= DESKTOP_OPERATION_MAX_TRANSITIONS) {
    fail(`attempt exceeds ${DESKTOP_OPERATION_MAX_TRANSITIONS} transitions`);
  }

  let next: DesktopOperationEnvelopeV1;
  let effects: readonly DesktopOperationEffectV1[] = [];
  switch (transition.type) {
    case "approve":
      requireCurrent(envelope, transition.type, "prepared");
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "approved",
        executionCertainty: "known-not-dispatched",
        retryPolicy: "not-eligible",
      });
      break;
    case "record-dispatch-intent":
      requireCurrent(envelope, transition.type, "approved");
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "dispatch-intent",
        executionCertainty: "known-not-dispatched",
        retryPolicy: "not-eligible",
      });
      break;
    case "record-provider-io-may-have-started":
      requireCurrent(envelope, transition.type, "dispatch-intent");
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "provider-io",
        executionCertainty: "may-have-dispatched",
        retryPolicy: "not-eligible",
      });
      effects = [{
        version: 1,
        kind: "dispatch-provider-request",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
        requestSha256: envelope.prepared.requestSha256,
      }];
      break;
    case "record-response": {
      requireCurrent(envelope, transition.type, "provider-io");
      if (encoder.encode(transition.responseText).length > DESKTOP_OPERATION_MAX_RESPONSE_BYTES) {
        fail(`response exceeds ${DESKTOP_OPERATION_MAX_RESPONSE_BYTES} bytes`);
      }
      const responseSha256 = hashTextV1(
        "zine.desktop-operation.response.v1",
        transition.responseText,
      );
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "response-completed",
        executionCertainty: "response-recorded",
        retryPolicy: "not-eligible",
      }, {
        response: {
          version: 1,
          text: transition.responseText,
          responseSha256,
          completedAtMs: transition.atMs,
        },
        fault: null,
      });
      effects = [{
        version: 1,
        kind: "present-result-for-review",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
        responseSha256,
      }];
      break;
    }
    case "record-failure":
      validateOperationFaultV1(transition.fault);
      if (transition.certainty === "known-not-dispatched") {
        requireCurrent(envelope, transition.type, "approved", "dispatch-intent");
      } else {
        requireCurrent(envelope, transition.type, "provider-io");
      }
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "failed",
        executionCertainty: transition.certainty,
        retryPolicy: transition.certainty === "known-not-dispatched"
          ? "safe-new-attempt"
          : "operator-confirmation-required",
      }, { fault: { ...transition.fault } });
      break;
    case "cancel": {
      requireCurrent(envelope, transition.type, "prepared", "approved", "dispatch-intent");
      const fault: OperationFaultV1 = {
        version: 1,
        code: "OPERATOR_CANCELLED",
        stage: envelope.lifecycle.status === "prepared" ? "prepare" : "dispatch",
        observedAtMs: transition.atMs,
        ...(transition.diagnosticRef ? { diagnosticRef: transition.diagnosticRef } : {}),
      };
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "cancelled",
        executionCertainty: "known-not-dispatched",
        retryPolicy: "safe-new-attempt",
      }, { fault });
      break;
    }
    case "mark-dispatch-unknown": {
      requireCurrent(envelope, transition.type, "dispatch-intent", "provider-io");
      const fault: OperationFaultV1 = {
        version: 1,
        code: "DISPATCH_OUTCOME_UNKNOWN",
        stage: "dispatch",
        observedAtMs: transition.atMs,
        ...(transition.diagnosticRef ? { diagnosticRef: transition.diagnosticRef } : {}),
      };
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "unknown",
        executionCertainty: "may-have-dispatched",
        retryPolicy: "operator-confirmation-required",
      }, { fault });
      break;
    }
    case "accept-result": {
      requireCurrent(envelope, transition.type, "response-completed");
      const response = envelope.response;
      if (!response) fail("accepted result has no recorded response");
      const range = extendApplyRange(envelope);
      const artifactIntent: AcceptedArtifactIntentV1 = {
        version: 1,
        intentId: transition.artifactIntentId,
        kind: "apply-extend-result",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
        acceptedAtMs: transition.atMs,
        targetRevision: { ...envelope.prepared.targetRevision },
        applyRange: range,
        preparedRequestSha256: envelope.prepared.requestSha256,
        selectedContextManifestSha256: envelope.selectedContext.manifestSha256,
        responseSha256: response.responseSha256,
      };
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "accepted",
        executionCertainty: "response-recorded",
        retryPolicy: "not-eligible",
      }, { artifactIntent });
      effects = [{
        version: 1,
        kind: "apply-artifact-intent",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
        intent: artifactIntent,
      }];
      break;
    }
    case "mark-target-stale": {
      requireCurrent(envelope, transition.type, "response-completed", "accepted");
      if (envelope.lifecycle.status === "accepted" && envelope.artifactReceipt) {
        fail("an applied artifact cannot later be marked target-stale");
      }
      const fault: OperationFaultV1 = {
        version: 1,
        code: "TARGET_STALE",
        stage: envelope.lifecycle.status === "accepted" ? "apply" : "review",
        observedAtMs: transition.atMs,
        ...(transition.diagnosticRef ? { diagnosticRef: transition.diagnosticRef } : {}),
      };
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "stale",
        executionCertainty: "response-recorded",
        retryPolicy: "safe-new-attempt",
      }, {
        fault,
        artifactIntent: null,
        artifactReceipt: null,
      });
      break;
    }
    case "reject-result":
      requireCurrent(envelope, transition.type, "response-completed", "stale");
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "rejected",
        executionCertainty: "response-recorded",
        retryPolicy: "safe-new-attempt",
      }, { fault: null, artifactIntent: null, artifactReceipt: null });
      break;
    case "abandon": {
      requireCurrent(envelope, transition.type, "prepared", "approved", "dispatch-intent", "unknown");
      const ambiguous = envelope.lifecycle.status === "unknown";
      next = withLifecycle(envelope, transition, actionSha256, {
        status: "abandoned",
        executionCertainty: ambiguous ? "may-have-dispatched" : "known-not-dispatched",
        retryPolicy: "not-eligible",
      });
      break;
    }
    case "record-artifact-applied":
      requireCurrent(envelope, transition.type, "accepted");
      if (!envelope.artifactIntent) fail("artifact receipt has no accepted intent");
      if (envelope.artifactReceipt) fail("artifact application receipt is already recorded");
      next = withLifecycle(envelope, transition, actionSha256, envelope.lifecycle, {
        artifactReceipt: {
          version: 1,
          receiptId: transition.receiptId,
          recordedAtMs: transition.atMs,
          resultingContentHash: transition.resultingContentHash,
        },
      });
      break;
    default:
      fail(`transition type ${(transition as { type?: unknown }).type ?? "<missing>"} is unsupported`);
  }
  return reduction(next, effects, false);
}

export interface DesktopOperationRecoveryProjectionV1 {
  version: 1;
  operationId: string;
  attemptId: string;
  status: DesktopOperationStatusV1;
  retryPolicy: DesktopOperationEnvelopeV1["lifecycle"]["retryPolicy"];
  automaticEffects: readonly DesktopOperationEffectV1[];
  operatorAction:
    | "approve-or-abandon"
    | "dispatch-or-abandon"
    | "review-result"
    | "review-stale-result"
    | "confirm-possible-duplicate-or-stop"
    | "none";
  mayAutomaticallyDispatch: boolean;
  privateEnvelopeDeletionDue: boolean;
}

/**
 * Recovery never returns `dispatch-provider-request` for a dispatch-intent or
 * provider-io state. A process/activation boundary can roll back the later
 * marker after I/O began, so both fail closed to `unknown` rather than risk a
 * duplicate provider call.
 */
export function projectDesktopOperationRecoveryV1(
  envelope: DesktopOperationEnvelopeV1,
  nowMs: number,
): DesktopOperationRecoveryProjectionV1 {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail("recovery time must be a non-negative safe integer");
  const privateEnvelopeDeletionDue = nowMs >= envelope.retention.deleteByMs;
  if (privateEnvelopeDeletionDue) {
    return Object.freeze({
      version: 1,
      operationId: envelope.operationId,
      attemptId: envelope.attempt.attemptId,
      status: envelope.lifecycle.status,
      retryPolicy: envelope.lifecycle.retryPolicy,
      automaticEffects: freezeEffects([{
        version: 1,
        kind: "delete-expired-private-envelope",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
      }]),
      operatorAction: "none",
      mayAutomaticallyDispatch: false,
      privateEnvelopeDeletionDue: true,
    });
  }
  const automaticEffects: DesktopOperationEffectV1[] = [];
  let operatorAction: DesktopOperationRecoveryProjectionV1["operatorAction"] = "none";
  switch (envelope.lifecycle.status) {
    case "prepared":
      operatorAction = "approve-or-abandon";
      break;
    case "approved":
      operatorAction = "dispatch-or-abandon";
      break;
    case "dispatch-intent":
    case "provider-io":
      automaticEffects.push({
        version: 1,
        kind: "record-attempt-unknown",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
      });
      break;
    case "response-completed":
      automaticEffects.push({
        version: 1,
        kind: "present-result-for-review",
        operationId: envelope.operationId,
        attemptId: envelope.attempt.attemptId,
        responseSha256: envelope.response!.responseSha256,
      });
      operatorAction = "review-result";
      break;
    case "accepted":
      if (!envelope.artifactReceipt) {
        automaticEffects.push({
          version: 1,
          kind: "apply-artifact-intent",
          operationId: envelope.operationId,
          attemptId: envelope.attempt.attemptId,
          intent: envelope.artifactIntent!,
        });
      }
      break;
    case "stale":
      operatorAction = "review-stale-result";
      break;
    case "unknown":
      operatorAction = "confirm-possible-duplicate-or-stop";
      break;
    case "failed":
      if (envelope.lifecycle.retryPolicy === "operator-confirmation-required") {
        operatorAction = "confirm-possible-duplicate-or-stop";
      }
      break;
    case "cancelled":
    case "rejected":
    case "abandoned":
      break;
  }
  return Object.freeze({
    version: 1,
    operationId: envelope.operationId,
    attemptId: envelope.attempt.attemptId,
    status: envelope.lifecycle.status,
    retryPolicy: envelope.lifecycle.retryPolicy,
    automaticEffects: freezeEffects(automaticEffects),
    operatorAction,
    mayAutomaticallyDispatch: false,
    privateEnvelopeDeletionDue,
  });
}

export interface CreateDesktopOperationRetryV1Input {
  attemptId: string;
  createdAtMs: number;
  retainForMs?: number;
  possibleDuplicateAcknowledged?: true;
  /** Required after TARGET_STALE; must be captured from the current editor revision. */
  freshPreparation?: Pick<
    CreateDesktopOperationEnvelopeV1Input,
    "prepared" | "provider" | "selectedContext" | "maxOutputTokens"
  >;
}

/** Create a linked attempt; never mutate or redispatch the prior attempt. */
export function createDesktopOperationRetryV1(
  prior: DesktopOperationEnvelopeV1,
  input: CreateDesktopOperationRetryV1Input,
): DesktopOperationEnvelopeV1 {
  if (prior.lifecycle.retryPolicy === "not-eligible") fail(`${prior.lifecycle.status} is not retryable`);
  if (input.attemptId === prior.attempt.attemptId) fail("retry must use a new attempt id");
  if (
    prior.lifecycle.retryPolicy === "operator-confirmation-required"
    && input.possibleDuplicateAcknowledged !== true
  ) {
    fail("possible provider dispatch requires explicit operator confirmation before retry");
  }
  if (
    prior.lifecycle.retryPolicy === "safe-new-attempt"
    && input.possibleDuplicateAcknowledged === true
  ) {
    fail("safe retry must not acknowledge a possible duplicate");
  }
  if (!Number.isSafeInteger(input.createdAtMs) || input.createdAtMs < prior.updatedAtMs) {
    fail("retry time must be monotonic");
  }
  const retainForMs = input.retainForMs
    ?? (prior.retention.deleteByMs - prior.retention.startedAtMs);
  if (!Number.isSafeInteger(retainForMs) || retainForMs <= 0 || retainForMs > DESKTOP_OPERATION_MAX_RETENTION_MS) {
    fail(`retry retention must be between 1 and ${DESKTOP_OPERATION_MAX_RETENTION_MS}`);
  }
  if (prior.lifecycle.status === "stale" && !input.freshPreparation) {
    fail("stale retry requires a fresh prepared operation and selected context");
  }
  if (input.freshPreparation) {
    if (prior.lifecycle.status !== "stale") {
      fail("fresh preparation is valid only for a stale retry");
    }
    if (input.freshPreparation.prepared.requestId === prior.prepared.requestId) {
      fail("fresh retry must use a new prepared request id");
    }
    if (
      input.freshPreparation.prepared.preparedRequestHash
      === prior.prepared.upstreamPreparedRequestHash
    ) {
      fail("fresh retry must use a new prepared request identity");
    }
    const freshTarget = input.freshPreparation.prepared.targetRevision;
    const priorTarget = prior.prepared.targetRevision;
    if (
      freshTarget.folderId !== priorTarget.folderId
      || freshTarget.path !== priorTarget.path
      || freshTarget.traceId !== priorTarget.traceId
    ) {
      fail("stale retry must re-prepare the same stable folder, path, and trace target");
    }
    const fresh = createDesktopOperationEnvelopeV1({
      operationId: prior.operationId,
      attemptId: input.attemptId,
      ...input.freshPreparation,
      createdAtMs: input.createdAtMs,
      retainForMs,
    });
    return cloneAndFreezeDesktopOperationEnvelopeV1({
      ...fresh,
      attempt: {
        ...fresh.attempt,
        retryOfAttemptId: prior.attempt.attemptId,
        possibleDuplicateAcknowledgedAtMs: input.possibleDuplicateAcknowledged
          ? input.createdAtMs
          : null,
      },
    });
  }
  const next: DesktopOperationEnvelopeV1 = {
    ...prior,
    attempt: {
      attemptId: input.attemptId,
      retryOfAttemptId: prior.attempt.attemptId,
      createdAtMs: input.createdAtMs,
      possibleDuplicateAcknowledgedAtMs: input.possibleDuplicateAcknowledged
        ? input.createdAtMs
        : null,
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
      ...prior.retention,
      startedAtMs: input.createdAtMs,
      deleteByMs: input.createdAtMs + retainForMs,
    },
    appliedTransitions: [],
    updatedAtMs: input.createdAtMs,
  };
  return cloneAndFreezeDesktopOperationEnvelopeV1(next);
}

function withLifecycle(
  envelope: DesktopOperationEnvelopeV1,
  transition: DesktopOperationTransitionV1,
  actionSha256: string,
  lifecycle: DesktopOperationEnvelopeV1["lifecycle"],
  patch: Partial<Pick<
    DesktopOperationEnvelopeV1,
    "response" | "fault" | "artifactIntent" | "artifactReceipt"
  >> = {},
): DesktopOperationEnvelopeV1 {
  const next: DesktopOperationEnvelopeV1 = {
    ...envelope,
    ...patch,
    lifecycle: { ...lifecycle },
    appliedTransitions: [
      ...envelope.appliedTransitions,
      {
        transitionId: transition.transitionId,
        transitionType: transition.type as DesktopOperationTransitionTypeV1,
        fromStatus: envelope.lifecycle.status,
        toStatus: lifecycle.status,
        actionSha256,
        appliedAtMs: transition.atMs,
      },
    ],
    updatedAtMs: transition.atMs,
  };
  return cloneAndFreezeDesktopOperationEnvelopeV1(next);
}

function extendApplyRange(
  envelope: DesktopOperationEnvelopeV1,
): { fromUtf16: number; toUtf16: number } {
  const { rangeFrom, rangeTo } = envelope.prepared.operationInputs;
  if (!Number.isSafeInteger(rangeFrom) || !Number.isSafeInteger(rangeTo)) {
    fail("prepared Extend request has no exact apply range");
  }
  return { fromUtf16: rangeFrom!, toUtf16: rangeTo! };
}

function requireCurrent(
  envelope: DesktopOperationEnvelopeV1,
  transition: DesktopOperationTransitionV1["type"],
  ...expected: readonly DesktopOperationStatusV1[]
): void {
  if (!expected.includes(envelope.lifecycle.status)) {
    fail(`${transition} is illegal from ${envelope.lifecycle.status}; expected ${expected.join(" or ")}`);
  }
}

function reduction(
  envelope: DesktopOperationEnvelopeV1,
  effects: readonly DesktopOperationEffectV1[],
  replayed: boolean,
): DesktopOperationReductionV1 {
  return Object.freeze({
    version: 1,
    envelope,
    effects: freezeEffects(effects),
    replayed,
    mustPersistBeforeEffects: true,
  });
}

function freezeEffects(
  effects: readonly DesktopOperationEffectV1[],
): readonly DesktopOperationEffectV1[] {
  for (const effect of effects) Object.freeze(effect);
  return Object.freeze([...effects]);
}

function fail(message: string): never {
  throw new DesktopOperationTransitionError(message);
}
