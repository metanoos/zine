import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTraceContextV1,
  type TraceContextSelectionSuccessV1,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import {
  DESKTOP_OPERATION_MAX_RESPONSE_BYTES,
  DesktopOperationEnvelopeError,
  canonicalJsonV1,
  createDesktopOperationEnvelopeV1,
  hashDesktopOperationEnvelopeV1,
  parseDesktopOperationEnvelopeV1,
  serializeDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
  type OperationFaultV1,
} from "./desktop-operation-envelope.js";
import {
  DesktopOperationTransitionError,
  createDesktopOperationRetryV1,
  projectDesktopOperationRecoveryV1,
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import type { PreparedOperation } from "./prepared-operation.js";

const TARGET_TEXT = "draft";
const BASE_TIME = 1_000;
const HASH = (label: string) => contentFingerprint(label);
let selectionPromise: Promise<TraceContextSelectionSuccessV1> | null = null;

async function selection(): Promise<TraceContextSelectionSuccessV1> {
  selectionPromise ??= selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-1",
        headId: "head-1",
        contentHash: "content-1",
        currentText: TARGET_TEXT,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: TARGET_TEXT.length, toUtf16: TARGET_TEXT.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  }).then((result) => {
    assert.equal(result.ok, true);
    return result as TraceContextSelectionSuccessV1;
  });
  const result = await selectionPromise;
  assert.equal(result.ok, true);
  return result;
}

function prepared(renderedContext: string): PreparedOperation {
  return Object.freeze({
    version: 1,
    requestId: "request-0001",
    operation: "extend",
    operationInputs: Object.freeze({
      seed: TARGET_TEXT,
      hasSelection: false,
      rangeFrom: TARGET_TEXT.length,
      rangeTo: TARGET_TEXT.length,
      sourceFrom: 0,
      sourceTo: TARGET_TEXT.length,
    }),
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: HASH("context"),
    traceAuthoring: null,
    messages: Object.freeze([
      { role: "system" as const, content: "Continue the document." },
      { role: "user" as const, content: renderedContext },
    ]),
    providerId: "provider-0001",
    providerFingerprint: HASH("provider"),
    targetRevision: {
      folderId: "folder-1",
      path: "draft.md",
      traceId: "trace-1",
      headId: "head-1",
      contentHash: "content-1",
    },
    provenance: Object.freeze({
      modelVoicePubkey: "a".repeat(64),
      lensId: "default" as const,
      voicePromptHash: HASH("voice"),
      dependencyFingerprint: HASH("dependency"),
    }),
    budget: Object.freeze({
      maxBytes: 32_768,
      totalBytes: 2_048,
      estimatedTokens: 512,
      contextBytes: 1_024,
      promptLayerBytes: 1_024,
    }),
    preparedRequestHash: HASH("upstream-request"),
    createdAt: BASE_TIME,
  });
}

async function envelope(suffix = "0001"): Promise<DesktopOperationEnvelopeV1> {
  const selected = await selection();
  return createDesktopOperationEnvelopeV1({
    operationId: `operation-${suffix}`,
    attemptId: `attempt-${suffix}`,
    prepared: prepared(selected.renderedContext),
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("redacted-transport-config"),
    },
    selectedContext: selected,
    maxOutputTokens: 1_024,
    createdAtMs: BASE_TIME,
    retainForMs: 60_000,
  });
}

function fault(
  code: OperationFaultV1["code"] = "PROVIDER_UNAVAILABLE",
  observedAtMs = BASE_TIME + 10,
): OperationFaultV1 {
  return {
    version: 1,
    code,
    stage: "dispatch",
    observedAtMs,
    diagnosticRef: "diagnostic-0001",
  };
}

function transition<T extends DesktopOperationTransitionV1["type"]>(
  type: T,
  atMs: number,
  extras: Omit<Extract<DesktopOperationTransitionV1, { type: T }>, "version" | "type" | "transitionId" | "atMs">,
): Extract<DesktopOperationTransitionV1, { type: T }> {
  return {
    version: 1,
    type,
    transitionId: `transition-${type}-${atMs}`,
    atMs,
    ...extras,
  } as Extract<DesktopOperationTransitionV1, { type: T }>;
}

