import assert from "node:assert/strict";
import test from "node:test";

import { createContextSnapshot } from "./context-snapshot.js";
import {
  PreparedOperationError,
  prepareOperation,
  providerProfileFingerprint,
} from "./prepared-operation.js";
import type { ProviderConfig } from "./models-store.js";

const provider: ProviderConfig = {
  id: "p1",
  label: "Provider",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  modelId: "model-1",
  credentialRef: "model:provider:p1:api-key",
  credentialConfigured: true,
};

function snapshot(options: { sourceUnstepped?: boolean; failure?: boolean } = {}) {
  return createContextSnapshot({
    target: {
      kind: "file", folderId: "folder", path: "draft.md", traceId: "trace",
      headId: "head", body: "draft body",
    },
    mount: { kind: "folder", path: "" },
    shields: [],
    inputs: [
      { path: "draft.md", traceId: "trace", headId: "head", body: "draft body", citations: [], deltaLog: [], unstepped: false },
      { path: "source.md", traceId: "source", headId: options.sourceUnstepped ? null : "source-head", body: "source", citations: [], deltaLog: [], unstepped: options.sourceUnstepped ?? false },
    ],
    renderedBlock: "=== CONTEXT ===\nsource\n=== END CONTEXT ===",
    failures: options.failure ? [{ stage: "chain", path: "source.md", message: "missing" }] : [],
  });
}

test("prepared operation freezes the exact provider-adjusted messages and metadata", () => {
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: { seed: "continue", hasSelection: false },
    contextSnapshot: snapshot(),
    provider: { ...provider, personality: "friendly" },
    modelVoicePubkey: "a".repeat(64),
    voicePrompt: "Use short sentences.",
    lensId: "default",
    dirtyTarget: false,
    requestId: "request-1",
    createdAt: 1,
  });
  assert.equal(prepared.messages[0].role, "system");
  assert.match(prepared.messages[0].content, /warm, approachable/);
  assert.match(prepared.messages.at(-1)?.content ?? "", /=== CONTEXT ===/);
  assert.equal(Object.isFrozen(prepared), true);
  assert.equal(Object.isFrozen(prepared.messages), true);
  assert.equal(prepared.targetRevision.headId, "head");
  assert.equal(prepared.contextFingerprint, prepared.contextSnapshot.fingerprint);
});

test("provider fingerprint changes for transport-affecting profile edits, never credential bytes", () => {
  assert.notEqual(
    providerProfileFingerprint(provider),
    providerProfileFingerprint({ ...provider, modelId: "model-2" }),
  );
  assert.doesNotMatch(providerProfileFingerprint(provider), /api-key/);
});

test("dirty targets, unstepped mounts, incomplete gather, and oversize all block preparation", () => {
  const base = {
    operation: "extend" as const,
    operationInputs: { seed: "x", hasSelection: false },
    provider,
    modelVoicePubkey: "a".repeat(64),
    voicePrompt: "",
    lensId: "default" as const,
  };
  assert.throws(
    () => prepareOperation({ ...base, contextSnapshot: snapshot(), dirtyTarget: true }),
    (error: unknown) => error instanceof PreparedOperationError && /unstepped changes/.test(error.message),
  );
  assert.throws(
    () => prepareOperation({ ...base, contextSnapshot: snapshot({ sourceUnstepped: true }), dirtyTarget: false }),
    /mounted inputs need Step: source.md/,
  );
  assert.throws(
    () => prepareOperation({ ...base, contextSnapshot: snapshot({ failure: true }), dirtyTarget: false }),
    /Context is incomplete/,
  );
  assert.throws(
    () => prepareOperation({ ...base, contextSnapshot: snapshot(), dirtyTarget: false, maxBytes: 8 }),
    /Prepared request exceeds/,
  );
});
