import { historyField } from "@codemirror/commands";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { EditorTransaction } from "@zine/protocol";

const SERIALIZED_HISTORY_FIELDS = { history: historyField };

/** One file's CodeMirror undo branch. The document text is retained only as a
 * validity check: if an inactive file changes externally, its old positional
 * history can no longer be applied safely and is discarded on restore. */
export interface FileUndoHistorySnapshot {
  readonly doc: string;
  readonly history: unknown;
}

export function captureFileUndoHistory(state: EditorState): FileUndoHistorySnapshot {
  const serialized = state.toJSON(SERIALIZED_HISTORY_FIELDS) as {
    doc: string;
    history: unknown;
  };
  return { doc: serialized.doc, history: serialized.history };
}

/** Recover the last selection observed by a retained transaction journal.
 * Null or out-of-range selections are an honest unknown, so they start at the
 * first character instead of fabricating continuity or crashing state creation. */
export function selectionAfterEditorTransactions(
  transactions: readonly EditorTransaction[],
  documentLength: number,
): EditorSelection {
  const selection = transactions[transactions.length - 1]?.selectionAfter;
  if (
    !selection ||
    selection.ranges.length === 0 ||
    selection.main < 0 ||
    selection.main >= selection.ranges.length ||
    selection.ranges.some(
      ({ anchor, head }) =>
        anchor < 0 ||
        head < 0 ||
        anchor > documentLength ||
        head > documentLength,
    )
  ) {
    return EditorSelection.single(0);
  }
  return EditorSelection.create(
    selection.ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
    selection.main,
  );
}

/** Create the editor state for one active file without admitting another
 * file's undo branch. A matching snapshot restores that file's own branch;
 * stale or absent snapshots start with an empty history. `selection` belongs
 * to the file being restored, never the outgoing tab. */
export function restoreFileUndoHistory(
  doc: string,
  extensions: Extension,
  snapshot?: FileUndoHistorySnapshot,
  selection: EditorSelection = EditorSelection.single(0),
): EditorState {
  if (!snapshot || snapshot.doc !== doc || snapshot.history === undefined) {
    return EditorState.create({ doc, selection, extensions });
  }
  return EditorState.fromJSON(
    {
      doc,
      selection: selection.toJSON(),
      history: snapshot.history,
    },
    { extensions },
    SERIALIZED_HISTORY_FIELDS,
  );
}
