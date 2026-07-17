import { useMemo, useState } from "react";
import { diffLines } from "diff";

import {
  openTraceLocator,
  RelayHintApprovalRequiredError,
  type OpenedTrace,
} from "./trace-handoff.js";
import {
  parseTraceLocator,
  relayHintsRequiringApproval,
  type TraceLocator,
} from "./trace-locator.js";

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}

export function TraceLocatorModal({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState("");
  const [opened, setOpened] = useState<OpenedTrace | null>(null);
  const [pendingApproval, setPendingApproval] = useState<{
    locator: TraceLocator;
    relayHints: string[];
  } | null>(null);
  const [selected, setSelected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const step = opened?.steps[selected];
  const previous = opened && selected > 0 ? opened.steps[selected - 1] : null;
  const changes = useMemo(
    () => step ? diffLines(previous?.snapshot ?? "", step.snapshot) : [],
    [previous?.snapshot, step?.snapshot],
  );

  async function loadLocator(locator: TraceLocator, approvedRelayHints: string[]) {
    setBusy(true);
    setError(null);
    setPendingApproval(null);
    try {
      const next = await openTraceLocator(locator, { approvedRelayHints });
      setOpened(next);
      setSelected(next.steps.length - 1);
    } catch (cause) {
      setOpened(null);
      if (cause instanceof RelayHintApprovalRequiredError) {
        setPendingApproval({ locator, relayHints: [...cause.relayHints] });
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setBusy(false);
    }
  }

  function requestOpen() {
    setError(null);
    setOpened(null);
    try {
      const locator = parseTraceLocator(input);
      const relayHints = relayHintsRequiringApproval(locator);
      if (relayHints.length > 0) {
        setPendingApproval({ locator, relayHints });
        return;
      }
      void loadLocator(locator, []);
    } catch (cause) {
      setPendingApproval(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <div className="compose-overlay" onClick={onClose}>
      <div
        className="compose-dialog trace-locator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trace-locator-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="compose-header">
          <h2 id="trace-locator-title">Open signed trace</h2>
          <button type="button" className="compose-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <p className="trace-locator-help">
          Paste the locator returned by the headless press. The desktop fetches and verifies its
          exact signed file nucleus without importing it into your Root.
        </p>
        <textarea
          className="trace-locator-input"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setPendingApproval(null);
          }}
          placeholder="zine-trace:…"
          rows={3}
          spellCheck={false}
        />
        <div className="trace-locator-actions">
          <button type="button" onClick={requestOpen} disabled={busy || !input.trim()}>
            {busy ? "Verifying…" : "Open trace"}
          </button>
        </div>
        {pendingApproval && (
          <section
            className="trace-locator-approval"
            role="alert"
            aria-labelledby="trace-locator-approval-title"
          >
            <h3 id="trace-locator-approval-title">Private or unencrypted connection requested</h3>
            <p>
              This locator asks Zine to contact a local/private destination or a plaintext
              clearnet relay. Continue only if you trust its sender.
            </p>
            <ul>
              {pendingApproval.relayHints.map((hint) => <li key={hint}><code>{hint}</code></li>)}
            </ul>
            <div className="trace-locator-approval-actions">
              <button type="button" onClick={() => setPendingApproval(null)}>Cancel</button>
              <button
                type="button"
                className="is-primary"
                onClick={() => void loadLocator(
                  pendingApproval.locator,
                  pendingApproval.relayHints,
                )}
              >
                Connect to listed relays
              </button>
            </div>
          </section>
        )}
        {error && <p className="create-error" role="alert">{error}</p>}
        {opened && step && (
          <div className="trace-locator-result">
            <dl className="trace-locator-meta">
              <div><dt>File</dt><dd>{opened.locator.relativePath}</dd></div>
              <div><dt>Owner</dt><dd title={opened.locator.ownerPubkey}>{shortId(opened.locator.ownerPubkey)}</dd></div>
              <div><dt>Root</dt><dd title={opened.locator.rootId}>{shortId(opened.locator.rootId)}</dd></div>
              <div><dt>Nucleus</dt><dd title={opened.locator.nodeId}>{shortId(opened.locator.nodeId)}</dd></div>
            </dl>
            <div className="trace-locator-steps" aria-label="Trace steps">
              {opened.steps.map((candidate, index) => (
                <button
                  type="button"
                  key={candidate.event.id}
                  className={index === selected ? "is-selected" : ""}
                  onClick={() => setSelected(index)}
                  title={candidate.event.id}
                >
                  <span>{index}</span>
                  <span>{candidate.action}</span>
                  <span>{candidate.steppedAtMs ? new Date(candidate.steppedAtMs).toLocaleString() : "time unavailable"}</span>
                </button>
              ))}
            </div>
            <div className="trace-locator-verification">
              Signature valid · exact nucleus · {opened.historyComplete
                ? `${opened.steps.length} signed Step${opened.steps.length === 1 ? "" : "s"}`
                : "private history unavailable"}
            </div>
            <pre className="trace-locator-diff" aria-label="Selected Step changes">
              {changes.map((change, index) => (
                <span
                  key={`${index}:${change.value.length}`}
                  className={change.added ? "is-added" : change.removed ? "is-removed" : ""}
                >
                  {change.value}
                </span>
              ))}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
