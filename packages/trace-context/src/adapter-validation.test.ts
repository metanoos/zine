import assert from "node:assert/strict";
import test from "node:test";

import {
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  validateTraceContextAbortSignalV1,
  validateTraceContextAdapterMetadataV1,
  validateTraceContextAdapterProcessBoundsV1,
} from "./index.js";

const BASE_OPERATION = {
  version: 1,
  operation: "extend",
  maxContextBytes: 4_096,
  preparedRequestMaxBytes: 8_192,
  reservedPromptBytes: 1_024,
} as const;

test("adapter metadata is normalized, recursively frozen, and bounded", () => {
  const metadata = validateTraceContextAdapterMetadataV1({
    version: 1,
    policy: "selected-trace-v1",
    operation: {
      ...BASE_OPERATION,
      operation: "settle",
      range: { fromUtf16: 2, toUtf16: 5 },
    },
    limits: {
      version: 1,
      maxCandidates: 12,
      maxInputBytes: 8_192,
      maxCandidateInputBytes: 2_048,
      maxManifestBytes: 4_096,
    },
  });

  assert.deepEqual(metadata.operation.range, { fromUtf16: 2, toUtf16: 5 });
  assert.equal(metadata.limits?.maxCandidates, 12);
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(metadata.operation), true);
  assert.equal(Object.isFrozen(metadata.operation.range), true);
  assert.equal(Object.isFrozen(metadata.limits), true);
});

test("adapter metadata rejects every invalid structural and numeric boundary", () => {
  const invalid: Array<[unknown, RegExp]> = [
    [null, /input must be an object/],
    [{ version: 2, policy: "text-only-v1", operation: BASE_OPERATION }, /input version/],
    [{ version: 1, policy: "other", operation: BASE_OPERATION }, /policy/],
    [{ version: 1, policy: "text-only-v1", operation: null }, /operation must be an object/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, version: 2 } }, /operation version/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, operation: "reply" } }, /operation must be/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, operation: "settle" } }, /Settle requires/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, range: [] } }, /operation range must be an object/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, range: { fromUtf16: -1, toUtf16: 1 } } }, /fromUtf16/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, range: { fromUtf16: 2, toUtf16: 1 } } }, /must be ordered/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, maxContextBytes: 0 } }, /maxContextBytes/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, preparedRequestMaxBytes: 1.5 } }, /preparedRequestMaxBytes/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, reservedPromptBytes: -1 } }, /reservedPromptBytes/],
    [{ version: 1, policy: "text-only-v1", operation: { ...BASE_OPERATION, reservedPromptBytes: 9_000 } }, /cannot exceed/],
    [{ version: 1, policy: "text-only-v1", operation: BASE_OPERATION, limits: [] }, /limits must be an object/],
    [{ version: 1, policy: "text-only-v1", operation: BASE_OPERATION, limits: { version: 2 } }, /limits version/],
    [{ version: 1, policy: "text-only-v1", operation: BASE_OPERATION, limits: { version: 1, maxCandidates: 0 } }, /positive safe integer/],
    [{
      version: 1,
      policy: "text-only-v1",
      operation: BASE_OPERATION,
      limits: { version: 1, maxCandidates: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates + 1 },
    }, /cannot exceed/],
  ];

  for (const [value, pattern] of invalid) {
    assert.throws(() => validateTraceContextAdapterMetadataV1(value), pattern);
  }
});

test("abort-signal validation accepts only signal-compatible values", () => {
  assert.equal(validateTraceContextAbortSignalV1(undefined), undefined);
  const controller = new AbortController();
  assert.equal(validateTraceContextAbortSignalV1(controller.signal), controller.signal);
  for (const value of [null, {}, { aborted: false }, { addEventListener() {} }]) {
    assert.throws(() => validateTraceContextAbortSignalV1(value), /signal must be an AbortSignal/);
  }
});

test("adapter process preflight bounds events, editor transactions, and projected candidates", () => {
  assert.doesNotThrow(() => validateTraceContextAdapterProcessBoundsV1([
    "not-json",
    JSON.stringify({ other: [] }),
    JSON.stringify({ editorTransactions: [null, { sequence: "a", changes: [] }] }),
  ], undefined));

  assert.throws(
    () => validateTraceContextAdapterProcessBoundsV1(
      Array.from({ length: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates + 1 }, () => "{}"),
      undefined,
    ),
    /bounded Step ceiling/,
  );
  assert.throws(
    () => validateTraceContextAdapterProcessBoundsV1(["{}", "{}"], 1),
    /projected candidate count/,
  );
  assert.throws(
    () => validateTraceContextAdapterProcessBoundsV1([
      JSON.stringify({
        editorTransactions: [{
          sequence: 0,
          changes: [{ op: "insert", from: 0, to: 0, text: "x" }],
        }],
      }),
    ], 2),
    /projected candidate count/,
  );
  assert.throws(
    () => validateTraceContextAdapterProcessBoundsV1([
      JSON.stringify({
        editorTransactions: Array.from(
          { length: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateSlots + 1 },
          () => null,
        ),
      }),
    ], undefined),
    /bounded editor transaction scan ceiling/,
  );
});
