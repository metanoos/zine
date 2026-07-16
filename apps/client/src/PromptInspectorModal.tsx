/**
 * Prompt inspector — see exactly what a single-shot LLM op would send.
 *
 * Opens when the user clicks the `~tokens` indicator beside the op buttons
 * (App.tsx threads `onInspect` onto `.action-palette-token-count`). Shows the full
 * `messages[]` layout a chosen op (Extend / Settle / Stir / Reply / Receive)
 * would hand to `complete()` against the op-target panel's focused file and
 * the current scope:
 *
 *   1. system — the MODEL voice's voice prompt (if any), spliced in first
 *   2. system — SYSTEM_PREAMBLE + the op's role preamble
 *   3. user   — the injected context block (=== CONTEXT === … === END CONTEXT ===)
 *   4. user   — the op body (seed / loose prose / source / limelight log)
 *
 * This is the pre-send view that was missing: the provenance reconstructor
 * (LlmReconstructPanel) shows the same shape for a STEPPED past call, but until
 * this modal there was no way to see what an op is ABOUT to send. Both read the
 * same builders (op-prompts.ts), so the preview is faithful by construction.
 *
 * The modal is a pure presentation layer: App.tsx derives the per-op inputs
 * (seed from the editor selection, loose prose via partitionDoc, etc.) and the
 * context block, then passes them in. Keeping the editor/parser coupling in
 * App.tsx matches RunModal's pattern (App owns logic, modal is the surface).
 *
 * Cheap inputs are derived live (Extend seed, Settle/Stir loose prose). Relay-
 * fetched inputs (Reply's minted traces, Receive's limelight log) can't be
 * reconstructed without a fetch, so they're shown as an honest note rather than
 * an empty box — the user sees what's missing and why.
 *
 * Agent-run insight is NOT here: the Run/agent-loop path injects differently
 * (AGENT_PREAMBLE, not SYSTEM_PREAMBLE; tool specs; a per-step ReAct log that
 * doesn't exist pre-send). That's flagged for follow-on work.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildOpMessages,
  OP_ORDER,
  OP_LABELS,
  type OpKind,
  type OpInputs,
} from "./op-prompts.js";

export interface PromptInspectorProps {
  /** The op to show first. Defaults to "extend". */
  defaultOp: OpKind;
  /** Pre-derived per-op inputs, keyed by op. App.tsx fills these from the live
   *  editor + scope (seed from selection, loose prose via partitionDoc, etc.).
   *  An op absent from the map renders with empty/default inputs. */
  inputs: Partial<Record<OpKind, OpInputs>>;
  /** Per-op notes for inputs that couldn't be derived without a relay fetch
   *  (e.g. Reply's minted traces, Receive's limelight log). Shown inline. */
  inputNotes?: Partial<Record<OpKind, string>>;
  /** The rendered context block (=== CONTEXT === … === END CONTEXT ===), or ""
   *  when no folder is attached / no file is active. Shared across all ops. */
  contextBlock: string;
  /** Whether the op-target file has been stepped (has a published kind-4290
   *  chain head). When false AND a context block is present, the delta-log
   *  section will omit this file's edits (it has no published history yet) —
   *  the modal surfaces an explanatory note so that absence reads as "not yet
   *  published," not "missing." True when `files[activePath].nodeId` is set. */
  activeFileStepped: boolean;
  /** The MODEL voice's custom prompt (voice-prompt-store), or "" if none. */
  voicePrompt: string;
  /** The resolved provider/model label for the header, or null. */
  modelLabel: string | null;
  /** Estimates total payload tokens from char count. Passed in so the modal
   *  uses the same ~4 chars/token heuristic as the action-palette indicator. */
  estimateTokens: (chars: number) => number;
  onClose: () => void;
}

/** One row in the message stack. */
interface MsgRow {
  role: "system" | "user" | "assistant";
  content: string;
  /** Stable key for React. */
  key: string;
  /** A short label rendered above the <pre>. */
  label: string;
  /** Optional hint shown after the label (e.g. "injected", "MODEL voice"). */
  hint?: string;
}

