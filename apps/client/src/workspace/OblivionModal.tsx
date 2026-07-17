import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface OblivionModalProps {
  name: string;
  path: string;
  content: string;
  nodeId: string;
  onClose: () => void;
}

/** Read-only inspection surface for a file retained in Oblivion. */
export function OblivionModal({
  name,
  path,
  content,
  nodeId,
  onClose,
}: OblivionModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return createPortal(
    <div className="compose-overlay oblivion-modal-overlay" onClick={onClose}>
      <section
        className="compose-dialog oblivion-modal-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="oblivion-modal-title"
        aria-describedby="oblivion-modal-hint"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="compose-header">
          <div>
            <p className="oblivion-modal-kicker">Retained file · read-only</p>
            <h2 id="oblivion-modal-title" className="compose-title">
              Oblivion · {name}
            </h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="compose-close"
            aria-label="Close Oblivion file"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <pre className="oblivion-modal-content" aria-label="Read-only file contents">
          {content}
        </pre>

        <dl className="oblivion-modal-meta">
          <div>
            <dt>Stored path</dt>
            <dd><code>{path}</code></dd>
          </div>
          <div>
            <dt>Signed node</dt>
            <dd><code>{nodeId || "Unstepped"}</code></dd>
          </div>
        </dl>

        <p id="oblivion-modal-hint" className="oblivion-modal-hint">
          Files in Oblivion cannot be edited. Restore this file to Root to continue working on it.
        </p>
      </section>
    </div>,
    document.body,
  );
}
