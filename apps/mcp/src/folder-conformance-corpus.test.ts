import assert from "node:assert/strict";
import test from "node:test";

import folderCorpus from "../../../packages/protocol/corpus/folder-conformance-v1.json" with { type: "json" };
import {
  traceOperationIdFromEvent,
  verifyFolderTraceChain,
  type TraceConformanceStatus,
} from "../../../packages/protocol/src/index.js";
import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

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

const events = folderCorpus.events as Record<string, Event>;

function chain(vector: { nodeIds: string[] }): Event[] {
  return vector.nodeIds.map((nodeId) => {
    const event = events[nodeId];
    assert.ok(event, `MCP corpus is missing ${nodeId}`);
    assert.equal(event.id, nodeId, `MCP corpus key does not match signed id ${nodeId}`);
    return event;
  });
}

function operationVectorValid(vector: OperationVector): boolean {
  const operationEvents = chain(vector);
  const requiredNodeIds = new Set(vector.requiredNodeIds);
  const exactMembership =
    new Set(vector.nodeIds).size === vector.nodeIds.length &&
    requiredNodeIds.size === vector.requiredNodeIds.length &&
    vector.nodeIds.length === vector.requiredNodeIds.length &&
    vector.nodeIds.every((nodeId) => requiredNodeIds.has(nodeId));
  if (operationEvents.some((event) => !verifyEvent(event))) return false;
  if (operationEvents.some((event) => traceOperationIdFromEvent(event) !== vector.operationId)) return false;

  const expectedPropagation = new Map(
    vector.propagation.map((expected) => [expected.nodeId, expected]),
  );
  if (expectedPropagation.size !== vector.propagation.length) return false;

  let folderNodeCount = 0;
  for (const [index, event] of operationEvents.entries()) {
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

test("MCP reads the fixed recursive folder corpus through its direct kernel source dependency", async () => {
  // This is package-boundary parity, not a claim of an independent runtime:
  // desktop and MCP are both TypeScript consumers of the same protocol kernel.
  // MCP's build aliases @zine/protocol to this source tree rather than installing
  // a second implementation, so this test follows that exact boundary.
  assert.match(folderCorpus.runtimeBoundary, /no independent non-JavaScript folder-chain reader/);
  for (const vector of folderCorpus.folderChains as ChainVector[]) {
    const verdict = await verifyFolderTraceChain(chain(vector), verifyEvent, {
      expectedTraceId: vector.traceId,
    });
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
  }
});

test("MCP enforces exact recursive operation membership and propagation", () => {
  for (const vector of folderCorpus.operations as OperationVector[]) {
    assert.equal(operationVectorValid(vector), vector.valid, vector.name);
  }
});

test("MCP fails closed on every malformed fixed folder chain", async () => {
  for (const vector of folderCorpus.malformedFolderChains as ChainVector[]) {
    const verdict = await verifyFolderTraceChain(chain(vector), verifyEvent);
    assert.equal(verdict.status, "invalid", vector.name);
    for (const code of vector.issueCodes) {
      assert.ok(verdict.issues.some((issue) => issue.code === code), `${vector.name}: missing ${code}`);
    }
  }
});
