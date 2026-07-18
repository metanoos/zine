import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

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

const folderEvents = folderCorpus.events as Record<string, Event>;

function eventsFor(nodeIds: readonly string[]): Event[] {
  return nodeIds.map((nodeId) => {
    const event = folderEvents[nodeId];
    assert.ok(event, `folder corpus is missing ${nodeId}`);
    return event;
  });
}

function operationVectorValid(vector: (typeof folderCorpus.operations)[number]): boolean {
  const events = eventsFor(vector.nodeIds);
  if (new Set(vector.nodeIds).size !== vector.nodeIds.length) return false;
  if (events.some((event) => !verifyEvent(event))) return false;
  if (events.some((event) => traceOperationIdFromEvent(event) !== vector.operationId)) return false;
  for (const expected of vector.propagation) {
    const event = folderEvents[expected.nodeId];
    if (!event) return false;
    const payload = JSON.parse(event.content) as {
      folderCheckpoint?: { cause?: string; sourceNodeId?: string };
    };
    if (payload.folderCheckpoint?.cause !== expected.cause) return false;
    if (payload.folderCheckpoint?.sourceNodeId !== expected.sourceNodeId) return false;
  }
  return vector.requiredNodeIds.every((nodeId) => vector.nodeIds.includes(nodeId));
}

function recoveryState(nodeIds: readonly string[]): "complete" | "incomplete" | "invalid" {
  const expected = folderCorpus.recovery;
  const required = new Set(expected.requiredNodeIds);
  if (
    new Set(nodeIds).size !== nodeIds.length ||
    nodeIds.some((nodeId) => !required.has(nodeId)) ||
    eventsFor(nodeIds).some((event) => traceOperationIdFromEvent(event) !== expected.operationId)
  ) return "invalid";
  return nodeIds.length === required.size ? "complete" : "incomplete";
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
  for (const vector of folderCorpus.operations) {
    assert.equal(operationVectorValid(vector), vector.valid, vector.name);
  }
});

test("recovery prefixes remain incomplete until every required ancestor checkpoint exists", () => {
  assert.deepEqual(
    folderCorpus.recovery.prefixes.map((prefix) => recoveryState(prefix)),
    folderCorpus.recovery.states,
  );
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
