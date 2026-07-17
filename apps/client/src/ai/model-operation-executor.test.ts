import assert from "node:assert/strict";
import test from "node:test";

import type { PreparedOperation } from "./prepared-operation.js";
import type { ProviderConfig } from "./models-store.js";
import {
  executePreparedOperation,
  prepareOperationBatch,
  type CurrentModelTarget,
} from "./model-operation-executor.js";

const provider = { id: "provider-1" } as ProviderConfig;

function fixture(operation: PreparedOperation["operation"] = "extend"): PreparedOperation {
  const targetRevision = {
    folderId: "folder-1",
    path: "draft.md",
    traceId: "trace-1",
    headId: "head-1",
    contentHash: "content-1",
  };
  return Object.freeze({
    version: 1,
    requestId: `request-${operation}`,
    operation,
    operationInputs: Object.freeze({}),
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: "context-1",
    messages: Object.freeze([{ role: "user" as const, content: operation }]),
    providerId: provider.id,
    providerFingerprint: "provider-fingerprint",
    targetRevision,
    provenance: Object.freeze({
      modelVoicePubkey: "model-voice",
      lensId: "default" as const,
      voicePromptHash: "voice-prompt",
      dependencyFingerprint: `dependency-${operation}`,
    }),
    budget: Object.freeze({
      maxBytes: 1000,
      totalBytes: 100,
      estimatedTokens: 25,
      contextBytes: 50,
      promptLayerBytes: 50,
    }),
    preparedRequestHash: `prepared-${operation}`,
    createdAt: 1,
  });
}

function current(prepared: PreparedOperation): CurrentModelTarget {
  return { ...prepared.targetRevision, focused: true };
}

for (const operation of ["extend", "settle", "stir", "reply", "analyze"] as const) {
  test(`${operation} buffers, revalidates, and applies once`, async () => {
    const prepared = fixture(operation);
    const applied: string[] = [];
    const result = await executePreparedOperation({
      prepared,
      provider,
      maxTokens: 100,
      readCurrentTarget: () => current(prepared),
      complete: async () => `${operation}-response`,
      apply: (response) => { applied.push(response); },
    });
    assert.equal(result.status, "applied");
    assert.deepEqual(applied, [`${operation}-response`]);
  });
}

test("a focus or revision change stores recovery and never mutates", async () => {
  const prepared = fixture();
  let reads = 0;
  const recoveries: string[] = [];
  const result = await executePreparedOperation({
    prepared,
    provider,
    maxTokens: 100,
    readCurrentTarget: () => reads++ === 0
      ? current(prepared)
      : { ...current(prepared), contentHash: "changed" },
    complete: async () => "valuable late response",
    apply: () => assert.fail("stale response must not apply"),
    onStale: (recovery) => { recoveries.push(recovery.response); },
  });
  assert.equal(result.status, "stale");
  assert.deepEqual(recoveries, ["valuable late response"]);
});

test("cancelled transport never applies", async () => {
  const prepared = fixture();
  const controller = new AbortController();
  const result = await executePreparedOperation({
    prepared,
    provider,
    maxTokens: 100,
    signal: controller.signal,
    readCurrentTarget: () => current(prepared),
    complete: async () => {
      controller.abort();
      return "ignored";
    },
    apply: () => assert.fail("cancelled response must not apply"),
  });
  assert.equal(result.status, "cancelled");
});

test("multi-call batches freeze order, target, and total budget", () => {
  const first = fixture("settle");
  const second = { ...fixture("settle"), requestId: "request-settle-2", preparedRequestHash: "prepared-settle-2" };
  const batch = prepareOperationBatch([first, second]);
  assert.deepEqual(batch.children.map((child) => child.requestId), ["request-settle", "request-settle-2"]);
  assert.equal(batch.totalBudgetBytes, 200);
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.children), true);
});
