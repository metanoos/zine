import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for binding persistence
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
  clear: () => values.clear(),
};

const { rememberFolderFork, storedAgentRoot, storedFolderFork } = await import("./folder-binding.js");

test("source folder bindings persist only valid event ids", () => {
  const source = "a".repeat(64);
  const fork = "b".repeat(64);
  rememberFolderFork(source, fork);
  assert.equal(storedFolderFork(source), fork);

  rememberFolderFork(source, "not-an-event-id");
  assert.equal(storedFolderFork(source), null);
});

test("headless Root pointers fail loudly when malformed", () => {
  values.set("zine.mcp.root", "not-json");
  assert.throws(() => storedAgentRoot(), /corrupt JSON/);
  values.set("zine.mcp.root", JSON.stringify({ id: "short", ownerPubkey: "b".repeat(64) }));
  assert.throws(() => storedAgentRoot(), /invalid shape/);
  values.delete("zine.mcp.root");
});
