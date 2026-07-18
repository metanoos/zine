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
import { prepareOperation, type PrepareOperationInput } from "./prepared-operation.js";
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
});

test("blocks selection when authoring would need to substitute markerized context bytes", async () => {
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
  await assert.rejects(
    prepareDesktopTraceContextOperationV1(input, boundary(node)),
    /cannot silently substitute markerized authoring bytes/,
  );
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
    () => prepareOperation({
      ...preparationInput(node, body),
      traceContextSelection: mutated,
    }),
    /rendered bytes do not match their frozen identity/,
  );
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
