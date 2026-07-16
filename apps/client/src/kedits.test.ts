/**
 * Keystroke log (`kedits`) wire-shape and op-classification tests.
 *
 * `kedits` is advisory metadata layered on the authoritative `snapshot` (like
 * `deltas`): one `KEdit` per discrete editor change since the previous step.
 * These tests pin four things:
 *
 *  1. Wire shape — a node carrying `kedits` round-trips through JSON, and the
 *     `KEdit` entries read back equal to what was stepped. This is the contract
 *     any reader (the press, a peer's relay, a future replay UI) depends on.
 *  2. Backward compat — `reconstructFromChain` still resolves content from
 *     `snapshot` when `kedits` is present. Old readers ignore the field; the
 *     snapshot stays authoritative (§R1).
 *  3. History intent — real CodeMirror undo/redo transactions retain their
 *     semantic action instead of becoming indistinguishable inverse edits.
 *  4. Transaction grouping — every range in a multi-range edit shares `tx`,
 *     while legacy entries without `tx` remain independently replayable.
 *
 * What's NOT tested here: the `keditField` StateField itself and the
 * drain-in-stepFile path (both need the full App harness). The capture helper
 * is exercised directly with headless CodeMirror transactions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { history, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";

import { captureKEditTransaction, groupKEditsByTransaction } from "./kedit-capture.js";
import { reconstructFromChain, keditsFromEvent } from "./provenance.js";
import type { Event } from "nostr-tools";
import type { KEdit } from "./provenance.js";

/** Build a file-node event mirroring the wire shape publishEdit emits:
 *  kind 4290, `z:file`, JSON content with `steppedAt` + `deltas` + `snapshot`
 *  + optionally `kedits`. */
function fileNode(
  id: string,
  prev: string | null,
  content: {
    steppedAt: number;
    deltas: unknown[];
    snapshot?: string;
    kedits?: KEdit[];
  },
): Event {
  return {
    id,
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["file", "draft.md"],
      ["folder", "f"],
      ["action", "edit"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify(content),
    sig: "",
  };
}

// --- op classification (pure re-implementation of keditField.update's rule) --
//
// Mirrors the exact tri-classification in App.tsx's keditField:
//   from === to      → "ins"   (pure insertion, no chars removed)
//   text === ""      → "del"   (pure deletion, no chars inserted)
//   otherwise        → "repl"  (replace-over-range)
//
// Kept in sync with the field by construction — if this and the field diverge,
// the field is wrong (this is the spec).
function classifyOp(from: number, to: number, text: string): KEdit["op"] {
  if (from === to) return "ins";
  if (text === "") return "del";
  return "repl";
}

const VOICE = "pk-author";

function kedit(from: number, to: number, text: string, t = 1000): KEdit {
  return { op: classifyOp(from, to, text), from, to, text, voice: VOICE, t };
}

test("op classification: pure insert (from === to)", () => {
  // Typing a single char at offset 5 (nothing deleted).
  const e = kedit(5, 5, "a");
  assert.equal(e.op, "ins");
  assert.equal(e.text, "a");
});

test("op classification: backspace (to = from + 1, empty insert)", () => {
  // Backspace at offset 5 deletes the char at [5,6).
  const e = kedit(5, 6, "");
  assert.equal(e.op, "del");
  assert.equal(e.text, "");
});

test("op classification: highlight-delete (range, empty insert)", () => {
  // Select offsets [3,12) and delete.
  const e = kedit(3, 12, "");
  assert.equal(e.op, "del");
  assert.equal(e.to - e.from, 9);
});

test("op classification: highlight-replace (range + non-empty insert)", () => {
  // Select offsets [3,12) and type over with "new".
  const e = kedit(3, 12, "new");
  assert.equal(e.op, "repl");
  assert.equal(e.text, "new");
});

test("op classification: multi-char insert at a point is still 'ins'", () => {
  // A paste at offset 0 (nothing deleted) — one KEdit, op ins.
  const e = kedit(0, 0, "pasted paragraph");
  assert.equal(e.op, "ins");
});

// --- CodeMirror history intent + transaction grouping ----------------------

test("capture: undo and redo retain semantic intent", () => {
  let state = EditorState.create({ doc: "draft", extensions: [history()] });
  state = state.update({
    changes: { from: 5, insert: "!" },
    userEvent: "input.type",
  }).state;

  let captured: KEdit[] = [];
  assert.equal(undo({
    state,
    dispatch: (tr) => {
      captured = captureKEditTransaction(tr, VOICE, 1);
      state = tr.state;
    },
  }), true);
  assert.equal(state.doc.toString(), "draft");
  assert.deepEqual(
    captured.map(({ op, from, to, text, tx, intent }) => ({ op, from, to, text, tx, intent })),
    [{ op: "del", from: 5, to: 6, text: "", tx: 1, intent: "undo" }],
  );

  assert.equal(redo({
    state,
    dispatch: (tr) => {
      captured = captureKEditTransaction(tr, VOICE, 2);
      state = tr.state;
    },
  }), true);
  assert.equal(state.doc.toString(), "draft!");
  assert.deepEqual(
    captured.map(({ op, from, to, text, tx, intent }) => ({ op, from, to, text, tx, intent })),
    [{ op: "ins", from: 5, to: 5, text: "!", tx: 2, intent: "redo" }],
  );
});

test("capture: every range in one history transaction shares tx and intent", () => {
  let state = EditorState.create({ doc: "abc", extensions: [history()] });
  state = state.update({
    changes: [
      { from: 0, to: 1, insert: "A" },
      { from: 2, to: 3, insert: "C" },
    ],
    userEvent: "input.type",
  }).state;

  let captured: KEdit[] = [];
  assert.equal(undo({
    state,
    dispatch: (tr) => {
      captured = captureKEditTransaction(tr, VOICE, 7);
      state = tr.state;
    },
  }), true);
  assert.equal(state.doc.toString(), "abc");
  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((edit) => edit.tx), [7, 7]);
  assert.deepEqual(captured.map((edit) => edit.intent), ["undo", "undo"]);
});

