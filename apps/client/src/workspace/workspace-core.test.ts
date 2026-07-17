/**
 * Tests for run-preserving edit and attribution helpers. `dominantVoiceInRegion`
 * selects the per-delta contributor voice; it must never select a trace signer.
 * A Step remains signed by the trace owner while `authors`/`voices` preserve
 * human and MODEL contributions across reload.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_KEDIT_LOG,
  applyKEditTransaction,
  appendKEditLog,
  changedRegion,
  dominantVoiceInRegion,
  dropKEditLogPrefix,
  fileHasUnsteppedChanges,
  keditLogFromArray,
  keditLogToArray,
  minimalTextChange,
  nextKEditTx,
  reconcileRunsText,
  spliceRuns,
  synthesizeKEditTransition,
  validateKEditTransition,
} from "./workspace-core.js";
import type { Run } from "./workspace-core.js";
import type { KEdit } from "../provenance/provenance.js";

const A = "aaaa".repeat(8); // the AUTHOR voice (pubkey)
const B = "bbbb".repeat(8); // the MODEL voice (pubkey)

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

test("synthetic KEdit records a non-editor transition as one atomic replacement", () => {
  const kedits = synthesizeKEditTransition("hello world", "hello Zine", B, 123, 7);
  assert.deepEqual(kedits, [{
    op: "repl",
    from: 6,
    to: 11,
    text: "Zine",
    voice: B,
    t: 123,
    tx: 7,
  }]);
  assert.deepEqual(validateKEditTransition("hello world", "hello Zine", kedits), { valid: true });
});

test("an empty KEdit log is valid only for an unchanged transition", () => {
  assert.deepEqual(validateKEditTransition("same", "same", []), { valid: true });
  assert.equal(validateKEditTransition("", "changed", []).valid, false);
});

test("KEdit transition validation fails closed on bad ranges and replay mismatch", () => {
  assert.match(
    validateKEditTransition("abc", "x", [{
      op: "repl", from: 0, to: 4, text: "x", voice: A, t: 1, tx: 0,
    }]).reason ?? "",
    /outside/,
  );
  assert.match(
    validateKEditTransition("abc", "abd", [{
      op: "repl", from: 2, to: 3, text: "x", voice: A, t: 1, tx: 0,
    }]).reason ?? "",
    /do not reproduce/,
  );
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

// --- append-efficient KEdit log -----------------------------------------

function edit(text: string, t: number): KEdit {
  return { op: "ins", from: 0, to: 0, text, voice: A, t, tx: t };
}

test("KEdit log appends chunks without changing the prior log", () => {
  const first = appendKEditLog(EMPTY_KEDIT_LOG, [edit("a", 1)]);
  const second = appendKEditLog(first, [edit("b", 2), edit("c", 3)]);
  assert.equal(first.length, 1);
  assert.equal(second.length, 3);
  assert.deepEqual(keditLogToArray(first).map((e) => e.text), ["a"]);
  assert.deepEqual(keditLogToArray(second).map((e) => e.text), ["a", "b", "c"]);
});

test("KEdit log round-trips a crash-pad array", () => {
  const entries = [edit("a", 1), edit("b", 2)];
  assert.deepEqual(keditLogToArray(keditLogFromArray(entries)), entries);
  assert.deepEqual(keditLogToArray(undefined), []);
});

test("KEdit log continues transaction ids after capture and restore", () => {
  const captured = keditLogFromArray([
    { ...edit("a", 1), tx: 3 },
    { ...edit("b", 2), tx: 4 },
  ]);
  assert.equal(nextKEditTx(captured), 5);
  assert.equal(nextKEditTx(EMPTY_KEDIT_LOG), 0);
});

test("KEdit transaction applies multi-range offsets against one pre-state", () => {
  const runs: Run[] = [{ voice: A, text: "abcd" }];
  const edits: KEdit[] = [
    { op: "repl", from: 0, to: 1, text: "A", voice: B, t: 1, tx: 0 },
    { op: "repl", from: 2, to: 3, text: "C", voice: B, t: 1, tx: 0 },
  ];
  assert.deepEqual(applyKEditTransaction(runs, edits), [
    { voice: B, text: "A" },
    { voice: A, text: "b" },
    { voice: B, text: "C" },
    { voice: A, text: "d" },
  ]);
});

test("Step drains its KEdit prefix but preserves edits typed while it is in flight", () => {
  const stepped = appendKEditLog(EMPTY_KEDIT_LOG, [edit("a", 1), edit("b", 2)]);
  const current = appendKEditLog(stepped, [edit("c", 3)]);
  const remaining = dropKEditLogPrefix(current, stepped);

  assert.deepEqual(keditLogToArray(remaining).map((e) => e.text), ["c"]);
  assert.equal(dropKEditLogPrefix(stepped, stepped), EMPTY_KEDIT_LOG);
});

test("Step never drains an unrelated KEdit log", () => {
  const current = keditLogFromArray([edit("a", 1), edit("b", 2)]);
  const unrelated = keditLogFromArray([edit("a", 1)]);
  assert.equal(dropKEditLogPrefix(current, unrelated), current);
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
        kedits: appendKEditLog(EMPTY_KEDIT_LOG, [edit("a", 1), edit("", 2)]),
      },
      undefined,
    ),
    true,
  );
});