export function PromptInspectorModal({
  defaultOp,
  inputs,
  inputNotes,
  contextBlock,
  activeFileStepped,
  voicePrompt,
  modelLabel,
  estimateTokens,
  onClose,
}: PromptInspectorProps) {
  const [op, setOp] = useState<OpKind>(defaultOp);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Build the op's base messages (system + user body), then apply the same
  // wrappers the live op uses: voice prompt spliced as the leading system
  // message, context block prepended to the first user message. This mirrors
  // withContext(withVoicePrompt(...)) in App.tsx exactly.
  const { rows, totalChars } = useMemo(() => {
    const base = buildOpMessages(op, inputs[op] ?? {});
    // Splice the voice prompt as the leading system message (matches
    // withVoicePrompt: only when non-empty).
    const withVoice =
      voicePrompt.trim().length > 0
        ? [{ role: "system" as const, content: voicePrompt.trim() }, ...base]
        : base;
    // Prepend the context block to the first user message (matches withContext).
    const idx = withVoice.findIndex((m) => m.role === "user");
    const withCtx =
      contextBlock && idx >= 0
        ? withVoice.map((m, i) =>
            i === idx ? { ...m, content: `${contextBlock}\n\n${m.content}` } : m,
          )
        : withVoice;

    const out: MsgRow[] = withCtx.map((m, i) => {
      const isVoice = voicePrompt.trim().length > 0 && i === 0 && m.role === "system";
      const isFirstUser = m.role === "user" && withCtx.slice(0, i).every((x) => x.role !== "user");
      const ctxPresent = contextBlock.length > 0;
      let label = "";
      let hint: string | undefined;
      if (m.role === "system") {
        label = "System prompt";
        if (isVoice) hint = "MODEL voice";
      } else if (m.role === "user") {
        if (isFirstUser && ctxPresent) {
          label = "User message";
          hint = "context block + op body";
        } else {
          label = "Op body";
        }
      } else {
        label = "Assistant";
      }
      return { role: m.role, content: m.content, key: `${m.role}-${i}`, label, hint };
    });

    const chars = withCtx.reduce((n, m) => n + m.content.length, 0);
    return { rows: out, totalChars: chars };
  }, [op, inputs, voicePrompt, contextBlock]);

  const note = inputNotes?.[op];

  return createPortal(
    <div className="compose-overlay prompt-inspector-overlay" onClick={onClose}>
      <div
        className="compose-dialog prompt-inspector-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Prompt inspector"
      >
        <div className="run-head">
          <h2 className="run-title">Prompt inspector</h2>
          <button type="button" className="attest-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="run-blurb">
          What the selected op would send to the LLM against the focused file + current scope.
          Switch tabs to see each op. The context block and voice prompt are shared.
        </p>

        <div className="prompt-inspector-tabs" role="tablist">
          {OP_ORDER.map((o) => (
            <button
              key={o}
              type="button"
              role="tab"
              aria-selected={o === op}
              className={`prompt-inspector-tab${o === op ? " active" : ""}`}
              onClick={() => setOp(o)}
            >
              {OP_LABELS[o]}
            </button>
          ))}
        </div>

        <div className="prompt-inspector-meta">
          {modelLabel ? <span className="prompt-inspector-model">{modelLabel}</span> : null}
          <span className="prompt-inspector-size">
            {estimateTokens(totalChars).toLocaleString()} tokens · {totalChars.toLocaleString()} chars
          </span>
          {voicePrompt.trim().length > 0 ? (
            <span className="prompt-inspector-flag" title="The MODEL voice has a custom prompt spliced in">
              voice prompt
            </span>
          ) : null}
          {contextBlock.length > 0 ? (
            <span className="prompt-inspector-flag" title="A context block is injected into the user message">
              context block
            </span>
          ) : (
            <span className="prompt-inspector-flag muted" title="No folder attached or no file active">
              no context
            </span>
          )}
        </div>

        {note ? <p className="prompt-inspector-note">{note}</p> : null}
        {/* The delta log is built from published kind-4290 trace nodes, which
            only exist after a step. An unstepped file has no history on the
            relay, so its edits won't appear under the directory-log header —
            surface that so the absence reads as "not yet published," not
            "missing." (The live ops see the exact same empty log; this note
            makes the gap legible because the inspector exposes the prompt.) */}
        {contextBlock.length > 0 && !activeFileStepped ? (
          <p className="prompt-inspector-note">
            The active file isn’t stepped yet, so its edit history isn’t in the
            delta log — the directory-log section lists only already-published
            files. Step the file once to publish its chain; the log populates
            on the next gather (no reopen needed).
          </p>
        ) : null}

        <div className="prompt-inspector-body">
          {rows.length === 0 ? (
            <p className="muted">No messages for this op.</p>
          ) : (
            rows.map((r) => (
              <section className="llm-recon-section prompt-inspector-row" key={r.key}>
                <span className="llm-recon-label">
                  {r.label}
                  {r.hint ? <span className="prompt-inspector-hint"> · {r.hint}</span> : null}
                </span>
                <pre className="llm-recon-pre">{r.content || "(empty)"}</pre>
              </section>
            ))
          )}
        </div>

        <p className="run-hint">
          Esc to close · click a tab to switch op
        </p>
      </div>
    </div>,
    document.body,
  );
}
