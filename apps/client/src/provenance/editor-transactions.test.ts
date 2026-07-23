/** Selection-aware editor transaction capture, wire, and replay tests. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { history, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Event } from "nostr-tools";

import { captureEditorTransaction } from "./editor-transaction-capture.js";
import { editorTransactionsFromEvent, reconstructFromChain } from "./provenance.js";
import type { EditorTransaction, TextChange } from "@zine/protocol";

const ACTOR = "pk-author";

function classifyOperation(from: number, to: number, text: string): TextChange["op"] {
  if (from === to) return "insert";
  if (text === "") return "delete";
  return "replace";
}

function editorTransaction(
  from: number,
  to: number,
  text: string,
  timestamp = 1_000,
  sequence = timestamp,
): EditorTransaction {
  return {
    sequence,
    timestamp,
    actor: ACTOR,
    changes: [{ op: classifyOperation(from, to, text), from, to, text }],
    selectionBefore: null,
    selectionAfter: null,
  };
}

function fileNode(
  id: string,
  previousId: string | null,
  snapshot: string,
  editorTransactions: EditorTransaction[],
): Event {
  return {
    id,
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["F", "draft.md"],
      ["f", "f"],
      ["action", "edit"],
      ...(previousId ? [["e", previousId, "", "prev"]] : []),
    ],
    content: JSON.stringify({
      steppedAt: 1_000,
      deltas: [],
      snapshot,
      editorTransactions,
    }),
    sig: "",
  };
}

test("text changes use transparent insert, delete, and replace labels", () => {
  assert.equal(editorTransaction(5, 5, "a").changes[0]?.op, "insert");
  assert.equal(editorTransaction(5, 6, "").changes[0]?.op, "delete");
  assert.equal(editorTransaction(3, 12, "new").changes[0]?.op, "replace");
});

test("capture retains undo and redo intent with before/after selections", () => {
  let state = EditorState.create({ doc: "draft", extensions: [history()] });
  state = state.update({
    changes: { from: 5, insert: "!" },
    selection: { anchor: 6 },
    userEvent: "input.type",
  }).state;

  const captured: EditorTransaction[] = [];
  assert.equal(undo({
    state,
    dispatch: (transaction) => {
      const editorTransaction = captureEditorTransaction(transaction, ACTOR, 1);
      if (editorTransaction) captured.push(editorTransaction);
      state = transaction.state;
    },
  }), true);
  const undoTransaction = captured[0];
  assert.ok(undoTransaction);
  assert.equal(undoTransaction.intent, "undo");
  assert.equal(undoTransaction.sequence, 1);
  assert.deepEqual(undoTransaction.changes, [{ op: "delete", from: 5, to: 6, text: "" }]);
  assert.deepEqual(undoTransaction.selectionBefore, { ranges: [{ anchor: 6, head: 6 }], main: 0 });
  assert.deepEqual(undoTransaction.selectionAfter, { ranges: [{ anchor: 0, head: 0 }], main: 0 });

  assert.equal(redo({
    state,
    dispatch: (transaction) => {
      const editorTransaction = captureEditorTransaction(transaction, ACTOR, 2);
      if (editorTransaction) captured.push(editorTransaction);
      state = transaction.state;
    },
  }), true);
  const redoTransaction = captured[1];
  assert.ok(redoTransaction);
  assert.equal(redoTransaction.intent, "redo");
  assert.deepEqual(redoTransaction.changes, [{ op: "insert", from: 5, to: 5, text: "!" }]);
});

test("capture records a selection-only transaction", () => {
  const state = EditorState.create({ doc: "draft" });
  const codeMirrorTransaction = state.update({ selection: { anchor: 1, head: 4 } });
  const captured = captureEditorTransaction(codeMirrorTransaction, ACTOR, 3);
  assert.ok(captured);
  assert.deepEqual(captured.changes, []);
  assert.deepEqual(captured.selectionBefore, { ranges: [{ anchor: 0, head: 0 }], main: 0 });
  assert.deepEqual(captured.selectionAfter, { ranges: [{ anchor: 1, head: 4 }], main: 0 });
});

test("capture keeps all ranges in one atomic transaction", () => {
  const state = EditorState.create({
    doc: "abc",
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.create([
      EditorSelection.cursor(0),
      EditorSelection.cursor(2),
    ]),
  });
  const codeMirrorTransaction = state.update({
    changes: [
      { from: 0, to: 1, insert: "A" },
      { from: 2, to: 3, insert: "C" },
    ],
  });
  const captured = captureEditorTransaction(codeMirrorTransaction, ACTOR, 7);
  assert.ok(captured);
  assert.equal(captured.sequence, 7);
  assert.deepEqual(captured.changes, [
    { op: "replace", from: 0, to: 1, text: "A" },
    { op: "replace", from: 2, to: 3, text: "C" },
  ]);
  assert.equal(captured.selectionBefore?.ranges.length, 2);
  assert.equal(captured.selectionAfter?.ranges.length, 2);
});

test("wire shape round-trips transactions, changes, and selections", () => {
  const transaction = {
    ...editorTransaction(0, 0, "hello", 1_000, 0),
    selectionBefore: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
    selectionAfter: { ranges: [{ anchor: 5, head: 5 }], main: 0 },
  } satisfies EditorTransaction;
  const node = fileNode("n1", null, "hello", [transaction]);
  const parsed = JSON.parse(node.content) as { editorTransactions?: EditorTransaction[] };
  assert.deepEqual(parsed.editorTransactions, [transaction]);
});

test("a no-op file Step carries an explicit empty transaction log", () => {
  const node = fileNode("n1", null, "", []);
  const parsed = JSON.parse(node.content) as { editorTransactions?: EditorTransaction[] };
  assert.deepEqual(parsed.editorTransactions, []);
});

test("snapshot materialization remains authoritative", () => {
  const node = fileNode("n1", null, "the final text", [
    editorTransaction(0, 0, "draft", 1_000, 0),
    editorTransaction(0, 5, "the final text", 1_100, 1),
  ]);
  assert.equal(reconstructFromChain([node]), "the final text");
});

test("CJK commits remain one transaction with intact text", () => {
  const transaction = editorTransaction(0, 0, "你好", 1_000, 0);
  const node = fileNode("n1", null, "你好", [transaction]);
  const parsed = JSON.parse(node.content) as { editorTransactions?: EditorTransaction[] };
  assert.equal(parsed.editorTransactions?.length, 1);
  assert.equal(parsed.editorTransactions?.[0]?.changes[0]?.text, "你好");
});

test("editorTransactionsFromEvent accepts only the current schema", () => {
  const transactions = [
    editorTransaction(0, 0, "hi", 1_000, 0),
    editorTransaction(2, 2, "!", 1_100, 1),
  ];
  assert.deepEqual(
    editorTransactionsFromEvent(fileNode("n1", null, "hi!", transactions)),
    transactions,
  );

  const malformed = fileNode("n2", null, "x", [{
    timestamp: 1,
    actor: ACTOR,
    changes: [{ op: "insert", from: 0, to: 0, text: "x" }],
    selectionBefore: null,
    selectionAfter: null,
  } as unknown as EditorTransaction]);
  assert.deepEqual(editorTransactionsFromEvent(malformed), []);
});

test("editorTransactionsFromEvent handles malformed JSON", () => {
  const broken: Event = {
    id: "x",
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [],
    content: "not valid json {{",
    sig: "",
  };
  assert.deepEqual(editorTransactionsFromEvent(broken), []);
});

function applyTransactions(startText: string, transactions: EditorTransaction[]): string[] {
  let text = startText;
  const states: string[] = [];
  for (const transaction of transactions) {
    const ordered = transaction.changes.map((change, index) => ({ change, index })).sort(
      (left, right) =>
        right.change.from - left.change.from ||
        right.change.to - left.change.to ||
        right.index - left.index,
    );
    for (const { change } of ordered) {
      const from = Math.max(0, Math.min(change.from, text.length));
      const to = Math.max(from, Math.min(change.to, text.length));
      text = `${text.slice(0, from)}${change.text}${text.slice(to)}`;
    }
    states.push(text);
  }
  return states;
}

test("replay applies atomic transactions sequentially", () => {
  const transactions = [
    editorTransaction(0, 0, "hello", 1_000, 0),
    editorTransaction(4, 5, "", 1_100, 1),
    editorTransaction(3, 4, "p", 1_200, 2),
  ];
  assert.deepEqual(applyTransactions("", transactions), ["hello", "hell", "help"]);
});

test("selection-only replay preserves text while producing an activity frame", () => {
  const transaction: EditorTransaction = {
    sequence: 0,
    timestamp: 1_000,
    actor: ACTOR,
    changes: [],
    selectionBefore: { ranges: [{ anchor: 0, head: 0 }], main: 0 },
    selectionAfter: { ranges: [{ anchor: 0, head: 2 }], main: 0 },
  };
  assert.deepEqual(applyTransactions("hi", [transaction]), ["hi"]);
});
