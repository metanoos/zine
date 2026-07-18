import assert from "node:assert/strict";
import test from "node:test";

import {
  SelectedTraceContextManifestValidationError,
  validateSelectedTraceContextManifestV1,
} from "./manifest-validator.js";
import { selectTraceContextV1 } from "./selector.js";
import type { SelectedTraceContextManifestV1 } from "./selection-types.js";

const VOICE = "a".repeat(64);

async function manifest(): Promise<SelectedTraceContextManifestV1> {
  const result = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-1",
        headId: "head-1",
        contentHash: "content-1",
        currentText: "A 🧠 target",
        chosenPath: "draft.md",
      },
      range: { fromUtf16: 2, toUtf16: 4 },
      maxContextBytes: 4_096,
      preparedRequestMaxBytes: 8_192,
      reservedPromptBytes: 512,
    },
    candidates: [],
  });
  if (!result.ok) assert.fail(result.error.message);
  return result.manifest;
}

async function processSelection() {
  const result = await selectTraceContextV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-process",
        headId: "head-process",
        contentHash: "content-process",
        currentText: "Process target",
      },
      range: { fromUtf16: 0, toUtf16: 7 },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 512,
    },
    candidates: [
      {
        version: 1,
        id: "process-transaction",
        dedupeKey: "process-transaction",
        kind: "process-fact",
        claimClass: "mechanical",
        source: {
          kind: "trace", ref: "b-transaction", traceId: "trace-process",
          headId: "head-process", nodeId: "head-process", processStatus: "full-trace",
          chainDistance: 0, transactionIndex: 0,
        },
        reasons: ["prepared-head-process"],
        fact: {
          kind: "transaction", transactionIndex: 0, capturedAtMs: 100,
          changeCount: 1, voiceIds: [VOICE],
        },
      },
      {
        version: 1,
        id: "process-change",
        dedupeKey: "process-change",
        kind: "process-fact",
        claimClass: "mechanical",
        source: {
          kind: "trace", ref: "a-change", traceId: "trace-process",
          headId: "head-process", nodeId: "head-process", processStatus: "full-trace",
          chainDistance: 0, transactionIndex: 0,
        },
        reasons: ["prepared-head-process"],
        fact: {
          kind: "change", transactionIndex: 0, operation: "insert",
          range: { fromUtf16: 0, toUtf16: 0 }, insertedCodePointCount: 1,
          deletedCodePointCount: 0, voiceId: VOICE,
        },
      },
    ],
  });
  if (!result.ok) assert.fail(result.error.message);
  return result;
}

test("accepts an exact selector-emitted manifest", async () => {
  const subject = await manifest();
  assert.doesNotThrow(() => validateSelectedTraceContextManifestV1(subject));
});

test("rejects every missing top-level field and every unknown field", async () => {
  const subject = await manifest();
  for (const key of Object.keys(subject)) {
    const malformed = structuredClone(subject) as unknown as Record<string, unknown>;
    delete malformed[key];
    assert.throws(
      () => validateSelectedTraceContextManifestV1(malformed),
      SelectedTraceContextManifestValidationError,
      `missing ${key}`,
    );
  }
  const unknown = { ...structuredClone(subject), unreviewed: true };
  assert.throws(
    () => validateSelectedTraceContextManifestV1(unknown),
    /unreviewed.*not part of the V1 contract/,
  );
});

test("rejects nested omissions, unknown keys, enums, ranges, and limit drift", async () => {
  const cases: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    ["missing target text", (value) => { delete value.operation.target.currentText; }, /currentText.*required/],
    ["unknown budget key", (value) => { value.budget.extra = 1; }, /budget\.extra.*not part/],
    ["unknown policy", (value) => { value.policy = "all-history-v1"; }, /policy.*unsupported/],
    ["reversed range", (value) => { value.operation.range = { fromUtf16: 4, toUtf16: 2 }; }, /must be ordered/],
    ["split Unicode", (value) => { value.operation.range = { fromUtf16: 3, toUtf16: 3 }; }, /splits a Unicode/],
    ["hard limit drift", (value) => { value.budget.hardContextCeilingBytes = 1; }, /package hard limit/],
    ["operation budget drift", (value) => { value.operation.maxContextBytes += 1; }, /operation\.maxContextBytes/],
    ["missing rendered hash", (value) => { delete value.hashes.renderedContextSha256; }, /renderedContextSha256.*required/],
  ];
  for (const [name, mutate, expected] of cases) {
    const malformed = structuredClone(await manifest()) as unknown as Record<string, any>;
    mutate(malformed);
    assert.throws(() => validateSelectedTraceContextManifestV1(malformed), expected, name);
  }
});

test("reuses selector semantics for process bindings, order, shapes, and rendered costs", async () => {
  const selected = await processSelection();
  assert.doesNotThrow(() => validateSelectedTraceContextManifestV1(
    selected.manifest,
    selected.renderedContext,
  ));

  const cases: Array<[string, (value: Record<string, any>) => void, RegExp]> = [
    ["fact/source transaction", (value) => { value.selected[0].fact.transactionIndex = 1; }, /prepared target head chain/],
    ["chain distance/head", (value) => {
      value.selected[0].source.chainDistance = 1;
      value.selected[0].priorityClass = "prior-process";
    }, /prepared target head chain/],
    ["change shape", (value) => { value.selected[0].fact.range.toUtf16 = 1; }, /counts\/range/],
    ["selected order", (value) => { value.selected.reverse(); }, /deterministic selector order/],
    ["rendered cost", (value) => { value.selected[0].renderedByteCost += 1; }, /rendered-byte accounting|rendered byte cost/],
  ];
  for (const [name, mutate, expected] of cases) {
    const malformed = structuredClone(selected.manifest) as unknown as Record<string, any>;
    mutate(malformed);
    assert.throws(
      () => validateSelectedTraceContextManifestV1(malformed, selected.renderedContext),
      expected,
      name,
    );
  }
});
