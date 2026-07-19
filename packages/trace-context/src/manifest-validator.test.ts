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

// Regression: process-projector emits these two forms for legacy / overflow
// inputs, and selector.ts accepts them, so the manifest validator must too.
// Before this fix the validator's exact() call omitted timingStatus and its
// voiceId() rejected anything that was not a 64-hex pubkey, so any durable
// envelope carrying one of these facts failed persistence — silently, because
// the in-memory prepared-operation path never calls this validator.
async function processSelectionWithLegacyForms() {
  const result = await selectTraceContextV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-legacy",
        headId: "head-legacy",
        contentHash: "content-legacy",
        currentText: "Legacy target",
      },
      range: { fromUtf16: 0, toUtf16: 7 },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 512,
    },
    candidates: [
      {
        version: 1,
        id: "process-step-summary",
        dedupeKey: "process-step-summary",
        kind: "process-fact",
        claimClass: "mechanical",
        source: {
          kind: "trace", ref: "step-summary", traceId: "trace-legacy",
          headId: "head-legacy", nodeId: "head-legacy", processStatus: "full-trace",
          chainDistance: 0, transactionIndex: 0,
        },
        reasons: ["prepared-head-process"],
        // step-summary carrying the timingStatus the projector emits when KEdit
        // capture times overflow Number.MAX_SAFE_INTEGER differences.
        fact: {
          kind: "step-summary",
          transactionCount: 1, rangeCount: 1,
          insertedCodePointCount: 1, deletedCodePointCount: 0,
          spanMs: 0, longestGapMs: 0,
          undoCount: 0, redoCount: 0,
          timingStatus: "outside-summary-domain",
        },
      },
      {
        version: 1,
        id: "process-change-legacy-voice",
        dedupeKey: "process-change-legacy-voice",
        kind: "process-fact",
        claimClass: "mechanical",
        source: {
          kind: "trace", ref: "a-change-legacy", traceId: "trace-legacy",
          headId: "head-legacy", nodeId: "head-legacy", processStatus: "full-trace",
          chainDistance: 0, transactionIndex: 0,
        },
        reasons: ["prepared-head-process"],
        fact: {
          kind: "change", transactionIndex: 0, operation: "insert",
          range: { fromUtf16: 0, toUtf16: 0 }, insertedCodePointCount: 1,
          deletedCodePointCount: 0,
          // Canonical legacy KEdit voice for a non-pubkey voice field.
          voiceId: "kedit-voice-utf16-v1:0061",
        },
      },
    ],
  });
  if (!result.ok) assert.fail(result.error.message);
  return result;
}

test("accepts projector-emitted timingStatus and canonical KEdit legacy voices", async () => {
  const selected = await processSelectionWithLegacyForms();
  assert.doesNotThrow(
    () => validateSelectedTraceContextManifestV1(selected.manifest, selected.renderedContext),
    "projector-emitted timingStatus and legacy KEdit voice should round-trip through the validator",
  );

  // Negative guard: a hand-set timingStatus paired with a non-zero spanMs must
  // still fail. Mutate the already-valid manifest so the rendered-byte and
  // rendered-evidence accounting stays intact; only the timing consistency
  // rule is violated.
  const badTiming = structuredClone(selected.manifest) as unknown as SelectedTraceContextManifestV1;
  const summaryEntry = badTiming.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { spanMs?: number; timingStatus?: string } } | undefined;
  assert.ok(summaryEntry, "fixture must include a step-summary fact");
  summaryEntry.fact.spanMs = 5;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(badTiming, selected.renderedContext),
    /timingStatus|span|capture times/i,
  );

  // timingStatus must be exactly "outside-summary-domain" — any other value
  // is rejected.
  const badValue = structuredClone(selected.manifest) as unknown as SelectedTraceContextManifestV1;
  const valueEntry = badValue.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { timingStatus?: string } } | undefined;
  assert.ok(valueEntry, "fixture must include a step-summary fact");
  valueEntry.fact.timingStatus = "outside-summary-domain-typo";
  assert.throws(
    () => validateSelectedTraceContextManifestV1(badValue, selected.renderedContext),
    /must be outside-summary-domain when present/,
  );

  // timingStatus and capture times are mutually exclusive.
  const bothPresent = structuredClone(selected.manifest) as unknown as SelectedTraceContextManifestV1;
  const bothEntry = bothPresent.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { timingStatus?: string; firstCapturedAtMs?: number; lastCapturedAtMs?: number; spanMs?: number; longestGapMs?: number } } | undefined;
  assert.ok(bothEntry, "fixture must include a step-summary fact");
  bothEntry.fact.firstCapturedAtMs = 10;
  bothEntry.fact.lastCapturedAtMs = 10;
  bothEntry.fact.spanMs = 0;
  bothEntry.fact.longestGapMs = 0;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(bothPresent, selected.renderedContext),
    /mutually exclusive/,
  );
});

