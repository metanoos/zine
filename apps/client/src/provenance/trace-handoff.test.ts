import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  openTraceLocator,
  RelayHintApprovalRequiredError,
} from "./trace-handoff.js";
import type { TraceLocator } from "./trace-locator.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const OWNER = getPublicKey(SECRET);
const ROOT = "a".repeat(64);
const TEST_OPERATION_ID = "1".repeat(64);

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
      operationId: TEST_OPERATION_ID,
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
  assert.equal(opened.conformance.status, "snapshot-only");
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
  assert.equal(opened.conformance.status, "snapshot-only");
  assert.ok(opened.conformance.issues.some((issue) => issue.code === "history-incomplete"));
  assert.deepEqual(opened.steps.map((step) => step.snapshot), ["shared result\n"]);
});

test("desktop handoff rejects a false trace identity for an available genesis", async () => {
  const genesis = await node("genesis\n");
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: "b".repeat(64),
    nodeId: genesis.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };

  await assert.rejects(
    openTraceLocator(locator, async () => [genesis]),
    /resolved genesis does not match the requested trace identity/,
  );
});

test("desktop handoff rejects malformed available ancestry", async () => {
  const malformedAncestor = await node("broken ancestry\n", "not-a-node-id");
  const head = await node("shared result\n", malformedAncestor.id);
  const byId = new Map([malformedAncestor, head].map((event) => [event.id, event]));
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: "c".repeat(64),
    nodeId: head.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: ["wss://relay.example.com"],
  };

  await assert.rejects(
    openTraceLocator(locator, async (ids) =>
      ids.map((id) => byId.get(id)).filter((event) => event !== undefined),
    ),
    /prev edge does not carry a canonical event id/,
  );
});

test("sensitive relay hints require exact approval before any loader runs", async () => {
  const genesis = await node("local handoff\n");
  const privateRelay = "ws://127.0.0.1:4869";
  const locator: TraceLocator = {
    format: "zine-trace-locator",
    version: 1,
    kind: "file",
    rootId: ROOT,
    traceId: genesis.id,
    nodeId: genesis.id,
    relativePath: "result.md",
    ownerPubkey: OWNER,
    relayHints: [privateRelay],
  };
  let loads = 0;
  const loadEvents = async () => {
    loads += 1;
    return [genesis];
  };

  await assert.rejects(
    openTraceLocator(locator, loadEvents),
    (error) => {
      assert.ok(error instanceof RelayHintApprovalRequiredError);
      assert.deepEqual(error.relayHints, [privateRelay]);
      return true;
    },
  );
  assert.equal(loads, 0);

  const opened = await openTraceLocator(locator, {
    loadEvents,
    approvedRelayHints: [privateRelay],
  });
  assert.equal(loads > 0, true);
  assert.equal(opened.steps[0]?.snapshot, "local handoff\n");
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
