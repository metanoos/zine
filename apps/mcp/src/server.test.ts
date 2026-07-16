import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("startup rejects an unavailable folder instead of binding an empty cache", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const config = join(mkdtempSync(join(tmpdir(), "zine-mcp-server-")), "mcp.json");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--folder",
      "a".repeat(64),
      "--relay",
      "ws://127.0.0.1:1",
      "--config",
      config,
    ],
    // Startup intentionally retries a relay that may still be booting. Keep the
    // process timeout comfortably above that retry budget: under the repository
    // verifier this test runs beside the client, Go, and Rust suites, and a 5s
    // wall-clock cap could kill the child just before it emitted the expected
    // attach diagnostic.
    { encoding: "utf8", timeout: 15_000 },
  );

  assert.equal(result.status, 3, result.stderr || result.error?.message);
  assert.match(result.stderr, /could not attach folder/);
  assert.doesNotMatch(result.stderr, /zine-mcp bound/);
});
