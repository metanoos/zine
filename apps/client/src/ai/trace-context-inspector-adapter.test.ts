import assert from "node:assert/strict";
import test from "node:test";

import { renderContextBlock, type DeltaLogEntry } from "./context-block.js";
import { createContextSnapshot } from "./context-snapshot.js";
import type { ProviderConfig } from "./models-store.js";
import { prepareOperation } from "./prepared-operation.js";
import { adaptPreparedOperationForTraceContextInspector } from "./trace-context-inspector-adapter.js";

const provider: ProviderConfig = {
  id: "provider-private-card",
  label: "Provider private card",
  protocol: "openai",
  baseUrl: "https://provider.invalid/v1",
  modelId: "private-model-id",
  credentialRef: "model:provider:private:api-key",
  credentialConfigured: true,
  instructions: "PRIVATE PROVIDER INSTRUCTION",
};

function fullTraceRows(): readonly DeltaLogEntry[] {
  return [
    {
      seq: 1,
      action: "edit",
      steppedAt: 1_000,
      relativePath: "draft.md",
      source: "file",
      prompt: null,
      summary: null,
      nodeId: "node-full",
      conformance: "full",
      process: {
        status: "complete",
        transactions: [{
          sequence: 3,
          timestamp: 900,
          actor: "a".repeat(64),
          selectionBefore: null,
          selectionAfter: null,
          changes: [{
            op: "replace",
            from: 0,
            to: 5,
            inserted: "clear",
            deleted: "rough",
            actor: "a".repeat(64),
          }],
        }],
      },
    },
    {
      seq: 2,
      action: "edit",
      steppedAt: 2_000,
      relativePath: "draft.md",
      source: "file",
      prompt: null,
      summary: null,
      nodeId: "node-snapshot",
      conformance: "snapshot-only",
      process: {
        status: "invalid",
        transactions: [],
        reason: "editor transactions do not reproduce the snapshot",
      },
    },
  ];
}

function makeSnapshot(body: string, deltaLog: readonly DeltaLogEntry[] = fullTraceRows()) {
  const renderedBlock = renderContextBlock({
    folderLabel: "folder-1",
    entries: [{ relativePath: "draft.md", content: body }],
    activePath: "draft.md",
    deltaLog: [...deltaLog],
  });
  return createContextSnapshot({
    target: {
      kind: "file",
      folderId: "folder-1",
      path: "draft.md",
      traceId: "trace-1",
      headId: "head-1",
      body,
    },
    mount: { kind: "folder", path: "" },
    shields: [
      { path: "draft.md", decision: "included", boundary: null },
      { path: "private.md", decision: "shielded", boundary: "private.md" },
      { path: "elsewhere.md", decision: "outside-mount", boundary: null },
    ],
    inputs: [{
      path: "draft.md",
      traceId: "trace-1",
      headId: "head-1",
      body,
      citations: [],
      deltaLog,
      unstepped: false,
    }],
    renderedBlock,
    maxBytes: 8_192,
    createdAt: 1,
  });
}

