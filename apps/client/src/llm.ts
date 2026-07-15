/**
 * Dual-protocol LLM client. Plain `fetch` — no SDK — so the bundle stays lean
 * and both protocols share one codepath shape. The dispatcher `complete()`
 * picks the request format by `cfg.protocol`:
 *
 *   - "openai"    → POST {baseUrl}/chat/completions  (Authorization: Bearer)
 *   - "anthropic" → POST {baseUrl}/v1/messages        (x-api-key + version)
 *
 * Both support optional SSE streaming: the caller passes an `onDelta` callback
 * and receives content chunks as they arrive; without it, the call resolves to
 * the full text in one shot. An AbortController is threaded through so the
 * caller can cancel a streaming response (the user hit Stop).
 *
 * Provider coverage (see models-store.ts presets):
 *   z.ai (Anthropic)  https://api.z.ai/api/anthropic   [glm-4.6]
 *   z.ai (OpenAI)     https://api.z.ai/api/paas/v4     [glm-4.6]
 *   Anthropic         https://api.anthropic.com        [claude-sonnet-4-5]
 *   OpenAI            https://api.openai.com/v1        [gpt-4o]
 *   OpenRouter        https://openrouter.ai/api/v1     [router model ids]
 *   Ollama (local)    http://localhost:11434/v1        [local model]
 * Any OpenAI-compatible endpoint (Together, Groq, LM Studio…) works by adding
 * a custom provider — that's the point of the generic shape.
 */

import type { ProviderConfig } from "./models-store.js";
import { isTauri } from "./identity.js";

/** Chat-role message, normalized across both protocols. The client translates
 *  to the wire format each protocol expects. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOptions {
  /** Max output tokens. Optional — let the provider default apply if unset. */
  maxTokens?: number;
  /** If set, stream content deltas as they arrive; otherwise resolve full. */
  onDelta?: (textDelta: string) => void;
  /** Cancel signal for a streaming request. */
  signal?: AbortSignal;
}

/** Dispatch by protocol. Returns the full assembled text (for non-streaming)
 *  or the concatenated deltas (for streaming). Throws on HTTP/network error
 *  with a message that surfaces cleanly in the sampler-status convention. */
export async function complete(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: CompleteOptions = {},
): Promise<string> {
  if (!cfg.baseUrl) throw new Error(`provider "${cfg.label}" has no base URL`);
  if (!cfg.modelId) throw new Error(`provider "${cfg.label}" has no model id`);
  return cfg.protocol === "anthropic"
    ? callAnthropic(cfg, messages, opts)
    : callOpenAI(cfg, messages, opts);
}

// --- OpenAI Chat Completions -------------------------------------------

