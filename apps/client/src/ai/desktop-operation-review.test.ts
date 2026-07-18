import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopOperationEnvelopeV1 } from "./desktop-operation-envelope.js";
import {
  compareDesktopOperationAttemptLineageV1,
  desktopOperationReviewQueueV1,
  mergeDesktopOperationPinnedHeadsV1,
  projectDesktopOperationReviewV1,
  resolveDesktopOperationPageLineageV1,
} from "./desktop-operation-review.js";
import type { DesktopOperationRepositoryV1 } from "./desktop-operation-runtime.js";

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
  assert.equal(projectDesktopOperationReviewV1(directiveEnvelope("abandoned")), null);
  const appliedDirective = directiveEnvelope("accepted");
  assert.equal(projectDesktopOperationReviewV1({
    ...appliedDirective,
    artifactReceipt: {
      version: 1,
      receiptId: "receipt-directive-applied",
      recordedAtMs: 3,
      resultingContentHash: "77".repeat(32),
    },
  }), null);
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
  ]) {
    const projected = projectDesktopOperationReviewV1(attempt);
    assert.equal(projected?.label, "AI draft authorization expired");
    assert.deepEqual(projected?.actions, ["reprepare"]);
    assert.doesNotMatch(projected?.actions.join(" ") ?? "", /resume|retry/);
  }

  const ambiguous = projectDesktopOperationReviewV1(
    directiveEnvelope("unknown", "operator-confirmation-required"),
  );
  assert.equal(ambiguous?.label.includes("provider outcome uncertain"), true);
  assert.deepEqual(ambiguous?.actions, ["reprepare-possible-duplicate", "abandon"]);

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

function attempt(
  operationIndex: number,
  attemptId: string,
  createdAtMs: number,
  retryOfAttemptId: string | null = null,
  status: DesktopOperationEnvelopeV1["lifecycle"]["status"] = "response-completed",
): DesktopOperationEnvelopeV1 {
  const base = envelope(status);
  return {
    ...base,
    operationId: `operation-${String(operationIndex).padStart(8, "0")}`,
    attempt: {
      ...base.attempt,
      attemptId,
      retryOfAttemptId,
      createdAtMs,
    },
    updatedAtMs: createdAtMs,
  };
}

function pagedRepository(
  records: readonly DesktopOperationEnvelopeV1[],
  failAtCall: number | null = null,
): DesktopOperationRepositoryV1 {
  let calls = 0;
  return {
    async listPage(cursor: string | null, limit: number) {
      calls += 1;
      if (calls === failAtCall) throw new Error("lineage scan failed");
      const from = cursor === null ? 0 : Number(cursor);
      const page = records.slice(from, from + limit);
      return {
        records: page,
        nextCursor: from + page.length < records.length ? String(from + page.length) : null,
      };
    },
  } as unknown as DesktopOperationRepositoryV1;
}

test("bounded archive projection suppresses split-page superseded attempts in arbitrary record order", async () => {
  const older = attempt(0, "attempt-lineage-older", 10);
  const newer = attempt(0, "attempt-lineage-newer", 30, older.attempt.attemptId);
  const other = Array.from({ length: 18 }, (_, index) => (
    attempt(index + 1, `attempt-other-${String(index).padStart(8, "0")}`, 100 + index)
  ));
  // The first opaque native page contains the older attempt; its linked head
  // is deliberately off-page after more than sixteen unrelated operations.
  const records = [older, ...other.slice(0, 15), other[15]!, newer, ...other.slice(16)];
  const firstPage = records.slice(0, 16);
  const projectedFirst = await resolveDesktopOperationPageLineageV1(
    pagedRepository(records),
    firstPage,
  );
  assert.equal(projectedFirst.some(({ attempt }) => attempt.attemptId === older.attempt.attemptId), false);
  assert.equal(projectedFirst.length, 15);

  const pageWithNewer = records.slice(16);
  const projectedLater = await resolveDesktopOperationPageLineageV1(
    pagedRepository(records),
    pageWithNewer,
  );
  assert.equal(projectedLater.some(({ attempt }) => attempt.attemptId === newer.attempt.attemptId), true);

  const reverseRecords = [newer, ...other, older];
  const projectedReverseTail = await resolveDesktopOperationPageLineageV1(
    pagedRepository(reverseRecords),
    [older],
  );
  assert.deepEqual(projectedReverseTail, []);
});

test("bounded pinned heads surface off-page completion and dedupe the exact archive head", () => {
  const current = attempt(99, "attempt-current-off-page", 1_000);
  const older = attempt(99, "attempt-current-older", 900);
  const unrelated = Array.from({ length: 20 }, (_, index) => (
    attempt(index + 200, `attempt-pin-${String(index).padStart(8, "0")}`, index)
  ));
  const pinned = mergeDesktopOperationPinnedHeadsV1([], [older, ...unrelated, current], 16);
  assert.equal(pinned.length, 16);
  assert.equal(pinned.some(({ attempt }) => attempt.attemptId === current.attempt.attemptId), true);
  assert.equal(pinned.some(({ attempt }) => attempt.attemptId === older.attempt.attemptId), false);
  const queue = desktopOperationReviewQueueV1([...pinned, current]);
  assert.equal(queue.filter(({ key }) => key.attemptId === current.attempt.attemptId).length, 1);
});

test("lineage ordering follows immutable retry identity and scans fail closed", async () => {
  const older = attempt(7, "attempt-tie-older", 50);
  const middle = attempt(7, "attempt-tie-middle", 50, older.attempt.attemptId);
  const newer = {
    ...attempt(7, "attempt-tie-newer", 50, middle.attempt.attemptId),
    updatedAtMs: 1,
  };
  assert.equal(compareDesktopOperationAttemptLineageV1(newer, middle), 1);
  assert.deepEqual(
    await resolveDesktopOperationPageLineageV1(
      pagedRepository([newer, older, middle]),
      [older, middle, newer],
    ),
    [newer],
  );
  await assert.rejects(
    () => resolveDesktopOperationPageLineageV1(
      pagedRepository([older, ...Array.from({ length: 16 }, (_, index) => (
        attempt(index + 20, `attempt-fail-${String(index).padStart(8, "0")}`, index)
      )), newer], 2),
      [older],
    ),
    /lineage scan failed/,
  );
  await assert.rejects(
    () => resolveDesktopOperationPageLineageV1(pagedRepository([older]), [older], {
      isCancelled: () => true,
    }),
    /cancelled/,
  );
  assert.deepEqual(
    await resolveDesktopOperationPageLineageV1(
      pagedRepository([]),
      [older],
    ),
    [],
    "a record deleted or expired after the archive read cannot remain actionable",
  );
});
