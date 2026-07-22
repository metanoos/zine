import assert from "node:assert/strict";
import test from "node:test";

import { finalizeEvent, getPublicKey, verifyEvent, type EventTemplate } from "nostr-tools/pure";

import { renderContextBlock } from "./context-block.js";
import { createContextSnapshot } from "./context-snapshot.js";
import {
  DesktopTraceContextPreparationError,
  prepareDesktopTraceContextOperationV1,
  type DesktopTraceContextPreparationBoundaryV1,
} from "./desktop-trace-context-preparation.js";
import { ModelOperationController } from "./model-operation-controller.js";
import type { ProviderConfig } from "./models-store.js";
import {
  prepareOperation,
  prepareOperationWithSelectedTraceContext,
  type PrepareOperationInput,
} from "./prepared-operation.js";
import { adaptPreparedOperationForTraceContextInspector } from "./trace-context-inspector-adapter.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 9]);
const OWNER = getPublicKey(SECRET);
const ROOT_ID = "f".repeat(64);
const OPERATION_ID = "1".repeat(64);

const provider: ProviderConfig = {
  id: "provider-1",
  label: "Provider",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  modelId: "model-1",
  credentialRef: "model:provider:provider-1:api-key",
  credentialConfigured: true,
};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Buffer.from(digest).toString("hex");
}

async function fileNode(text: string, omitKedits = false) {
  const template: EventTemplate = {
    kind: 4290,
    created_at: 1_700_000_000,
    tags: [
      ["z", "file"],
      ["F", "draft.md"],
      ["f", ROOT_ID],
      ["action", "import"],
    ],
    content: JSON.stringify({
      snapshot: text,
      contentHash: await sha256(text),
      operationId: OPERATION_ID,
      ...(omitKedits ? {} : {
        kedits: [{
          op: "ins",
          from: 0,
          to: 0,
          text,
          voice: OWNER,
          t: 1_700_000_000_000,
          tx: 1,
        }],
      }),
    }),
  };
  return finalizeEvent(template, SECRET);
}

function snapshotFor(node: Awaited<ReturnType<typeof fileNode>>, body: string, headId = node.id) {
  return createContextSnapshot({
    target: {
      kind: "file",
      folderId: "folder-1",
      path: "draft.md",
      traceId: node.id,
      headId,
      body,
    },
    mount: { kind: "file", path: "draft.md" },
    shields: [],
    inputs: [{
      path: "draft.md",
      traceId: node.id,
      headId,
      body,
      citations: [],
      deltaLog: [],
      unstepped: false,
    }],
    renderedBlock: renderContextBlock({
      folderLabel: "folder-1",
      entries: [{ relativePath: "draft.md", content: body }],
      activePath: "draft.md",
      deltaLog: [],
    }),
    createdAt: 1,
  });
}

function preparationInput(
  node: Awaited<ReturnType<typeof fileNode>>,
  body: string,
  headId = node.id,
): PrepareOperationInput {
  return {
    operation: "extend",
    operationInputs: {
      seed: body,
      hasSelection: true,
      rangeFrom: body.length,
      rangeTo: body.length,
      sourceFrom: 0,
      sourceTo: body.length,
    },
    contextSnapshot: snapshotFor(node, body, headId),
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    actingAuthorId: "author-a",
    authoritySpans: [],
    requestId: "request-1",
    createdAt: 1,
  };
}

function boundary(
  node: Awaited<ReturnType<typeof fileNode>>,
  policy: DesktopTraceContextPreparationBoundaryV1["policy"] = "selected-trace-v1",
  maxContextBytes = 16_384,
): DesktopTraceContextPreparationBoundaryV1 {
  return {
    version: 1,
    policy,
    chain: [node],
    verifyEvent,
    maxContextBytes,
  };
}

