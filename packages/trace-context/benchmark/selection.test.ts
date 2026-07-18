import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSelectorRelativeInputV1,
  runSelectorRelativeCaseV1,
  SELECTOR_RELATIVE_SIZES_V1,
} from "./selection.js";

test("selector relative harness covers deterministic 0/100/1k/10k structures", async () => {
  let priorInputBytes = 0;
  for (const size of SELECTOR_RELATIVE_SIZES_V1) {
    const result = await runSelectorRelativeCaseV1(size);
    assert.equal(result.size, size);
    assert.equal(result.selectionComplete, true);
    assert.equal(result.selectedCount + result.budgetExcludedCount, size);
    assert.ok(result.projectedInputBytes > priorInputBytes || size === 0);
    assert.ok(result.renderedContextBytes <= 256 * 1_024);
    assert.match(result.frozenInputsSha256, /^[0-9a-f]{64}$/);
    assert.match(result.renderedContextSha256, /^[0-9a-f]{64}$/);
    assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
    priorInputBytes = result.projectedInputBytes;
  }
});

test("relative fixture enumeration does not enter selector identity", async () => {
  const forward = await runSelectorRelativeCaseV1(100);
  const reverse = await runSelectorRelativeCaseV1(100, true);
  assert.deepEqual(reverse, forward);
});

test("relative fixture generator rejects unsupported scales", () => {
  assert.throws(() => buildSelectorRelativeInputV1(-1), RangeError);
  assert.throws(() => buildSelectorRelativeInputV1(10_001), RangeError);
  assert.throws(() => buildSelectorRelativeInputV1(1.5), RangeError);
});
