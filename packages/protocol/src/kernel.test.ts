import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";

import corpus from "../corpus/conformance-v1.json" with { type: "json" };
import folderCorpus from "../corpus/folder-conformance-v1.json" with { type: "json" };
import {
  canonicalBytes,
  canonicalJson,
  encodeTraceLocator,
  parseTraceLocator,
  validateKEditTransition,
  validateTraceLocator,
  verifyFileTraceChain,
  verifyFolderTraceChain,
  traceOperationIdFromEvent,
  type CanonicalJsonValue,
  type KEdit,
  type TraceConformanceStatus,
} from "./index.js";

type ChainVector = {
  name: string;
  traceId: string;
  nodeIds: string[];
  status: TraceConformanceStatus;
  stepStatuses: TraceConformanceStatus[];
  issueCodes: string[];
};

type OperationVector = {
  name: string;
  operationId: string;
  nodeIds: string[];
  requiredNodeIds: string[];
  propagation: Array<{
    nodeId: string;
    cause: string;
    sourceNodeId?: string;
  }>;
  valid: boolean;
};

const folderEvents = folderCorpus.events as Record<string, Event>;

function eventsFor(nodeIds: readonly string[]): Event[] {
  return nodeIds.map((nodeId) => {
    const event = folderEvents[nodeId];
    assert.ok(event, `folder corpus is missing ${nodeId}`);
    assert.equal(event.id, nodeId, `folder corpus key does not match signed id ${nodeId}`);
    return event;
  });
}

const FOLDER_TEST_SECRET = Uint8Array.from([...new Uint8Array(31), 7]);

async function folderNode(
  members: Array<{
    kind: "file" | "folder";
    relativePath: string;
    latestNodeId: string;
    contentHash: string;
  }>,
  folderCheckpoint: { version: 1; cause: string; sourceNodeId?: string },
  operationId: string,
  previous?: Event,
  deltas: unknown[] = [],
): Promise<Event> {
  const body = JSON.stringify(
    members.map((member) => [member.relativePath, member.kind, member.contentHash]),
  );
  const contentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  ).toString("hex");
  const traceId = previous?.tags.find((tag) => tag[0] === "f")?.[1] ?? previous?.id;
  const createdAt = (previous?.created_at ?? 0) + 1;
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [
      ["z", "folder"],
      ...(traceId ? [["f", traceId]] : []),
      ...members.map((member) => ["q", member.latestNodeId]),
      ["action", previous ? "edit" : "import"],
      ...(previous ? [["e", previous.id, "", "prev"]] : []),
      ["x", contentHash],
    ],
    content: JSON.stringify({
      steppedAt: createdAt * 1_000,
      snapshot: { members },
      contentHash,
      operationId,
      deltas,
      folderCheckpoint,
    }),
  }, FOLDER_TEST_SECRET);
}