test("binds Unicode selected-context bytes and all package-local identities to messages and Inspector", async () => {
  const body = "Current 🧠 draft — café";
  const node = await fileNode(body);
  const prepared = await prepareDesktopTraceContextOperationV1(
    preparationInput(node, body),
    boundary(node),
  );
  const selection = prepared.traceContextSelection;
  assert.ok(selection);
  assert.equal(Object.isFrozen(selection), true);
  assert.equal(
    new TextEncoder().encode(selection.renderedContext).length,
    selection.manifest.budget.usedRenderedBytes,
  );
  assert.equal(prepared.budget.contextBytes, selection.manifest.budget.usedRenderedBytes);
  assert.equal(
    prepared.budget.totalBytes - prepared.budget.contextBytes,
    selection.manifest.budget.reservedPromptBytes,
  );
  const wireText = prepared.messages.map((message) => message.content).join("\n");
  assert.equal(wireText.split(selection.renderedContext).length - 1, 1);

  const inspector = adaptPreparedOperationForTraceContextInspector(prepared);
  assert.equal(inspector.policy, "selected-trace-v1");
  assert.deepEqual(inspector.metadata.selectionIdentities, {
    frozenInputsSha256: selection.manifest.hashes.frozenInputsSha256,
    renderedContextSha256: selection.manifest.hashes.renderedContextSha256,
    manifestSha256: selection.manifestSha256,
  });
  assert.equal(inspector.metadata.budget.usedContextBytes, selection.manifest.budget.usedRenderedBytes);
  assert.equal(inspector.selectedEvidence.length, selection.manifest.selected.length);
});

test("text-only remains trace-free even though the signed target is verified", async () => {
  const body = "Plain comparison";
  const node = await fileNode(body);
  const prepared = await prepareDesktopTraceContextOperationV1(
    preparationInput(node, body),
    boundary(node, "text-only-v1"),
  );
  const selection = prepared.traceContextSelection!;
  assert.equal(selection.manifest.policy, "text-only-v1");
  assert.deepEqual(selection.manifest.selected, []);
  assert.doesNotMatch(selection.renderedContext, new RegExp(node.id));
  assert.doesNotMatch(selection.renderedContext, new RegExp(OWNER));
  assert.equal(
    adaptPreparedOperationForTraceContextInspector(prepared).selectedEvidence.length,
    0,
  );
});

test("binds Settle to its exact UTF-16 source range", async () => {
  const body = "Intro 🧠 revise this ending";
  const node = await fileNode(body);
  const fromUtf16 = body.indexOf("revise");
  const toUtf16 = body.length;
  const input = preparationInput(node, body);
  input.operation = "settle";
  input.operationInputs = {
    loose: body.slice(fromUtf16, toUtf16),
    rangeFrom: fromUtf16,
    rangeTo: toUtf16,
    sourceFrom: fromUtf16,
    sourceTo: toUtf16,
  };

  const prepared = await prepareDesktopTraceContextOperationV1(input, boundary(node));

  assert.equal(prepared.operation, "settle");
  assert.deepEqual(prepared.traceContextSelection?.manifest.operation.range, {
    fromUtf16,
    toUtf16,
  });
  assert.deepEqual(
    adaptPreparedOperationForTraceContextInspector(prepared).targetRevision.operationRange,
    { fromUtf16, toUtf16 },
  );
});

test("fails closed for incomplete selected trace and mandatory context budget failure", async () => {
  const body = "Snapshot only";
  const incomplete = await fileNode(body, true);
  await assert.rejects(
    prepareDesktopTraceContextOperationV1(
      preparationInput(incomplete, body),
      boundary(incomplete),
    ),
    (error: unknown) => error instanceof DesktopTraceContextPreparationError
      && error.selectionError?.code === "CONTEXT_INCOMPLETE",
  );
  const textOnly = await prepareDesktopTraceContextOperationV1(
    preparationInput(incomplete, body),
    boundary(incomplete, "text-only-v1"),
  );
  assert.equal(textOnly.traceContextSelection?.manifest.policy, "text-only-v1");
  assert.deepEqual(textOnly.traceContextSelection?.manifest.selected, []);

  const complete = await fileNode(body);
  await assert.rejects(
    prepareDesktopTraceContextOperationV1(
      preparationInput(complete, body),
      boundary(complete, "selected-trace-v1", 1),
    ),
    (error: unknown) => error instanceof DesktopTraceContextPreparationError
      && error.selectionError?.code === "MANDATORY_BUDGET_EXCEEDED",
  );

  const reference = await prepareDesktopTraceContextOperationV1(
    preparationInput(complete, body),
    boundary(complete, "text-only-v1"),
  );
  const requestBound = preparationInput(complete, body);
  requestBound.maxBytes = reference.budget.totalBytes - 1;
  await assert.rejects(
    prepareDesktopTraceContextOperationV1(
      requestBound,
      boundary(complete, "text-only-v1"),
    ),
    (error: unknown) => error instanceof DesktopTraceContextPreparationError
      && error.selectionError?.code === "MANDATORY_BUDGET_EXCEEDED",
  );
});

