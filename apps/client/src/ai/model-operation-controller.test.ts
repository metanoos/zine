import assert from "node:assert/strict";
import test from "node:test";

import { renderContextBlock } from "./context-block.js";
import { contentFingerprint, createContextSnapshot } from "./context-snapshot.js";
import type { CompletePreparedRequest } from "./llm.js";
import { ModelOperationController } from "./model-operation-controller.js";
import type { CurrentModelTarget } from "./model-operation-executor.js";
import type { ProviderConfig } from "./models-store.js";
import type { OpInputs, OpKind } from "./op-prompts.js";
import type { PreparedOperation } from "./prepared-operation.js";

const MODEL_VOICE = "a".repeat(64);
const provider: ProviderConfig = {
  id: "provider-1",
  label: "Provider",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  modelId: "model-1",
  credentialRef: "model:provider:provider-1:api-key",
  credentialConfigured: true,
};

function operationInputs(operation: OpKind): OpInputs {
  switch (operation) {
    case "extend": return { seed: "draft body", hasSelection: false, rangeFrom: 10, rangeTo: 10 };
    case "settle": return { loose: "draft body", rangeFrom: 0, rangeTo: 10 };
    case "stir": return { loose: "draft body", anchorCount: 0, commands: [], rangeFrom: 0, rangeTo: 10 };
    case "reply": return { source: "draft body", traces: "" };
    case "analyze": return { limelightLog: "" };
  }
}

