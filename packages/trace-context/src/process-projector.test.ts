import assert from "node:assert/strict";
import test from "node:test";

import {
  projectTraceProcessCandidatesV1,
  projectTraceProcessCandidatesV1Async,
  selectTraceContextV1,
  validateSelectedTraceContextManifestV1,
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
    "signed source transaction ids 7/42 must not leak into process-array ordinals",
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

test("selection-only transactions survive projection, selection, and manifest validation", async () => {
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
        sourceTransactionId: 10,
        capturedAtMs: 500,
        changes: [],
      }],
    }],
  });

  assert.deepEqual(candidates.map((candidate) => candidate.fact), [
    {
      kind: "step-summary",
      transactionCount: 1,
      rangeCount: 0,
      insertedCodePointCount: 0,
      deletedCodePointCount: 0,
      firstCapturedAtMs: 500,
      lastCapturedAtMs: 500,
      spanMs: 0,
      longestGapMs: 0,
      undoCount: 0,
      redoCount: 0,
    },
    {
      kind: "transaction",
      transactionIndex: 0,
      capturedAtMs: 500,
      changeCount: 0,
      voiceIds: [],
    },
  ]);

  const selected = await selectTraceContextV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID,
        headId: HEAD_ID,
        contentHash: "selection-only-content",
        currentText: "draft",
        chosenPath: "draft.md",
      },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 512,
    },
    candidates,
  });
  assert.equal(selected.ok, true, selected.ok ? undefined : selected.error.message);
  if (!selected.ok) return;
  assert.doesNotThrow(() => validateSelectedTraceContextManifestV1(selected.manifest));
  assert.match(selected.renderedContext, /transaction 0 @ 500 · selection only/);
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

test("projector closes the complete protocol EditorTransaction domain without inventing signer authority", () => {
  const nonPubkeyActor = "non-pubkey actor";
  const surrogateVoice = "\ud800";
  const candidates = projectTraceProcessCandidatesV1({
    version: 1,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    steps: [{
      version: 1,
      nodeId: HEAD_ID,
      chainDistance: 0,
      transactions: [
        {
          version: 1,
          sourceTransactionId: 0,
          capturedAtMs: -Number.MAX_VALUE,
          changes: [{
            version: 1,
            operation: "insert",
            range: { fromUtf16: 0, toUtf16: 0 },
            insertedText: "A",
            deletedText: "",
            voiceId: nonPubkeyActor,
          }],
        },
        {
          version: 1,
          sourceTransactionId: Number.MAX_SAFE_INTEGER + 1,
          capturedAtMs: Number.MAX_VALUE,
          changes: [{
            version: 1,
            operation: "insert",
            range: { fromUtf16: 1, toUtf16: 1 },
            insertedText: "B",
            deletedText: "",
            voiceId: surrogateVoice,
          }],
        },
      ],
    }],
  });

  assert.deepEqual(candidates[0]?.fact, {
    kind: "step-summary",
    transactionCount: 2,
    rangeCount: 2,
    insertedCodePointCount: 2,
    deletedCodePointCount: 0,
    spanMs: 0,
    longestGapMs: 0,
    timingStatus: "outside-summary-domain",
    undoCount: 0,
    redoCount: 0,
  });
  assert.deepEqual(
    candidates.flatMap((candidate) =>
      candidate.fact.kind === "change" ? [candidate.fact.voiceId] : []),
    [
      "editor-transaction-actor-utf16-v1:006e006f006e002d007000750062006b006500790020006100630074006f0072",
      "editor-transaction-actor-utf16-v1:d800",
    ],
  );
});

test("async projector enforces selector bounds and cancellation before returning candidates", async () => {
  const input: TraceContextProcessProjectionInputV1 = {
    version: 1,
    traceId: TRACE_ID,
    headId: HEAD_ID,
    steps: [{
      version: 1,
      nodeId: HEAD_ID,
      chainDistance: 0,
      transactions: [{
        version: 1,
        sourceTransactionId: 0,
        capturedAtMs: 1,
        changes: [noOp()],
      }],
    }],
  };
  await assert.rejects(
    projectTraceProcessCandidatesV1Async(input, { maxCandidates: 1 }),
    /candidate count exceeds the selector ceiling/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    projectTraceProcessCandidatesV1Async(input, { signal: controller.signal }),
    /projection was cancelled/,
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
