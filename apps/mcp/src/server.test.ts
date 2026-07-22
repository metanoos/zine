import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validateKEditTransition, type KEdit } from "@zine/protocol";
import type { Event } from "nostr-tools";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

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

test("unsupported Mint recovery leaves a corrupt journal inert beyond the watch interval", {
  timeout: 60_000,
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "zine-mcp-corrupt-mint-home-"));
  const config = join(home, "profile.json");
  const initial = await connectOfflineServer(config, home);
  try {
    const info = jsonToolResult(await initial.client.callTool({
      name: "zine_workspace_info",
      arguments: {},
    }));
    assert.match(String(info.rootId), /^[0-9a-f]{64}$/);
  } finally {
    await initial.client.close();
    await initial.transport.close();
  }

  const corruptJournal = "{ definitely-not-a-mint-journal";
  const stored = JSON.parse(readFileSync(config, "utf8")) as Record<string, string>;
  stored["zine.pending-coin-mints.v1"] = corruptJournal;
  writeFileSync(config, JSON.stringify(stored), { mode: 0o600 });

  const restarted = await connectOfflineServer(config, home);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 5_500));
    const info = jsonToolResult(await restarted.client.callTool({
      name: "zine_workspace_info",
      arguments: {},
    }));
    assert.match(String(info.rootId), /^[0-9a-f]{64}$/);

    const failedMint = await restarted.client.callTool({
      name: "zine_mint_span",
      arguments: {
        originPath: "result.md",
        phrase: "unsupported",
        originNodeId: "e".repeat(64),
      },
    });
    assert.equal(failedMint.isError, true);
    assert.match(
      (failedMint.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      /requires a headless Kademlia indexing backend/,
    );
  } finally {
    await restarted.client.close();
    await restarted.transport.close();
  }

  const recovered = JSON.parse(readFileSync(config, "utf8")) as Record<string, string>;
  assert.equal(
    recovered["zine.pending-coin-mints.v1"],
    corruptJournal,
    "the unavailable recovery subsystem must never parse or rewrite the legacy journal",
  );
});

