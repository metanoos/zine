import assert from "node:assert/strict";
import test from "node:test";

import {
  SelectedTraceContextManifestValidationError,
  validateSelectedTraceContextManifestV1,
} from "./manifest-validator.js";
import { selectTraceContextV1 } from "./selector.js";
import type { SelectedTraceContextManifestV1 } from "./selection-types.js";

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