function operationVectorValid(vector: OperationVector): boolean {
  const events = eventsFor(vector.nodeIds);
  const requiredNodeIds = new Set(vector.requiredNodeIds);
  const exactMembership =
    new Set(vector.nodeIds).size === vector.nodeIds.length &&
    requiredNodeIds.size === vector.requiredNodeIds.length &&
    vector.nodeIds.length === vector.requiredNodeIds.length &&
    vector.nodeIds.every((nodeId) => requiredNodeIds.has(nodeId));
  if (events.some((event) => !verifyEvent(event))) return false;
  if (events.some((event) => traceOperationIdFromEvent(event) !== vector.operationId)) return false;

  const expectedPropagation = new Map(
    vector.propagation.map((expected) => [expected.nodeId, expected]),
  );
  if (expectedPropagation.size !== vector.propagation.length) return false;

  let folderNodeCount = 0;
  for (const [index, event] of events.entries()) {
    const nodeId = vector.nodeIds[index]!;
    const payload = JSON.parse(event.content) as {
      folderCheckpoint?: { cause?: string; sourceNodeId?: string };
    };
    const expected = expectedPropagation.get(nodeId);
    if (!payload.folderCheckpoint) {
      if (expected) return false;
      continue;
    }
    folderNodeCount += 1;
    if (!expected) return false;
    if (payload.folderCheckpoint.cause !== expected.cause) return false;
    if (payload.folderCheckpoint.sourceNodeId !== expected.sourceNodeId) return false;
  }
  return exactMembership && folderNodeCount === expectedPropagation.size;
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

test("the fixed folder corpus identifies its runtime boundary", () => {
  assert.equal(folderCorpus.format, "zine-folder-conformance");
  assert.equal(folderCorpus.version, 1);
  assert.match(folderCorpus.runtimeBoundary, /no independent non-JavaScript folder-chain reader/);
});

test("fixed nested file, folder, and Root chains conform", async () => {
  for (const vector of folderCorpus.fileChains as ChainVector[]) {
    const verdict = await verifyFileTraceChain(eventsFor(vector.nodeIds), verifyEvent);
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
  }
  for (const vector of folderCorpus.folderChains as ChainVector[]) {
    const verdict = await verifyFolderTraceChain(eventsFor(vector.nodeIds), verifyEvent, {
      expectedTraceId: vector.traceId,
    });
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
  }
});

test("every fixed recursive frontier resolves to the exact signed immediate child", () => {
  for (const vector of folderCorpus.folderChains as ChainVector[]) {
    for (const event of eventsFor(vector.nodeIds)) {
      const payload = JSON.parse(event.content) as {
        snapshot: {
          members: Array<{
            kind: "file" | "folder";
            latestNodeId: string;
            contentHash: string;
          }>;
        };
      };
      for (const member of payload.snapshot.members) {
        const child = folderEvents[member.latestNodeId];
        assert.ok(child, `${vector.name}: missing immediate child ${member.latestNodeId}`);
        assert.equal(verifyEvent(child), true, `${vector.name}: invalid child signature`);
        assert.ok(child.tags.some((tag) => tag[0] === "z" && tag[1] === member.kind));
        const childPayload = JSON.parse(child.content) as { contentHash?: string };
        assert.equal(childPayload.contentHash, member.contentHash);
      }
    }
  }
});

test("fixed folder history distinguishes structure changes, child advance, and explicit Step", () => {
  const nested = folderCorpus.folderChains[0] as ChainVector;
  const checkpoints = eventsFor(nested.nodeIds).map((event) => {
    const payload = JSON.parse(event.content) as {
      deltas?: Array<{ type?: string }>;
      folderCheckpoint: { cause: string };
    };
    return {
      cause: payload.folderCheckpoint.cause,
      membership: (payload.deltas ?? [])
        .map((delta) => delta.type)
        .filter((type) => type === "add" || type === "remove" || type === "rename" || type === "advance"),
    };
  });
  assert.deepEqual(checkpoints, [
    { cause: "genesis", membership: [] },
    { cause: "structure-change", membership: ["add"] },
    { cause: "structure-change", membership: ["rename"] },
    { cause: "structure-change", membership: ["remove"] },
    { cause: "structure-change", membership: ["add"] },
    { cause: "structure-change", membership: ["add"] },
    { cause: "child-advance", membership: ["advance"] },
    { cause: "explicit-step", membership: [] },
  ]);
});

test("fixed folder hashes preserve member order and permitted Unicode path bytes", async () => {
  const body = folderCorpus.canonical.folderBody;
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("hex");
  assert.equal(digest, folderCorpus.canonical.folderHash);
  assert.deepEqual(JSON.parse(body).map((entry: unknown[]) => entry[0]), folderCorpus.canonical.memberOrder);
  assert.ok(folderCorpus.canonical.unicodePaths.includes("草稿 e\u0301.md"));
  assert.ok(folderCorpus.canonical.unicodePaths.includes("résumé 📝.md"));
  assert.ok(folderCorpus.canonical.unicodePaths.includes("back\\slash.md"));

  const carryingEvent = Object.values(folderEvents).find((event) => {
    const payload = JSON.parse(event.content) as { contentHash?: string };
    return payload.contentHash === folderCorpus.canonical.folderHash;
  });
  assert.ok(carryingEvent);
  const payload = JSON.parse(carryingEvent.content) as {
    snapshot: { members: Array<{ relativePath: string; latestNodeId: string }> };
  };
  assert.deepEqual(payload.snapshot.members.map((member) => member.relativePath), folderCorpus.canonical.memberOrder);
  assert.deepEqual(
    carryingEvent.tags.filter((tag) => tag[0] === "q").map((tag) => tag[1]),
    payload.snapshot.members.map((member) => member.latestNodeId),
  );
});

test("recursive gesture vectors share one operation id and name every immediate advance", () => {
  for (const vector of folderCorpus.operations as OperationVector[]) {
    assert.equal(operationVectorValid(vector), vector.valid, vector.name);
  }
});

test("fixed structural prefixes stop before the complete ancestor checkpoint set", () => {
  const fixture = folderCorpus.structuralPrefixes;
  assert.match(fixture.scope, /apps\/mcp\/integration\/recursive-checkpoint-recovery\.ts/);

  const requiredNodeIds = new Set(fixture.requiredNodeIds);
  assert.equal(requiredNodeIds.size, fixture.requiredNodeIds.length);
  for (const event of eventsFor(fixture.requiredNodeIds)) {
    assert.equal(verifyEvent(event), true);
    assert.equal(traceOperationIdFromEvent(event), fixture.operationId);
  }
  for (const prefix of fixture.incompleteNodeIdPrefixes) {
    assert.ok(prefix.length < fixture.requiredNodeIds.length, fixture.name);
    assert.deepEqual(prefix, fixture.requiredNodeIds.slice(0, prefix.length), fixture.name);
  }
});

test("malformed fixed folder chains fail closed", async () => {
  for (const vector of folderCorpus.malformedFolderChains as ChainVector[]) {
    const events = eventsFor(vector.nodeIds);
    for (const event of events) {
      assert.equal(verifyEvent(event), true, `${vector.name}: fixture must be signed but semantically malformed`);
    }
    const verdict = await verifyFolderTraceChain(events, verifyEvent);
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
    for (const code of vector.issueCodes) {
      assert.ok(verdict.issues.some((issue) => issue.code === code), `${vector.name}: missing ${code}`);
    }
  }
});

test("folder conformance rejects structural F tags owned by parent membership", async () => {
  const valid = await folderNode([], { version: 1, cause: "genesis" }, "67".repeat(32));
  const invalid = finalizeEvent({
    kind: valid.kind,
    created_at: valid.created_at,
    tags: [...valid.tags, ["F", "alias"]],
    content: valid.content,
  }, FOLDER_TEST_SECRET);
  const verdict = await verifyFolderTraceChain([invalid], verifyEvent);
  assert.equal(verdict.status, "invalid");
  assert.ok(verdict.issues.some((issue) => issue.code === "folder-name-tag"));
});

test("folder conformance rejects malformed recognized deltas and ignores unknown ones", async () => {
  for (const delta of [
    { type: "focus", op: "mount", selection: { kind: "file", path: "a.md" }, panelIndex: 0, timestamp: 1.5 },
    { type: "cite", role: "tag", sourceEventId: "not-an-id", timestamp: 1 },
  ]) {
    const genesis = await folderNode([], { version: 1, cause: "genesis" }, "68".repeat(32), undefined, [delta]);
    const verdict = await verifyFolderTraceChain([genesis], verifyEvent);
    assert.equal(verdict.status, "invalid");
    assert.ok(verdict.issues.some((issue) => issue.code === "nonconforming-deltas"));
  }
  const extensible = await folderNode(
    [], { version: 1, cause: "genesis" }, "69".repeat(32), undefined,
    [{ type: "future-observation", timestamp: 1 }],
  );
  assert.equal((await verifyFolderTraceChain([extensible], verifyEvent)).status, "full");
});

test("folder conformance accepts a valid cite delta and matching q edge", async () => {
  const sourceEventId = "ab".repeat(32);
  const unsignedQ = await folderNode(
    [], { version: 1, cause: "genesis" }, "6a".repeat(32), undefined,
    [{ type: "cite", role: "tag", op: "add", sourceEventId, timestamp: 1 }],
  );
  const cited = finalizeEvent({
    kind: unsignedQ.kind,
    created_at: unsignedQ.created_at,
    tags: [...unsignedQ.tags, ["q", sourceEventId]],
    content: unsignedQ.content,
  }, FOLDER_TEST_SECRET);
  assert.equal((await verifyFolderTraceChain([cited], verifyEvent)).status, "full");
});

test("folder conformance rejects duplicate q targets and invalid citation roles", async () => {
  const first = "ac".repeat(32);
  const second = "ad".repeat(32);
  const base = await folderNode(
    [], { version: 1, cause: "genesis" }, "6b".repeat(32), undefined,
    [first, second].map((sourceEventId) => ({
      type: "cite", role: "tag", op: "add", sourceEventId, timestamp: 1,
    })),
  );
  const duplicate = finalizeEvent({
    kind: base.kind,
    created_at: base.created_at,
    tags: [...base.tags, ["q", first], ["q", first]],
    content: base.content,
  }, FOLDER_TEST_SECRET);
  assert.equal((await verifyFolderTraceChain([duplicate], verifyEvent)).status, "invalid");

  const invalidRemove = await folderNode(
    [], { version: 1, cause: "genesis" }, "6c".repeat(32), undefined,
    [{ type: "cite", role: "inline", op: "remove", sourceEventId: first, timestamp: 1 }],
  );
  assert.equal((await verifyFolderTraceChain([invalidRemove], verifyEvent)).status, "invalid");
});

test("folder conformance rejects a changed child hash without a new child node", async () => {
  const nodeId = "aa".repeat(32);
  const member = {
    kind: "file" as const,
    relativePath: "essay.md",
    latestNodeId: nodeId,
    contentHash: "cc".repeat(32),
  };
  const genesis = await folderNode([member], { version: 1, cause: "genesis" }, "77".repeat(32));
  const impossible = { ...member, contentHash: "dd".repeat(32) };
  const invalid = await folderNode(
    [impossible],
    { version: 1, cause: "child-advance", sourceNodeId: nodeId },
    "88".repeat(32),
    genesis,
    [{
      type: "advance",
      kind: "file",
      relativePath: "essay.md",
      previousNodeId: nodeId,
      nodeId,
      timestamp: 2,
    }],
  );

  const verdict = await verifyFolderTraceChain([genesis, invalid], verifyEvent);
  assert.equal(verdict.status, "invalid");
  assert.ok(verdict.issues.some((issue) => issue.code === "nonconforming-deltas"));
});

test("folder conformance requires remove to pin the removed child head", async () => {
  const member = {
    kind: "file" as const,
    relativePath: "essay.md",
    latestNodeId: "aa".repeat(32),
    contentHash: "cc".repeat(32),
  };
  const genesis = await folderNode([member], { version: 1, cause: "genesis" }, "99".repeat(32));
  const invalid = await folderNode(
    [],
    { version: 1, cause: "structure-change" },
    "aa".repeat(32),
    genesis,
    [{
      type: "remove",
      kind: "file",
      relativePath: "essay.md",
      timestamp: 2,
    }],
  );

  const verdict = await verifyFolderTraceChain([genesis, invalid], verifyEvent);
  assert.equal(verdict.status, "invalid");
  assert.ok(verdict.issues.some((issue) => issue.code === "nonconforming-deltas"));
});

test("folder conformance requires integer timestamps on every membership delta", async () => {
  const member = {
    kind: "file" as const,
    relativePath: "essay.md",
    latestNodeId: "aa".repeat(32),
    contentHash: "cc".repeat(32),
  };

  for (const timestamp of [undefined, "1", 1.5, Number.POSITIVE_INFINITY]) {
    const genesis = await folderNode([], { version: 1, cause: "genesis" }, "bb".repeat(32));
    const invalid = await folderNode(
      [member],
      { version: 1, cause: "structure-change" },
      "cc".repeat(32),
      genesis,
      [{
        type: "add",
        kind: member.kind,
        relativePath: member.relativePath,
        nodeId: member.latestNodeId,
        ...(timestamp === undefined ? {} : { timestamp }),
      }],
    );

    const verdict = await verifyFolderTraceChain([genesis, invalid], verifyEvent);
    assert.equal(verdict.status, "invalid", `timestamp ${String(timestamp)}`);
    assert.ok(
      verdict.issues.some((issue) => issue.code === "nonconforming-deltas"),
      `timestamp ${String(timestamp)}`,
    );
  }
});