// Cover the step-summary capture-times paths that the timingStatus fixture
// above does not reach: the happy path with paired, consistent capture times,
// plus the three consistency failures the validator enforces only when
// capture times are present (span mismatch, span without capture times, and
// undo/redo overflow).
async function processSelectionWithCaptureTimes() {
  const result = await selectTraceContextV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: "trace-capture",
        headId: "head-capture",
        contentHash: "content-capture",
        currentText: "Capture target",
      },
      range: { fromUtf16: 0, toUtf16: 7 },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 512,
    },
    candidates: [
      {
        version: 1,
        id: "process-step-summary-capture",
        dedupeKey: "process-step-summary-capture",
        kind: "process-fact",
        claimClass: "mechanical",
        source: {
          kind: "trace", ref: "step-summary-capture", traceId: "trace-capture",
          headId: "head-capture", nodeId: "head-capture", processStatus: "full-trace",
          chainDistance: 0, transactionIndex: 0,
        },
        reasons: ["prepared-head-process"],
        fact: {
          kind: "step-summary",
          transactionCount: 2, rangeCount: 2,
          insertedCodePointCount: 3, deletedCodePointCount: 1,
          firstCapturedAtMs: 100,
          lastCapturedAtMs: 250,
          spanMs: 150,
          longestGapMs: 150,
          undoCount: 0, redoCount: 1,
        },
      },
    ],
  });
  if (!result.ok) assert.fail(result.error.message);
  return result;
}

test("accepts step-summary with consistent paired capture times", async () => {
  const selected = await processSelectionWithCaptureTimes();
  assert.doesNotThrow(
    () => validateSelectedTraceContextManifestV1(selected.manifest, selected.renderedContext),
    "a step-summary whose span equals last - first capture time should round-trip",
  );
});

test("rejects step-summary capture/span inconsistencies", async () => {
  const base = await processSelectionWithCaptureTimes();

  // spanMs != lastCapturedAtMs - firstCapturedAtMs
  const spanMismatch = structuredClone(base.manifest) as unknown as SelectedTraceContextManifestV1;
  const spanEntry = spanMismatch.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { spanMs?: number } } | undefined;
  assert.ok(spanEntry, "fixture must include a step-summary fact");
  spanEntry.fact.spanMs = 999;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(spanMismatch, base.renderedContext),
    /capture times and span are inconsistent/,
  );

  // span without capture times: drop the capture pair but leave spanMs nonzero.
  const orphanSpan = structuredClone(base.manifest) as unknown as SelectedTraceContextManifestV1;
  const orphanEntry = orphanSpan.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { firstCapturedAtMs?: number; lastCapturedAtMs?: number; spanMs?: number; longestGapMs?: number } } | undefined;
  assert.ok(orphanEntry, "fixture must include a step-summary fact");
  delete orphanEntry.fact.firstCapturedAtMs;
  delete orphanEntry.fact.lastCapturedAtMs;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(orphanSpan, base.renderedContext),
    /must be zero without capture times/,
  );

  // undo + redo overflow vs transactionCount
  const overflow = structuredClone(base.manifest) as unknown as SelectedTraceContextManifestV1;
  const overflowEntry = overflow.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { undoCount?: number; redoCount?: number; transactionCount?: number } } | undefined;
  assert.ok(overflowEntry, "fixture must include a step-summary fact");
  overflowEntry.fact.undoCount = 5;
  overflowEntry.fact.redoCount = 5;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(overflow, base.renderedContext),
    /summary counts are inconsistent/,
  );

  // only one capture time present (unpaired)
  const unpaired = structuredClone(base.manifest) as unknown as SelectedTraceContextManifestV1;
  const unpairedEntry = unpaired.selected.find((entry) => entry.fact?.kind === "step-summary") as
    unknown as { fact: { lastCapturedAtMs?: number } } | undefined;
  assert.ok(unpairedEntry, "fixture must include a step-summary fact");
  delete unpairedEntry.fact.lastCapturedAtMs;
  assert.throws(
    () => validateSelectedTraceContextManifestV1(unpaired, base.renderedContext),
    /capture times must be paired/,
  );
});
