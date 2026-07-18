import assert from "node:assert/strict";
import test from "node:test";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

import type { Voice } from "../../client/src/identity/identity.js";
import type { Workspace } from "../../client/src/workspace/workspace-core.js";
import {
  createMcpWorkspace,
  initializeMcpKeySession,
  registerTools,
  runMcpMintLifecycle,
} from "./tools.js";

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function voice(): Voice {
  const secretKey = generateSecretKey();
  return { secretKey, publicKey: getPublicKey(secretKey) };
}

test("MCP key bootstrap replaces corrupt public state and creates a usable workspace", async () => {
  const storage = new MemoryStorage();
  globalThis.localStorage = storage;
  storage.setItem("zine.keys", "not-json");
  const agent = voice();

  await initializeMcpKeySession(agent);
  const stored = JSON.parse(storage.getItem("zine.keys") ?? "[]") as Array<{
    id?: unknown;
    pubkey?: unknown;
  }>;
  assert.deepEqual(stored.map(({ id, pubkey }) => ({ id, pubkey })), [
    { id: "mcp-agent", pubkey: agent.publicKey },
  ]);

  const workspace = createMcpWorkspace(agent);
  assert.equal(workspace.ref, null);
});

test("MCP Mint lifecycle serializes calls and remains usable after a rejection", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const first = runMcpMintLifecycle(async () => {
    order.push("first:start");
    await barrier;
    order.push("first:end");
  });
  const second = runMcpMintLifecycle(async () => {
    order.push("second");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first:start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);

  await assert.rejects(
    runMcpMintLifecycle(async () => { throw new Error("expected"); }),
    /expected/,
  );
  assert.equal(await runMcpMintLifecycle(async () => "recovered"), "recovered");
});

test("registered local tools require a Root and return structured JSON", async () => {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<unknown>>();
  const server = {
    tool(name: string, ...args: unknown[]) {
      handlers.set(name, args.at(-1) as (input: Record<string, unknown>) => Promise<unknown>);
    },
  } as unknown as McpServer;
  const deletions: Array<[string, boolean]> = [];
  const writes: unknown[][] = [];
  const workspaceState: {
    ref: { id: string } | null;
    writeFile: (...args: unknown[]) => Promise<string>;
    deletePath: (path: string, isFolder: boolean) => Promise<void>;
  } = {
    ref: { id: "f".repeat(64) },
    writeFile: async (...args: unknown[]) => {
      writes.push(args);
      return "b".repeat(64);
    },
    deletePath: async (path: string, isFolder: boolean) => {
      deletions.push([path, isFolder]);
    },
  };
  const workspace = workspaceState as unknown as Workspace;
  registerTools(server, workspace, {
    profile: "test",
    configPath: "/tmp/test.json",
    homeRelay: "ws://127.0.0.1:4869",
    publishRelays: [],
    ownerPubkey: "a".repeat(64),
  });

  assert.equal(handlers.size, 11);
  const info = await handlers.get("zine_workspace_info")?.({}) as {
    content: Array<{ text: string }>;
  };
  assert.deepEqual(JSON.parse(info.content[0]!.text), {
    profile: "test",
    rootId: "f".repeat(64),
    ownerPubkey: "a".repeat(64),
    homeRelay: "ws://127.0.0.1:4869",
    publishRelays: [],
    pendingLocalEvents: 0,
  });
  const stepped = await handlers.get("zine_step")?.({
    relativePath: "draft.md",
    content: "draft",
    tags: ["notes"],
  }) as { content: Array<{ text: string }> };
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(stepped.content[0]!.text), {
    nodeId: "b".repeat(64),
    folderId: "f".repeat(64),
    sent: false,
    pendingLocalEvents: 0,
  });
  const result = await handlers.get("zine_delete")?.({
    relativePath: "drafts",
    isFolder: true,
  }) as { content: Array<{ text: string }> };
  assert.deepEqual(deletions, [["drafts", true]]);
  assert.deepEqual(JSON.parse(result.content[0]!.text), {
    deleted: "drafts",
    isFolder: true,
  });

  workspaceState.ref = null;
  const deleteHandler = handlers.get("zine_delete");
  assert.ok(deleteHandler);
  await assert.rejects(
    deleteHandler({ relativePath: "draft.md" }),
    /no Root bound/,
  );
});
