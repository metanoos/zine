import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Transaction } from "@codemirror/state";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateEditorTransactionTransition } from "@zine/protocol";
import { captureEditorTransaction } from "../provenance/editor-transaction-capture.js";
import {
  captureFileUndoHistory,
  restoreFileUndoHistory,
  selectionAfterEditorTransactions,
} from "./file-undo-history.js";

const ACTOR = "a".repeat(64);

function typeAtEnd(state: EditorState, text: string): EditorState {
  return state.update({
    changes: { from: state.doc.length, insert: text },
    annotations: Transaction.userEvent.of("input.type"),
  }).state;
}

function runUndo(state: EditorState): { state: EditorState; applied: boolean } {
  let next = state;
  const applied = undo({ state, dispatch: (transaction) => { next = transaction.state; } });
  return { state: next, applied };
}

function runRedo(state: EditorState): { state: EditorState; applied: boolean } {
  let next = state;
  const applied = redo({ state, dispatch: (transaction) => { next = transaction.state; } });
  return { state: next, applied };
}

test("undo and redo history stays with its file across tab switches", () => {
  const extensions = [history()];
  let fileA = EditorState.create({ doc: "alpha", extensions });
  fileA = typeAtEnd(fileA, "!");
  const savedA = captureFileUndoHistory(fileA);

  let fileB = restoreFileUndoHistory("beta", extensions);
  let result = runUndo(fileB);
  assert.equal(result.applied, false, "a new file must not inherit file A's undo stack");
  assert.equal(result.state.doc.toString(), "beta");

  fileB = typeAtEnd(fileB, "?");
  const savedB = captureFileUndoHistory(fileB);

  fileA = restoreFileUndoHistory("alpha!", extensions, savedA);
  result = runUndo(fileA);
  assert.equal(result.applied, true);
  assert.equal(result.state.doc.toString(), "alpha");
  const savedAAfterUndo = captureFileUndoHistory(result.state);

  fileB = restoreFileUndoHistory("beta?", extensions, savedB);
  result = runUndo(fileB);
  assert.equal(result.applied, true);
  assert.equal(result.state.doc.toString(), "beta");

  fileA = restoreFileUndoHistory("alpha", extensions, savedAAfterUndo);
  const redoneA = runRedo(fileA);
  assert.equal(redoneA.applied, true, "file A's redo branch must survive visiting file B");
  assert.equal(redoneA.state.doc.toString(), "alpha!");
});

test("an external file change invalidates only that file's stale undo stack", () => {
  const extensions = [history()];
  let state = EditorState.create({ doc: "draft", extensions });
  state = typeAtEnd(state, " one");
  const saved = captureFileUndoHistory(state);

  state = restoreFileUndoHistory("externally replaced", extensions, saved);
  const result = runUndo(state);
  assert.equal(result.applied, false);
  assert.equal(result.state.doc.toString(), "externally replaced");
});

test("restoring an unstepped editor continues its captured selection post-state", () => {
  const extensions = [history()];
  const initial = EditorState.create({ doc: "draft", extensions });
  const firstUpdate = initial.update({
    changes: { from: 5, insert: "!" },
    selection: { anchor: 6 },
    annotations: Transaction.userEvent.of("input.type"),
  });
  const first = captureEditorTransaction(firstUpdate, ACTOR, 1);
  assert.ok(first);

  const restored = restoreFileUndoHistory(
    firstUpdate.state.doc.toString(),
    extensions,
    undefined,
    selectionAfterEditorTransactions([first], firstUpdate.state.doc.length),
  );
  const secondUpdate = restored.update({
    changes: { from: restored.selection.main.head, insert: "X" },
    selection: { anchor: restored.selection.main.head + 1 },
    annotations: Transaction.userEvent.of("input.type"),
  });
  const second = captureEditorTransaction(secondUpdate, ACTOR, 2);
  assert.ok(second);

  assert.deepEqual(
    validateEditorTransactionTransition(
      "draft",
      secondUpdate.state.doc.toString(),
      [first, second],
    ),
    { valid: true },
  );
});

test("retained selection recovery falls back safely when cursor state is unknown or invalid", () => {
  assert.deepEqual(
    selectionAfterEditorTransactions([], 5).toJSON(),
    EditorSelection.single(0).toJSON(),
  );
  assert.deepEqual(
    selectionAfterEditorTransactions([{
      sequence: 0,
      timestamp: 1,
      actor: ACTOR,
      changes: [],
      selectionBefore: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
      selectionAfter: { ranges: [{ anchor: 6, head: 6 }], main: 0 },
    }], 5).toJSON(),
    EditorSelection.single(0).toJSON(),
  );
});

test("FileEditor switches paths by restoring path-owned state, not replacing the shared doc", () => {
  const source = readFileSync(new URL("./FileEditor.tsx", import.meta.url), "utf8");
  const start = source.indexOf("if (switched) {");
  const end = source.indexOf("// Same file, external update", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const switchBranch = source.slice(start, end);

  assert.match(switchBranch, /captureFileUndoHistory\(view\.state\)/);
  assert.match(switchBranch, /undoHistoryByPathRef\.current\.get\(path\)/);
  assert.match(switchBranch, /restoreFileUndoHistory\(/);
  assert.match(switchBranch, /view\.setState\(nextState\)/);
  assert.doesNotMatch(switchBranch, /view\.dispatch\(/);
});
