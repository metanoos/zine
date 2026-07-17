import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function jsonToolResult(result: unknown): Record<string, unknown> {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content), "tool returned no content array");
  const block = content.find(
    (item: unknown): item is { type: "text"; text: string } =>
      !!item && typeof item === "object" &&
      (item as { type?: unknown }).type === "text" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  assert.ok(block, "tool returned no JSON text block");
  return JSON.parse(block.text) as Record<string, unknown>;
}

async function connectOfflineServer(config: string, fakeHome: string) {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  env.HOME = fakeHome;
  const transport = new StdioClientTransport({
    command: tsx,
    args: [
      join(packageRoot, "src", "server.ts"),
      "--profile",
      "offline-test",
      "--home-relay",
      "ws://127.0.0.1:1",
      "--config",
      config,
    ],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "zine-test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

test("startup rejects an unavailable source folder instead of binding an empty cache", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const config = join(mkdtempSync(join(tmpdir(), "zine-mcp-server-")), "mcp.json");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--folder",
      "a".repeat(64),
      "--home-relay",
      "ws://127.0.0.1:1",
      "--config",
      config,
    ],
    // Startup intentionally retries a relay that may still be booting. Keep the
    // process timeout comfortably above that retry budget: under the repository
    // verifier this test runs beside the client, Go, and Rust suites, and a 5s
    // wall-clock cap could kill the child just before it emitted the expected
    // attach diagnostic.
    { encoding: "utf8", timeout: 45_000 },
  );

  assert.equal(result.status, 3, result.stderr || result.error?.message);
  assert.match(result.stderr, /could not bind source folder/);
  assert.doesNotMatch(result.stderr, /zine-mcp bound/);
});

test("startup rejects a non-loopback home before connecting", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--folder",
      "a".repeat(64),
      "--home-relay",
      "wss://relay.example.com",
    ],
    { encoding: "utf8", timeout: 45_000 },
  );

  assert.equal(result.status, 2, result.stderr || result.error?.message);
  assert.match(result.stderr, /--home-relay must be loopback/);
  assert.match(result.stderr, /--publish-relay/);
  assert.doesNotMatch(result.stderr, /could not bind source folder/);
});

test("startup rejects a loopback publication destination", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--folder",
      "a".repeat(64),
      "--publish-relay",
      "ws://127.0.0.1:7777",
    ],
    { encoding: "utf8", timeout: 45_000 },
  );

  assert.equal(result.status, 2, result.stderr || result.error?.message);
  assert.match(result.stderr, /--publish-relay must cross the machine boundary/);
  assert.doesNotMatch(result.stderr, /could not bind source folder/);
});

test("cold headless profile mints one Root and Steps exact events while the relay is offline", {
  timeout: 90_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "zine-mcp-home-"));
  const config = join(home, "profile.json");
  const first = await connectOfflineServer(config, home);
  let rootId: string;
  let ownerPubkey: string;
  try {
    const info = jsonToolResult(await first.client.callTool({
      name: "zine_workspace_info",
      arguments: {},
    }));
    rootId = String(info.rootId);
    ownerPubkey = String(info.ownerPubkey);
    assert.match(rootId, /^[0-9a-f]{64}$/);
    assert.match(ownerPubkey, /^[0-9a-f]{64}$/);
    assert.equal(info.profile, "offline-test");

    const stepped = jsonToolResult(await first.client.callTool({
      name: "zine_step",
      arguments: { relativePath: "result.md", content: "offline signed Step\n" },
    }));
    const nodeId = String(stepped.nodeId);
    assert.match(nodeId, /^[0-9a-f]{64}$/);
    assert.equal(stepped.sent, false);
    assert.ok(Number(stepped.pendingLocalEvents) >= 1);

    const node = jsonToolResult(await first.client.callTool({
      name: "zine_get_node",
      arguments: { nodeId },
    }));
    const event = node.event as Record<string, unknown>;
    assert.equal(event.id, nodeId);
    assert.equal(event.pubkey, ownerPubkey);
    assert.equal((node.payload as { snapshot?: string }).snapshot, "offline signed Step\n");
    assert.equal(typeof event.sig, "string");
  } finally {
    await first.client.close();
    await first.transport.close();
  }

  const second = await connectOfflineServer(config, home);
  try {
    const info = jsonToolResult(await second.client.callTool({
      name: "zine_workspace_info",
      arguments: {},
    }));
    assert.equal(info.rootId, rootId);
    assert.equal(info.ownerPubkey, ownerPubkey);
  } finally {
    await second.client.close();
    await second.transport.close();
  }
});
