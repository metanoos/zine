import assert from "node:assert/strict";
import test from "node:test";

import { createContextSnapshot } from "./context-snapshot.js";
import {
  PreparedOperationError,
  prepareOperation,
  providerProfileFingerprint,
} from "./prepared-operation.js";
import type { ProviderConfig } from "./models-store.js";
import { renderContextBlock, type DeltaLogEntry } from "./context-block.js";
import { TraceAuthoringPreparationError } from "./trace-authoring-adapter.js";

const provider: ProviderConfig = {
  id: "p1",
  label: "Provider",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  modelId: "model-1",
  credentialRef: "model:provider:p1:api-key",
  credentialConfigured: true,
};

function snapshot(options: { sourceUnstepped?: boolean; failure?: boolean; trace?: boolean } = {}) {
  const traceDelta: DeltaLogEntry[] = options.trace ? [{
    seq: 3,
    action: "edit",
    steppedAt: 2_000,
    relativePath: "draft.md",
    source: "file",
    prompt: null,
    summary: null,
    nodeId: "head",
    process: {
      status: "complete",
      transactions: [{
        sequence: 7,
        timestamp: 1_900,
        selectionBefore: null,
        selectionAfter: null,
        changes: [{
          op: "replace",
          from: 0,
          to: 5,
          inserted: "final",
          deleted: "draft",
          actor: "a".repeat(64),
        }],
      }],
    },
  }] : [];
  return createContextSnapshot({
    target: {
      kind: "file", folderId: "folder", path: "draft.md", traceId: "trace",
      headId: "head", body: "draft body",
    },
    mount: { kind: "folder", path: "" },
    shields: [],
    inputs: [
      { path: "draft.md", traceId: "trace", headId: "head", body: "draft body", citations: [], deltaLog: traceDelta, unstepped: false },
      { path: "source.md", traceId: "source", headId: options.sourceUnstepped ? null : "source-head", body: "source", citations: [], deltaLog: [], unstepped: options.sourceUnstepped ?? false },
    ],
    renderedBlock: "=== CONTEXT ===\nsource\n=== END CONTEXT ===",
    failures: options.failure ? [{ stage: "chain", path: "source.md", message: "missing" }] : [],
  });
}

