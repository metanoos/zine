/**
 * Run — kick off an in-app agent loop.
 *
 * The modal the MODEL row's Run button opens. An agent run takes a freeform
 * goal, creates a sandboxed subfolder under the current scope, and works there
 * via a tool-calling loop — think/act/write, with optional fan-out to
 * subagents running different models (each a distinct voice/color). Everything
 * it writes is DRAFT until the human author Steps it; nothing steps here.
 *
 * The modal is just the entry surface: a textarea for the goal, a model picker
 * for the root agent, and Start. The actual loop lives in agent-loop.ts and is
 * invoked via the `onStart` callback the host wires up.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProviderConfig } from "./models-store.js";

export interface RunModalProps {
  /** Configured providers, for the root-model dropdown. */
  providers: ProviderConfig[];
  /** The currently active provider id (default selection). */
  defaultProviderId: string | null;
  /** Called with the goal + chosen provider when the user clicks Start. */
  onStart: (goal: string, providerId: string) => void;
  onClose: () => void;
}

/** Modal overlay + dialog for composing an agent-run goal. Mirrors the
 *  compose-overlay / compose-dialog shell AttestModal uses. */
export function RunModal({ providers, defaultProviderId, onStart, onClose }: RunModalProps) {
  const [goal, setGoal] = useState("");
  const [providerId, setProviderId] = useState(
    defaultProviderId && providers.some((p) => p.id === defaultProviderId)
      ? defaultProviderId
      : providers[0]?.id ?? "",
  );
  const ref = useRef<HTMLTextAreaElement>(null);

  // Autofocus the textarea on open, so typing begins immediately.
  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Enter starts (Shift+Enter for newline); Escape closes.
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  function commit() {
    const trimmed = goal.trim();
    if (!trimmed || !providerId) return;
    onStart(trimmed, providerId);
  }

  return createPortal(
    <div className="compose-overlay run-overlay" onClick={onClose}>
      <div className="compose-dialog run-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="run-head">
          <h2 className="run-title">Run an agent</h2>
          <button type="button" className="attest-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="run-blurb">
          Describe a goal. The agent creates a subfolder under the current scope, works there
          (reading, writing, thinking), and can fan out to subagents on other models. Everything
          it writes stays draft until you Step it.
        </p>
        <textarea
          ref={ref}
          className="run-goal-input"
          placeholder="e.g. Research the trade-offs between CRDTs and operation logs for local-first apps, then draft a comparison."
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          onKeyDown={onKeyDown}
          rows={6}
        />
        <div className="run-foot">
          <select
            className="run-model-select"
            value={providerId}
            onChange={(e) => setProviderId(e.target.value)}
            disabled={providers.length === 0}
            title="Root model for the agent run"
          >
            {providers.length === 0 ? (
              <option value="">add a model…</option>
            ) : (
              providers.map((p) => (
                <option key={p.id} value={p.id}>{p.label || p.modelId || p.id}</option>
              ))
            )}
          </select>
          <button
            type="button"
            className="run-start"
            onClick={commit}
            disabled={!goal.trim() || !providerId}
            title="Start the agent run (Enter)"
          >
            Start
          </button>
        </div>
        <p className="run-hint">
          Enter to start · Shift+Enter for a new line · Esc to close
        </p>
      </div>
    </div>,
    document.body,
  );
}