function apply(
  current: DesktopOperationEnvelopeV1,
  action: DesktopOperationTransitionV1,
): DesktopOperationEnvelopeV1 {
  return reduceDesktopOperationV1(current, action).envelope;
}

async function atStatus(
  status: DesktopOperationEnvelopeV1["lifecycle"]["status"],
): Promise<DesktopOperationEnvelopeV1> {
  let current = await envelope(status.replace(/[^a-z]/g, "0").padEnd(8, "0"));
  let at = BASE_TIME + 1;
  const run = (action: DesktopOperationTransitionV1) => {
    current = apply(current, action);
    at += 1;
  };
  if (status === "prepared") return current;
  if (status === "cancelled") {
    run(transition("cancel", at, {}));
    return current;
  }
  if (status === "abandoned") {
    run(transition("abandon", at, {}));
    return current;
  }
  run(transition("approve", at, {}));
  if (status === "approved") return current;
  run(transition("record-dispatch-intent", at, {}));
  if (status === "dispatch-intent") return current;
  if (status === "failed") {
    run(transition("record-failure", at, {
      certainty: "known-not-dispatched",
      fault: fault("PROVIDER_UNAVAILABLE", at),
    }));
    return current;
  }
  run(transition("record-provider-io-may-have-started", at, {}));
  if (status === "provider-io") return current;
  if (status === "unknown") {
    run(transition("mark-dispatch-unknown", at, {}));
    return current;
  }
  run(transition("record-response", at, { responseText: "continued prose" }));
  if (status === "response-completed") return current;
  if (status === "rejected") {
    run(transition("reject-result", at, {}));
    return current;
  }
  run(transition("accept-result", at, { artifactIntentId: "artifact-intent-0001" }));
  assert.equal(status, "accepted");
  return current;
}

test("creates a frozen private envelope bound to exact request and selected-context bytes", async () => {
  const subject = await envelope();
  assert.equal(subject.lifecycle.status, "prepared");
  assert.equal(subject.prepared.operation, "extend");
  assert.equal(subject.selectedContext.manifest.operation.target.headId, "head-1");
  assert.equal(subject.selectedContext.renderedContext, subject.prepared.messages[1]!.content);
  assert.equal(Object.isFrozen(subject), true);
  assert.equal(Object.isFrozen(subject.selectedContext.manifest), true);
  assert.match(subject.prepared.requestSha256, /^[0-9a-f]{64}$/);
  assert.match(hashDesktopOperationEnvelopeV1(subject), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(subject), /credential|api.?key|bearer/i);
  assert.equal(subject.retention.classification, "vault-local-private");
  assert.equal(subject.retention.deleteByMs, BASE_TIME + 60_000);
});

test("canonical bytes are deterministic, I-JSON safe, and round-trip with integrity checks", async () => {
  const subject = await envelope();
  const serialized = serializeDesktopOperationEnvelopeV1(subject);
  const parsed = parseDesktopOperationEnvelopeV1(serialized);
  assert.deepEqual(parsed, subject);
  assert.equal(serializeDesktopOperationEnvelopeV1(parsed), serialized);
  assert.equal(canonicalJsonV1({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.throws(() => canonicalJsonV1({ bad: Number.NaN }), DesktopOperationEnvelopeError);
  assert.throws(() => canonicalJsonV1({ bad: 1.5 }), /safe I-JSON integer/);
  assert.throws(() => canonicalJsonV1({ bad: undefined }), /undefined/);
  assert.throws(() => canonicalJsonV1({ bad: "\ud800" }), /unpaired high surrogate/);

  const corrupted = JSON.parse(serialized) as {
    prepared: { messages: Array<{ role: string; content: string }> };
  };
  corrupted.prepared.messages[1]!.content = "tampered";
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(corrupted)),
    /prepared request hash does not match/,
  );
});

test("creation rejects mismatched context identity, non-Extend operations, split Unicode, and unbounded retention", async () => {
  const selected = await selection();
  const base = {
    operationId: "operation-invalid",
    attemptId: "attempt-invalid",
    prepared: prepared(selected.renderedContext),
    provider: {
      protocol: "openai" as const,
      modelId: "model-1",
      transportConfigSha256: HASH("config"),
    },
    selectedContext: selected,
    maxOutputTokens: 100,
    createdAtMs: BASE_TIME,
  };
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    selectedContext: { ...selected, renderedContext: `${selected.renderedContext}x` },
  }), /rendered-context identity/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: { ...base.prepared, operation: "settle" },
  }), /supports Extend only/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    retainForMs: 31 * 24 * 60 * 60 * 1_000,
  }), /retainForMs/);

  const badPrepared = {
    ...base.prepared,
    operationInputs: { ...base.prepared.operationInputs, rangeFrom: 1, rangeTo: 1 },
  };
  const selectedEmoji = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-1", headId: "head-1", contentHash: "content-1",
        currentText: "😀", chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: 0 },
      maxContextBytes: 1_024,
      preparedRequestMaxBytes: 2_048,
      reservedPromptBytes: 100,
    },
    candidates: [],
  });
  assert.equal(selectedEmoji.ok, true);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: badPrepared,
    selectedContext: selectedEmoji as TraceContextSelectionSuccessV1,
  }), /splits a Unicode scalar/);
});

