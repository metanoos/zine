import { Transaction } from "@codemirror/state";
import type {
  EditorSelectionState,
  EditorTransaction,
  EditorTransactionIntent,
  TextChange,
} from "@zine/protocol";

/** Preserve the editor's semantic history action when one exists. CodeMirror
 *  supplies these annotations on the inverse/forward transactions generated
 *  by its history commands, so this is direct capture rather than inference
 *  from the resulting text change. */
export function editorTransactionIntentFromCodeMirror(
  tr: Transaction,
): EditorTransactionIntent | undefined {
  if (tr.isUserEvent("undo")) return "undo";
  if (tr.isUserEvent("redo")) return "redo";
  return undefined;
}

function selectionState(selection: Transaction["startState"]["selection"]): EditorSelectionState {
  return {
    ranges: selection.ranges.map(({ anchor, head }) => ({ anchor, head })),
    main: selection.mainIndex,
  };
}

/** Convert one CodeMirror transaction into the editor transaction carried by
 *  the next Step. Every change range uses the pre-transaction coordinate
 *  space, and the selection is captured on both sides of the transaction. */
export function captureEditorTransaction(
  tr: Transaction,
  actor: string,
  sequence: number,
): EditorTransaction | null {
  if (!tr.docChanged && tr.selection === undefined) return null;
  const intent = editorTransactionIntentFromCodeMirror(tr);
  const changes: TextChange[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.sliceString(0);
    changes.push({
      op: fromA === toA ? "insert" : text === "" ? "delete" : "replace",
      from: fromA,
      to: toA,
      text,
    });
  });
  return {
    sequence,
    timestamp: tr.annotation(Transaction.time) ?? Date.now(),
    actor,
    changes,
    selectionBefore: selectionState(tr.startState.selection),
    selectionAfter: selectionState(tr.newSelection),
    ...(intent ? { intent } : {}),
  };
}
