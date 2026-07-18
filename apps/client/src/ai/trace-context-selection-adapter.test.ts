import assert from "node:assert/strict";
import test from "node:test";

import type { TraceConformanceVerdict, TraceProcessView } from "@zine/protocol";
import { selectTraceContextV1 } from "@zine/trace-context";

import {
  adaptDesktopTraceContextSelectionV1,
  DesktopTraceContextSelectionAdapterError,
  type DesktopTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

const VOICE_A = "a".repeat(64);
const TRACE_ID = "1".repeat(64);
const HEAD_ID = "2".repeat(64);

function process(at: number, inserted: string): TraceProcessView {
  return {
    status: "complete",
    transactions: [{
      tx: 17,
      at,
      changes: [{
        op: "ins",
        from: 4,
        to: 4,
        inserted,
        deleted: "",
        voice: VOICE_A,
      }],
    }],
  };
}

function verdict(): TraceConformanceVerdict {
  return {
    status: "full",
    issues: [],
    steps: [
      { nodeId: TRACE_ID, stepIndex: 0, status: "full", process: process(1_000, "x") },
      { nodeId: HEAD_ID, stepIndex: 1, status: "full", process: process(2_000, "🧠") },
    ],
  };
}

function input(): DesktopTraceContextSelectionAdapterInputV1 {
  return {
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      range: { fromUtf16: 0, toUtf16: 16 },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 300_000,
      reservedPromptBytes: 1_024,
    },
    snapshot: {
      version: 1,
      traceId: TRACE_ID,
      headId: HEAD_ID,
      contentHash: "sha256:current",
      currentText: "Current 🧠 draft",
      chosenPath: "draft.md",
      verdict: verdict(),
    },
    processFacts: [
      {
        version: 1,
        traceId: TRACE_ID,
        headId: HEAD_ID,
        nodeId: HEAD_ID,
        chainDistance: 0,
        transactionIndex: 0,
        fact: {
          kind: "step-summary",
          transactionCount: 1,
          rangeCount: 1,
          insertedCodePointCount: 1,
          deletedCodePointCount: 0,
          firstCapturedAtMs: 2_000,
          lastCapturedAtMs: 2_000,
          spanMs: 0,
          longestGapMs: 0,
          undoCount: 0,
          redoCount: 0,
        },
      },
      {
        version: 1,
        traceId: TRACE_ID,
        headId: HEAD_ID,
        nodeId: TRACE_ID,
        chainDistance: 1,
        transactionIndex: 0,
        changeIndex: 0,
        fact: {
          kind: "change",
          transactionIndex: 0,
          operation: "insert",
          range: { fromUtf16: 4, toUtf16: 4 },
          insertedCodePointCount: 1,
          deletedCodePointCount: 0,
          voiceId: VOICE_A,
        },
      },
    ],
    limits: { version: 1, maxCandidates: 24 },
  };
}

test("maps only facts that exactly bind FULL verified Steps", () => {
  const source = input();
  const before = structuredClone(source);
  const result = adaptDesktopTraceContextSelectionV1(source);

  assert.deepEqual(source, before, "the adapter is pure and does not mutate its projection");
  assert.deepEqual(result.operation, {
    version: 1,
    operation: "extend",
    target: {
      traceId: TRACE_ID,
      headId: HEAD_ID,
      contentHash: "sha256:current",
      currentText: "Current 🧠 draft",
      chosenPath: "draft.md",
    },
    range: { fromUtf16: 0, toUtf16: 16 },
    maxContextBytes: 16_384,
    preparedRequestMaxBytes: 300_000,
    reservedPromptBytes: 1_024,
  });
  assert.deepEqual(result.candidates.map((candidate) => ({
    id: candidate.id,
    source: candidate.source,
    reasons: candidate.reasons,
    fact: candidate.kind === "process-fact" ? candidate.fact : undefined,
  })), [
    {
      id: `desktop-trace:${TRACE_ID}:${HEAD_ID}:summary`,
      source: {
        kind: "trace",
        ref: `desktop-trace:${TRACE_ID}:${HEAD_ID}:summary`,
        traceId: TRACE_ID,
        headId: HEAD_ID,
        nodeId: HEAD_ID,
        processStatus: "full-trace",
        chainDistance: 0,
        transactionIndex: 0,
      },
      reasons: ["prepared-head-process"],
      fact: source.processFacts[0]!.fact,
    },
    {
      id: `desktop-trace:${TRACE_ID}:${TRACE_ID}:transaction:0:change:0`,
      source: {
        kind: "trace",
        ref: `desktop-trace:${TRACE_ID}:${TRACE_ID}:transaction:0:change:0`,
        traceId: TRACE_ID,
        headId: HEAD_ID,
        nodeId: TRACE_ID,
        processStatus: "full-trace",
        chainDistance: 1,
        transactionIndex: 0,
        range: { fromUtf16: 4, toUtf16: 4 },
      },
      reasons: ["recent-target-process"],
      fact: source.processFacts[1]!.fact,
    },
  ]);
});

