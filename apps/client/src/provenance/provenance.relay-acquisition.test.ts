import assert from "node:assert/strict";
import test from "node:test";

import { connectRelaysBounded } from "./provenance.js";

test("relay acquisition preserves order while bounding connection fan-out", async () => {
  let active = 0;
  let peak = 0;
  const connected = await connectRelaysBounded(
    ["a", "b", "c", "d", "e"],
    async (url) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      active--;
      return url;
    },
    undefined,
    2,
  );
  assert.equal(peak, 2);
  assert.deepEqual(connected, ["a", "b", "c", "d", "e"]);
});

test("relay acquisition stops waiting for a never-settling connection on abort", {
  timeout: 1_000,
}, async () => {
  const controller = new AbortController();
  const acquisition = connectRelaysBounded(
    ["dead"],
    async () => new Promise<string | null>(() => {}),
    controller.signal,
  );
  controller.abort(new Error("Coins disabled"));
  await assert.rejects(acquisition, /Coins disabled/);
});
