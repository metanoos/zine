import assert from "node:assert/strict";
import test from "node:test";

import { enforceGoCoverage, parseGoCoverage } from "./check-go-coverage.mjs";

const passingOutput = [
  "ok  \tgithub.com/zine/relay\t0.426s\tcoverage: 57.4% of statements",
  "ok  \tgithub.com/zine/relay/cmd/hosted\t0.782s\tcoverage: 68.0% of statements",
].join("\n");

test("Go coverage parser records every measured package", () => {
  assert.deepEqual(
    Object.fromEntries(parseGoCoverage(passingOutput)),
    {
      "github.com/zine/relay": 57.4,
      "github.com/zine/relay/cmd/hosted": 68,
    },
  );
});

test("Go coverage enforcement accepts the checked-in package floors", () => {
  assert.doesNotThrow(() => enforceGoCoverage(passingOutput));
});

test("Go coverage enforcement rejects missing and regressed packages", () => {
  assert.throws(
    () => enforceGoCoverage(
      "ok  \tgithub.com/zine/relay\t(cached)\tcoverage: 55.9% of statements",
    ),
    /github\.com\/zine\/relay: 55\.9% is below 56\.0%[\s\S]*hosted: no coverage result/,
  );
});
