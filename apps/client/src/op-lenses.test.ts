import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for the lens store
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

import {
  DEFAULT_OP_LENSES,
  OP_LENSES,
  lensForOp,
  loadOpLensSelections,
  saveOpLensSelection,
} from "./op-lenses.js";

test("each operation exposes only relevant editorial lenses", () => {
  assert.ok(OP_LENSES.settle.some((lens) => lens.id === "conservative-line-editor"));
  assert.ok(OP_LENSES.reply.some((lens) => lens.id === "psychoanalytic-reading"));
  assert.ok(OP_LENSES.receive.some((lens) => lens.id === "forensic-process-analyst"));
  assert.ok(!OP_LENSES.settle.some((lens) => lens.id === "psychoanalytic-reading"));
});

test("lens selections persist per operation without leaking to another op", () => {
  store.clear();
  const next = saveOpLensSelection("reply", "skeptical-reader");
  assert.equal(next.reply, "skeptical-reader");
  assert.equal(next.settle, "default");
  assert.deepEqual(loadOpLensSelections(), next);
});

test("corrupt or incompatible stored lens ids normalize to defaults", () => {
  store.set("zine.op.lenses.v1", JSON.stringify({
    ...DEFAULT_OP_LENSES,
    settle: "psychoanalytic-reading",
  }));
  assert.equal(loadOpLensSelections().settle, "default");
  assert.equal(lensForOp("settle", "psychoanalytic-reading").id, "default");
});
