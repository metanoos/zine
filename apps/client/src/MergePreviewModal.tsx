/**
 * Clean-merge preview modal.
 *
 * When a three-way merge auto-resolves with no overlapping conflicts (the
 * divergence is purely structural — unStepped checkpoints, identical text, or
 * non-overlapping edits), we don't seal blindly: this modal shows the diff of
 * what the auto-merge will change before committing it. Mirrors the
 * compose/affirm modal shape.
 */

import { useMemo } from "react";
import { createPortal } from "react-dom";
import { diffLines } from "diff";

/**
 * Minimal display shape the modal needs from a merge source. `MergeCandidate`
 * (fork / sibling-head reconciliation) satisfies this structurally; a staged
 * background-pull merge passes a synthesized object with no `kind`.
 */
export interface MergePreviewInfo {
  headId: string;
  ownerPubkey: string;
  kind?: "incoming-fork" | "sibling-head";
}

export interface MergePreviewModalProps {
  candidate: MergePreviewInfo;
  path: string;
  /** Current head body (ours). */
  before: string;
  /** Auto-merged body the seal will write. */
  after: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function MergePreviewModal({
  candidate,
  path,
  before,
  after,
  busy,
  error,
  onClose,
  onConfirm,
}: MergePreviewModalProps) {
  // diffLines(before → after): added = lines the merge brings in, removed =
  // lines it drops. Identical text yields a single unchanged part.
  const parts = useMemo(() => diffLines(before, after), [before, after]);
  const changed = before !== after;

  const short = candidate.headId.slice(0, 8);
  const who = candidate.ownerPubkey.slice(0, 8);
  const fileName = path.split("/").pop() ?? path;

  return createPortal(
    <div className="compose-overlay" onClick={onClose}>
      <div className="compose-dialog merge-preview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="merge-preview-head">
          <div>
            <h2 className="merge-preview-title">Clean merge · {fileName}</h2>
            <p className="merge-preview-sub">
              {candidate.kind === "incoming-fork"
                ? `Fork ${short} by ${who}`
                : candidate.kind === "sibling-head"
                  ? `Sibling branch ${short}`
                  : `Synced edit by ${who}`}
              {" — no overlapping edits, auto-resolved. Review and seal."}
            </p>
          </div>
          <button
            type="button"
            className="merge-preview-close"
            aria-label="Close"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </div>

        {error && (
          <p className="merge-error" role="alert" title={error}>
            {error}
          </p>
        )}

        {!changed && (
          <div className="merge-clean-note">
            Both sides hold identical text — sealing advances the chain without
            changing the file body.
          </div>
        )}

        <div className="merge-preview-body">
          <div className="merge-col-title">
            Result {changed ? `· ${parts.filter((p) => p.added || p.removed).length} region${parts.filter((p) => p.added || p.removed).length === 1 ? "" : "s"} changed` : ""}
          </div>
          <pre className="merge-preview-diff">
            {parts.map((part, i) => (
              <span
                key={i}
                className={
                  part.added
                    ? "merge-preview-add"
                    : part.removed
                      ? "merge-preview-remove"
                      : "merge-preview-same"
                }
              >
                {part.value}
              </span>
            ))}
          </pre>
        </div>

        <div className="merge-preview-actions">
          <button type="button" className="confirm-cancel" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="confirm-delete merge-preview-confirm"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "Sealing…" : "Seal merge"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