test("grouping: legacy entries remain singletons and tx groups stay atomic", () => {
  const groups = groupKEditsByTransaction([
    { ...kedit(0, 0, "a"), tx: 0 },
    { ...kedit(2, 2, "c"), tx: 0 },
    kedit(1, 1, "b"),
    { ...kedit(3, 3, "d"), tx: 1 },
  ]);
  assert.deepEqual(groups.map((group) => group.length), [2, 1, 1]);
});

// --- wire shape: kedits round-trips through JSON ----------------------------

test("wire shape: kedits survives JSON round-trip intact", () => {
  const kedits: KEdit[] = [
    { ...kedit(0, 0, "hello", 1000), tx: 0 },
    { ...kedit(5, 5, " ", 1100), tx: 1 },
    { ...kedit(6, 6, "world", 1200), tx: 2 },
    { ...kedit(5, 11, "", 1300), tx: 3, intent: "undo" },
    { ...kedit(0, 5, "hi", 1400), tx: 4 },
  ];
  const node = fileNode("n1", null, {
    steppedAt: 2000,
    deltas: [{ type: "replace", position: { start: 0, end: 5 }, newValue: "hi", timestamp: 2000 }],
    snapshot: "hi",
    kedits,
  });
  // Parse back and verify every entry matches.
  const parsed = JSON.parse(node.content) as { kedits?: KEdit[] };
  assert.ok(parsed.kedits, "kedits field present on the wire");
  assert.equal(parsed.kedits!.length, 5);
  // Deep-equal each entry (op, from, to, text, voice, t).
  for (let i = 0; i < kedits.length; i++) {
    assert.deepEqual(parsed.kedits![i], kedits[i], `kedit[${i}] round-trips`);
  }
});

