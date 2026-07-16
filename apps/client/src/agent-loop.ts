/**
 * The in-app agent loop — a tool-calling ReAct driver that runs on the MODEL
 * voice(s) and writes everything into a sandboxed per-run subfolder.
 *
 * Design constraints (see the plan + the provenance model):
 *   - NEVER steps. Drafts are `FileState` entries with `nodeId: ""`; the
 *     per-render files effect mirrors them to the crash pad and nothing more.
 *     The only thing that steps is a human Step.
 *   - Per-model voice: each distinct model gets its own deterministic Nostr
 *     voice (model-voice.ts), so the fan-out renders as a multi-color tree.
 *   - Fan-out via recursion: `dispatch_subagent` spawns a child loop in a
 *     child subfolder. Different `model_id` ⇒ different voice/color.
 *
 * The driver is framework-agnostic: it takes an `AgentCtx` (the small surface
 * it needs from the app) so it can be unit-tested without React. The app wires
 * the concrete `AgentCtx` in App.tsx.
 */

import type { Run } from "./workspace-core.js";
import type { ProviderConfig } from "./models-store.js";
import { completeWithTools, type AgentMsg, type ToolCall, type ToolSpec, type ToolTurn } from "./agent-llm.js";
import { ensureModelVoice } from "./model-voice.js";

/** The transport function the loop calls each turn. Mirrors
 *  `completeWithTools` so the real one is passed straight through; tests inject
 *  a scripted stub. Kept as a property of AgentCtx (not a monkey-patch) because
 *  ESM module exports are frozen and can't be reassigned at runtime. */
export type Transport = typeof completeWithTools;

/** What the loop needs from the host app. Kept minimal so the driver is
 *  unit-testable without React/workspace plumbing. */
export interface AgentCtx {
  /** The 32-byte browser Nostr secret — the HKDF root for per-model voices. */
  nostrSecret: Uint8Array;
  /** Resolve a model reference (id or label) to a ProviderConfig, or null.
   *  Used for the root model and for `dispatch_subagent`'s optional model_id. */
  resolveModel: (ref: string) => ProviderConfig | null;
  /** Read a file's flattened text by relative path. Returns null if absent. */
  readFile: (path: string) => string | null;
  /** List the relative paths under a prefix (or all files if empty). */
  listFiles: (prefix?: string) => string[];
  /** Write a DRAFT file: set files state with runs attributed to `voice`,
   *  nodeId "". Never steps. */
  writeDraft: (path: string, runs: Run[]) => void;
  /** Append to an existing draft (or create it). Attributed to `voice`. */
  appendDraft: (path: string, voice: string, text: string) => void;
  /** The scope-relative root path of this run's sandbox folder. */
  runPath: string;
  /** Optional gathered context block for the root goal (preamble only). */
  seedContext?: string;
  /** Override the LLM transport — defaults to the real completeWithTools.
   *  Tests inject a scripted stub here. */
  transport?: Transport;
}

export interface RunOptions {
  goal: string;
  /** The root model to run with. Defaults to ctx's first resolvable model. */
  model: ProviderConfig;
  signal: AbortSignal;
  /** Recursion depth — root runs start at 0. Caps fan-out breadth. */
  depth?: number;
  /** Override for tests; production reads MAX_STEPS. */
  maxSteps?: number;
}

/** Max ReAct iterations per loop before forcing a terminal write. */
export const MAX_STEPS = 12;
/** Max subagent recursion depth (root is depth 0). */
export const MAX_DEPTH = 2;

/** The system preamble for an agent run. Extends the zine writing rules with
 *  tool-use guidance and the no-step posture. */
export const AGENT_PREAMBLE = [
  "You are an agent running inside zine, a provenance-tracked writing tool.",
  "You operate by calling tools to read and write files inside your private",
  "run folder, then producing a final answer. Everything you write is a DRAFT",
  "that the human author must deliberately save (Step) — you never publish or",
  "step anything yourself.",
  "",
  "Rules:",
  "- Use write_file / append_file to keep notes, plans, and drafts in your run",
  "  folder. Files are how your thinking persists between turns.",
  "- Use read_file / list_files to inspect your own folder AND the surrounding",
  "  scope (read-only) so you understand the work around you.",
  "- To tackle an independent sub-problem in parallel, call dispatch_subagent",
  "  with a focused goal. A different model_id gives a distinct voice/color.",
  "- When the goal is met, respond with your final answer as plain text (no",
  "  tool calls). That text is written to output.md and returned to your",
  "  caller; it is the deliverable.",
  "- Keep tool calls focused: one logical action per call.",
].join("\n");

/** The v1 tool catalog (specs + the executor). */
const TOOL_SPECS: ToolSpec[] = [
  {
    name: "write_file",
    description: "Overwrite a file in the run folder with the given content. Creates the file if absent.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filename or relative path within the run folder (e.g. 'plan.md', 'research/notes.md')." },
        content: { type: "string", description: "The full file contents to write." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "append_file",
    description: "Append text to a file in the run folder (creates it if absent). Use for incremental notes/logs.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Filename or relative path within the run folder." },
        content: { type: "string", description: "The text to append." },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's contents. Reads from the run folder, or (read-only) from the surrounding scope.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Relative path to read." } },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List relative file paths under a prefix. Omit the prefix to list the whole scope.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Optional prefix (folder) to list under." } },
    },
  },
  {
    name: "dispatch_subagent",
    description: "Spawn a child agent for an independent sub-goal. It runs in its own subfolder and may use a different model (different voice/color). Returns the child's output.md.",
    parameters: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The focused sub-goal for the child agent." },
        model_id: { type: "string", description: "Optional model id or label for the child. Defaults to the parent's model." },
      },
      required: ["goal"],
    },
  },
];