test("adapts only frozen bounded-context, authoring, and trace-row facts", () => {
  const inRange = "[[keep exact]] ((tighten this)) and ((quoted request))";
  const body = `${inRange}\n\noutside ((unfinished`;
  const manualFrom = body.indexOf("((tighten this))");
  const pastedFrom = body.indexOf("((quoted request))");
  const snapshot = makeSnapshot(body);
  const prepared = prepareOperation({
    operation: "settle",
    operationInputs: {
      loose: inRange,
      rangeFrom: 0,
      rangeTo: inRange.length,
      sourceFrom: 0,
      sourceTo: inRange.length,
    },
    contextSnapshot: snapshot,
    provider,
    modelVoicePubkey: "b".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    actingAuthorId: "author-a",
    authoritySpans: [
      {
        id: "manual-1",
        actorId: "author-a",
        origin: "manual",
        instructionEligible: true,
        fromUtf16: manualFrom,
        toUtf16: manualFrom + "((tighten this))".length,
      },
      {
        id: "paste-1",
        actorId: "author-a",
        origin: "paste",
        instructionEligible: false,
        fromUtf16: pastedFrom,
        toUtf16: pastedFrom + "((quoted request))".length,
      },
    ],
    requestId: "request-inspector",
    createdAt: 1,
  });

  const presentation = adaptPreparedOperationForTraceContextInspector(prepared);

  assert.equal(presentation.policy, "bounded-trace-v1");
  assert.equal(presentation.operation, "settle");
  assert.deepEqual(presentation.targetRevision, {
    traceId: "trace-1",
    headId: "head-1",
    contentHash: snapshot.target.contentHash,
    displayPath: "draft.md",
    operationRange: { fromUtf16: 0, toUtf16: inRange.length },
  });
  assert.equal(presentation.directives.length, 1);
  assert.equal(presentation.directives[0]?.displayInstruction, "tighten this");
  assert.equal(presentation.directives[0]?.state, "pending");
  assert.equal(presentation.directives[0]?.consumptionReceiptLabel, undefined);
  assert.equal(presentation.directives[0]?.canExclude, false);
  assert.equal(presentation.directives[0]?.canReactivate, false);
  assert.deepEqual(presentation.protectedRanges.map((item) => item.displayText), ["[[keep exact]]"]);
  assert.deepEqual(presentation.inertDirectives.map((item) => item.reason), ["ineligible-authority"]);
  assert.equal(presentation.inertDirectives[0]?.displayCandidate, "((quoted request))");
  assert.equal(presentation.inertDirectives[0]?.canPromote, false);
  assert.deepEqual(
    presentation.compilationErrors.map((item) => item.code),
    ["UNTERMINATED_DIRECTIVE"],
  );

  assert.equal(presentation.selectedEvidence.length, 2);
  assert.match(presentation.selectedEvidence[0]?.displayClaim ?? "", /FULL TRACE/);
  assert.match(presentation.selectedEvidence[0]?.displayClaim ?? "", /trace 1 transactions \/ 1 ranges/);
  assert.match(presentation.selectedEvidence[1]?.displayClaim ?? "", /SNAPSHOT ONLY/);
  assert.match(presentation.selectedEvidence[1]?.displayClaim ?? "", /snapshot only/);
  assert.equal(presentation.selectedEvidence[0]?.byteCostLabel, "source record bytes");
  assert.match(
    presentation.selectedEvidence[0]?.selectionReasons.join(" ") ?? "",
    /exact prepared-operation context total/,
  );
  assert.deepEqual(
    presentation.excludedEvidence.map((item) => [item.displayLabel, item.count]),
    [
      ["Paths behind an explicit context shield", 1],
      ["Paths outside the active context mount", 1],
    ],
  );

  assert.equal(presentation.metadata.budget.usedContextBytes, prepared.budget.contextBytes);
  assert.equal(presentation.metadata.budget.effectiveContextBytes, snapshot.budget.maxBytes);
  assert.equal(presentation.metadata.budget.truncated, false);
  assert.equal(presentation.metadata.fingerprint, snapshot.fingerprint);
  assert.match(presentation.metadata.versions.compiler, /trace-authoring-adapter:v1\/kernel:v1/);
  assert.equal(
    presentation.metadata.versions.selector,
    "context-snapshot:v1/bounded-chronological",
  );
  assert.doesNotMatch(presentation.metadata.versions.selector, /selected/i);
  assert.ok(Object.isFrozen(presentation));
  assert.ok(Object.isFrozen(presentation.selectedEvidence));

  const serialized = JSON.stringify(presentation);
  assert.doesNotMatch(serialized, /PRIVATE PROVIDER INSTRUCTION|private-model-id|api-key/);
  assert.doesNotMatch(serialized, /consumptionReceipt|cleanupStatus/);
});

test("non-authoring operations show exact whole-target scope without inventing compiler output", () => {
  const body = "Current source document.";
  const snapshot = makeSnapshot(body, []);
  const prepared = prepareOperation({
    operation: "analyze",
    operationInputs: { limelightLog: "" },
    contextSnapshot: snapshot,
    provider,
    modelVoicePubkey: "b".repeat(64),
    lensId: "forensic-process-analyst",
    dirtyTarget: false,
    requestId: "request-analyze-inspector",
    createdAt: 1,
  });

  const presentation = adaptPreparedOperationForTraceContextInspector(prepared);
  assert.equal(prepared.traceAuthoring, null);
  assert.deepEqual(
    presentation.targetRevision.operationRange,
    { fromUtf16: 0, toUtf16: body.length },
  );
  assert.deepEqual(presentation.directives, []);
  assert.deepEqual(presentation.protectedRanges, []);
  assert.deepEqual(presentation.inertDirectives, []);
  assert.deepEqual(presentation.compilationErrors, []);
  assert.equal(presentation.metadata.versions.compiler, "not-applied:analyze");
  assert.equal(presentation.policy, "bounded-trace-v1");
});

