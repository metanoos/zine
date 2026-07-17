/**
 * Three-way merge panel for conflict incorporate (protocol §3.8).
 *
 * Shows auto-resolved regions as context and conflict hunks with
 * ours / theirs / both / base choices. Confirm steps the unilateral merge
 * with the resolved snapshot.
 */

import { useMemo, useState } from "react";
import type { MergeCandidate } from "../provenance/provenance.js";
import {
  threeWayMerge,
  applyMergeChoices,
  type ConflictChoice,
  type MergeChunk,
} from "./three-way-merge.js";

export interface MergePanelProps {
  candidate: MergeCandidate;
  /** Common ancestor body (fork point). Empty string if unknown. */
  base: string;
  /** Our current head body. */
  ours: string;
  path: string;
  busy: boolean;
  /** Inline failure message from the last step/incorporate attempt. */
  error?: string | null;
  onCancel: () => void;
  onConfirm: (resolvedSnapshot: string) => void;
}

function previewLines(lines: string[], max = 12): string {
  if (lines.length === 0) return "∅";
  const body = lines.slice(0, max).join("\n");
  return lines.length > max ? body + `\n… +${lines.length - max} lines` : body;
}

function ConflictBlock({
  chunk,
  index,
  choice,
  onChoice,
}: {
  chunk: Extract<MergeChunk, { type: "conflict" }>;
  index: number;
  choice: ConflictChoice;
  onChoice: (c: ConflictChoice) => void;
}) {
  return (
    <div className="merge-conflict" data-choice={choice}>
      <div className="merge-conflict-head">
        <span className="merge-conflict-label">Conflict {index + 1}</span>
        <div className="merge-conflict-choices">
          {(
            [
              ["ours", "Yours"],
              ["theirs", "Theirs"],
              ["both", "Both"],
              ["base", "Base"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={"merge-choice" + (choice === value ? " active" : "")}
              onClick={() => onChoice(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="merge-conflict-cols">
        <div className="merge-col merge-col-ours">
          <div className="merge-col-title">Yours</div>
          <pre>{previewLines(chunk.ours)}</pre>
        </div>
        <div className="merge-col merge-col-theirs">
          <div className="merge-col-title">Theirs</div>
          <pre>{previewLines(chunk.theirs)}</pre>
        </div>
        <div className="merge-col merge-col-base">
          <div className="merge-col-title">Base</div>
          <pre>{previewLines(chunk.base)}</pre>
        </div>
      </div>
    </div>
  );
}

export function MergePanel({
  candidate,
  base,
  ours,
  path,
  busy,
  error,
  onCancel,
  onConfirm,
}: MergePanelProps) {
  const result = useMemo(() => threeWayMerge(base, ours, candidate.snapshot), [base, ours, candidate.snapshot]);
  const [choices, setChoices] = useState<Record<number, ConflictChoice>>({});
  const [showPreview, setShowPreview] = useState(false);
  // Index into conflictBlocks for the one-at-a-time stepper. Bounded below
  // before use so a stale value (e.g. after the underlying chunks change)
  // can't run past the end.
  const [activeConflict, setActiveConflict] = useState(0);

  const resolved = useMemo(() => applyMergeChoices(result.chunks, choices), [result.chunks, choices]);

  let conflictOrdinal = 0;
  const conflictBlocks: { chunk: Extract<MergeChunk, { type: "conflict" }>; index: number }[] = [];
  for (const c of result.chunks) {
    if (c.type === "conflict") {
      conflictBlocks.push({ chunk: c, index: conflictOrdinal++ });
    }
  }

  const currentConflict = conflictBlocks.length
    ? Math.min(activeConflict, conflictBlocks.length - 1)
    : 0;

  const short = candidate.headId.slice(0, 8);
  const who = candidate.ownerPubkey.slice(0, 8);

  return (
    <div className="merge-panel" role="dialog" aria-label="Resolve merge conflicts">
      <div className="merge-panel-head">
        <div>
          <div className="merge-panel-title">
            Reconcile · {path}
          </div>
          <div className="merge-panel-sub">
            {candidate.kind === "incoming-fork"
              ? `Fork ${short} by ${who}`
              : `Sibling branch ${short}`}
            {result.clean
              ? " — auto-merged cleanly"
              : ` — ${result.conflictCount} conflict${result.conflictCount === 1 ? "" : "s"}`}
            . Unilateral accept under your key; their chain stays addressable.
          </div>
        </div>
        <div className="merge-panel-actions">
          <button type="button" className="merge-panel-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="merge-panel-preview"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? "Hide preview" : "Preview result"}
          </button>
          <button
            type="button"
            className="merge-panel-confirm"
            disabled={busy}
            onClick={() => onConfirm(resolved)}
          >
            {busy ? "Stepping…" : "Step merge"}
          </button>
        </div>
      </div>

      {error && (
        <p className="merge-error" role="alert" title={error}>
          {error}
        </p>
      )}

      {result.clean && (
        <div className="merge-clean-note">
          No overlapping edits — result combines both sides automatically. Review preview and step.
        </div>
      )}

      {conflictBlocks.length > 0 && (() => {
        const { chunk, index } = conflictBlocks[currentConflict];
        const remaining = conflictBlocks.filter(
          ({ index: i }) => choices[i] === undefined,
        ).length;
        return (
          <div className="merge-conflicts">
            <div className="merge-conflict-pager">
              <span className="merge-conflict-pager-count">
                Conflict {currentConflict + 1} of {conflictBlocks.length}
                {remaining > 0 && (
                  <span className="merge-conflict-pager-remaining">
                    {" · "}{remaining} unresolved
                  </span>
                )}
              </span>
              <div className="merge-conflict-pager-nav">
                <button
                  type="button"
                  className="merge-pager-btn"
                  onClick={() => setActiveConflict((i) => Math.max(0, i - 1))}
                  disabled={currentConflict === 0}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="merge-pager-btn"
                  onClick={() =>
                    setActiveConflict((i) =>
                      Math.min(conflictBlocks.length - 1, i + 1),
                    )
                  }
                  disabled={currentConflict >= conflictBlocks.length - 1}
                >
                  Next →
                </button>
              </div>
            </div>
            <ConflictBlock
              chunk={chunk}
              index={index}
              choice={choices[index] ?? "ours"}
              onChoice={(c) => {
                setChoices((prev) => ({ ...prev, [index]: c }));
                // Auto-advance once a choice is made, unless this is the last
                // conflict — then the user is reviewing, not stepping.
                if (currentConflict < conflictBlocks.length - 1) {
                  setActiveConflict((i) => i + 1);
                }
              }}
            />
          </div>
        );
      })()}

      {showPreview && (
        <div className="merge-preview">
          <div className="merge-col-title">Result ({resolved.length} chars)</div>
          <pre>{resolved.length > 4000 ? resolved.slice(0, 4000) + "\n…" : resolved}</pre>
        </div>
      )}
    </div>
  );
}
