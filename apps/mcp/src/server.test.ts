import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import type { KEdit } from "../../client/src/provenance/provenance.js";
import { validateKEditTransition } from "../../client/src/workspace/workspace-core.js";

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

function canonicalEvent(event: Event): Event {
  return JSON.parse(JSON.stringify(event)) as Event;
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
      "--source-folder",
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
      "--source-folder",
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

test("a hostname beginning with 127 is not treated as loopback", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--home-relay",
      "ws://127.attacker.example:4869",
    ],
    { encoding: "utf8", timeout: 45_000 },
  );

  assert.equal(result.status, 2, result.stderr || result.error?.message);
  assert.match(result.stderr, /--home-relay must be loopback/);
});

test("startup rejects a loopback publication destination", () => {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const tsx = join(packageRoot, "node_modules", ".bin", "tsx");
  const result = spawnSync(
    tsx,
    [
      join(packageRoot, "src", "server.ts"),
      "--source-folder",
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
  const contents = [
    "offline signed Step\n",
    "offline signed Step with a non-genesis edit 🙂\n",
    "offline signed Step with a non-genesis edit 🙂\n",
  ];
  const nodeIds: string[] = [];
  const rawEvents: Event[] = [];
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

    for (const content of contents) {
      const stepped = jsonToolResult(await first.client.callTool({
        name: "zine_step",
        arguments: { relativePath: "result.md", content },
      }));
      const nodeId = String(stepped.nodeId);
      assert.match(nodeId, /^[0-9a-f]{64}$/);
      assert.equal(stepped.sent, false);
      assert.ok(Number(stepped.pendingLocalEvents) >= 1);
      nodeIds.push(nodeId);
    }
    assert.equal(new Set(nodeIds).size, contents.length, "every explicit Step must mint one node");

    const history = jsonToolResult(await first.client.callTool({
      name: "zine_get_history",
      arguments: { relativePath: "result.md" },
    }));
    assert.equal((history.conformance as { status?: string }).status, "full");
    const historyRows = history.history as Array<{
      nodeId: string;
      payload: { snapshot?: string; kedits?: KEdit[] };
      event: Event;
    }>;
    assert.deepEqual(historyRows.map((row) => row.nodeId), nodeIds);

    let previousSnapshot = "";
    for (let index = 0; index < historyRows.length; index += 1) {
      const row = historyRows[index]!;
      const expectedSnapshot = contents[index]!;
      assert.equal(row.payload.snapshot, expectedSnapshot);
      assert.ok(Array.isArray(row.payload.kedits), `Step ${index} is missing kedits`);
      assert.equal(
        validateKEditTransition(previousSnapshot, expectedSnapshot, row.payload.kedits!).valid,
        true,
        `Step ${index} KEdits do not replay its signed transition`,
      );
      assert.equal(verifyEvent(canonicalEvent(row.event)), true, `Step ${index} signature is invalid`);
      assert.equal(row.event.id, nodeIds[index]);
      assert.equal(row.event.pubkey, ownerPubkey);
      if (previousSnapshot === expectedSnapshot) {
        assert.deepEqual(row.payload.kedits, [], "unchanged Step must carry kedits: []");
      } else {
        assert.equal(row.payload.kedits!.length, 1, "headless change must be one atomic KEdit");
        const edit = row.payload.kedits![0]!;
        assert.ok(Number.isSafeInteger(edit.tx) && edit.tx >= 0, "invalid transaction id");
        assert.ok(Number.isSafeInteger(edit.t) && edit.t >= 0, "invalid transaction timestamp");
        assert.equal(edit.voice, ownerPubkey, "KEdit voice must be the profile signer");
        assert.match(edit.voice, /^[0-9a-f]{64}$/);
        assert.ok(Number.isSafeInteger(edit.from) && edit.from >= 0, "invalid KEdit start");
        assert.ok(Number.isSafeInteger(edit.to) && edit.to >= edit.from, "invalid KEdit end");
        assert.ok(edit.op === "ins" || edit.op === "del" || edit.op === "repl");
        assert.equal(typeof edit.text, "string");
      }
      rawEvents.push(canonicalEvent(row.event));
      previousSnapshot = expectedSnapshot;
    }

    const node = jsonToolResult(await first.client.callTool({
      name: "zine_get_node",
      arguments: { nodeId: nodeIds[2] },
    }));
    assert.deepEqual(node.event, rawEvents[2], "node read must expose the canonical raw event");
    assert.equal(
      (node.conformance as { status?: string } | undefined)?.status,
      "full",
    );
    assert.equal(node.historyComplete, true);

    const handoff = jsonToolResult(await first.client.callTool({
      name: "zine_get_handoff",
      arguments: { relativePath: "result.md" },
    }));
    const locator = handoff.locator as Record<string, unknown>;
    assert.equal(handoff.sent, false);
    assert.equal(locator.rootId, rootId);
    assert.equal(locator.traceId, nodeIds[0]);
    assert.equal(locator.nodeId, nodeIds[2]);
    assert.equal(locator.relativePath, "result.md");
    assert.equal(locator.ownerPubkey, ownerPubkey);
    assert.match(String(handoff.encoded), /^zine-trace:/);
  } finally {
    await first.client.close();
    await first.transport.close();
  }

  const stored = JSON.parse(readFileSync(config, "utf8")) as Record<string, string>;
  const outbox = JSON.parse(stored["zine.pending-trace-events"] ?? "[]") as Array<{
    event: Event;
  }>;
  const queuedById = new Map(outbox.map((record) => [record.event.id, record.event]));
  for (const event of rawEvents) {
    assert.deepEqual(
      queuedById.get(event.id),
      event,
      `offline profile did not retain exact signed event ${event.id}`,
    );
  }

  const second = await connectOfflineServer(config, home);
  try {
    const info = jsonToolResult(await second.client.callTool({
      name: "zine_workspace_info",
      arguments: {},
    }));
    assert.equal(info.rootId, rootId);
    assert.equal(info.ownerPubkey, ownerPubkey);

    const history = jsonToolResult(await second.client.callTool({
      name: "zine_get_history",
      arguments: { relativePath: "result.md" },
    }));
    const historyRows = history.history as Array<{ nodeId: string; event: Event }>;
    assert.deepEqual(historyRows.map((row) => row.nodeId), nodeIds);
    assert.deepEqual(historyRows.map((row) => row.event), rawEvents);
    assert.equal((history.conformance as { status?: string }).status, "full");
  } finally {
    await second.client.close();
    await second.transport.close();
  }
});