test("keeps selected context exact while carrying authorized directives separately", async () => {
  const body = "Draft ((tighten this))";
  const node = await fileNode(body);
  const input = preparationInput(node, body);
  input.authoritySpans = [{
    id: "manual-1",
    actorId: "author-a",
    origin: "manual",
    instructionEligible: true,
    fromUtf16: body.indexOf("(("),
    toUtf16: body.length,
  }];
  const prepared = await prepareDesktopTraceContextOperationV1(input, boundary(node));
  assert.equal(prepared.traceContextSelection?.renderedContext.includes(body), true);
  assert.equal(prepared.traceAuthoring?.compiled.directives.length, 1);
  assert.match(prepared.operationInputs.seed ?? "", /ZINE_DIRECTIVE_V1/);
});

test("rejects a target/head mismatch and a mutated selected output", async () => {
  const body = "Exact target";
  const node = await fileNode(body);
  await assert.rejects(
    prepareDesktopTraceContextOperationV1(
      preparationInput(node, body, "0".repeat(64)),
      boundary(node),
    ),
    /target\/head does not match/,
  );

  const prepared = await prepareDesktopTraceContextOperationV1(
    preparationInput(node, body),
    boundary(node),
  );
  const mutated = structuredClone(prepared.traceContextSelection!);
  mutated.renderedContext += " ";
  assert.throws(
    () => prepareOperationWithSelectedTraceContext(preparationInput(node, body), mutated),
    /rendered bytes do not match their frozen identity/,
  );

  assert.throws(
    () => prepareOperation({
      ...preparationInput(node, body),
      traceContextSelection: prepared.traceContextSelection,
    } as PrepareOperationInput),
    /Caller-supplied trace-context selection is not accepted/,
  );
});

test("deep-freezes a valid shallow-frozen selection supplied at the internal boundary", async () => {
  const body = "Immutable selection";
  const node = await fileNode(body);
  const selected = await prepareDesktopTraceContextOperationV1(
    preparationInput(node, body),
    boundary(node),
  );
  const shallowFrozen = Object.freeze(structuredClone(selected.traceContextSelection!));
  assert.equal(Object.isFrozen(shallowFrozen.manifest), false);

  const prepared = prepareOperationWithSelectedTraceContext(
    preparationInput(node, body),
    shallowFrozen,
  );

  assert.equal(Object.isFrozen(prepared.traceContextSelection?.manifest), true);
  assert.equal(Object.isFrozen(prepared.traceContextSelection?.manifest.operation.target), true);
  assert.equal(Object.isFrozen(prepared.traceContextSelection?.decisions), true);
});

test("controller invalidates approval when only the selection policy identity changes", async () => {
  const body = "Approval target";
  const node = await fileNode(body);
  const snapshot = snapshotFor(node, body);
  let gathers = 0;
  const controller = new ModelOperationController({
    capture: (panelIndex) => ({
      workspaceId: "folder-1",
      activePath: "draft.md",
      focus: {
        kind: "file",
        path: "draft.md",
        nodeId: node.id,
        panelIndex,
        tabPath: "draft.md",
      },
      target: {
        path: "draft.md",
        traceId: node.id,
        headId: node.id,
        contentHash: snapshot.target.contentHash,
        authoritySpans: [],
      },
      mount: { kind: "file", path: "draft.md" },
      shields: [],
      voicePrompt: "",
      dirtyTarget: false,
      actingAuthorId: "author-a",
      gatherContext: async () => {
        gathers += 1;
        return snapshot;
      },
    }),
    readCurrentTarget: (prepared) => ({ ...prepared.targetRevision, focused: true }),
  });
  const base = {
    panelIndex: 0,
    operation: "extend" as const,
    operationInputs: preparationInput(node, body).operationInputs,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default" as const,
  };
  const approved = await controller.prepare({
    ...base,
    traceContext: boundary(node, "selected-trace-v1"),
  });
  controller.approve(approved);

  await assert.rejects(
    controller.executeApproved({
      ...base,
      traceContext: boundary(node, "text-only-v1"),
      maxTokens: 10,
      complete: async () => assert.fail("changed selection must not dispatch"),
      apply: () => assert.fail("changed selection must not apply"),
    }),
    /Inspect and approve this AI request before running it/,
  );
  assert.equal(gathers, 2);
});