test("the complete live path emits one dispatch, review, and accepted-only artifact intent", async () => {
  let current = await envelope();
  current = apply(current, transition("approve", 1_001, {}));
  current = apply(current, transition("record-dispatch-intent", 1_002, {}));
  const ioAction = transition("record-provider-io-may-have-started", 1_003, {});
  const io = reduceDesktopOperationV1(current, ioAction);
  current = io.envelope;
  assert.deepEqual(io.effects.map((effect) => effect.kind), ["dispatch-provider-request"]);
  assert.equal(io.mustPersistBeforeEffects, true);
  assert.deepEqual(
    current.appliedTransitions.map((entry) => entry.transitionType),
    ["approve", "record-dispatch-intent", "record-provider-io-may-have-started"],
  );
  const replay = reduceDesktopOperationV1(current, ioAction);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.effects, [], "idempotent replay cannot redispatch");

  const completed = reduceDesktopOperationV1(
    current,
    transition("record-response", 1_004, { responseText: "continued prose" }),
  );
  current = completed.envelope;
  assert.deepEqual(completed.effects.map((effect) => effect.kind), ["present-result-for-review"]);
  assert.equal(current.artifactIntent, null, "completion alone never creates an artifact intent");

  const accepted = reduceDesktopOperationV1(
    current,
    transition("accept-result", 1_005, { artifactIntentId: "artifact-intent-0001" }),
  );
  current = accepted.envelope;
  assert.equal(current.lifecycle.status, "accepted");
  assert.equal(current.artifactIntent?.responseSha256, current.response?.responseSha256);
  assert.deepEqual(accepted.effects.map((effect) => effect.kind), ["apply-artifact-intent"]);
  assert.equal("step" in (current.artifactIntent ?? {}), false, "contract does not create a signed Step");

  current = apply(current, transition("record-artifact-applied", 1_006, {
    receiptId: "artifact-receipt-0001",
    resultingContentHash: HASH("resulting content"),
  }));
  assert.equal(current.artifactReceipt?.receiptId, "artifact-receipt-0001");
  assert.throws(() => reduceDesktopOperationV1(current, transition("record-artifact-applied", 1_007, {
    receiptId: "artifact-receipt-0002",
    resultingContentHash: HASH("different content"),
  })), /already recorded/);
});

test("rejecting a response never creates an artifact intent", async () => {
  let current = await atStatus("response-completed");
  current = apply(current, transition("reject-result", current.updatedAtMs + 1, {}));
  assert.equal(current.lifecycle.status, "rejected");
  assert.equal(current.artifactIntent, null);
  assert.equal(current.artifactReceipt, null);
});