test("wire shape: a node without kedits omits the field (not null)", () => {
  // A forced no-op Step steps with an empty kedit buffer → kedits absent.
  const node = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [],
    snapshot: "unchanged",
  });
  const parsed = JSON.parse(node.content) as { kedits?: KEdit[] };
  assert.equal(parsed.kedits, undefined, "kedits absent (not null) when buffer empty");
});

// --- backward compat: snapshot stays authoritative when kedits is present ----

test("backward compat: reconstructFromChain ignores kedits, uses snapshot", () => {
  // A node carries kedits AND a snapshot. Reconstruction must yield the
  // snapshot — kedits is advisory, never spliced into content.
  const node = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [],
    snapshot: "the final text",
    kedits: [
      kedit(0, 0, "draft"),
      kedit(0, 5, "the final text"),
    ],
  });
  assert.equal(reconstructFromChain([node]), "the final text");
});

test("backward compat: chain of kedits-carrying nodes reconstructs linearly", () => {
  // Three steps, each carrying kedits. Content reconstruction walks snapshots.
  const n1 = fileNode("n1", null, {
    steppedAt: 1000, deltas: [], snapshot: "v1", kedits: [kedit(0, 0, "v1")],
  });
  const n2 = fileNode("n2", "n1", {
    steppedAt: 2000, deltas: [], snapshot: "v2", kedits: [kedit(0, 2, "v2")],
  });
  const n3 = fileNode("n3", "n2", {
    steppedAt: 3000, deltas: [], snapshot: "v3", kedits: [kedit(0, 2, "v3")],
  });
  // The last node's snapshot wins.
  assert.equal(reconstructFromChain([n1, n2, n3]), "v3");
});

// --- CJK: a multi-char IME commit is one KEdit (no special handling needed) --
//
// CodeMirror suppresses transactions during IME composition, so a Chinese
// commit arrives as ONE transaction with the full committed text. This test
// pins that the wire shape carries multi-byte text correctly in a single entry
// — the guarantee CJK writers depend on.

test("CJK: a 你好 IME commit is one ins entry with intact text", () => {
  // Committing "你好" at offset 0 (no prior text removed).
  const e = kedit(0, 0, "你好");
  assert.equal(e.op, "ins");
  assert.equal(e.text, "你好");
  // The entry is a single KEdit — one commit, one record.
  const node = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "你好", timestamp: 1000 }],
    snapshot: "你好",
    kedits: [e],
  });
  const parsed = JSON.parse(node.content) as { kedits?: KEdit[] };
  assert.equal(parsed.kedits!.length, 1);
  assert.equal(parsed.kedits![0].text, "你好");
});

test("CJK: backspacing 你好 → 你 is one del entry", () => {
  // Cursor after 好, backspace deletes [1,2) in UTF-16 (好 is one BMP code unit).
  const e = kedit(1, 2, "");
  assert.equal(e.op, "del");
  assert.equal(e.text, "");
});

// --- keditsFromEvent: the read-side function -------------------------------
//
// The reader a UI (StepsModal's KeditsPanel, a future replay player) calls to
// pull the keystroke log off a stepped node. Unlike reconstructRunsFromChain
// there's no chain walk or fallback synthesis — kedits is either on the node
// or it isn't.

test("keditsFromEvent: reads the kedits array from a node's content JSON", () => {
  const kedits: KEdit[] = [
    kedit(0, 0, "hi", 1000),
    kedit(2, 2, "!", 1100),
  ];
  const node = fileNode("n1", null, {
    steppedAt: 2000,
    deltas: [],
    snapshot: "hi!",
    kedits,
  });
  const out = keditsFromEvent(node);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], kedits[0]);
  assert.deepEqual(out[1], kedits[1]);
});

test("keditsFromEvent: returns [] when the node has no kedits field (backward compat)", () => {
  // A pre-kedits node or a forced no-op Step: no kedits on the wire.
  const node = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [],
    snapshot: "old content",
  });
  assert.deepEqual(keditsFromEvent(node), []);
});