test("cold headless profile mints one Root and Steps exact events while the relay is offline", {
  // Coverage instruments both server subprocesses. Under the canonical verifier
  // they also run beside the client, trace-context, Go, and Rust suites, so the
  // same test can take roughly twice its isolated wall-clock time.
  timeout: 180_000,
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

    const filesBeforeMint = jsonToolResult(await first.client.callTool({
      name: "zine_list_files",
      arguments: {},
    }));
    const failedMint = await first.client.callTool({
      name: "zine_mint_span",
      arguments: {
        originPath: "result.md",
        phrase: "must not be minted",
        originNodeId: "f".repeat(64),
      },
    });
    assert.equal(failedMint.isError, true);
    assert.match(
      (failedMint.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      /requires a headless Kademlia indexing backend/,
    );
    assert.deepEqual(
      jsonToolResult(await first.client.callTool({
        name: "zine_list_files",
        arguments: {},
      })),
      filesBeforeMint,
      "the unavailable Mint tool must fail before changing inventory",
    );

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
  assert.equal(
    stored["zine.pending-coin-mints.v1"],
    undefined,
    "the unavailable Mint tool must not create a journal row",
  );
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

  // A profile from an older build may contain a valid public-pair receipt but
  // no durable H-indexing receipt. Restart recovery must retain that journal
  // row without admitting it to Mint inventory or silently clearing it.
  const secretHex = stored["zine.headless.voice.secretHex"];
  assert.match(secretHex, /^[0-9a-f]{64}$/);
  const secret = Uint8Array.from(Buffer.from(secretHex!, "hex"));
  const legacyPhrase = "offline signed Step";
  const contentHash = createHash("sha256").update(legacyPhrase).digest("hex");
  const sourceContentHash = String(
    (JSON.parse(rawEvents[2]!.content) as { contentHash?: string }).contentHash,
  );
  const legacyCoin = finalizeEvent({
    kind: 4290,
    created_at: 1_730_000_000,
    tags: [
      ["z", "file"],
      ["F", "legacy-coin.md"],
      ["f", rootId],
      ["x", contentHash],
      ["action", "import"],
      ["e", rawEvents[2]!.id, "", "extracted-from"],
    ],
    content: JSON.stringify({
      snapshot: legacyPhrase,
      contentHash,
      coin: {
        version: 1,
        origin: {
          kind: "extracted",
          sourceNodeId: rawEvents[2]!.id,
          sourceContentHash,
          range: { start: 0, end: legacyPhrase.length },
        },
      },
    }),
  }, secret);
  const legacyAttestation = finalizeEvent({
    kind: 4294,
    created_at: legacyCoin.created_at,
    tags: [
      ["e", legacyCoin.id, "", "target"],
      ["k", "4290"],
      ["p", ownerPubkey],
    ],
    content: "{}",
  }, secret);
  const legacyPendingMint = {
    operationKey: "legacy-published-pair",
    sourceFolderId: rootId,
    mintFolderId: rootId,
    localPath: "Mint/legacy-coin.md",
    memberName: "legacy-coin.md",
    phrase: legacyPhrase,
    coin: legacyCoin,
    publishedAttestation: legacyAttestation,
    sourceFinalization: {
      kind: "span",
      relativePath: "result.md",
      sourceNodeId: rawEvents[2]!.id,
      sourceContentHash,
      range: { start: 0, end: legacyPhrase.length },
    },
    queuedAt: 1_730_000_000_000,
  };
  const legacyMintJournal = JSON.stringify([
    legacyPendingMint,
    {
      ...legacyPendingMint,
      operationKey: "legacy-overlapping-pair",
      queuedAt: 1_730_000_000_001,
    },
  ]);
  stored["zine.pending-coin-mints.v1"] = legacyMintJournal;
  writeFileSync(config, JSON.stringify(stored), { mode: 0o600 });

  const second = await connectOfflineServer(config, home);
  try {
    const recoveryBarrier = await second.client.callTool({
      name: "zine_mint_span",
      arguments: {
        originPath: "result.md",
        phrase: "barrier",
        originNodeId: "e".repeat(64),
      },
    });
    assert.equal(recoveryBarrier.isError, true);

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

    const blockedDelete = await second.client.callTool({
      name: "zine_delete",
      arguments: { relativePath: "result.md" },
    });
    assert.equal(blockedDelete.isError, true);
    assert.match(
      (blockedDelete.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      /cannot delete result\.md: a pending Mint journal still reserves/,
    );

    const blockedStep = await second.client.callTool({
      name: "zine_step",
      arguments: { relativePath: "result.md", content: "mutated while reserved" },
    });
    assert.equal(blockedStep.isError, true);
    assert.match(
      (blockedStep.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      /cannot step result\.md: a pending Mint journal still reserves/,
    );

    const blockedSend = await second.client.callTool({
      name: "zine_send",
      arguments: { relativePath: "result.md", content: "mutated while reserved" },
    });
    assert.equal(blockedSend.isError, true);
    assert.match(
      (blockedSend.content as Array<{ type?: string; text?: string }>)
        .filter((block) => block.type === "text")
        .map((block) => block.text ?? "")
        .join("\n"),
      /cannot send result\.md: a pending Mint journal still reserves/,
    );

    const files = jsonToolResult(await second.client.callTool({
      name: "zine_list_files",
      arguments: {},
    })).files as Array<{ relativePath: string }>;
    assert.equal(
      files.some((file) => file.relativePath === "Mint/legacy-coin.md"),
      false,
      "legacy pair receipt must not become Mint inventory without H-indexing",
    );
    assert.equal(
      files.some((file) => file.relativePath === "result.md"),
      true,
      "a pending extracted Mint must retain its source file",
    );
  } finally {
    await second.client.close();
    await second.transport.close();
  }

  const recovered = JSON.parse(readFileSync(config, "utf8")) as Record<string, string>;
  const pendingMints = JSON.parse(recovered["zine.pending-coin-mints.v1"] ?? "[]") as Array<{
    operationKey?: string;
    coin?: Event;
  }>;
  assert.equal(
    recovered["zine.pending-coin-mints.v1"],
    legacyMintJournal,
    "unsupported startup recovery must leave even overlapping legacy rows byte-for-byte unchanged",
  );
  assert.equal(pendingMints.length, 2);
  assert.equal(pendingMints[0]?.operationKey, "legacy-published-pair");
  assert.equal(pendingMints[0]?.coin?.id, legacyCoin.id);
  assert.equal(pendingMints[1]?.operationKey, "legacy-overlapping-pair");
  assert.equal(pendingMints[1]?.coin?.id, legacyCoin.id);
  const recoveredOutbox = JSON.parse(
    recovered["zine.pending-trace-events"] ?? "[]",
  ) as Array<{ event?: Event }>;
  assert.equal(
    recoveredOutbox.some((record) => record.event?.id === legacyCoin.id),
    false,
    "restart recovery must not publish a legacy Coin while indexing is unavailable",
  );
});
