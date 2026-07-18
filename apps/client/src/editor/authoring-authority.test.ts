import assert from "node:assert/strict";
import test from "node:test";

import {
  applyEditorAuthorityChanges,
  classifyEditorTransaction,
  createEditorAuthorityState,
  resetEditorAuthorityState,
} from "./authoring-authority.js";

test("only direct manual typing is instruction-eligible", () => {
  const origins = [
    classifyEditorTransaction({ model: false, paste: false, drop: false, manualType: true, undoRedo: false }),
    classifyEditorTransaction({ model: false, paste: true, drop: false, manualType: false, undoRedo: false }),
    classifyEditorTransaction({ model: false, paste: false, drop: true, manualType: false, undoRedo: false }),
    classifyEditorTransaction({ model: true, paste: false, drop: false, manualType: false, undoRedo: false }),
    classifyEditorTransaction({ model: false, paste: false, drop: false, manualType: false, undoRedo: true }),
    classifyEditorTransaction({ model: false, paste: false, drop: false, manualType: false, undoRedo: false }),
  ];
  assert.deepEqual(origins, ["manual", "paste", "drop", "model", "undo-redo", "unknown"]);

  for (const origin of origins) {
    const state = applyEditorAuthorityChanges(
      createEditorAuthorityState(0),
      [{ fromA: 0, toA: 0, fromB: 0, toB: 9 }],
      origin,
      "author-a",
    );
    assert.equal(state.spans[0]?.instructionEligible, origin === "manual");
  }
});

test("manual insertion splits unknown content and maps UTF-16 offsets", () => {
  const state = applyEditorAuthorityChanges(
    createEditorAuthorityState(4),
    [{ fromA: 2, toA: 2, fromB: 2, toB: 6 }],
    "manual",
    "author-a",
  );
  assert.deepEqual(
    state.spans.map((span) => [span.fromUtf16, span.toUtf16, span.origin, span.actorId]),
    [
      [0, 2, "unknown", ""],
      [2, 6, "manual", "author-a"],
      [6, 8, "unknown", ""],
    ],
  );
});

test("adjacent manual UTF-16 edits coalesce without losing actor identity", () => {
  const first = applyEditorAuthorityChanges(
    createEditorAuthorityState(0),
    [{ fromA: 0, toA: 0, fromB: 0, toB: 2 }],
    "manual",
    "author-a",
  );
  const second = applyEditorAuthorityChanges(
    first,
    [{ fromA: 2, toA: 2, fromB: 2, toB: 4 }],
    "manual",
    "author-a",
  );
  assert.deepEqual(second.spans.map((span) => ({
    from: span.fromUtf16,
    to: span.toUtf16,
    actor: span.actorId,
    eligible: span.instructionEligible,
  })), [{ from: 0, to: 4, actor: "author-a", eligible: true }]);
});

test("replacement removes prior authority and classifies only inserted bytes", () => {
  const manual = applyEditorAuthorityChanges(
    createEditorAuthorityState(0),
    [{ fromA: 0, toA: 0, fromB: 0, toB: 10 }],
    "manual",
    "author-a",
  );
  const pasted = applyEditorAuthorityChanges(
    manual,
    [{ fromA: 3, toA: 7, fromB: 3, toB: 8 }],
    "paste",
    "author-a",
  );
  assert.deepEqual(
    pasted.spans.map((span) => [span.fromUtf16, span.toUtf16, span.origin]),
    [
      [0, 3, "manual"],
      [3, 8, "paste"],
      [8, 11, "manual"],
    ],
  );
});

test("reload and programmatic repopulation discard current-session authority", () => {
  const manual = applyEditorAuthorityChanges(
    createEditorAuthorityState(0),
    [{ fromA: 0, toA: 0, fromB: 0, toB: 11 }],
    "manual",
    "author-a",
  );
  const reloaded = resetEditorAuthorityState(manual, 11);
  assert.equal(reloaded.persistence, "current-editor-session-only");
  assert.deepEqual(reloaded.spans.map((span) => ({
    range: [span.fromUtf16, span.toUtf16],
    origin: span.origin,
    eligible: span.instructionEligible,
  })), [{ range: [0, 11], origin: "unknown", eligible: false }]);
});
