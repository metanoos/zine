/**
 * Tests for run-preserving edit and attribution helpers. `dominantVoiceInRegion`
 * selects the per-delta contributor voice; it must never select a trace signer.
 * A Step remains signed by the trace owner while `authors`/`voices` preserve
 * human and MODEL contributions across reload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_EDITOR_TRANSACTION_LOG,
  applyEditorTransaction,
  appendEditorTransactionLog,
  changedRegion,
  dominantVoiceInRegion,
  dropEditorTransactionLogPrefix,
  fileHasUnsteppedChanges,
  editorTransactionLogFromArray,
  editorTransactionLogToArray,
  minimalTextChange,
  nextEditorTransactionSequence,
  reconcileRunsText,
  recoverStepEditorTransactions,
  resolveStepEditorTransactions,
  spliceRuns,
  synthesizeEditorTransactionTransition,
  validateEditorTransactionTransition,
} from "./workspace-core.js";
import type { Run } from "./workspace-core.js";
import type { EditorTransaction } from "../provenance/provenance.js";

const A = "aaaa".repeat(8); // the AUTHOR voice (pubkey)
const B = "bbbb".repeat(8); // the MODEL voice (pubkey)

function transaction(
  from: number,
  to: number,
  text: string,
  actor = A,
  timestamp = 1,
  sequence = timestamp,
): EditorTransaction {
  return {
    sequence,
    timestamp,
    actor,
    changes: [{
      op: from === to ? "insert" : text === "" ? "delete" : "replace",
      from,
      to,
      text,
    }],
    selectionBefore: null,
    selectionAfter: null,
  };
}

// --- changedRegion --------------------------------------------------------

test("changedRegion: identical strings → null", () => {
  assert.equal(changedRegion("hello", "hello"), null);
});

test("changedRegion: pure append → the appended span", () => {
  assert.deepEqual(changedRegion("hello", "hello world"), { from: 5, to: 11 });
});

test("changedRegion: pure insert in the middle", () => {
  assert.deepEqual(changedRegion("hello world", "hello NEW world"), { from: 6, to: 10 });
});

test("changedRegion: pure delete", () => {
  // "hello world" → "world" deletes the prefix; the changed region in the new
  // text is a collapsed point at 0 (nothing new was written).
  assert.deepEqual(changedRegion("hello world", "world"), { from: 0, to: 0 });
});

test("changedRegion: replace", () => {
  assert.deepEqual(changedRegion("hello world", "hello earth"), { from: 6, to: 11 });
});

// --- run-preserving text edits -------------------------------------------

test("spliceRuns attributes only inserted text and preserves surrounding voices", () => {
  const runs: Run[] = [
    { voice: A, text: "human " },
    { voice: B, text: "model prose" },
  ];
  assert.deepEqual(spliceRuns(runs, 11, 11, "NEW ", A), [
    { voice: A, text: "human " },
    { voice: B, text: "model" },
    { voice: A, text: "NEW " },
    { voice: B, text: " prose" },
  ]);
});

test("spliceRuns uses CodeMirror UTF-16 offsets after emoji", () => {
  const runs: Run[] = [
    { voice: A, text: "🤖" }, // two UTF-16 code units
    { voice: B, text: "model" },
  ];
  assert.deepEqual(spliceRuns(runs, 2, 2, "!", A), [
    { voice: A, text: "🤖!" },
    { voice: B, text: "model" },
  ]);
});

test("spliceRuns preserves src seams on untouched provenance", () => {
  const src1 = "1".repeat(64);
  const src2 = "2".repeat(64);
  const runs: Run[] = [
    { voice: B, text: "left", src: src1 },
    { voice: B, text: "right", src: src2 },
  ];
  assert.deepEqual(spliceRuns(runs, 4, 4, " ", A), [
    { voice: B, text: "left", src: src1 },
    { voice: A, text: " " },
    { voice: B, text: "right", src: src2 },
  ]);
});

test("minimalTextChange localizes a whole-document citation rewrite", () => {
  assert.deepEqual(
    minimalTextChange("[[ model words | old-id ]]", "[[ model words | new-id ]]"),
    { from: 17, to: 20, insert: "new" },
  );
});

test("synthetic EditorTransaction records a non-editor transition as one atomic replacement", () => {
  const editorTransactions = synthesizeEditorTransactionTransition("hello world", "hello Zine", B, 123, 7);
  assert.deepEqual(editorTransactions, [{
    sequence: 7,
    timestamp: 123,
    actor: B,
    changes: [{ op: "replace", from: 6, to: 11, text: "Zine" }],
    selectionBefore: null,
    selectionAfter: null,
  }]);
  assert.deepEqual(validateEditorTransactionTransition("hello world", "hello Zine", editorTransactions), { valid: true });
});

test("an empty EditorTransaction log is valid only for an unchanged transition", () => {
  assert.deepEqual(validateEditorTransactionTransition("same", "same", []), { valid: true });
  assert.equal(validateEditorTransactionTransition("", "changed", []).valid, false);
});

test("EditorTransaction transition validation fails closed on bad ranges and replay mismatch", () => {
  assert.match(
    validateEditorTransactionTransition("abc", "x", [{
      ...transaction(0, 4, "x", A, 1, 0),
    }]).reason ?? "",
    /outside/,
  );
  assert.match(
    validateEditorTransactionTransition("abc", "abd", [{
      ...transaction(2, 3, "x", A, 1, 0),
    }]).reason ?? "",
    /do not reproduce/,
  );
});

test("only explicit crash recovery replaces an unusable partial EditorTransaction log with a snapshot transition", () => {
  const priorText = "prior draft";
  const currentText = `${priorText}!`;
  const partialCapture = [transaction(priorText.length, priorText.length, "!", A, 2, 0)];

  assert.match(
    validateEditorTransactionTransition("", currentText, partialCapture).reason ?? "",
    /outside its pre-state/,
  );
  const resolved = recoverStepEditorTransactions("", currentText, partialCapture, A, 3);
  assert.equal(resolved.source, "snapshot");
  assert.match(resolved.rejectedReason ?? "", /outside its pre-state/);
  assert.deepEqual(validateEditorTransactionTransition("", currentText, resolved.editorTransactions), { valid: true });
});

test("ordinary Step rejects an invalid current-session EditorTransaction journal", () => {
  const partialCapture = [transaction(12, 12, "!", A, 2, 0)];

  assert.throws(
    () => resolveStepEditorTransactions("", "prior draft!", partialCapture, A, 3),
    /invalid captured EditorTransaction log.*outside its pre-state/,
  );
});

test("Step recovery preserves a complete captured EditorTransaction log exactly", () => {
  const captured = [transaction(3, 3, "!", A, 2, 4)];

  assert.deepEqual(resolveStepEditorTransactions("hey", "hey!", captured, B, 9), {
    editorTransactions: captured,
    source: "captured",
  });
});

test("reconcileRunsText keeps model prose voiced during a metadata rewrite", () => {
  const before = "[[ model words | old-id ]]";
  const after = "[[ model words | new-id ]]";
  assert.deepEqual(reconcileRunsText([{ voice: B, text: before }], after, A), [
    { voice: B, text: "[[ model words | " },
    { voice: A, text: "new" },
    { voice: B, text: "-id ]]" },
  ]);
});

test("separate metadata rewrites do not revoice the model prose between them", () => {
  let text = "[[ first | old ]] model middle [[ second | old ]]";
  let runs: Run[] = [{ voice: B, text }];
  for (const [from, to] of [[43, 46], [11, 14]]) {
    runs = spliceRuns(runs, from, to, "new", A);
    text = text.slice(0, from) + "new" + text.slice(to);
  }
  assert.equal(runs.map((run) => run.text).join(""), text);
  assert.deepEqual(runs, [
    { voice: B, text: "[[ first | " },
    { voice: A, text: "new" },
    { voice: B, text: " ]] model middle [[ second | " },
    { voice: A, text: "new" },
    { voice: B, text: " ]]" },
  ]);
});

// --- dominantVoiceInRegion -----------------------------------------------

test("dominantVoiceInRegion: single voice in region → that voice", () => {
  const runs: Run[] = [{ voice: A, text: "hello " }, { voice: B, text: "world" }];
  // Region [6,11) is entirely B's run.
  assert.equal(dominantVoiceInRegion(runs, 6, 11), B);
});

test("dominantVoiceInRegion: MODEL text appended, region = appended span → MODEL", () => {
  // The motivating scenario: a doc was all AUTHOR text, then MODEL appended.
  const runs: Run[] = [
    { voice: A, text: "human wrote this" },
    { voice: B, text: " and the model continued" },
  ];
  const region = changedRegion("human wrote this", "human wrote this and the model continued")!;
  // The new region is entirely the MODEL's run.
  assert.equal(dominantVoiceInRegion(runs, region.from, region.to), B);
});

test("dominantVoiceInRegion: region spanning both voices picks the larger share", () => {
  const runs: Run[] = [
    { voice: A, text: "AAAAAAAA" }, // 8 chars
    { voice: B, text: "BB" }, // 2 chars
  ];
  // Whole doc: A dominates 8:2.
  assert.equal(dominantVoiceInRegion(runs, 0, 10), A);
  // Just the tail [8,10): B dominates.
  assert.equal(dominantVoiceInRegion(runs, 8, 10), B);
});

test("dominantVoiceInRegion: tie → first-seen wins (stable)", () => {
  const runs: Run[] = [
    { voice: A, text: "AA" },
    { voice: B, text: "BB" },
  ];
  // Equal share (2:2); the iteration order of Map preserves insertion, so A wins.
  assert.equal(dominantVoiceInRegion(runs, 0, 4), A);
});

test("dominantVoiceInRegion: empty / collapsed region → null", () => {
  const runs: Run[] = [{ voice: A, text: "hello" }];
  assert.equal(dominantVoiceInRegion(runs, 0, 0), null);
  assert.equal(dominantVoiceInRegion(runs, 3, 3), null);
});

test("dominantVoiceInRegion: offsets clamped to document bounds", () => {
  const runs: Run[] = [{ voice: A, text: "hi" }];
  // Negative start / past-end end are tolerated.
  assert.equal(dominantVoiceInRegion(runs, -5, 99), A);
});

test("dominantVoiceInRegion: empty run list → null", () => {
  assert.equal(dominantVoiceInRegion([], 0, 10), null);
});

// --- append-efficient EditorTransaction log -----------------------------------------

function edit(text: string, t: number): EditorTransaction {
  return transaction(0, 0, text, A, t, t);
}

test("EditorTransaction log appends chunks without changing the prior log", () => {
  const first = appendEditorTransactionLog(EMPTY_EDITOR_TRANSACTION_LOG, [edit("a", 1)]);
  const second = appendEditorTransactionLog(first, [edit("b", 2), edit("c", 3)]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 3);
  assert.deepEqual(editorTransactionLogToArray(first).map((entry) => entry.changes[0]?.text), ["a"]);
  assert.deepEqual(editorTransactionLogToArray(second).map((entry) => entry.changes[0]?.text), ["a", "b", "c"]);
});

test("EditorTransaction log round-trips a crash-pad array", () => {
  const entries = [edit("a", 1), edit("b", 2)];
  assert.deepEqual(editorTransactionLogToArray(editorTransactionLogFromArray(entries)), entries);
  assert.deepEqual(editorTransactionLogToArray(undefined), []);
});

test("EditorTransaction log continues transaction ids after capture and restore", () => {
  const captured = editorTransactionLogFromArray([
    { ...edit("a", 1), sequence: 3 },
    { ...edit("b", 2), sequence: 4 },
  ]);
  assert.equal(nextEditorTransactionSequence(captured), 5);
  assert.equal(nextEditorTransactionSequence(EMPTY_EDITOR_TRANSACTION_LOG), 0);
});

test("editor transaction applies multi-range offsets against one pre-state", () => {
  const runs: Run[] = [{ voice: A, text: "abcd" }];
  const first = transaction(0, 1, "A", B, 1, 0);
  const second = transaction(2, 3, "C", B, 1, 0);
  const atomic = { ...first, changes: [...first.changes, ...second.changes] };
  assert.deepEqual(applyEditorTransaction(runs, atomic), [
    { voice: B, text: "A" },
    { voice: A, text: "b" },
    { voice: B, text: "C" },
    { voice: A, text: "d" },
  ]);
});

test("Step drains its EditorTransaction prefix but preserves edits typed while it is in flight", () => {
  const stepped = appendEditorTransactionLog(EMPTY_EDITOR_TRANSACTION_LOG, [edit("a", 1), edit("b", 2)]);
  const current = appendEditorTransactionLog(stepped, [edit("c", 3)]);
  const remaining = dropEditorTransactionLogPrefix(current, stepped);

  assert.deepEqual(editorTransactionLogToArray(remaining).map((entry) => entry.changes[0]?.text), ["c"]);
  assert.equal(dropEditorTransactionLogPrefix(stepped, stepped), EMPTY_EDITOR_TRANSACTION_LOG);
});

test("Step never drains an unrelated EditorTransaction log", () => {
  const current = editorTransactionLogFromArray([edit("a", 1), edit("b", 2)]);
  const unrelated = editorTransactionLogFromArray([edit("a", 1)]);
  assert.equal(dropEditorTransactionLogPrefix(current, unrelated), current);
});

test("a freshly created empty file has no unstepped indicator", () => {
  const fresh = { runs: [], nodeId: "", tags: [] };
  assert.equal(fileHasUnsteppedChanges(fresh, undefined), false);
});

test("the first real change makes a fresh file unstepped", () => {
  assert.equal(
    fileHasUnsteppedChanges({ runs: [{ voice: A, text: "a" }], nodeId: "", tags: [] }, undefined),
    true,
  );
  assert.equal(
    fileHasUnsteppedChanges(
      {
        runs: [],
        nodeId: "",
        tags: [],
        editorTransactions: appendEditorTransactionLog(EMPTY_EDITOR_TRANSACTION_LOG, [edit("a", 1), edit("", 2)]),
      },
      undefined,
    ),
    true,
  );
});

test("selection-only activity remains pending against an existing Step baseline", () => {
  const selectionOnly: EditorTransaction = {
    sequence: 0,
    timestamp: 1,
    actor: A,
    changes: [],
    selectionBefore: {
      ranges: [{ anchor: 0, head: 0 }],
      main: 0,
    },
    selectionAfter: {
      ranges: [{ anchor: 0, head: 1 }],
      main: 0,
    },
  };
  assert.equal(
    fileHasUnsteppedChanges(
      {
        runs: [{ voice: A, text: "a" }],
        nodeId: "1".repeat(64),
        tags: [],
        editorTransactions: appendEditorTransactionLog(
          EMPTY_EDITOR_TRANSACTION_LOG,
          [selectionOnly],
        ),
      },
      { content: "a", tags: [], citationIds: [] },
    ),
    true,
  );
});
