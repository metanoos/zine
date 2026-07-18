import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

import corpus from "../corpus/conformance-v1.json" with { type: "json" };
import {
  canonicalBytes,
  canonicalJson,
  encodeTraceLocator,
  parseTraceLocator,
  validateKEditTransition,
  validateTraceLocator,
  verifyFileTraceChain,
  verifyFolderTraceChain,
  type CanonicalJsonValue,
  type KEdit,
  type TraceConformanceStatus,
} from "./index.js";

const TEST_SECRET = Uint8Array.from([...new Uint8Array(31), 1]);

async function sha256Hex(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))).toString("hex");
}

async function folderNode(
  members: Array<{ kind: "file" | "folder"; relativePath: string; latestNodeId: string; contentHash: string }>,
  checkpoint: { version: 1; cause: string; sourceNodeId?: string },
  operationId: string,
  prev?: Event,
  deltas: unknown[] = [],
): Promise<Event> {
  const contentHash = await sha256Hex(JSON.stringify(
    members.map((member) => [member.relativePath, member.kind, member.contentHash]),
  ));
  return finalizeEvent({
    kind: 4290,
    created_at: 1_800_000_000 + (prev ? 1 : 0),
    tags: [
      ["z", "folder"],
      ...(prev ? [["f", prev.tags.find((tag) => tag[0] === "f")?.[1] ?? prev.id]] : []),
      ...members.map((member) => ["q", member.latestNodeId]),
      ["action", prev ? "edit" : "import"],
      ...(prev ? [["e", prev.id, "", "prev"]] : []),
      ["x", contentHash],
    ],
    content: JSON.stringify({
      snapshot: { members },
      ...(deltas.length > 0 ? { deltas } : {}),
      contentHash,
      operationId,
      folderCheckpoint: checkpoint,
    }),
  }, TEST_SECRET);
}

test("the fixed corpus identifies this kernel version", () => {
  assert.equal(corpus.format, "zine-protocol-conformance");
  assert.equal(corpus.version, 1);
});

test("canonical encoding matches every fixed byte vector", () => {
  for (const vector of corpus.canonical) {
    const value = vector.value as CanonicalJsonValue;
    assert.equal(canonicalJson(value), vector.encoded, vector.name);
    assert.equal(Buffer.from(canonicalBytes(value)).toString("hex"), vector.utf8Hex, vector.name);
  }
  assert.throws(() => canonicalJson(Number.NaN as never), /non-finite/);
  assert.throws(() => canonicalJson("\ud800"), /unpaired Unicode surrogate/);
});

test("KEdit validation matches every fixed transition vector", () => {
  for (const vector of corpus.kedits) {
    const verdict = validateKEditTransition(
      vector.before,
      vector.after,
      vector.kedits as KEdit[],
    );
    assert.equal(verdict.valid, vector.valid, vector.name);
    if (vector.reasonIncludes) {
      assert.match(verdict.reason ?? "", new RegExp(vector.reasonIncludes), vector.name);
    }
  }
});

test("trace locator validation and encoding match every fixed vector", () => {
  for (const vector of corpus.locators) {
    if (!vector.valid) {
      assert.throws(
        () => validateTraceLocator(vector.value),
        new RegExp(vector.reasonIncludes ?? "invalid"),
        vector.name,
      );
      continue;
    }
    const locator = validateTraceLocator(vector.value);
    assert.deepEqual(parseTraceLocator(JSON.stringify(vector.value)), locator, vector.name);
    assert.equal(encodeTraceLocator(locator), vector.encoded, vector.name);
    assert.deepEqual(parseTraceLocator(vector.encoded ?? ""), locator, vector.name);
  }
});

test("trace conformance matches the fixed signed-event corpus", async () => {
  for (const vector of corpus.traces) {
    const verdict = await verifyFileTraceChain(vector.chain as Event[], verifyEvent);
    assert.equal(verdict.status, vector.status as TraceConformanceStatus, vector.name);
    assert.deepEqual(
      verdict.steps.map((step) => step.status),
      vector.stepStatuses as TraceConformanceStatus[],
      vector.name,
    );
  }
});

test("folder conformance verifies add, advance, and explicit checkpoints", async () => {
  const genesis = await folderNode([], { version: 1, cause: "genesis" }, "11".repeat(32));
  const firstMember = {
    kind: "file" as const,
    relativePath: "essay.md",
    latestNodeId: "aa".repeat(32),
    contentHash: "cc".repeat(32),
  };
  const added = await folderNode(
    [firstMember],
    { version: 1, cause: "structure-change" },
    "22".repeat(32),
    genesis,
    [{
      type: "add",
      kind: "file",
      relativePath: "essay.md",
      nodeId: firstMember.latestNodeId,
      timestamp: 1,
    }],
  );
  const advancedMember = {
    ...firstMember,
    latestNodeId: "bb".repeat(32),
    contentHash: "dd".repeat(32),
  };
  const advanced = await folderNode(
    [advancedMember],
    { version: 1, cause: "child-advance", sourceNodeId: advancedMember.latestNodeId },
    "33".repeat(32),
    added,
    [{
      type: "advance",
      kind: "file",
      relativePath: "essay.md",
      previousNodeId: firstMember.latestNodeId,
      nodeId: advancedMember.latestNodeId,
      timestamp: 2,
    }],
  );
  const explicit = await folderNode(
    [advancedMember],
    { version: 1, cause: "explicit-step" },
    "44".repeat(32),
    advanced,
  );

  const verdict = await verifyFolderTraceChain(
    [genesis, added, advanced, explicit],
    verifyEvent,
  );
  assert.equal(verdict.status, "full");
  assert.deepEqual(verdict.steps.map((step) => step.status), ["full", "full", "full", "full"]);
});

test("folder conformance rejects an existing child encoded as add", async () => {
  const member = {
    kind: "file" as const,
    relativePath: "essay.md",
    latestNodeId: "aa".repeat(32),
    contentHash: "cc".repeat(32),
  };
  const genesis = await folderNode([member], { version: 1, cause: "genesis" }, "55".repeat(32));
  const replacement = { ...member, latestNodeId: "bb".repeat(32) };
  const invalid = await folderNode(
    [replacement],
    { version: 1, cause: "structure-change" },
    "66".repeat(32),
    genesis,
    [{
      type: "add",
      kind: "file",
      relativePath: "essay.md",
      nodeId: replacement.latestNodeId,
      timestamp: 2,
    }],
  );
  const verdict = await verifyFolderTraceChain([genesis, invalid], verifyEvent);
  assert.equal(verdict.status, "invalid");
  assert.ok(verdict.issues.some((issue) => issue.code === "nonconforming-deltas"));
});