test("controller invalidation aborts selector preparation after context gathering completes", async () => {
  const body = "Cancel selected context";
  const node = await fileNode(body);
  const snapshot = snapshotFor(node, body);
  let gathered = false;
  let verifierCalls = 0;
  let controller: ModelOperationController;
  controller = new ModelOperationController({
    capture: (panelIndex) => ({
      workspaceId: "folder-1",
      activePath: "draft.md",
      focus: {
        kind: "file",
        path: "draft.md",
        nodeId: node.id,
        panelIndex,
        tabPath: "draft.md",
      },
      target: {
        path: "draft.md",
        traceId: node.id,
        headId: node.id,
        contentHash: snapshot.target.contentHash,
        authoritySpans: [],
      },
      mount: { kind: "file", path: "draft.md" },
      shields: [],
      voicePrompt: "",
      dirtyTarget: false,
      actingAuthorId: "author-a",
      gatherContext: async () => {
        gathered = true;
        return snapshot;
      },
    }),
    readCurrentTarget: (prepared) => ({ ...prepared.targetRevision, focused: true }),
  });
  const traceContext = boundary(node);
  traceContext.verifyEvent = (event) => {
    verifierCalls += 1;
    controller.invalidate();
    return verifyEvent(event as Parameters<typeof verifyEvent>[0]);
  };

  await assert.rejects(
    controller.prepare({
      panelIndex: 0,
      operation: "extend",
      operationInputs: preparationInput(node, body).operationInputs,
      provider,
      modelVoicePubkey: "a".repeat(64),
      lensId: "default",
      traceContext,
    }),
    /cancelled/,
  );
  assert.equal(gathered, true);
  assert.ok(verifierCalls > 0);
});

// Regression for the Extend autofire path (palette click fires Extend directly,
// without first opening the Inspector to produce a pre-approved request). The
// autofire branch calls controller.prepare({ operation: "extend", traceContext })
// and then hands the result to the durable desktop runtime, which requires
// prepared.traceContextSelection to be populated. This test pins that the
// controller-level prepare — not just prepareDesktopTraceContextOperationV1 —
// surfaces the selection on the prepared operation.
test("controller prepare for extend with trace context populates traceContextSelection for the durable runtime", async () => {
  const body = "Autofire extend body";
  const node = await fileNode(body);
  const snapshot = snapshotFor(node, body);
  const controller = new ModelOperationController({
    capture: (panelIndex) => ({
      workspaceId: "folder-1",
      activePath: "draft.md",
      focus: {
        kind: "file",
        path: "draft.md",
        nodeId: node.id,
        panelIndex,
        tabPath: "draft.md",
      },
      target: {
        path: "draft.md",
        traceId: node.id,
        headId: node.id,
        contentHash: snapshot.target.contentHash,
        authoritySpans: [],
      },
      mount: { kind: "file", path: "draft.md" },
      shields: [],
      voicePrompt: "",
      dirtyTarget: false,
      actingAuthorId: "author-a",
      gatherContext: async () => snapshot,
    }),
    readCurrentTarget: (prepared) => ({ ...prepared.targetRevision, focused: true }),
  });

  const prepared = await controller.prepare({
    panelIndex: 0,
    operation: "extend",
    operationInputs: preparationInput(node, body).operationInputs,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    traceContext: boundary(node),
  });

  // The durable runtime's guard (extendLLM) rejects a prepared Extend request
  // whose traceContextSelection is missing. Autofire must satisfy it.
  assert.ok(prepared.traceContextSelection, "autofire prepare must bind selected trace context");
  assert.equal(prepared.operation, "extend");
  assert.equal(
    prepared.traceContextSelection!.manifest.policy,
    "selected-trace-v1",
  );
});