test("Inspector includes folder evidence for a removed path absent from current inputs", () => {
  const body = "Current source document.";
  const removed: DeltaLogEntry = {
    seq: 1,
    action: "remove",
    steppedAt: 3_000,
    relativePath: "removed.md",
    source: "folder",
    prompt: null,
    summary: null,
    nodeId: "folder-node-remove",
  };
  const renderedBlock = renderContextBlock({
    folderLabel: "folder-1",
    entries: [{ relativePath: "draft.md", content: body }],
    activePath: "draft.md",
    deltaLog: [removed],
  });
  const snapshot = createContextSnapshot({
    target: {
      kind: "file",
      folderId: "folder-1",
      path: "draft.md",
      traceId: "trace-1",
      headId: "head-1",
      body,
    },
    mount: { kind: "folder", path: "" },
    shields: [{ path: "draft.md", decision: "included", boundary: null }],
    inputs: [{
      path: "draft.md",
      traceId: "trace-1",
      headId: "head-1",
      body,
      citations: [],
      deltaLog: [],
      unstepped: false,
    }],
    deltaLog: [removed],
    renderedBlock,
    maxBytes: 8_192,
    createdAt: 1,
  });
  const prepared = prepareOperation({
    operation: "analyze",
    operationInputs: { limelightLog: "" },
    contextSnapshot: snapshot,
    provider,
    modelVoicePubkey: "b".repeat(64),
    lensId: "forensic-process-analyst",
    dirtyTarget: false,
    requestId: "request-orphan-folder-row",
    createdAt: 1,
  });

  assert.match(prepared.messages.map((message) => message.content).join("\n"), /removed\.md/);
  const presentation = adaptPreparedOperationForTraceContextInspector(prepared);
  assert.equal(presentation.selectedEvidence.length, 1);
  assert.match(presentation.selectedEvidence[0]?.displayClaim ?? "", /Folder trace row #1.*remove.*removed\.md/);
  assert.equal(presentation.selectedEvidence[0]?.scope, "folder");
  assert.equal(presentation.selectedEvidence[0]?.source.traceId, undefined);
  assert.equal(presentation.selectedEvidence[0]?.source.headId, undefined);
});

test("folder deltas sharing one signed node retain unique identities and honest scope", () => {
  const body = "Current source document.";
  const rows: DeltaLogEntry[] = [
    {
      seq: 1,
      action: "remove",
      steppedAt: 3_000,
      relativePath: "removed.md",
      source: "folder",
      prompt: null,
      summary: null,
      nodeId: "folder-node-shared",
    },
    {
      seq: 2,
      action: "rename",
      steppedAt: 3_000,
      fromPath: "old.md",
      relativePath: "new.md",
      source: "folder",
      prompt: null,
      summary: null,
      nodeId: "folder-node-shared",
    },
  ];
  const snapshot = createContextSnapshot({
    target: {
      kind: "file", folderId: "folder-1", path: "draft.md", traceId: "trace-1",
      headId: "head-1", body,
    },
    mount: { kind: "folder", path: "" },
    shields: [{ path: "draft.md", decision: "included", boundary: null }],
    inputs: [{
      path: "draft.md", traceId: "trace-1", headId: "head-1", body,
      citations: [], deltaLog: [], unstepped: false,
    }],
    deltaLog: rows,
    renderedBlock: renderContextBlock({
      folderLabel: "folder-1",
      entries: [{ relativePath: "draft.md", content: body }],
      activePath: "draft.md",
      deltaLog: rows,
    }),
    maxBytes: 8_192,
    createdAt: 1,
  });
  const prepared = prepareOperation({
    operation: "analyze",
    operationInputs: { limelightLog: "" },
    contextSnapshot: snapshot,
    provider,
    modelVoicePubkey: "b".repeat(64),
    lensId: "forensic-process-analyst",
    dirtyTarget: false,
    requestId: "request-shared-folder-row",
    createdAt: 1,
  });

  const evidence = adaptPreparedOperationForTraceContextInspector(prepared).selectedEvidence;
  assert.equal(new Set(evidence.map((item) => item.id)).size, 2);
  assert.deepEqual(evidence.map((item) => item.scope), ["folder", "folder"]);
  assert.match(evidence[1]?.displayClaim ?? "", /old\.md → new\.md/);
  assert.equal(evidence[0]?.source.traceId, undefined);
  assert.equal(evidence[1]?.source.headId, undefined);
});
