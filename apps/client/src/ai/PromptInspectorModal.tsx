/**
 * Prompt inspector — see exactly what a single-shot LLM op would send.
 *
 * Opens when the user clicks the `~tokens` indicator beside the op buttons
 * (App.tsx threads `onInspect` onto `.action-palette-token-count`). Shows the full
 * `messages[]` layout a chosen op (Extend / Settle / Stir / Reply / Analyze)
 * would send against the op-target panel's focused file and current scope:
 *
 *   1. system — provider-card personality/instructions (if any)
 *   2. system — SYSTEM_PREAMBLE + op role + optional voice/lens layers
 *   3. user   — injected context block + op body
 *
 * This is a pre-send view: there is no attempt to rebuild a past call from
 * incomplete provenance. App passes the immutable PreparedOperation itself;
 * this component renders its exact messages and returns that same object when
 * the user approves it. It never runs prompt builders.
 *
 * The modal is a pure presentation layer. App owns editor/parser coupling,
 * canonical gathering, preparation, invalidation, and execution.
 *
 * Cheap inputs are derived live (Extend seed, Settle/Stir loose prose). Relay-
 * fetched inputs (Reply's minted traces, Analyze's limelight log) are captured
 * by App when the modal opens. Fetch failures are shown as honest notes.
 *
 * Agent-run insight is NOT here: the Run/agent-loop path injects differently
 * (AGENT_PREAMBLE, not SYSTEM_PREAMBLE; tool specs; a per-step ReAct log that
 * doesn't exist pre-send). That's flagged for follow-on work.
 */

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  OP_ORDER,
  OP_LABELS,
  type OpKind,
} from "./op-prompts.js";
import { OP_LENSES, lensForOp, type OpLensId, type OpLensSelections } from "./op-lenses.js";
import type { ProviderConfig } from "./models-store.js";
import type { PreparedOperation } from "./prepared-operation.js";

export interface PromptInspectorProps {
  /** The op to show first. Defaults to "extend". */
  defaultOp: OpKind;
  /** Per-op notes for inputs that couldn't be derived without a relay fetch
   *  (e.g. Reply's minted traces, Analyze's limelight log). Shown inline. */
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
  /** Resolved provider. Its system layer is applied through the live helper. */
  provider: ProviderConfig | null;
  /** Browser-local lens choice for each operation. */
  lensSelections: OpLensSelections;
  onLensChange: (op: OpKind, lensId: OpLensId) => void;
  /** Exact session objects produced by App's canonical preparation path. */
  preparedOperations: Partial<Record<OpKind, PreparedOperation>>;
  preparingOp?: OpKind | null;
  preparationError?: string | null;
  approvedRequestHash?: string | null;
  onOperationChange: (op: OpKind) => void;
  onApprove: (prepared: PreparedOperation) => void;
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
  inputNotes,
  contextBlock,
  activeFileStepped,
  voicePrompt,
  provider,
  lensSelections,
  onLensChange,
  preparedOperations,
  preparingOp,
  preparationError,
  approvedRequestHash,
  onOperationChange,
  onApprove,
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

  const selectedLens = lensForOp(op, lensSelections[op]);
  const preparedOperation = preparedOperations[op] ?? null;
  const effectiveContextBlock = preparedOperation?.contextSnapshot.renderedBlock ?? contextBlock;

  // Inspector never rebuilds. These are the exact frozen messages which
  // completePrepared receives after approval.
  const { rows, totalChars } = useMemo(() => {
    const prepared = preparedOperation?.messages ?? [];
    const hasProviderSystem = Boolean(
      provider?.instructions?.trim() && prepared[0]?.role === "system",
    );

    const out: MsgRow[] = prepared.map((m, i) => {
      const isProviderSystem = hasProviderSystem && i === 0 && m.role === "system";
      const isFirstUser = m.role === "user" && prepared.slice(0, i).every((x) => x.role !== "user");
      const ctxPresent = effectiveContextBlock.length > 0;
      let label = "";
      let hint: string | undefined;
      if (m.role === "system") {
        label = "System prompt";
        hint = isProviderSystem ? "provider card" : "zine role + local layers";
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

    const chars = prepared.reduce((n, m) => n + m.content.length, 0);
    return { rows: out, totalChars: chars };
  }, [preparedOperation, effectiveContextBlock, provider]);

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
              onClick={() => {
                setOp(o);
                onOperationChange(o);
              }}
            >
              {OP_LABELS[o]}
            </button>
          ))}
        </div>

        <label className="prompt-inspector-lens">
          <span>Editorial lens</span>
          <select
            value={selectedLens.id}
            onChange={(event) => onLensChange(op, event.target.value as OpLensId)}
            aria-label={`Editorial lens for ${OP_LABELS[op]}`}
          >
            {OP_LENSES[op].map((lens) => (
              <option key={lens.id} value={lens.id}>{lens.label}</option>
            ))}
          </select>
          <small>{selectedLens.description}</small>
        </label>

        <div className="prompt-inspector-meta">
          {provider ? (
            <span className="prompt-inspector-model">
              {provider.label || provider.protocol} · {provider.modelId}
            </span>
          ) : null}
          <span className="prompt-inspector-size">
            {estimateTokens(totalChars).toLocaleString()} tokens · {totalChars.toLocaleString()} chars
          </span>
          {voicePrompt.trim().length > 0 ? (
            <span className="prompt-inspector-flag" title="The AI voice has a custom preference folded into the operation contract">
              voice prompt
            </span>
          ) : null}
          {selectedLens.id !== "default" ? (
            <span className="prompt-inspector-flag" title="An operation-scoped editorial lens is active">
              {selectedLens.label}
            </span>
          ) : null}
          {effectiveContextBlock.length > 0 ? (
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
        {preparingOp === op ? (
          <p className="prompt-inspector-note">Preparing the exact request…</p>
        ) : null}
        {preparationError ? (
          <p className="prompt-inspector-note">{preparationError}</p>
        ) : null}
        {preparedOperation ? (
          <p className="prompt-inspector-note">
            Context {preparedOperation.contextSnapshot.budget.totalBytes.toLocaleString()} bytes · prompt layers {preparedOperation.budget.promptLayerBytes.toLocaleString()} bytes · fingerprint {preparedOperation.contextFingerprint.slice(0, 12)}…
          </p>
        ) : null}
        {/* The delta log is built from published kind-4290 trace nodes, which
            only exist after a step. An unstepped file has no history on the
            relay, so its edits won't appear under the directory-log header —
            surface that so the absence reads as "not yet published," not
            "missing." (The live ops see the exact same empty log; this note
            makes the gap legible because the inspector exposes the prompt.) */}
        {effectiveContextBlock.length > 0 && !activeFileStepped ? (
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
              <section className="prompt-inspector-row" key={r.key}>
                <span className="prompt-inspector-label">
                  {r.label}
                  {r.hint ? <span className="prompt-inspector-hint"> · {r.hint}</span> : null}
                </span>
                <pre className="prompt-inspector-pre">{r.content || "(empty)"}</pre>
              </section>
            ))
          )}
        </div>

        {preparedOperation ? (
          <button
            type="button"
            className="run-start"
            onClick={() => onApprove(preparedOperation)}
            disabled={approvedRequestHash === preparedOperation.preparedRequestHash}
          >
            {approvedRequestHash === preparedOperation.preparedRequestHash
              ? "Approved for this session"
              : `Approve ${OP_LABELS[op]}`}
          </button>
        ) : null}

        <p className="run-hint">
          Esc to close · click a tab to switch op
        </p>
      </div>
    </div>,
    document.body,
  );
}