async function callOpenAI(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: CompleteOptions,
): Promise<string> {
  const url = joinPath(cfg.baseUrl, "chat/completions");
  const stream = !!opts.onDelta;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;

  const body = JSON.stringify({
    model: cfg.modelId,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    stream,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
  });

  const text = await doRequest(url, headers, body, stream, opts, "OpenAI");

  if (stream) return text; // deltas already assembled by doRequest
  const json = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

// --- Anthropic Messages ------------------------------------------------

async function callAnthropic(
  cfg: ProviderConfig,
  messages: ChatMessage[],
  opts: CompleteOptions,
): Promise<string> {
  const url = joinPath(cfg.baseUrl, "v1/messages");
  const stream = !!opts.onDelta;
  // Anthropic separates the system prompt from the message list.
  const systemMsg = messages.find((m) => m.role === "system")?.content;
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (cfg.apiKey) headers["x-api-key"] = cfg.apiKey;

  const body = JSON.stringify({
    model: cfg.modelId,
    max_tokens: opts.maxTokens ?? 4096,
    messages: turns,
    ...(systemMsg ? { system: systemMsg } : {}),
    stream,
  });

  const text = await doRequest(url, headers, body, stream, opts, "Anthropic");

  if (stream) return text; // deltas already assembled by doRequest
  const json = JSON.parse(text) as {
    content?: Array<{ type: string; text?: string }>;
  };
  return (json.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
}

// --- transport dispatch ------------------------------------------------

/** Dispatch a request to the right transport: under Tauri, route through the
 *  Rust `llm_fetch` command (native HTTP — the webview's `fetch` can't reliably
 *  reach cross-origin LLM providers: responses arrive with a doubled
 *  `Access-Control-Allow-Origin` that browsers reject). In a plain browser,
 *  fall back to direct `fetch` + `consumeSSE` — same codepath the desktop shell
 *  used before the proxy existed.
 *
 *  Browser dev caveat: z.ai's gateway double-stamps `Access-Control-Allow-
 *  Origin`, which no direct fetch survives. `devProxyUrl()` rewrites z.ai URLs
 *  to the same-origin `/llm/zai` dev proxy (vite.config.ts) so the request
 *  never leaves the page origin. Tauri and the hosted webapp have their own
 *  non-CORS paths (native `llm_fetch` / a server-side proxy) and bypass this.
 *
 *  For streaming: the `parse` callback is applied per SSE event (data string),
 *  deltas are forwarded to `opts.onDelta`, and the concatenated text is
 *  returned — identical semantics to `consumeSSE`, which the fetch path still
 *  uses under the hood.
 *
 *  `protocolLabel` only flavors the thrown error message so callers keep their
 *  "OpenAI HTTP …" / "Anthropic HTTP …" status convention. */
async function doRequest(
  url: string,
  headers: Record<string, string>,
  body: string,
  stream: boolean,
  opts: CompleteOptions,
  protocolLabel: string,
): Promise<string> {
  if (isTauri()) {
    return completeViaTauri(url, headers, body, stream, opts, protocolLabel);
  }
  const res = await fetch(devProxyUrl(url), {
    method: "POST",
    headers,
    body,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`${protocolLabel} HTTP ${res.status}: ${await safeText(res)}`);
  if (!stream) return await res.text();
  // Parse per the protocol that issued this request — the dispatch keeps the
  // closure so consumeSSE stays the single streaming consumer.
  const parse =
    protocolLabel === "Anthropic"
      ? (data: string) => {
          try {
            const evt = JSON.parse(data) as { type?: string; delta?: { text?: string } };
            if (evt.type === "content_block_delta") return evt.delta?.text ?? "";
            return "";
          } catch {
            return "";
          }
        }
      : (data: string) => {
          if (data === "[DONE]") return "";
          try {
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            return chunk.choices?.[0]?.delta?.content ?? "";
          } catch {
            return ""; // keep-alive or partial — ignore
          }
        };
  return consumeSSE(res, opts, parse);
}

/** Tauri transport: invoke the Rust `llm_fetch` command, receiving SSE events
 *  (or the full body for non-streaming calls) over an IPC channel. The Rust
 *  side does SSE framing only; `parse` interprets each event the same way the
 *  fetch path would. The AbortController is honored on both sides — the webview
 *  still owns `opts.signal`, and cancelling it rejects the invoke promise. */
async function completeViaTauri(
  url: string,
  headers: Record<string, string>,
  body: string,
  stream: boolean,
  opts: CompleteOptions,
  protocolLabel: string,
): Promise<string> {
  const { Channel, invoke } = await import("@tauri-apps/api/core");
  const parse =
    protocolLabel === "Anthropic"
      ? (data: string) => {
          try {
            const evt = JSON.parse(data) as { type?: string; delta?: { text?: string } };
            if (evt.type === "content_block_delta") return evt.delta?.text ?? "";
            return "";
          } catch {
            return "";
          }
        }
      : (data: string) => {
          if (data === "[DONE]") return "";
          try {
            const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
            return chunk.choices?.[0]?.delta?.content ?? "";
          } catch {
            return "";
          }
        };

  let assembled = "";
  const channel = new Channel<string>();
  channel.onmessage = (data) => {
    if (!stream) {
      // Non-streaming: the single message carries the full response body.
      assembled = data;
      return;
    }
    const delta = parse(data);
    if (delta) {
      assembled += delta;
      opts.onDelta?.(delta);
    }
  };

  await invoke("llm_fetch", {
    url,
    method: "POST",
    headers,
    body,
    stream,
    onEvent: channel,
  });
  return assembled;
}

// --- SSE plumbing ------------------------------------------------------

/** Drain an SSE stream, invoking `parse` per `data:` payload to extract a text
 *  delta. Returns the concatenated text when the stream closes. This is the
 *  shared streaming core — both protocols frame deltas as `data: <json>\n\n`. */
async function consumeSSE(
  res: Response,
  opts: CompleteOptions,
  parse: (data: string) => string,
): Promise<string> {
  if (!res.body) throw new Error("streaming response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assembled = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE events are separated by a blank line; process complete ones.
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLines = rawEvent
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (dataLines.length === 0) continue;
        const delta = parse(dataLines.join("\n"));
        if (delta) {
          assembled += delta;
          opts.onDelta?.(delta);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return assembled;
}

/** Join `base` and `path` without doubling slashes. Handles providers whose
 *  baseUrl already ends in `/v1` (OpenAI) and those that don't (Anthropic's
 *  api.anthropic.com → /v1/messages). */
function joinPath(base: string, path: string): string {
  const left = base.replace(/\/+$/, "");
  const right = path.replace(/^\/+/, "");
  return `${left}/${right}`;
}

/** Rewrite a z.ai provider URL to the same-origin dev proxy so a browser
 *  webapp can reach it despite z.ai's doubled `Access-Control-Allow-Origin`.
 *  Other providers, Tauri, and the hosted webapp are left untouched.
 *
 *  The proxy is a dev affordance: it only exists while `vite dev` serves the
 *  page, so detection keys off both `isTauri()` (skip — native path instead)
 *  and `import.meta.env.DEV` (skip in a prod build). `vite-plugin`'s
 *  `/llm/zai` prefix is fixed in vite.config.ts; the rewrite mirrors the
 *  proxy's `rewrite`, so `/llm/zai/api/anthropic/v1/messages` → z.ai path.
 *  The proxy target is hardcoded to api.z.ai (Vite's dynamic `router` is
 *  unreliable), so this only intercepts z.ai URLs. */
function devProxyUrl(url: string): string {
  if (isTauri()) return url;
  if (!import.meta.env.DEV) return url;
  if (!url.startsWith("https://api.z.ai/")) return url;
  const path = url.slice("https://api.z.ai".length); // keep leading slash
  return `/llm/zai${path}`;
}

/** Best-effort error body read, size-capped so a 5xx HTML page doesn't blow
 *  the message. Returns the status text if the body is empty/unreadable. */
async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 500 ? text.slice(0, 500) + "…" : text;
  } catch {
    return res.statusText;
  }
}
