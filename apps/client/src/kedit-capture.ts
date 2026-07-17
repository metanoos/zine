import { Transaction } from "@codemirror/state";

import type { KEdit, KEditIntent } from "./provenance.js";

/** Preserve the editor's semantic history action when one exists. CodeMirror
 *  supplies these annotations on the inverse/forward transactions generated
 *  by its history commands, so this is direct capture rather than inference
 *  from the resulting text change. */
export function keditIntentFromTransaction(tr: Transaction): KEditIntent | undefined {
  if (tr.isUserEvent("undo")) return "undo";
  if (tr.isUserEvent("redo")) return "redo";
  return undefined;
}

/** Convert one CodeMirror transaction into the KEdits carried by the next
 *  Step. A multi-range transaction produces several entries with one shared
 *  `tx`; every offset is relative to the same pre-transaction document. */
export function captureKEditTransaction(
  tr: Transaction,
  voice: string,
  tx: number,
): KEdit[] {
  if (!tr.docChanged) return [];
  const intent = keditIntentFromTransaction(tr);
  const t = tr.annotation(Transaction.time) ?? Date.now();
  const edits: KEdit[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const text = inserted.sliceString(0);
    edits.push({
      op: fromA === toA ? "ins" : text === "" ? "del" : "repl",
      from: fromA,
      to: toA,
      text,
      voice,
      t,
      tx,
      ...(intent ? { intent } : {}),
    });
  });
  return edits;
}

/** Group consecutive KEdits that share a transaction id. */
export function groupKEditsByTransaction(kedits: readonly KEdit[]): KEdit[][] {
  const groups: KEdit[][] = [];
  for (const edit of kedits) {
    const previous = groups[groups.length - 1];
    const previousTx = previous?.[0]?.tx;
    if (previous && previousTx === edit.tx) {
      previous.push(edit);
    } else {
      groups.push([edit]);
    }
  }
  return groups;
}