/** Resolve a path into the run folder, guarding against `../` escapes. */
function inRun(ctx: AgentCtx, rel: string): string {
  const clean = rel.replace(/^\/+/, "");
  // Block path traversal out of the run folder.
  if (clean.includes("..")) return `${ctx.runPath}/${clean.replace(/\.\.\//g, "")}`;
  return `${ctx.runPath}/${clean}`;
}

/** Execute one tool call against the ctx. Returns the string result for the
 *  model (fed back as a `tool` message). */
async function execTool(
  ctx: AgentCtx,
  tc: ToolCall,
  env: { voice: string; model: ProviderConfig; depth: number; signal: AbortSignal },
): Promise<string> {
  switch (tc.name) {
    case "write_file": {
      const path = String(tc.args.path ?? "");
      const content = String(tc.args.content ?? "");
      if (!path) return "error: write_file requires a path";
      ctx.writeDraft(inRun(ctx, path), [{ voice: env.voice, text: content }]);
      return `wrote ${inRun(ctx, path)} (${content.length} chars)`;
    }
    case "append_file": {
      const path = String(tc.args.path ?? "");
      const content = String(tc.args.content ?? "");
      if (!path) return "error: append_file requires a path";
      ctx.appendDraft(inRun(ctx, path), env.voice, content);
      return `appended ${content.length} chars to ${inRun(ctx, path)}`;
    }
    case "read_file": {
      const path = String(tc.args.path ?? "");
      if (!path) return "error: read_file requires a path";
      // Try the run folder first, then the surrounding scope (read-only).
      const inRunPath = inRun(ctx, path);
      const found = ctx.readFile(inRunPath) ?? ctx.readFile(path);
      return found ?? `error: ${path} not found`;
    }
    case "list_files": {
      const prefix = tc.args.path ? String(tc.args.path) : undefined;
      const all = ctx.listFiles(prefix);
      // Show run-folder files first (the agent's own work), then the rest.
      const own = all.filter((p) => p.startsWith(ctx.runPath));
      const rest = all.filter((p) => !p.startsWith(ctx.runPath));
      return [...own, ...(rest.length ? ["--- surrounding scope (read-only) ---", ...rest] : [])].join("\n");
    }
    case "dispatch_subagent": {
      const goal = String(tc.args.goal ?? "");
      if (!goal) return "error: dispatch_subagent requires a goal";
      if (env.depth >= MAX_DEPTH) {
        return `error: max subagent depth (${MAX_DEPTH}) reached — cannot spawn further subagents`;
      }
      const modelRef = tc.args.model_id ? String(tc.args.model_id) : null;
      const childModel = modelRef ? ctx.resolveModel(modelRef) ?? env.model : env.model;
      // Child runs in <runPath>/<slug>-<id>/.
      const slug = slugify(goal).slice(0, 24) || "sub";
      const childPath = `${ctx.runPath}/${slug}-${shortId()}`;
      const childCtx: AgentCtx = { ...ctx, runPath: childPath };
      try {
        const out = await runAgentLoop(childCtx, {
          goal,
          model: childModel,
          signal: env.signal,
          depth: env.depth + 1,
        });
        return out || "(subagent produced no output)";
      } catch (e) {
        return `subagent error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    default:
      return `error: unknown tool "${tc.name}"`;
  }
}

/**
 * The recursive ReAct driver. Runs one agent (one model, one voice) to
 * completion against `ctx`, returning the terminal answer text (also written
 * to `<runPath>/output.md`).
 */
export async function runAgentLoop(ctx: AgentCtx, opts: RunOptions): Promise<string> {
  const depth = opts.depth ?? 0;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const call = ctx.transport ?? completeWithTools;
  const voice = ensureModelVoice(ctx.nostrSecret, opts.model.modelId, opts.model.label);
  const log: AgentMsg[] = [
    { role: "system", content: AGENT_PREAMBLE },
    { role: "user", content: opts.goal + (ctx.seedContext ? `\n\n=== SURROUNDING CONTEXT ===\n${ctx.seedContext}` : "") },
  ];

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal.aborted) break;
    const turn: ToolTurn = await call(opts.model, log, {
      tools: TOOL_SPECS,
      maxTokens: 4096,
      signal: opts.signal,
    });

    // Terminal turn — no tool calls. Write the answer and return it.
    if (turn.toolCalls.length === 0) {
      if (turn.content) {
        ctx.writeDraft(`${ctx.runPath}/output.md`, [{ voice: voice.pubkey, text: turn.content }]);
      }
      return turn.content;
    }

    // Tool turn — record the assistant message, execute every tool call
    // (parallel fan-out when the model emits multiple calls in one turn),
    // and feed each result back as a tool message.
    log.push({ role: "assistant", content: turn.content, toolCalls: turn.toolCalls });
    const results = await Promise.all(
      turn.toolCalls.map((tc) =>
        execTool(ctx, tc, { voice: voice.pubkey, model: opts.model, depth, signal: opts.signal }),
      ),
    );
    turn.toolCalls.forEach((tc, i) =>
      log.push({ role: "tool", toolCallId: tc.id, content: results[i] }),
    );
  }

  // Budget exhausted — write a marker and return a summary so a parent
  // subagent caller still gets a string (never an unhandled rejection).
  const notice = `(agent reached the ${maxSteps}-step budget without finishing)`;
  ctx.appendDraft(`${ctx.runPath}/output.md`, voice.pubkey, notice);
  return notice;
}

// --- small helpers --------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function shortId(): string {
  // Enough entropy to avoid sibling-subfolder collisions within one run.
  return Math.random().toString(16).slice(2, 8);
}
