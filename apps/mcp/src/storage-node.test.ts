import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installNodeStorage } from "./storage-node.js";

test("MCP key storage is created with owner-only permissions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zine-mcp-storage-")), "mcp.json");
  installNodeStorage(path);
  globalThis.localStorage.setItem("secret", "nsec");

  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("MCP key storage repairs permissions from older versions", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zine-mcp-storage-")), "mcp.json");
  installNodeStorage(path);
  globalThis.localStorage.setItem("secret", "nsec");
  chmodSync(path, 0o644);

  installNodeStorage(path);
  assert.equal(globalThis.localStorage.getItem("secret"), "nsec");
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
