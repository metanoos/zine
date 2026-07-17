import assert from "node:assert/strict";
import test from "node:test";

import { createContextSnapshot } from "./context-snapshot.js";
import { completePrepared, probeProvider } from "./llm.js";
import type { ProviderConfig } from "./models-store.js";
import { prepareOperation } from "./prepared-operation.js";
import { putSecret } from "./secret-store.js";

let requestBody: Record<string, unknown> | null = null;
// @ts-expect-error recording fetch fixture
globalThis.fetch = async (_url: string, init: RequestInit) => {
  requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
  };
};

const provider: ProviderConfig = {
  id: "prepared-provider",
  label: "Prepared",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  modelId: "model-1",
  credentialRef: "model:test:prepared",
  credentialConfigured: true,
};
await putSecret(provider.credentialRef, new TextEncoder().encode("sk-recording"));

const context = createContextSnapshot({
  target: {
    kind: "file", folderId: "folder", path: "draft.md", traceId: "trace",
    headId: "head", body: "draft",
  },
  mounts: [],
  shields: [],
  inputs: [{
    path: "draft.md", traceId: "trace", headId: "head", body: "draft",
    citations: [], deltaLog: [], unstepped: false,
  }],
  renderedBlock: "=== CONTEXT ===\nsecret workspace marker\n=== END CONTEXT ===",
});

test("recording transport receives byte-identical approved messages", async () => {
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: { seed: "seed", hasSelection: false },
    contextSnapshot: context,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    focusFingerprint: "focus:draft.md@0",
    dirtyTarget: false,
    requestId: "recording-request",
    createdAt: 1,
  });
  await completePrepared(prepared, provider);
  assert.deepEqual(requestBody?.messages, prepared.messages);
});

test("provider edits invalidate approval before transport", async () => {
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: { seed: "seed", hasSelection: false },
    contextSnapshot: context,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    focusFingerprint: "focus:draft.md@0",
    dirtyTarget: false,
  });
  await assert.rejects(
    completePrepared(prepared, { ...provider, modelId: "changed" }),
    /changed after prompt approval/,
  );
});

test("neutral provider probe never includes workspace context", async () => {
  await probeProvider(provider);
  assert.doesNotMatch(JSON.stringify(requestBody), /secret workspace marker|=== CONTEXT ===/);
  assert.match(JSON.stringify(requestBody), /Connection probe/);
});