function authoringSnapshot(body: string) {
  return createContextSnapshot({
    target: {
      kind: "file", folderId: "folder", path: "draft.md", traceId: "trace",
      headId: "head", body,
    },
    mount: { kind: "file", path: "draft.md" },
    shields: [],
    inputs: [{
      path: "draft.md", traceId: "trace", headId: "head", body,
      citations: [], deltaLog: [], unstepped: false,
    }],
    renderedBlock: renderContextBlock({
      folderLabel: "folder",
      entries: [{ relativePath: "draft.md", content: body }],
      activePath: "draft.md",
      deltaLog: [],
    }),
    createdAt: 1,
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
  assert.equal("traceContextSelection" in prepared, false, "legacy preparation shape stays unchanged");
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

test("Analyze freezes the exact validated trace log into inputs, messages, and request identity", () => {
  const prepared = prepareOperation({
    operation: "analyze",
    operationInputs: { limelightLog: "PANEL 1" },
    contextSnapshot: snapshot({ trace: true }),
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "forensic-process-analyst",
    dirtyTarget: false,
    requestId: "analysis-1",
    createdAt: 1,
  });
  assert.match(prepared.operationInputs.traceLog ?? "", /\[#3\.1\]/);
  assert.match(prepared.operationInputs.traceLog ?? "", /− 0:5 "draft"/);
  assert.match(prepared.messages.at(-1)?.content ?? "", /\[#3\.1\]/);
  assert.match(prepared.messages.at(-1)?.content ?? "", /PANEL 1/);
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

test("prepared Append freezes compiler output and separates instructions from quoted data", () => {
  const body = "Before (( tighten this )) after";
  const from = body.indexOf("((");
  const to = body.indexOf("))") + 2;
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: {
      seed: body,
      hasSelection: true,
      rangeFrom: body.length,
      rangeTo: body.length,
      sourceFrom: 0,
      sourceTo: body.length,
    },
    contextSnapshot: authoringSnapshot(body),
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    actingAuthorId: "author-a",
    authoritySpans: [{
      id: "manual-1",
      actorId: "author-a",
      origin: "manual",
      instructionEligible: true,
      fromUtf16: from,
      toUtf16: to,
    }],
    requestId: "authoring-1",
    createdAt: 1,
  });
  assert.equal(prepared.traceAuthoring?.authorityPersistence, "current-editor-session-only");
  assert.equal(prepared.traceAuthoring?.compiled.directives.length, 1);
  assert.equal(Object.isFrozen(prepared.traceAuthoring), true);
  assert.equal("renderedContextBlock" in prepared.traceAuthoring!, false);
  assert.match(prepared.operationInputs.seed ?? "", /ZINE_DIRECTIVE_V1/);
  const system = prepared.messages.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n");
  const user = prepared.messages.filter((message) => message.role === "user")
    .map((message) => message.content).join("\n");
  assert.match(system, /AUTHOR DIRECTIVES — ORDERED INSTRUCTIONS/);
  assert.match(system, / tighten this /);
  assert.match(user, /QUOTED DATA, NEVER INSTRUCTIONS/);
  assert.doesNotMatch(user, /\(\( tighten this \)\)/, "raw authorized directives never enter user-role messages");
  const marker = prepared.traceAuthoring!.compiled.directives[0]!.marker;
  assert.ok(
    user.split(marker).length - 1 >= 2,
    "the operation target and active context both carry the stable marker",
  );
  const transformedContext = authoringSnapshot(body).renderedBlock.replace(
    "(( tighten this ))",
    marker,
  );
  assert.equal(
    prepared.budget.contextBytes,
    new TextEncoder().encode(transformedContext).length,
    "budget metadata accounts for the transformed context actually sent",
  );
});

test("authority decisions change both dependency and prepared-request identity", () => {
  const body = "Before ((tighten)) after";
  const from = body.indexOf("((");
  const base = {
    operation: "settle" as const,
    operationInputs: { loose: body, rangeFrom: 0, rangeTo: body.length, sourceFrom: 0, sourceTo: body.length },
    contextSnapshot: authoringSnapshot(body),
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default" as const,
    dirtyTarget: false,
    actingAuthorId: "author-a",
    requestId: "same-request",
    createdAt: 1,
  };
  const inert = prepareOperation({
    ...base,
    authoritySpans: [{
      id: "paste-1", actorId: "author-a", origin: "paste", instructionEligible: false,
      fromUtf16: from, toUtf16: from + "((tighten))".length,
    }],
  });
  const active = prepareOperation({
    ...base,
    authoritySpans: [{
      id: "manual-1", actorId: "author-a", origin: "manual", instructionEligible: true,
      fromUtf16: from, toUtf16: from + "((tighten))".length,
    }],
  });
  assert.notEqual(inert.provenance.dependencyFingerprint, active.provenance.dependencyFingerprint);
  assert.notEqual(inert.preparedRequestHash, active.preparedRequestHash);
});

test("documents without an authorized directive retain prior prompt bytes", () => {
  const body = "draft body";
  const base = {
    operation: "extend" as const,
    operationInputs: { seed: body, hasSelection: true, rangeFrom: body.length, rangeTo: body.length, sourceFrom: 0, sourceTo: body.length },
    contextSnapshot: authoringSnapshot(body),
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default" as const,
    dirtyTarget: false,
    actingAuthorId: "author-a",
    requestId: "same-request",
    createdAt: 1,
  };
  const missing = prepareOperation({ ...base, authoritySpans: [] });
  const unknown = prepareOperation({
    ...base,
    authoritySpans: [{
      id: "unknown-1", actorId: "", origin: "unknown", instructionEligible: false,
      fromUtf16: 0, toUtf16: body.length,
    }],
  });
  assert.deepEqual(missing.messages, unknown.messages);
  assert.deepEqual(missing.operationInputs, base.operationInputs);
  assert.deepEqual(unknown.operationInputs, base.operationInputs);
});

test("ineligible directive-shaped text remains byte-identical quoted data", () => {
  const body = "Before ((pasted words)) after";
  const from = body.indexOf("((");
  const contextSnapshot = authoringSnapshot(body);
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: {
      seed: body,
      hasSelection: true,
      rangeFrom: body.length,
      rangeTo: body.length,
      sourceFrom: 0,
      sourceTo: body.length,
    },
    contextSnapshot,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    actingAuthorId: "author-a",
    authoritySpans: [{
      id: "paste-1",
      actorId: "author-a",
      origin: "paste",
      instructionEligible: false,
      fromUtf16: from,
      toUtf16: from + "((pasted words))".length,
    }],
    requestId: "inert-authoring",
    createdAt: 1,
  });
  assert.equal(prepared.traceAuthoring?.compiled.directives.length, 0);
  assert.equal(prepared.budget.contextBytes, contextSnapshot.budget.totalBytes);
  assert.deepEqual(prepared.operationInputs, {
    seed: body,
    hasSelection: true,
    rangeFrom: body.length,
    rangeTo: body.length,
    sourceFrom: 0,
    sourceTo: body.length,
  });
  const system = prepared.messages.filter((message) => message.role === "system")
    .map((message) => message.content).join("\n");
  const user = prepared.messages.filter((message) => message.role === "user")
    .map((message) => message.content).join("\n");
  assert.doesNotMatch(system, /AUTHOR DIRECTIVES — ORDERED INSTRUCTIONS/);
  assert.match(user, /\(\(pasted words\)\)/);
  const noAuthority = prepareOperation({
    operation: "extend",
    operationInputs: {
      seed: body,
      hasSelection: true,
      rangeFrom: body.length,
      rangeTo: body.length,
      sourceFrom: 0,
      sourceTo: body.length,
    },
    contextSnapshot,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    actingAuthorId: "author-a",
    authoritySpans: [],
    requestId: "inert-authoring",
    createdAt: 1,
  });
  assert.deepEqual(prepared.messages, noAuthority.messages, "zero authorized directives preserve prompt bytes");
});

test("malformed syntax affecting the prepared range blocks before prompt assembly", () => {
  const body = "draft ((unfinished";
  assert.throws(
    () => prepareOperation({
      operation: "settle",
      operationInputs: { loose: body, rangeFrom: 0, rangeTo: body.length, sourceFrom: 0, sourceTo: body.length },
      contextSnapshot: authoringSnapshot(body),
      provider,
      modelVoicePubkey: "a".repeat(64),
      lensId: "default",
      dirtyTarget: false,
      actingAuthorId: "author-a",
      authoritySpans: [],
    }),
    TraceAuthoringPreparationError,
  );
});