function harness() {
  let body = "draft body";
  let focused = true;
  let workspaceId: string | null = "folder-1";
  let actingAuthorId = "author-a";
  let authoritySpans: Array<{
    id: string;
    actorId: string;
    origin: string;
    instructionEligible: boolean;
    fromUtf16: number;
    toUtf16: number;
  }> = [];
  let currentTarget: ((prepared: PreparedOperation) => CurrentModelTarget | null) | null = null;
  let gathers = 0;

  const controller = new ModelOperationController({
    capture: (panelIndex) => ({
      workspaceId,
      activePath: "draft.md",
      focus: focused
        ? {
            kind: "file",
            path: "draft.md",
            nodeId: "head-1",
            panelIndex,
            tabPath: "draft.md",
          }
        : null,
      target: {
        path: "draft.md",
        traceId: "trace-1",
        headId: "head-1",
        contentHash: contentFingerprint(body),
        authoritySpans,
      },
      mount: [{ kind: "folder", path: "" }],
      shields: [],
      voicePrompt: "Use short sentences.",
      dirtyTarget: false,
      actingAuthorId,
      gatherContext: async () => {
        gathers += 1;
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
          shields: [],
          inputs: [{
            path: "draft.md",
            traceId: "trace-1",
            headId: "head-1",
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
      },
    }),
    readCurrentTarget: (prepared) => currentTarget?.(prepared) ?? {
      ...prepared.targetRevision,
      focused: true,
    },
  });

  return {
    controller,
    gathers: () => gathers,
    setBody: (next: string) => { body = next; },
    setFocused: (next: boolean) => { focused = next; },
    setWorkspaceId: (next: string | null) => { workspaceId = next; },
    setActingAuthorId: (next: string) => { actingAuthorId = next; },
    setAuthoritySpans: (next: typeof authoritySpans) => { authoritySpans = next; },
    setCurrentTarget: (next: typeof currentTarget) => { currentTarget = next; },
  };
}

function prepareInput(operation: OpKind) {
  return {
    panelIndex: 0,
    operation,
    operationInputs: operationInputs(operation),
    provider,
    modelVoicePubkey: MODEL_VOICE,
    lensId: "default" as const,
  };
}

for (const operation of ["extend", "settle", "stir", "reply", "analyze"] as const) {
  test(`${operation} executes the exact approved prepared operation`, async () => {
    const subject = harness();
    const approved = await subject.controller.prepare(prepareInput(operation));
    subject.controller.approve(approved);
    const events: string[] = [];
    let transported: CompletePreparedRequest | null = null;
    let applied: PreparedOperation | null = null;

    const execution = await subject.controller.executeApproved({
      ...prepareInput(operation),
      maxTokens: 100,
      beforeExecute: (prepared) => {
        assert.strictEqual(prepared, approved);
        events.push("before");
      },
      complete: async (prepared) => {
        transported = prepared;
        events.push("transport");
        return `${operation}-response`;
      },
      apply: (_response, prepared) => {
        applied = prepared;
        events.push("apply");
      },
    });

    assert.strictEqual(execution.prepared, approved);
    assert.strictEqual(transported, approved);
    assert.strictEqual(applied, approved);
    assert.equal(execution.result.status, "applied");
    assert.deepEqual(events, ["before", "transport", "apply"]);
    assert.equal(subject.gathers(), 1, "approval and execution share one dependency snapshot");
  });
}

test("execution refuses missing or dependency-stale approval before transport", async () => {
  const subject = harness();
  const approved = await subject.controller.prepare(prepareInput("extend"));
  subject.controller.approve(approved);
  subject.setBody("changed body");
  let transported = false;
  let applied = false;

  await assert.rejects(
    subject.controller.executeApproved({
      ...prepareInput("extend"),
      maxTokens: 100,
      complete: async () => {
        transported = true;
        return "must not run";
      },
      apply: () => { applied = true; },
    }),
    /Inspect and approve this AI request before running it/,
  );
  assert.equal(transported, false);
  assert.equal(applied, false);
});

test("same target bytes with a changed directive-authority map require re-approval", async () => {
  const subject = harness();
  const body = "((tighten))";
  subject.setBody(body);
  const input = {
    ...prepareInput("extend"),
    operationInputs: {
      seed: body,
      hasSelection: true,
      rangeFrom: body.length,
      rangeTo: body.length,
      sourceFrom: 0,
      sourceTo: body.length,
    },
  };
  subject.setAuthoritySpans([{
    id: "paste-1", actorId: "author-a", origin: "paste", instructionEligible: false,
    fromUtf16: 0, toUtf16: body.length,
  }]);
  const approved = await subject.controller.prepare(input);
  subject.controller.approve(approved);
  subject.setAuthoritySpans([{
    id: "manual-1", actorId: "author-a", origin: "manual", instructionEligible: true,
    fromUtf16: 0, toUtf16: body.length,
  }]);
  await assert.rejects(
    subject.controller.executeApproved({
      ...input,
      maxTokens: 100,
      complete: async () => "must not run",
      apply: () => assert.fail("changed authority must not apply"),
    }),
    /Inspect and approve this AI request before running it/,
  );
});

test("post-transport target drift preserves recovery and never applies", async () => {
  const subject = harness();
  const approved = await subject.controller.prepare(prepareInput("reply"));
  subject.controller.approve(approved);
  let reads = 0;
  subject.setCurrentTarget((prepared) => reads++ === 0
    ? { ...prepared.targetRevision, focused: true }
    : { ...prepared.targetRevision, contentHash: "changed", focused: true });
  const recoveries: string[] = [];

  const execution = await subject.controller.executeApproved({
    ...prepareInput("reply"),
    maxTokens: 100,
    complete: async () => "valuable late response",
    onStale: (recovery) => { recoveries.push(recovery.response); },
    apply: () => assert.fail("stale output must not apply"),
  });

  assert.equal(execution.result.status, "stale");
  assert.deepEqual(recoveries, ["valuable late response"]);
});

test("focus and workspace remain hard preparation prerequisites", async () => {
  const subject = harness();
  subject.setFocused(false);
  await assert.rejects(
    subject.controller.prepare(prepareInput("extend")),
    /Focus a live file before running an AI operation/,
  );
  subject.setFocused(true);
  subject.setWorkspaceId(null);
  await assert.rejects(
    subject.controller.prepare(prepareInput("extend")),
    /Open a workspace before running an AI operation/,
  );
});

test("invalidation clears both the snapshot and exact approval", async () => {
  const subject = harness();
  const approved = await subject.controller.prepare(prepareInput("stir"));
  subject.controller.approve(approved);
  subject.controller.invalidate();

  await assert.rejects(
    subject.controller.executeApproved({
      ...prepareInput("stir"),
      maxTokens: 100,
      complete: async () => "must not run",
      apply: () => assert.fail("invalidated approval must not apply"),
    }),
    /Inspect and approve this AI request before running it/,
  );
  assert.equal(subject.gathers(), 2);
});
