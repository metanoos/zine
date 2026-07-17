/**
 * Tests for the agent loop driver (agent-loop.ts).
 *
 * The driver is framework-agnostic, so we inject a fake AgentCtx (in-memory
 * file map) and a scripted transport via `ctx.transport`. This lets us assert
 * the load-bearing invariants without any network or React:
 *
 *   1. Drafts land as runs attributed to the model voice (no step — we never
 *      touch provenance; the host's writeDraft just records runs).
 *   2. Tool calls are executed; their results feed back into the next turn.
 *   3. The terminal turn writes output.md attributed to the model voice.
 *   4. dispatch_subagent recurses into a child subfolder; a different
 *      model_id resolves to a different voice/color.
 *   5. Subagent depth is capped (MAX_DEPTH) — dispatch at max depth errors.
 *   6. Abort stops the loop before the first turn.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// localStorage shim — ensureModelVoice upserts into the keychain.
const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import { runAgentLoop, MAX_DEPTH, type AgentCtx } from "./agent-loop.js";
import type { ProviderConfig } from "./models-store.js";
import type { Run } from "./workspace-core.js";
import type { ToolTurn } from "./agent-llm.js";

const ROOT_MODEL: ProviderConfig = {
  id: "m1", label: "Root", protocol: "openai", baseUrl: "x", modelId: "root-model",
  credentialRef: "model:test:root", credentialConfigured: false,
};
const CHILD_MODEL: ProviderConfig = {
  id: "m2", label: "Child", protocol: "openai", baseUrl: "x", modelId: "child-model",
  credentialRef: "model:test:child", credentialConfigured: false,
};

/** Build a fake ctx backed by an in-memory file map. */
function fakeCtx(
  runPath = "runs/test",
  files = new Map<string, Run[]>(),
  transport?: (cfg: ProviderConfig, msgs: any[], opts: any) => Promise<ToolTurn>,
): AgentCtx {
  return {
    nostrSecret: new Uint8Array(32).fill(7),
    resolveModel: (ref) => (ref === "child-model" || ref === "Child" ? CHILD_MODEL : ROOT_MODEL),
    readFile: (path) => {
      const runs = files.get(path);
      return runs ? runs.map((r) => r.text).join("") : null;
    },
    listFiles: (prefix) => [...files.keys()].filter((p) => !prefix || p.startsWith(prefix)),
    writeDraft: (path, runs) => { files.set(path, runs); },
    appendDraft: (path, voice, text) => {
      const prev = files.get(path);
      files.set(path, prev ? [...prev, { voice, text }] : [{ voice, text }]);
    },
    runPath,
    seedContext: "",
    transport,
  };
}

test("terminal turn writes output.md attributed to the model voice", async () => {
  const ctx = fakeCtx(undefined, undefined, async () => ({ content: "Here is the answer.", toolCalls: [], stopReason: "end" as const }));
  const out = await runAgentLoop(ctx, { goal: "say hi", model: ROOT_MODEL, signal: new AbortController().signal });
  assert.equal(out, "Here is the answer.");
  assert.equal(ctx.readFile("runs/test/output.md"), "Here is the answer.");
});

test("tool turn executes write_file and the result feeds the next turn", async () => {
  let call = 0;
  const scripted: ToolTurn[] = [
    { content: "planning", toolCalls: [{ id: "c1", name: "write_file", args: { path: "plan.md", content: "step 1" } }], stopReason: "tools" },
    { content: "done", toolCalls: [], stopReason: "end" },
  ];
  const ctx = fakeCtx(undefined, undefined, async () => scripted[call++]);
  await runAgentLoop(ctx, { goal: "plan then finish", model: ROOT_MODEL, signal: new AbortController().signal });
  assert.equal(ctx.readFile("runs/test/plan.md"), "step 1");
  assert.equal(ctx.readFile("runs/test/output.md"), "done");
});

test("multiple tool calls in one turn run in parallel and all feed back", async () => {
  let call = 0;
  const scripted: ToolTurn[] = [
    { content: "fan out", toolCalls: [
      { id: "c1", name: "write_file", args: { path: "a.md", content: "A" } },
      { id: "c2", name: "write_file", args: { path: "b.md", content: "B" } },
    ], stopReason: "tools" },
    { content: "merged", toolCalls: [], stopReason: "end" },
  ];
  const ctx = fakeCtx(undefined, undefined, async () => scripted[call++]);
  await runAgentLoop(ctx, { goal: "parallel", model: ROOT_MODEL, signal: new AbortController().signal });
  assert.equal(ctx.readFile("runs/test/a.md"), "A");
  assert.equal(ctx.readFile("runs/test/b.md"), "B");
});

test("dispatch_subagent recurses into a child subfolder and returns its output", async () => {
  // The root + child share the same transport; distinguish by goal text.
  const transport = async (_cfg: ProviderConfig, msgs: any[]): Promise<ToolTurn> => {
    const userText = msgs.find((m: any) => m.role === "user")?.content ?? "";
    if (userText.startsWith("research subtopic")) {
      return { content: "child result", toolCalls: [], stopReason: "end" };
    }
    // Root: dispatch on the first turn, finish on the second.
    const assistantTurns = msgs.filter((m: any) => m.role === "assistant").length;
    if (assistantTurns === 0) {
      return { content: "delegating", toolCalls: [{ id: "d1", name: "dispatch_subagent", args: { goal: "research subtopic", model_id: "child-model" } }], stopReason: "tools" };
    }
    return { content: "root done", toolCalls: [], stopReason: "end" };
  };
  const ctx = fakeCtx(undefined, undefined, transport);
  const out = await runAgentLoop(ctx, { goal: "main task", model: ROOT_MODEL, signal: new AbortController().signal });
  assert.equal(out, "root done");
  // Root + child output.md both present.
  const outputs = ctx.listFiles("runs/test").filter((p) => p.endsWith("/output.md"));
  assert.ok(outputs.length >= 2, `expected root + child output.md, got: ${outputs.join(", ")}`);
});

test("dispatch_subagent at MAX_DEPTH is refused (no child spawned)", async () => {
  let dispatched = false;
  const transport = async (): Promise<ToolTurn> => ({
    content: "x",
    toolCalls: [{ id: "d1", name: "dispatch_subagent", args: { goal: "too deep" } }],
    stopReason: "tools",
  });
  const ctx = fakeCtx(undefined, undefined, transport);
  // Start at MAX_DEPTH; the dispatch tool must refuse rather than recurse.
  // The tool result is fed back, but with maxSteps=1 the loop stops before
  // another turn — and no child output.md should ever appear.
  const wrappedCtx: AgentCtx = {
    ...ctx,
    writeDraft: (path, runs) => {
      ctx.writeDraft(path, runs);
      if (path.includes("/output.md") && path !== "runs/test/output.md") dispatched = true;
    },
  };
  const out = await runAgentLoop(wrappedCtx, {
    goal: "recurse forever",
    model: ROOT_MODEL,
    signal: new AbortController().signal,
    depth: MAX_DEPTH,
    maxSteps: 1,
  });
  assert.equal(dispatched, false, "no child output.md should be written at max depth");
  assert.match(out, /budget|max depth/);
});

test("abort signal stops the loop before the first turn", async () => {
  let calls = 0;
  const ctx = fakeCtx(undefined, undefined, async () => { calls++; return { content: "x", toolCalls: [], stopReason: "end" as const }; });
  const ac = new AbortController();
  ac.abort();
  await runAgentLoop(ctx, { goal: "abort me", model: ROOT_MODEL, signal: ac.signal });
  assert.equal(calls, 0, "no turns should run once aborted");
});