test("keditsFromEvent: returns [] for malformed content JSON (doesn't throw)", () => {
  const broken: Event = {
    id: "x",
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [],
    content: "not valid json {{",
    sig: "",
  };
  assert.deepEqual(keditsFromEvent(broken), []);
});

// --- kedit replay engine: sequential application ---------------------------
//
// The core of buildKeditTimeline (App.tsx) is applying kedits one at a time to
// reconstruct the document state after every keystroke. Each kedit's from/to
// is into the pre-edit state — which is the running state after all prior
// kedits. This pure function mirrors that logic exactly so it can be tested
// in isolation (buildKeditTimeline itself needs a live CodeMirror + chain).
//
// Returns the document text after each kedit — the frame states a playback
// would render.
function applyKedits(startText: string, kedits: KEdit[]): string[] {
  let chars = [...startText];
  const states: string[] = [];
  for (const k of kedits) {
    const from = Math.max(0, Math.min(k.from, chars.length));
    const to = Math.max(from, Math.min(k.to, chars.length));
    const insertChars = [...k.text];
    chars = [...chars.slice(0, from), ...insertChars, ...chars.slice(to)];
    states.push(chars.join(""));
  }
  return states;
}

test("replay: typing 'hello' one char at a time → 5 incremental states", () => {
  const kedits: KEdit[] = [
    kedit(0, 0, "h", 1000),
    kedit(1, 1, "e", 1100),
    kedit(2, 2, "l", 1200),
    kedit(3, 3, "l", 1300),
    kedit(4, 4, "o", 1400),
  ];
  assert.deepEqual(applyKedits("", kedits), ["h", "he", "hel", "hell", "hello"]);
});

test("replay: backspace after 'hello' → 'hell'", () => {
  // Backspace deletes [4,5) — the 'o'.
  const states = applyKedits("hello", [kedit(4, 5, "", 1500)]);
  assert.deepEqual(states, ["hell"]);
});

test("replay: highlight-replace 'llo' with 'y' → 'hey'", () => {
  // Select [2,5) ('llo') and replace with 'y'.
  const states = applyKedits("hello", [kedit(2, 5, "y", 1600)]);
  assert.deepEqual(states, ["hey"]);
});

test("replay: multi-kedit within one step carries state forward", () => {
  // Type 'hello', backspace 'o', replace 'l' with 'p' → 'help'
  const kedits: KEdit[] = [
    kedit(0, 0, "hello", 1000),
    kedit(4, 5, "", 1100),        // del 'o' → 'hell'
    kedit(3, 4, "p", 1200),       // repl 'l'→'p' → 'help'
  ];
  assert.deepEqual(applyKedits("", kedits), ["hello", "hell", "help"]);
});

test("replay: state carries across steps (step1 then step2)", () => {
  // Step 1 types 'ab' — simulates the running state after that step.
  const afterStep1 = applyKedits("", [kedit(0, 0, "ab", 1000)]);
  assert.deepEqual(afterStep1, ["ab"]);
  // Step 2 starts from 'ab' (the carried state), deletes 'b', types 'c'.
  const afterStep2 = applyKedits("ab", [
    kedit(1, 2, "", 2000),    // del 'b' → 'a'
    kedit(1, 1, "c", 2100),   // ins 'c' → 'ac'
  ]);
  assert.deepEqual(afterStep2, ["a", "ac"]);
});

test("replay: empty kedits produce no frames, state unchanged", () => {
  // A forced no-op Step: no kedits → no frames.
  assert.deepEqual(applyKedits("unchanged", []), []);
});

test("replay: clamped offsets degrade safely (corrupted kedit)", () => {
  // A kedit with from/to beyond the document length clamps to bounds instead
  // of throwing. Characters beyond length are appended.
  const states = applyKedits("hi", [kedit(0, 99, "x", 1000)]);
  assert.deepEqual(states, ["x"]);
});