test("legal transitions are idempotent and every omitted graph edge fails closed", async () => {
  const legal: Readonly<Record<DesktopOperationEnvelopeV1["lifecycle"]["status"], readonly DesktopOperationTransitionV1["type"][]>> = {
    prepared: ["approve", "cancel", "abandon"],
    approved: ["record-dispatch-intent", "record-failure", "cancel", "abandon"],
    "dispatch-intent": ["record-provider-io-may-have-started", "record-failure", "cancel", "abandon"],
    "provider-io": ["record-response", "record-failure", "mark-dispatch-unknown"],
    "response-completed": ["accept-result", "reject-result"],
    accepted: ["record-artifact-applied"],
    failed: [],
    cancelled: [],
    unknown: [],
    rejected: [],
    abandoned: [],
  };
  const allTypes = [
    "approve", "record-dispatch-intent", "record-provider-io-may-have-started",
    "record-response", "record-failure", "cancel", "mark-dispatch-unknown",
    "accept-result", "reject-result", "abandon", "record-artifact-applied",
  ] as const;

  for (const status of Object.keys(legal) as Array<keyof typeof legal>) {
    const current = await atStatus(status);
    for (const type of allTypes) {
      const action = actionFor(type, current.updatedAtMs + 1, current.lifecycle.executionCertainty);
      if (legal[status].includes(type)) {
        const first = reduceDesktopOperationV1(current, action);
        const second = reduceDesktopOperationV1(first.envelope, action);
        assert.equal(second.replayed, true, `${status} -> ${type} must be idempotent`);
        assert.strictEqual(second.envelope, first.envelope);
        assert.deepEqual(second.effects, []);
      } else {
        assert.throws(
          () => reduceDesktopOperationV1(current, action),
          DesktopOperationTransitionError,
          `${status} -> ${type} must be illegal`,
        );
      }
    }
  }
});

test("a reused transition id with different action bytes is rejected", async () => {
  const current = await envelope();
  const first = transition("approve", 1_001, {});
  const approved = apply(current, first);
  assert.throws(
    () => reduceDesktopOperationV1(approved, { ...first, atMs: 1_002 }),
    /reused with different bytes/,
  );
});

test("post-marker ambiguity becomes unknown and recovery never automatically redispatches", async () => {
  const io = await atStatus("provider-io");
  const recovery = projectDesktopOperationRecoveryV1(io, io.updatedAtMs + 1);
  assert.equal(recovery.mayAutomaticallyDispatch, false);
  assert.deepEqual(recovery.automaticEffects.map((effect) => effect.kind), ["record-attempt-unknown"]);
  assert.equal(
    recovery.automaticEffects.some((effect) => effect.kind === "dispatch-provider-request"),
    false,
  );

  const unknown = apply(io, transition("mark-dispatch-unknown", io.updatedAtMs + 1, {}));
  assert.equal(unknown.lifecycle.status, "unknown");
  assert.equal(unknown.lifecycle.executionCertainty, "may-have-dispatched");
  assert.equal(unknown.lifecycle.retryPolicy, "operator-confirmation-required");
  assert.throws(
    () => reduceDesktopOperationV1(io, transition("cancel", io.updatedAtMs + 1, {})),
    /cancel is illegal from provider-io/,
  );
});

test("pre-I/O dispatch intent resumes the handshake without claiming a provider call", async () => {
  const intent = await atStatus("dispatch-intent");
  const recovery = projectDesktopOperationRecoveryV1(intent, intent.updatedAtMs + 1);
  assert.deepEqual(recovery.automaticEffects.map((effect) => effect.kind), ["resume-dispatch-handshake"]);
  assert.equal(intent.lifecycle.executionCertainty, "known-not-dispatched");
  assert.equal(recovery.mayAutomaticallyDispatch, false);
});

test("recovery re-presents completed responses and replays only pending local artifact intents", async () => {
  const completed = await atStatus("response-completed");
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(completed, completed.updatedAtMs + 1).automaticEffects
      .map((effect) => effect.kind),
    ["present-result-for-review"],
  );
  let accepted = await atStatus("accepted");
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(accepted, accepted.updatedAtMs + 1).automaticEffects
      .map((effect) => effect.kind),
    ["apply-artifact-intent"],
  );
  accepted = apply(accepted, transition("record-artifact-applied", accepted.updatedAtMs + 1, {
    receiptId: "artifact-receipt-0002",
    resultingContentHash: HASH("applied"),
  }));
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(accepted, accepted.updatedAtMs + 1).automaticEffects,
    [],
  );
});

