import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function SampleModal({
  children,
  onClose,
  title = "Sample relays",
  wide = false,
}: {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  /** Widens the dialog for content that needs more than the default shell. */
  wide?: boolean;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="compose-overlay sample-modal-overlay" onClick={onClose}>
      <div
        className={`compose-dialog sample-modal${wide ? " sample-modal-wide" : ""}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="compose-header sample-modal-header">
          <h2 className="compose-title">{title}</h2>
          <button
            type="button"
            className="compose-close"
            aria-label="Close sample dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
