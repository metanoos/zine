import assert from "node:assert/strict";
import test from "node:test";

import folderCorpus from "@zine/protocol/folder-corpus" with { type: "json" };
import {
  traceOperationIdFromEvent,
  type TraceConformanceStatus,
} from "@zine/protocol";
import type { Event } from "nostr-tools";

import {
  verifyFileTraceChain,
  verifyFolderTraceChain,
} from "./trace-conformance.js";

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
    assert.ok(event, `desktop corpus is missing ${nodeId}`);
    return event;
  });
}

test("desktop reads the fixed recursive folder corpus through its protocol wrapper", async () => {
  for (const vector of folderCorpus.fileChains as ChainVector[]) {
    const verdict = await verifyFileTraceChain(chain(vector));
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
  }
  for (const vector of folderCorpus.folderChains as ChainVector[]) {
    const verdict = await verifyFolderTraceChain(chain(vector), {
      expectedTraceId: vector.traceId,
    });
    assert.equal(verdict.status, vector.status, vector.name);
    assert.deepEqual(verdict.steps.map((step) => step.status), vector.stepStatuses, vector.name);
  }
});

test("desktop fails closed on every malformed fixed folder chain", async () => {
  for (const vector of folderCorpus.malformedFolderChains as ChainVector[]) {
    const verdict = await verifyFolderTraceChain(chain(vector));
    assert.equal(verdict.status, "invalid", vector.name);
    for (const code of vector.issueCodes) {
      assert.ok(verdict.issues.some((issue) => issue.code === code), `${vector.name}: missing ${code}`);
    }
  }
});

test("desktop rejects a recursive gesture whose recovery changes operation id", () => {
  for (const vector of folderCorpus.operations) {
    const sameOperation = vector.nodeIds.every(
      (nodeId) => traceOperationIdFromEvent(events[nodeId]!) === vector.operationId,
    );
    assert.equal(sameOperation, vector.valid, vector.name);
  }
});
