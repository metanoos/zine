/**
 * Tests for the tool-calling transport (agent-llm.ts).
 *
 * The contracts pinned here:
 *   1. OpenAI: the request body carries `tools` + `tool_choice`, and a
 *      response with `tool_calls` parses to `{toolCalls, stopReason:"tools"}`.
 *   2. OpenAI: a response with only text parses to `{stopReason:"end"}`.
 *   3. OpenAI: tool results are echoed back in the request as `tool` messages
 *      with `tool_call_id`, and prior assistant tool calls round-trip.
 *   4. Anthropic: the request body carries top-level `tools` + `system`, tool
 *      calls in a `tool_use` content block parse correctly, and a text-only
 *      response is terminal.
 *   5. Anthropic: tool results are sent back as a `user` turn with
 *      `tool_result` blocks.
 *
 * We mock `globalThis.fetch` (the browser codepath) and stub `isTauri` to
 * false so the Tauri branch is never taken.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// --- stubs ----------------------------------------------------------------

// isTauri() reads window/__TAURI__; force the fetch codepath in tests.
// We monkeypatch the imported module's re-exported function. The module imports
// isTauri from identity.js, so we intercept globalThis first.
// @ts-expect-error test shim — no Tauri runtime in node test
globalThis.__TAURI_INTERNALS__ = undefined;

let lastRequest: { url: string; headers: Record<string, string>; body: any } | null = null;
let nextResponse: { status: number; text: string } = { status: 200, text: "{}" };

// @ts-expect-error fetch shim
globalThis.fetch = async (url: string, init: any) => {
  lastRequest = {
    url: String(url),
    headers: init?.headers ?? {},
    body: init?.body ? JSON.parse(init.body) : null,
  };
  // The dev proxy rewrite turns z.ai into /llm/zai/...; tests use an
  // openai.example base so devProxyUrl is a no-op.
  return {
    ok: nextResponse.status >= 200 && nextResponse.status < 300,
    status: nextResponse.status,
    text: async () => nextResponse.text,
  };
};

// window shim so devProxyUrl's typeof window check passes.
// @ts-expect-error minimal window shim
globalThis.window = {};

import { completeWithTools, type AgentMsg, type ToolSpec } from "./agent-llm.js";

const OPENAI_CFG = {
  id: "p1",
  label: "OpenAI",
  protocol: "openai" as const,
  baseUrl: "https://openai.example.com",
  modelId: "gpt-test",
  apiKey: "sk-test",
};
const ANTH_CFG = {
  id: "p2",
  label: "Anthropic",
  protocol: "anthropic" as const,
  baseUrl: "https://anthropic.example.com",
  modelId: "claude-test",
  apiKey: "sk-ant-test",
};

const TOOLS: ToolSpec[] = [
  { name: "write_file", description: "write a file", parameters: { type: "object" } },
];

test("OpenAI: request carries tools + tool_choice, URL and auth header", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "done" } }] }) };
  await completeWithTools(OPENAI_CFG, [{ role: "user", content: "hi" }], { tools: TOOLS });
  assert.equal(lastRequest!.url, "https://openai.example.com/chat/completions");
  assert.equal(lastRequest!.headers["Authorization"], "Bearer sk-test");
  assert.equal(lastRequest!.body.tool_choice, "auto");
  assert.ok(lastRequest!.body.tools?.[0]?.function?.name === "write_file");
  assert.equal(lastRequest!.body.stream, false);
});

test("OpenAI: model-card generation controls and personality reach the wire", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "done" } }] }) };
  await completeWithTools({
    ...OPENAI_CFG,
    reasoningEffort: "xhigh",
    verbosity: "low",
    personality: "friendly",
    instructions: "Prefer small patches.",
    temperature: 0.2,
    maxTokens: 8192,
  }, [{ role: "system", content: "agent preamble" }, { role: "user", content: "hi" }], { tools: TOOLS });

  assert.equal(lastRequest!.body.reasoning_effort, "xhigh");
  assert.equal(lastRequest!.body.verbosity, "low");
  assert.equal(lastRequest!.body.temperature, 0.2);
  assert.equal(lastRequest!.body.max_tokens, 8192);
  assert.match(lastRequest!.body.messages[0].content, /warm, approachable/);
  assert.match(lastRequest!.body.messages[0].content, /Prefer small patches/);
  assert.equal(lastRequest!.body.messages[1].content, "agent preamble");
});

test("OpenAI: tool_calls in the response parse to stopReason 'tools'", async () => {
  nextResponse = {
    status: 200,
    text: JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call_1", function: { name: "write_file", arguments: '{"path":"a.md","content":"hi"}' } }],
        },
        finish_reason: "tool_calls",
      }],
    }),
  };
  const turn = await completeWithTools(OPENAI_CFG, [{ role: "user", content: "go" }], { tools: TOOLS });
  assert.equal(turn.stopReason, "tools");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].id, "call_1");
  assert.equal(turn.toolCalls[0].name, "write_file");
  assert.equal(turn.toolCalls[0].args.path, "a.md");
});

test("OpenAI: text-only response is terminal (stopReason 'end')", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "all done" } }] }) };
  const turn = await completeWithTools(OPENAI_CFG, [{ role: "user", content: "go" }], { tools: TOOLS });
  assert.equal(turn.stopReason, "end");
  assert.equal(turn.toolCalls.length, 0);
  assert.equal(turn.content, "all done");
});

test("OpenAI: prior assistant tool calls + tool results round-trip in the request", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
  const log: AgentMsg[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "write_file", args: { path: "a.md" } }] },
    { role: "tool", toolCallId: "call_1", content: "wrote a.md" },
  ];
  await completeWithTools(OPENAI_CFG, log, { tools: TOOLS });
  const msgs = lastRequest!.body.messages;
  // assistant turn carries tool_calls
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].tool_calls[0].id, "call_1");
  // tool result as its own message
  assert.equal(msgs[2].role, "tool");
  assert.equal(msgs[2].tool_call_id, "call_1");
  assert.equal(msgs[2].content, "wrote a.md");
});

test("OpenAI: malformed tool-call arguments parse to an empty object (loop survives)", async () => {
  nextResponse = {
    status: 200,
    text: JSON.stringify({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ id: "call_x", function: { name: "write_file", arguments: "not-json{" } }],
        },
      }],
    }),
  };
  const turn = await completeWithTools(OPENAI_CFG, [{ role: "user", content: "go" }], { tools: TOOLS });
  assert.equal(turn.toolCalls[0].args.__parseError, "could not parse arguments for tool call call_x");
});

test("Anthropic: request carries top-level tools, system string, x-api-key header", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ content: [{ type: "text", text: "done" }] }) };
  await completeWithTools(ANTH_CFG, [
    { role: "system", content: "be good" },
    { role: "user", content: "hi" },
  ], { tools: TOOLS });
  assert.equal(lastRequest!.url, "https://anthropic.example.com/v1/messages");
  assert.equal(lastRequest!.headers["x-api-key"], "sk-ant-test");
  assert.equal(lastRequest!.headers["anthropic-version"], "2023-06-01");
  assert.equal(lastRequest!.body.system, "be good");
  assert.equal(lastRequest!.body.tools[0].name, "write_file");
  assert.equal(lastRequest!.body.tools[0].input_schema.type, "object");
});

test("Anthropic: card effort and every system layer are preserved", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ content: [{ type: "text", text: "done" }] }) };
  await completeWithTools({
    ...ANTH_CFG,
    reasoningEffort: "high",
    personality: "pragmatic",
    instructions: "Prefer small patches.",
    temperature: 0.4,
    maxTokens: 12000,
  }, [
    { role: "system", content: "agent preamble" },
    { role: "system", content: "voice instructions" },
    { role: "user", content: "hi" },
  ], { tools: TOOLS });

  assert.deepEqual(lastRequest!.body.output_config, { effort: "high" });
  assert.equal(lastRequest!.body.temperature, 0.4);
  assert.equal(lastRequest!.body.max_tokens, 12000);
  assert.match(lastRequest!.body.system, /concisely and practically/);
  assert.match(lastRequest!.body.system, /Prefer small patches/);
  assert.match(lastRequest!.body.system, /agent preamble/);
  assert.match(lastRequest!.body.system, /voice instructions/);
});

test("Anthropic: tool_use blocks parse to stopReason 'tools'", async () => {
  nextResponse = {
    status: 200,
    text: JSON.stringify({
      content: [
        { type: "text", text: "writing now" },
        { type: "tool_use", id: "tu_1", name: "write_file", input: { path: "a.md", content: "hi" } },
      ],
    }),
  };
  const turn = await completeWithTools(ANTH_CFG, [{ role: "user", content: "go" }], { tools: TOOLS });
  assert.equal(turn.stopReason, "tools");
  assert.equal(turn.content, "writing now");
  assert.equal(turn.toolCalls.length, 1);
  assert.equal(turn.toolCalls[0].id, "tu_1");
  assert.equal(turn.toolCalls[0].args.path, "a.md");
});

test("Anthropic: tool results are sent back as user turns with tool_result blocks", async () => {
  nextResponse = { status: 200, text: JSON.stringify({ content: [{ type: "text", text: "ok" }] }) };
  const log: AgentMsg[] = [
    { role: "system", content: "be good" },
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "write_file", args: { path: "a.md" } }] },
    { role: "tool", toolCallId: "tu_1", content: "wrote a.md" },
  ];
  await completeWithTools(ANTH_CFG, log, { tools: TOOLS });
  const msgs = lastRequest!.body.messages;
  // system is hoisted out of messages; user/assistant/tool_result follow.
  // tool result is a user turn with a tool_result content block.
  const toolResultTurn = msgs.find((m: any) =>
    Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"));
  assert.ok(toolResultTurn, "expected a tool_result user turn");
  assert.equal(toolResultTurn.role, "user");
  assert.equal(toolResultTurn.content[0].tool_use_id, "tu_1");
});
