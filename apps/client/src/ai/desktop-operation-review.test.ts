import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopOperationEnvelopeV1 } from "./desktop-operation-envelope.js";
import {
  desktopOperationReviewQueueV1,
  projectDesktopOperationReviewV1,
} from "./desktop-operation-review.js";

function envelope(
  status: DesktopOperationEnvelopeV1["lifecycle"]["status"],
  retryPolicy: DesktopOperationEnvelopeV1["lifecycle"]["retryPolicy"] = "not-eligible",
  extras: Partial<DesktopOperationEnvelopeV1> = {},
): DesktopOperationEnvelopeV1 {
  return {
    version: 1,
    contract: "desktop-operation-private-local-v1",
    operationId: "operation-12345678",
    attempt: {
      attemptId: "attempt-12345678",
      retryOfAttemptId: null,
      createdAtMs: 1,
      possibleDuplicateAcknowledgedAtMs: null,
    },
    prepared: {
      version: 1,
      requestId: "request-12345678",
      operation: "extend",
      operationInputs: {},
      traceAuthoring: {} as DesktopOperationEnvelopeV1["prepared"]["traceAuthoring"],
      messages: [],
      modelVoicePubkey: "aa".repeat(32),
      provider: {
        version: 1,
        providerId: "provider-12345678",
        providerFingerprint: "11".repeat(32),
        protocol: "openai",
        modelId: "model",
        transportConfigSha256: "22".repeat(32),
      },
      maxOutputTokens: 10,
      targetRevision: {
        folderId: "folder",
        path: "draft.md",
        traceId: "trace",
        headId: "head",
        contentHash: "33".repeat(32),
      },
      upstreamPreparedRequestHash: "44".repeat(32),
      requestSha256: "55".repeat(32),
    },
    selectedContext: {} as DesktopOperationEnvelopeV1["selectedContext"],
    lifecycle: {
      status,
      executionCertainty: status === "unknown" ? "may-have-dispatched" : "known-not-dispatched",
      retryPolicy,
    },
    response: status === "response-completed" || status === "stale"
      ? { version: 1, text: "draft result", responseSha256: "66".repeat(32), completedAtMs: 2 }
      : null,
    fault: null,
    artifactIntent: null,
    artifactReceipt: null,
    retention: {} as DesktopOperationEnvelopeV1["retention"],
    appliedTransitions: [],
    updatedAtMs: 2,
    ...extras,
  };
}

function directiveEnvelope(
  status: DesktopOperationEnvelopeV1["lifecycle"]["status"],
  retryPolicy: DesktopOperationEnvelopeV1["lifecycle"]["retryPolicy"] = "not-eligible",
): DesktopOperationEnvelopeV1 {
  const base = envelope(status, retryPolicy);
  return {
    ...base,
    prepared: {
      ...base.prepared,
      traceAuthoring: {
        authorityPersistence: "current-editor-session-only",
        compiled: { directives: [{}] },
      } as unknown as DesktopOperationEnvelopeV1["prepared"]["traceAuthoring"],
    },
  };
}

test("completed, unknown, and stale attempts expose only explicit safe actions", () => {
  assert.deepEqual(projectDesktopOperationReviewV1(envelope("response-completed"))?.actions, [
    "accept",
    "reject",
  ]);
  assert.deepEqual(
    projectDesktopOperationReviewV1(envelope("unknown", "operator-confirmation-required"))?.actions,
    ["retry-possible-duplicate", "abandon"],
  );
  assert.deepEqual(projectDesktopOperationReviewV1(envelope("stale", "safe-new-attempt"))?.actions, [
    "reprepare",
    "reject",
  ]);
  assert.deepEqual(projectDesktopOperationReviewV1(envelope("dispatch-intent"))?.actions, []);
  assert.deepEqual(projectDesktopOperationReviewV1(envelope("provider-io"))?.actions, []);
});

test("an applied local receipt and abandoned work leave the compact queue", () => {
  assert.equal(projectDesktopOperationReviewV1(envelope("abandoned")), null);
  assert.equal(projectDesktopOperationReviewV1(envelope("accepted", "not-eligible", {
    artifactReceipt: {
      version: 1,
      receiptId: "receipt-12345678",
      recordedAtMs: 3,
      resultingContentHash: "77".repeat(32),
    },
  })), null);
});

test("the review queue shows only the newest linked attempt", () => {
  const prior = envelope("unknown", "operator-confirmation-required");
  const retry = envelope("response-completed", "not-eligible", {
    attempt: {
      ...prior.attempt,
      attemptId: "attempt-87654321",
      retryOfAttemptId: prior.attempt.attemptId,
      createdAtMs: 4,
    },
    updatedAtMs: 5,
  });
  const queue = desktopOperationReviewQueueV1([prior, retry]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.key.attemptId, "attempt-87654321");
  assert.equal(queue[0]?.label, "AI draft ready");
});

test("expired directive attempts expose exact-target re-prepare only", () => {
  for (const attempt of [
    directiveEnvelope("prepared"),
    directiveEnvelope("approved"),
    directiveEnvelope("failed", "safe-new-attempt"),
    directiveEnvelope("unknown", "operator-confirmation-required"),
  ]) {
    const projected = projectDesktopOperationReviewV1(attempt);
    assert.equal(projected?.label, "AI draft authorization expired");
    assert.deepEqual(projected?.actions, ["reprepare"]);
    assert.doesNotMatch(projected?.actions.join(" ") ?? "", /resume|retry/);
  }

  assert.deepEqual(
    projectDesktopOperationReviewV1(directiveEnvelope("prepared"), () => true)?.actions,
    ["resume", "abandon"],
  );
});

test("response-free stale authorization tombstones cannot be rejected", () => {
  const stale = directiveEnvelope("stale", "safe-new-attempt");
  const projected = projectDesktopOperationReviewV1({ ...stale, response: null }, () => true);
  assert.deepEqual(projected?.actions, ["reprepare"]);
});
