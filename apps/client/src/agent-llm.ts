/**
 * Tool-calling transport for the in-app agent loop.
 *
 * This is a *sibling* to `llm.ts`'s `complete()` — it does not touch the
 * single-shot op path at all. The agent loop needs a richer exchange
 * (assistant turns can carry tool calls; tool results come back as their own
 * role), and a return value that surfaces tool calls and the stop reason,
 * which `Promise<string>` can't.
 *
 * v1 is non-streaming: tool iterations are short round-trips, and the loop's
 * terminal turn writes its whole prose to a file. (Streaming the synthesizer
 * into the editor is a noted follow-up, not a v1 goal.)
 *
 * Two protocols, translated from a neutral `AgentMsg[]` + `ToolSpec[]`:
 *
 *   OpenAI (and OpenAI-compatible) — `tools: [{type:"function",function:…}]`,
 *     `tool_choice:"auto"`. Assistant tool calls land in
 *     `choices[0].message.tool_calls` as `{id, function:{name, arguments(JSON string)}}`.
 *     Tool results are sent back as `{role:"tool", tool_call_id, content}`.
 *
 *   Anthropic — top-level `tools: [{name, description, input_schema}]`. Tool
 *     calls land as `content` blocks of `type:"tool_use"` carrying `{id, name, input(object)}`.
 *     Tool results are sent back as a `user` turn whose content is an array of
 *     `{type:"tool_result", tool_use_id, content}`. Anthropic takes a single
 *     `system` string, so all configured/system layers are joined in order.
 */

import { providerCredential, type ProviderConfig } from "./models-store.js";
import { isTauri } from "./identity.js";
import {
  anthropicModelOptions,
  modelSystemInstruction,
  openAIModelOptions,
} from "./model-config.js";

/** A tool call the model wants executed. `args` is the parsed JSON object. */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Neutral conversation message for a tool-calling loop. */
export type AgentMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool the model may call. `parameters` is a JSON-Schema object. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: object;
}

/** The result of one model turn in the loop. */
export interface ToolTurn {
  /** The assistant's textual content for this turn (may be empty when the
   *  model only emits tool calls). */
  content: string;
  /** Tool calls the model requested (empty when the turn is terminal). */
  toolCalls: ToolCall[];
  /** `"tools"` if the model asked for tools (loop continues), `"end"` if it
   *  produced a final answer (loop terminates). */
  stopReason: "end" | "tools";
}

export interface CompleteWithToolsOptions {
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * Send one tool-capable turn to the model. Translates the neutral message log
 * to the provider's wire shape, parses tool calls back, and returns a `ToolTurn`.
 */
export async function completeWithTools(
  cfg: ProviderConfig,
  messages: AgentMsg[],
  opts: CompleteWithToolsOptions,
): Promise<ToolTurn> {
  if (!cfg.baseUrl) throw new Error(`provider "${cfg.label}" has no base URL`);
  if (!cfg.modelId) throw new Error(`provider "${cfg.label}" has no model id`);
  const instruction = modelSystemInstruction(cfg);
  const configuredMessages: AgentMsg[] = instruction
    ? [{ role: "system", content: instruction }, ...messages]
    : messages;
  return cfg.protocol === "anthropic"
    ? callAnthropic(cfg, configuredMessages, opts)
    : callOpenAI(cfg, configuredMessages, opts);
}

// --- OpenAI ---------------------------------------------------------------

async function callOpenAI(
  cfg: ProviderConfig,
  messages: AgentMsg[],
  opts: CompleteWithToolsOptions,
): Promise<ToolTurn> {
  const url = joinPath(cfg.baseUrl, "chat/completions");
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = providerCredential(cfg);
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const body = JSON.stringify({
    model: cfg.modelId,
    messages: messages.map(toOpenAIMsg),
    tools: opts.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    tool_choice: "auto",
    stream: false,
    ...openAIModelOptions(cfg, opts.maxTokens),
  });

  const text = await rawRequest(url, headers, body, opts.signal, "OpenAI");
  const json = JSON.parse(text) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{
          id: string;
          function: { name: string; arguments: string };
        }>;
      };
      finish_reason?: string;
    }>;
  };
  const msg = json.choices?.[0]?.message;
  const rawCalls = msg?.tool_calls ?? [];
  const toolCalls: ToolCall[] = rawCalls.map((c) => ({
    id: c.id,
    name: c.function.name,
    args: parseArgs(c.function.arguments, c.id),
  }));
  return {
    content: msg?.content ?? "",
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tools" : "end",
  };
}