test("keeps complete current text only at operation.target", () => {
  const result = adaptDesktopTraceContextSelectionV1(input());
  const paths: string[] = [];
  const visit = (value: unknown, path: string): void => {
    if (value === result.operation.target.currentText) paths.push(path);
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, `${path}.${key}`);
    }
  };
  visit(result, "$result");
  assert.deepEqual(paths, ["$result.operation.target.currentText"]);
});

test("produces selector-valid Extend and Settle vectors", async () => {
  const extend = await selectTraceContextV1(adaptDesktopTraceContextSelectionV1(input()));
  assert.equal(extend.ok, true);
  if (!extend.ok) return;
  assert.equal(extend.manifest.operation.operation, "extend");

  const settleInput = input();
  settleInput.operation.operation = "settle";
  settleInput.operation.range = { fromUtf16: 8, toUtf16: 10 };
  const settle = await selectTraceContextV1(adaptDesktopTraceContextSelectionV1(settleInput));
  assert.equal(settle.ok, true);
  if (!settle.ok) return;
  assert.equal(settle.manifest.operation.operation, "settle");
  assert.deepEqual(settle.manifest.operation.range, { fromUtf16: 8, toUtf16: 10 });
});

test("rejects non-FULL, incomplete, discontinuous, or snapshot-mismatched verdicts", () => {
  const cases: Array<[string, (candidate: DesktopTraceContextSelectionAdapterInputV1) => void]> = [
    ["non-FULL", (candidate) => { candidate.snapshot.verdict.status = "snapshot-only"; }],
    ["issues", (candidate) => {
      candidate.snapshot.verdict.issues.push({
        kind: "process",
        code: "missing",
        message: "missing process",
        stepIndex: 0,
      });
    }],
    ["incomplete", (candidate) => {
      candidate.snapshot.verdict.steps[0]!.process = { status: "absent", transactions: [] };
    }],
    ["discontinuous", (candidate) => { candidate.snapshot.verdict.steps[1]!.stepIndex = 4; }],
    ["trace mismatch", (candidate) => { candidate.snapshot.traceId = "3".repeat(64); }],
    ["head mismatch", (candidate) => { candidate.snapshot.headId = "4".repeat(64); }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = input();
    mutate(candidate);
    assert.throws(
      () => adaptDesktopTraceContextSelectionV1(candidate),
      DesktopTraceContextSelectionAdapterError,
      name,
    );
  }
});

test("rejects trace, head, node, distance, transaction, and change mismatches", () => {
  const cases: Array<[string, (candidate: DesktopTraceContextSelectionAdapterInputV1) => void]> = [
    ["trace", (candidate) => { candidate.processFacts[0]!.traceId = "3".repeat(64); }],
    ["head", (candidate) => { candidate.processFacts[0]!.headId = "4".repeat(64); }],
    ["node", (candidate) => { candidate.processFacts[0]!.nodeId = TRACE_ID; }],
    ["distance", (candidate) => { candidate.processFacts[0]!.chainDistance = 1; }],
    ["transaction", (candidate) => { candidate.processFacts[1]!.transactionIndex = 2; }],
    ["change", (candidate) => { candidate.processFacts[1]!.changeIndex = 3; }],
  ];
  for (const [name, mutate] of cases) {
    const candidate = input();
    mutate(candidate);
    assert.throws(
      () => adaptDesktopTraceContextSelectionV1(candidate),
      DesktopTraceContextSelectionAdapterError,
      name,
    );
  }
});

test("rejects altered or open-ended mechanical facts", () => {
  const altered = input();
  const summary = altered.processFacts[0]!.fact;
  assert.equal(summary.kind, "step-summary");
  if (summary.kind === "step-summary") summary.insertedCodePointCount = 99;
  assert.throws(
    () => adaptDesktopTraceContextSelectionV1(altered),
    DesktopTraceContextSelectionAdapterError,
  );

  for (const key of ["text", "summary", "confidence"]) {
    const candidate = input();
    Object.assign(candidate.processFacts[0]!.fact, { [key]: key === "confidence" ? 0.9 : "invented" });
    assert.throws(
      () => adaptDesktopTraceContextSelectionV1(candidate),
      DesktopTraceContextSelectionAdapterError,
      key,
    );
  }
});
