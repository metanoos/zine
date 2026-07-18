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

const events = folderCorpus.events as Record<string, Event>;

function chain(vector: ChainVector): Event[] {
  return vector.nodeIds.map((nodeId) => {
    const event = events[nodeId];
    assert.ok(event, `MCP corpus is missing ${nodeId}`);
    return event;
  });
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

test("MCP rejects a recursive gesture whose recovery changes operation id", () => {
  for (const vector of folderCorpus.operations) {
    const sameOperation = vector.nodeIds.every(
      (nodeId) => traceOperationIdFromEvent(events[nodeId]!) === vector.operationId,
    );
    assert.equal(sameOperation, vector.valid, vector.name);
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