test("retries keep operation identity, create a linked attempt, and require ambiguity acknowledgement", async () => {
  const cancelled = await atStatus("cancelled");
  const safeRetry = createDesktopOperationRetryV1(cancelled, {
    attemptId: "attempt-retry-0001",
    createdAtMs: cancelled.updatedAtMs + 1,
  });
  assert.equal(safeRetry.operationId, cancelled.operationId);
  assert.equal(safeRetry.attempt.retryOfAttemptId, cancelled.attempt.attemptId);
  assert.equal(safeRetry.attempt.attemptId, "attempt-retry-0001");
  assert.equal(safeRetry.attempt.possibleDuplicateAcknowledgedAtMs, null);
  assert.equal(safeRetry.prepared.requestSha256, cancelled.prepared.requestSha256);
  assert.equal(safeRetry.lifecycle.status, "prepared");

  const unknown = await atStatus("unknown");
  assert.throws(() => createDesktopOperationRetryV1(unknown, {
    attemptId: "attempt-retry-0002",
    createdAtMs: unknown.updatedAtMs + 1,
  }), /explicit operator confirmation/);
  const confirmed = createDesktopOperationRetryV1(unknown, {
    attemptId: "attempt-retry-0002",
    createdAtMs: unknown.updatedAtMs + 1,
    possibleDuplicateAcknowledged: true,
  });
  assert.equal(confirmed.attempt.possibleDuplicateAcknowledgedAtMs, unknown.updatedAtMs + 1);
  const accepted = await atStatus("accepted");
  assert.throws(() => createDesktopOperationRetryV1(accepted, {
    attemptId: "attempt-retry-0003",
    createdAtMs: 2_000,
  }), /not retryable/);
});

test("faults are structured and reject unredacted exception fields", async () => {
  const approved = await atStatus("approved");
  const rawFault = {
    ...fault("PROVIDER_UNAVAILABLE", approved.updatedAtMs + 1),
    message: "Authorization: Bearer secret-token",
  } as OperationFaultV1;
  assert.throws(() => reduceDesktopOperationV1(approved, transition("record-failure", approved.updatedAtMs + 1, {
    certainty: "known-not-dispatched",
    fault: rawFault,
  })), /could contain unredacted diagnostics/);

  const failed = apply(approved, transition("record-failure", approved.updatedAtMs + 1, {
    certainty: "known-not-dispatched",
    fault: fault("PROVIDER_UNAVAILABLE", approved.updatedAtMs + 1),
  }));
  assert.equal(failed.lifecycle.status, "failed");
  assert.equal(failed.lifecycle.retryPolicy, "safe-new-attempt");
  assert.equal("message" in failed.fault!, false);
});

test("response and retention limits fail before persistence and signal bounded deletion", async () => {
  const io = await atStatus("provider-io");
  assert.throws(() => reduceDesktopOperationV1(io, transition("record-response", io.updatedAtMs + 1, {
    responseText: "x".repeat(DESKTOP_OPERATION_MAX_RESPONSE_BYTES + 1),
  })), /response exceeds/);
  const due = projectDesktopOperationRecoveryV1(io, io.retention.deleteByMs);
  assert.equal(due.privatePayloadDeletionDue, true);
  assert.equal(due.automaticEffects.at(-1)?.kind, "delete-expired-private-payloads");
});

function actionFor(
  type: DesktopOperationTransitionV1["type"],
  atMs: number,
  certainty: DesktopOperationEnvelopeV1["lifecycle"]["executionCertainty"],
): DesktopOperationTransitionV1 {
  switch (type) {
    case "approve": return transition(type, atMs, {});
    case "record-dispatch-intent": return transition(type, atMs, {});
    case "record-provider-io-may-have-started": return transition(type, atMs, {});
    case "record-response": return transition(type, atMs, { responseText: "result" });
    case "record-failure": return transition(type, atMs, {
      certainty: certainty === "may-have-dispatched"
        ? "provider-completed-without-result"
        : "known-not-dispatched",
      fault: fault("PROVIDER_UNAVAILABLE", atMs),
    });
    case "cancel": return transition(type, atMs, {});
    case "mark-dispatch-unknown": return transition(type, atMs, {});
    case "accept-result": return transition(type, atMs, { artifactIntentId: `artifact-intent-${atMs}` });
    case "reject-result": return transition(type, atMs, {});
    case "abandon": return transition(type, atMs, {});
    case "record-artifact-applied": return transition(type, atMs, {
      receiptId: `artifact-receipt-${atMs}`,
      resultingContentHash: HASH(`result-${atMs}`),
    });
  }
}
