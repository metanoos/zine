import assert from "node:assert/strict";
import test from "node:test";

import { RefCountedStepGate } from "./ref-counted-step-gate.js";

test("parallel operations release together with per-path state intact", () => {
  const gate = new RefCountedStepGate<string, { model: string }>();
  gate.begin();
  gate.begin();

  assert.equal(gate.suppressed, true);
  assert.equal(gate.release("a.md", "signer-a", { model: "a" }), null);
  assert.equal(gate.suppressed, true);

  const ready = gate.release("b.md", "signer-b", { model: "b" });
  assert.equal(gate.suppressed, false);
  assert.equal(ready?.get("a.md")?.signer, "signer-a");
  assert.equal(ready?.get("a.md")?.meta?.model, "a");
  assert.equal(ready?.get("b.md")?.signer, "signer-b");
  assert.equal(ready?.get("b.md")?.meta?.model, "b");
});

test("a completed batch does not leak releases into the next operation", () => {
  const gate = new RefCountedStepGate<string, string>();
  gate.begin();
  assert.equal(gate.release("a.md", "a", "meta-a")?.size, 1);

  gate.begin();
  const ready = gate.release("b.md", "b", "meta-b");
  assert.equal(ready?.has("a.md"), false);
  assert.equal(ready?.get("b.md")?.meta, "meta-b");
});
