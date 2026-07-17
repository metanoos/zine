import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { SendFailure, SendFailureView } from "./send-failure.js";

export function SendFailureModal({
  failure,
  onClose,
  onNavigate,
}: {
  failure: SendFailure;
  onClose: () => void;
  onNavigate: (view: SendFailureView) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="confirm-overlay send-failure-overlay" onClick={onClose}>
      <div
        className="confirm-dialog send-failure-dialog"
        onClick={(event) => event.stopPropagation()}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="send-failure-title"
        aria-describedby="send-failure-summary"
      >
        <h2 id="send-failure-title" className="send-failure-title">
          {failure.title}
        </h2>
        <p id="send-failure-summary" className="confirm-message send-failure-summary">
          {failure.summary}
        </p>
        <details className="send-failure-detail">
          <summary>Technical detail</summary>
          <pre>{failure.detail}</pre>
        </details>
        <div className="confirm-actions">
          <button
            ref={closeRef}
            type="button"
            className="confirm-cancel"
            onClick={onClose}
          >
            Close
          </button>
          {failure.destination && failure.actionLabel ? (
            <button
              type="button"
              className="confirm-delete"
              onClick={() => {
                if (failure.destination) onNavigate(failure.destination);
              }}
            >
              {failure.actionLabel}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