/** Map a neutral AgentMsg to the OpenAI wire shape (role/content/tool_calls/tool_call_id). */
function toOpenAIMsg(m: AgentMsg): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      // Echo the model's prior tool calls back so the API sees a well-formed
      // assistant turn before the tool results that answer them.
      return m.toolCalls && m.toolCalls.length > 0
        ? {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: JSON.stringify(tc.args) },
            })),
          }
        : { role: "assistant", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

// --- Anthropic ------------------------------------------------------------

async function callAnthropic(
  cfg: ProviderConfig,
  messages: AgentMsg[],
  opts: CompleteWithToolsOptions,
): Promise<ToolTurn> {
  const url = joinPath(cfg.baseUrl, "v1/messages");
  // Anthropic takes one top-level system string. Join every system layer so a
  // card instruction never displaces the agent preamble (or vice versa).
  const systemMsg = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map(toAnthropicTurn)
    // Anthropic requires strictly alternating user/assistant roles. A run of
    // `tool` results is emitted as a single user turn above; collapse any
    // adjacent same-role turns the loop produced so the wire stays valid.
    .filter((t, i, arr) => i === 0 || t.role !== arr[i - 1].role || Array.isArray(t.content));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  const apiKey = providerCredential(cfg);
  if (apiKey) headers["x-api-key"] = apiKey;

  const body = JSON.stringify({
    model: cfg.modelId,
    ...anthropicModelOptions(cfg, opts.maxTokens),
    messages: turns,
    tools: opts.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
    stream: false,
    ...(systemMsg ? { system: systemMsg } : {}),
  });

  const text = await rawRequest(url, headers, body, opts.signal, "Anthropic");
  const json = JSON.parse(text) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    stop_reason?: string;
  };
  const blocks = json.content ?? [];
  const contentText = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      args: (b.input as Record<string, unknown>) ?? {},
    }));
  return {
    content: contentText,
    toolCalls,
    stopReason: toolCalls.length > 0 ? "tools" : "end",
  };
}

/** Map a neutral AgentMsg to an Anthropic message turn.
 *  Tool results become a `user` turn with a `tool_result` content block
 *  (Anthropic's shape — there is no `tool` role). */
function toAnthropicTurn(m: AgentMsg): { role: string; content: unknown } {
  switch (m.role) {
    case "system":
      // Handled separately as the top-level `system`; shouldn't reach here,
      // but emit as a user turn defensively if it does.
      return { role: "user", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      if (m.toolCalls && m.toolCalls.length > 0) {
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
        }
        return { role: "assistant", content: blocks };
      }
      return { role: "assistant", content: m.content };
    case "tool":
      return {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      };
  }
}

// --- shared transport (non-streaming) -------------------------------------

/** One non-streaming POST. Routes through Tauri `llm_fetch` under the desktop
 *  shell (same reason as llm.ts: the webview's fetch hits a doubled
 *  Access-Control-Allow-Origin on cross-origin LLM providers), else `fetch`
 *  through the z.ai dev proxy rewrite. */
async function rawRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal | undefined,
  protocolLabel: string,
): Promise<string> {
  if (isTauri()) {
    // Reuse the Rust side's non-streaming path: it returns the full SSE/text
    // body over the channel when stream=false. We don't need a parse callback
    // for a non-streaming response — the full body arrives in one message.
    const { invoke, Channel } = await import("@tauri-apps/api/core");
    const chan = new Channel<string>();
    const chunks: string[] = [];
    chan.onmessage = (frame) => chunks.push(frame);
    const out = (await invoke("llm_fetch", {
      url,
      method: "POST",
      headers,
      body,
      stream: false,
      onEvent: chan,
    })) as string;
    // Tauri returns the assembled body directly for non-streaming calls.
    return out ?? chunks.join("");
  }
  const res = await fetch(devProxyUrl(url), { method: "POST", headers, body, signal });
  if (!res.ok) throw new Error(`${protocolLabel} HTTP ${res.status}: ${await res.text()}`);
  return await res.text();
}

function parseArgs(raw: string, callId: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Malformed arguments — return an empty object rather than killing the
    // loop; the model sees the failed tool result and can self-correct.
    return { __parseError: `could not parse arguments for tool call ${callId}` };
  }
}

// --- small URL helpers (duplicated from llm.ts, which keeps them private) --

function joinPath(base: string, path: string): string {
  if (!path) return base;
  if (base.endsWith("/")) return base + path.replace(/^\/+/, "");
  return base + "/" + path.replace(/^\/+/, "");
}

/** Rewrite z.ai URLs to the same-origin dev proxy in browser dev (see
 *  llm.ts:314). No-op under Tauri or the hosted webapp. */
function devProxyUrl(url: string): string {
  if (typeof window === "undefined") return url;
  try {
    if (url.startsWith("https://api.z.ai/")) {
      return `/llm/zai/${url.slice("https://api.z.ai/".length)}`;
    }
  } catch {
    /* not in a browser — return as-is */
  }
  return url;
}
