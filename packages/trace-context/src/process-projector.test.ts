import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTraceProcessCandidatesV1,
  type TraceContextProcessProjectionInputV1,
} from "./index.js";

const TRACE_ID = "a".repeat(64);
const HEAD_ID = "b".repeat(64);
const PRIOR_ID = "c".repeat(64);
const VOICE_A = "d".repeat(64);
const VOICE_B = "e".repeat(64);

test("projector owns press-neutral identity, enumeration, ordinals, and exact ranges", () => {
  const input: TraceContextProcessProjectionInputV1 = {
    version: 1,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    steps: [
      {
        version: 1,
        nodeId: PRIOR_ID,
        chainDistance: 1,
        transactions: [{
          version: 1,
          sourceTransactionId: 42,
          capturedAtMs: 200,
          changes: [{
            version: 1,
            operation: "insert",
            range: { fromUtf16: 2, toUtf16: 2 },
            insertedText: "🙂",
            deletedText: "",
            voiceId: VOICE_B,
          }],
        }],
      },
      {
        version: 1,
        nodeId: HEAD_ID,
        chainDistance: 0,
        transactions: [{
          version: 1,
          sourceTransactionId: 7,
          capturedAtMs: 300,
          intent: "undo",
          changes: [{
            version: 1,
            operation: "replace",
            range: { fromUtf16: 0, toUtf16: 2 },
            insertedText: "雪",
            deletedText: "ab",
            voiceId: VOICE_A,
          }],
        }],
      },
    ],
  };

  const candidates = projectTraceProcessCandidatesV1(input);
  assert.deepEqual(candidates.map((candidate) => candidate.id), [
    `trace-process-v1:${TRACE_ID}:${HEAD_ID}:summary`,
    `trace-process-v1:${TRACE_ID}:${HEAD_ID}:transaction:0`,
    `trace-process-v1:${TRACE_ID}:${HEAD_ID}:transaction:0:change:0`,
    `trace-process-v1:${TRACE_ID}:${PRIOR_ID}:summary`,
    `trace-process-v1:${TRACE_ID}:${PRIOR_ID}:transaction:0`,
    `trace-process-v1:${TRACE_ID}:${PRIOR_ID}:transaction:0:change:0`,
  ]);
  assert.deepEqual(
    candidates.map((candidate) => candidate.source.transactionIndex),
    [0, 0, 0, 0, 0, 0],
    "signed source tx ids 7/42 must not leak into process-array ordinals",
  );
  assert.deepEqual(candidates[2]?.fact, {
    kind: "change",
    transactionIndex: 0,
    operation: "replace",
    range: { fromUtf16: 0, toUtf16: 2 },
    insertedCodePointCount: 1,
    deletedCodePointCount: 2,
    voiceId: VOICE_A,
  });
  assert.deepEqual(candidates[2]?.source, {
    kind: "trace",
    ref: `trace-process-v1:${TRACE_ID}:${HEAD_ID}:transaction:0:change:0`,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    nodeId: HEAD_ID,
    processStatus: "full-trace",
    chainDistance: 0,
    transactionIndex: 0,
    range: { fromUtf16: 0, toUtf16: 2 },
  });
  assert.ok(Object.isFrozen(candidates));
  assert.ok(Object.isFrozen(candidates[0]));
  assert.deepEqual(projectTraceProcessCandidatesV1(structuredClone(input)), candidates);
});

test("native-neutral no-op process views retain summary/transaction and omit zero-effect change", () => {
  const candidates = projectTraceProcessCandidatesV1({
    version: 1,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    steps: [{
      version: 1,
      nodeId: HEAD_ID,
      chainDistance: 0,
      transactions: [{
        version: 1,
        sourceTransactionId: 9,
        capturedAtMs: 400,
        changes: [{
          version: 1,
          operation: "insert",
          range: { fromUtf16: 0, toUtf16: 0 },
          insertedText: "",
          deletedText: "",
          voiceId: VOICE_A,
        }],
      }],
    }],
  });

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.fact), [
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 1,
      insertedCodePointCount: 0,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 400,
      lastCapturedAtMs: 400,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 400,
      changeCount: 1,
      voiceIds: [VOICE_A],
    },
  ]);
});

test("projector rejects ambiguous chain and ordinal projections", () => {
  const baseline: TraceContextProcessProjectionInputV1 = {
    version: 1,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    steps: [{
      version: 1,
      nodeId: HEAD_ID,
      chainDistance: 0,
      transactions: [],
    }],
  };
  assert.throws(
    () => projectTraceProcessCandidatesV1({
      ...baseline,
      steps: [{ ...baseline.steps[0]!, chainDistance: 1 }],
    }),
    /distance zero must bind exactly the prepared head/,
  );
  assert.throws(
    () => projectTraceProcessCandidatesV1({
      ...baseline,
      steps: [{
        ...baseline.steps[0]!,
        transactions: [
          { version: 1, sourceTransactionId: 7, capturedAtMs: 1, changes: [noOp()] },
          { version: 1, sourceTransactionId: 7, capturedAtMs: 2, changes: [noOp()] },
        ],
      }],
    }),
    /source transaction ids must be strictly increasing/,
  );
});

function noOp() {
  return {
    version: 1 as const,
    operation: "insert" as const,
    range: { fromUtf16: 0, toUtf16: 0 },
    insertedText: "",
    deletedText: "",
    voiceId: VOICE_A,
  };
}
