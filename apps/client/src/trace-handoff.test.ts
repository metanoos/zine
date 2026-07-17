import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import { openTraceLocator } from "./trace-handoff.js";
import type { TraceLocator } from "./trace-locator.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OWNER = getPublicKey(SECRET);
const ROOT = "a".repeat(64);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function node(snapshot: string, previous?: string, contentHash?: string) {
  return finalizeEvent({
    kind: 4290,
    created_at: 1_700_000_000 + (previous ? 1 : 0),
    tags: [
      ["z", "file"],
      ["F", "result.md"],
      ["f", ROOT],
      ["action", previous ? "edit" : "import"],
      ...(previous ? [["e", previous, "", "prev"]] : []),
    ],
    content: JSON.stringify({
      snapshot,
      contentHash: contentHash ?? await sha256Hex(snapshot),
      steppedAt: 1_700_000_000_000,
    }),
  }, SECRET);
}

test("desktop handoff opens one exact, verified file chain without importing it", async () => {
  const genesis = await node("draft\n");
  const head = await node("final\n", genesis.id);
  const byId = new Map([genesis, head].map((event) => [event.id, event]));
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: genesis.id,
    nodeId: head.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };

  const opened = await openTraceLocator(locator, async (ids) =>
    ids.map((id) => byId.get(id)).filter((event) => event !== undefined),
  );
  assert.equal(opened.historyComplete, true);
  assert.deepEqual(opened.steps.map((step) => step.snapshot), ["draft\n", "final\n"]);
  assert.deepEqual(opened.steps.map((step) => step.action), ["import", "edit"]);
});

test("desktop handoff opens the exact sent nucleus when private ancestry is unavailable", async () => {
  const genesis = await node("private draft\n");
  const head = await node("shared result\n", genesis.id);
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: genesis.id,
    nodeId: head.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };

  const opened = await openTraceLocator(locator, async (ids) =>
    ids.includes(head.id) ? [head] : [],
  );
  assert.equal(opened.historyComplete, false);
  assert.deepEqual(opened.steps.map((step) => step.snapshot), ["shared result\n"]);
});

test("desktop handoff rejects a locator whose owner claim mismatches the chain", async () => {
  const genesis = await node("draft\n");
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: genesis.id,
    nodeId: genesis.id,
    relativePath: "result.md",
    ownerPubkey: "b".repeat(64),
    relayHints: ["wss://relay.example.com"],
  };
  await assert.rejects(
    openTraceLocator(locator, async () => [genesis]),
    /unexpected owner/,
  );
});

test("desktop handoff rejects a signed snapshot whose hash does not match", async () => {
  const head = await node("tampered snapshot\n", undefined, "0".repeat(64));
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: head.id,
    nodeId: head.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };
  await assert.rejects(
    openTraceLocator(locator, async () => [head]),
    /snapshot hash mismatch/,
  );
});

test("desktop handoff rejects a signed non-file event", async () => {
  const snapshot = "folder payload\n";
  const event = finalizeEvent({
    kind: 4290,
    created_at: 1_700_000_000,
    tags: [["z", "folder"], ["F", "result.md"], ["f", ROOT]],
    content: JSON.stringify({ snapshot, contentHash: await sha256Hex(snapshot) }),
  }, SECRET);
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: event.id,
    nodeId: event.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };

  await assert.rejects(
    openTraceLocator(locator, async () => [event]),
    /not a file TraceNode/,
  );
});
