import type { RecoverableModelResult } from "../ai/model-operation-executor.js";
import { createPortal } from "react-dom";

export type MintRecoveryNotice = {
  pending: number;
  failures: string[];
  startError?: string;
};

export function HeldModelResultDialog({
  result,
  onClose,
  onRetry,
}: {
  result: RecoverableModelResult;
  onClose: () => void;
  onRetry: (operation: RecoverableModelResult["operation"]) => void;
}) {
  return createPortal(
    <div className="compose-overlay" onClick={onClose}>
      <div
        className="compose-dialog prompt-inspector-dialog"
        role="dialog"
        aria-label="Held AI response"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="run-head">
          <h2 className="run-title">AI response held</h2>
          <button
            type="button"
            className="attest-close"
            aria-label="Close"
            onClick={onClose}
          >×</button>
        </div>
        <p className="run-blurb">
          Focus or the source revision changed while the provider was working, so nothing was edited.
        </p>
        <pre className="prompt-inspector-pre">
          {result.response || "(No response was sent because the target was already stale.)"}
        </pre>
        <div className="run-actions">
          <button
            type="button"
            className="run-save"
            disabled={!result.response}
            onClick={() => void navigator.clipboard.writeText(result.response)}
          >Copy response</button>
          <button
            type="button"
            className="run-start"
            onClick={() => onRetry(result.operation)}
          >Inspect to retry</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function MintRecoveryAlert({
  notice,
  coinsEnabled,
  busy,
  onRetry,
  onOpenNetworking,
}: {
  notice: MintRecoveryNotice;
  coinsEnabled: boolean;
  busy: boolean;
  onRetry: () => void;
  onOpenNetworking: () => void;
}) {
  return (
    <div className="mint-recovery-alert" role="alert">
      <div className="mint-recovery-alert-content">
        <strong>
          {notice.pending > 0
            ? `${notice.pending} pending Mint ${notice.pending === 1 ? "transaction remains" : "transactions remain"} incomplete and may already be public.`
            : "Pending Mint recovery could not start."}
        </strong>
        {!coinsEnabled && notice.pending > 0 && (
          <span> Coins are disabled, so recovery is paused.</span>
        )}
        {notice.startError && (
          <span className="mint-recovery-error"> {notice.startError}</span>
        )}
        {notice.failures.length > 0 && (
          <ul>
            {notice.failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        )}
      </div>
      {coinsEnabled ? (
        <button type="button" disabled={busy} onClick={onRetry}>
          {busy ? "Retrying…" : "Retry"}
        </button>
      ) : (
        <button type="button" onClick={onOpenNetworking}>
          Open Networking
        </button>
      )}
    </div>
  );
}

export function FactoryResetDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="confirm-overlay" onClick={() => { if (!busy) onCancel(); }}>
      <div
        className="confirm-dialog factory-reset-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="factory-reset-title"
        aria-describedby="factory-reset-description"
        aria-busy={busy}
      >
        <h2 id="factory-reset-title" className="create-modal-title factory-reset-title">
          Factory Reset the Local App
        </h2>
        <p id="factory-reset-description" className="confirm-message factory-reset-message">
          Erases all local app state, including the root binding, crash pads, secure key
          vaults, AI credentials, relay config, voices, models, and layouts. On desktop it
          also deletes every event from the local sidecar and resets peer access. The app
          reloads into vault creation; the next vault then mints a new root with an empty oblivion. Events
          already sent to remote relays cannot be erased from those relays. There is no undo.
        </p>
        {error && <p className="create-error" role="alert">{error}</p>}
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-cancel"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="confirm-delete"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Erasing…" : "Erase everything"}
          </button>
        </div>
      </div>
    </div>
  );
}
