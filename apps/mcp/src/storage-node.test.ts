import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { configPathForProfile, installNodeStorage } from "./storage-node.js";

test("MCP key storage is created with owner-only permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zine-mcp-storage-")), "mcp.json");
  installNodeStorage(path);
  globalThis.localStorage.setItem("secret", "nsec");

  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("MCP key storage repairs insecure existing permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zine-mcp-storage-")), "mcp.json");
  installNodeStorage(path);
  globalThis.localStorage.setItem("secret", "nsec");
  chmodSync(path, 0o644);

  installNodeStorage(path);
  assert.equal(globalThis.localStorage.getItem("secret"), "nsec");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("named profiles resolve to isolated paths and explicit config wins", () => {
  assert.match(configPathForProfile("research"), /\.zine\/profiles\/research\.json$/);
  assert.match(configPathForProfile("default"), /\.zine\/mcp\.json$/);
  assert.equal(configPathForProfile("research", "/tmp/explicit.json"), "/tmp/explicit.json");
  assert.throws(() => configPathForProfile("../escape"), /--profile/);
});

test("profile writes are atomic and corrupt state fails loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "zine-mcp-storage-"));
  const path = join(dir, "mcp.json");
  installNodeStorage(path);
  globalThis.localStorage.setItem("root", "one");
  globalThis.localStorage.setItem("root", "two");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), []);

  const corruptPath = join(dir, "corrupt.json");
  writeFileSync(corruptPath, "not-json", "utf8");
  installNodeStorage(corruptPath);
  assert.throws(() => globalThis.localStorage.getItem("root"), /cannot read headless profile/);

  const invalidShapePath = join(dir, "invalid-shape.json");
  writeFileSync(invalidShapePath, JSON.stringify({ root: 42 }), "utf8");
  installNodeStorage(invalidShapePath);
  assert.throws(() => globalThis.localStorage.getItem("root"), /string values/);
});
