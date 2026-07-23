import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  bracketExtensions,
  bracketRangeAt,
  doubleBackspaceReopenCommand,
  findAddedInlineCitations,
  findInProgressBracket,
  findMintSelectionTarget,
  findResolvedBrackets,
  modeFacet,
  resolveBracket,
  resolvedBracketMarkup,
} from "./brackets.js";

function edited(
  doc: string,
  mode: "markdown" | "preview",
  changes: { from: number; to: number; insert?: string },
  userEvent: string,
): string {
  const state = EditorState.create({
    doc,
    extensions: [modeFacet.of(mode), ...bracketExtensions()],
  });
  return state.update({ changes, userEvent }).state.doc.toString();
}

test("resolvedBracketMarkup builds pasteable citation text", () => {
  assert.equal(
    resolvedBracketMarkup("  a minted phrase  ", "node-123"),
    "[[ a minted phrase | node-123 ]]",
  );
});

test("resolvedBracketMarkup round-trips through the bracket parser", () => {
  const markup = resolvedBracketMarkup("first line\nsecond line", "node-456");
  assert.deepEqual(findResolvedBrackets(markup), [
    {
      phrase: "first line\nsecond line",
      nodeId: "node-456",
      matchStart: 0,
      matchEnd: markup.length,
    },
  ]);
});

test("resolvedBracketMarkup rejects an empty phrase or node id", () => {
  assert.equal(resolvedBracketMarkup("   ", "node-789"), "");
  assert.equal(resolvedBracketMarkup("phrase", ""), "");
});

test("findAddedInlineCitations records only newly installed coin occurrences", () => {
  const prior = "Existing [[ first coin | node-a ]]";
  const next = `${prior}; copied [[ second coin | node-b ]]`;
  assert.deepEqual(findAddedInlineCitations(prior, next), [
    {
      sourceEventId: "node-b",
      newValue: "second coin",
      positionStart: next.indexOf("second coin"),
      positionEnd: next.indexOf("second coin") + "second coin".length,
    },
  ]);
});

test("findAddedInlineCitations uses multiset semantics for repeated coins", () => {
  const prior = "[[ repeat | node-a ]]";
  const next = `${prior} + [[ repeat | node-a ]]`;
  assert.equal(findAddedInlineCitations(prior, next).length, 1);
});

test("findAddedInlineCitations does not turn a moved coin into a new citation", () => {
  const prior = "before [[ moving | node-a ]] after";
  const next = "[[ moving | node-a ]] before after";
  assert.deepEqual(findAddedInlineCitations(prior, next), []);
});

test("findAddedInlineCitations does not turn an edited bracket into a new citation", () => {
  const prior = "[[ original words | node-a ]]";
  const next = "[[ edited words | node-a ]]";
  assert.deepEqual(findAddedInlineCitations(prior, next), []);
});

test("click target lookup exposes the phrase separately from bracket markup", () => {
  const doc = "before [[ kept | node-1 ]] after";
  assert.deepEqual(bracketRangeAt(doc, doc.indexOf("kept") + 1), {
    phrase: "kept",
    matchStart: 7,
    matchEnd: 26,
    phraseStart: 10,
    phraseEnd: 14,
    resolved: true,
  });
});

test("an opening bracket stays in progress through the first closing bracket", () => {
  for (const doc of ["[[", "[[ kept", "[[ kept ]"] as const) {
    assert.deepEqual(findInProgressBracket(doc), {
      matchStart: 0,
      matchEnd: doc.length,
    });
  }
  assert.equal(findInProgressBracket("[[ kept ]]"), null);

  const afterComplete = "[[ done ]] then [[ draft ]";
  assert.deepEqual(findInProgressBracket(afterComplete), {
    matchStart: afterComplete.lastIndexOf("[["),
    matchEnd: afterComplete.length,
  });
});

test("Step target: a loose highlight mints exactly the highlighted text", () => {
  const doc = "before selected after";
  assert.deepEqual(findMintSelectionTarget(doc, 7, 15), {
    phrase: "selected",
    bracket: null,
  });
});

test("Step target: selecting a pending bracket mints its visible phrase", () => {
  const doc = "before [[ selected ]] after";
  assert.deepEqual(findMintSelectionTarget(doc, 7, 21), {
    phrase: "selected",
    bracket: {
      matchStart: 7,
      matchEnd: 21,
      phraseStart: 10,
      phraseEnd: 18,
    },
  });
});

test("Step target rejects resolved and cross-boundary bracket selections", () => {
  const resolved = "before [[ selected | node-1 ]] after";
  assert.equal(findMintSelectionTarget(resolved, 7, 30), null);

  const pending = "before [[ selected ]] after";
  assert.equal(findMintSelectionTarget(pending, 0, pending.length), null);
});

test("mint resolution turns either selection route into a citation", () => {
  const pending = "before [[ selected ]] after";
  const target = findMintSelectionTarget(pending, 7, 21);
  assert.ok(target?.bracket);
  const resolved = resolveBracket(
    pending,
    target.bracket.matchStart,
    target.bracket.matchEnd,
    "node-1",
  );
  assert.deepEqual(findResolvedBrackets(resolved), [
    { phrase: "selected", nodeId: "node-1", matchStart: 7, matchEnd: 30 },
  ]);
});

for (const mode of ["markdown", "preview"] as const) {
  test(`${mode}: selection deletion preserves complete brackets`, () => {
    const doc = "loose [[ kept ]] words";
    assert.equal(
      edited(doc, mode, { from: 0, to: doc.length }, "delete.selection"),
      "[[ kept ]]",
    );
  });
}

test("Cut removes the complete selection, including brackets", () => {
  const doc = "loose [[ kept ]] words";
  assert.equal(edited(doc, "markdown", { from: 0, to: doc.length }, "delete.cut"), "");
});

test("paste/type-over replaces the complete selection, including brackets", () => {
  const doc = "loose [[ kept ]] words";
  assert.equal(
    edited(doc, "preview", { from: 0, to: doc.length, insert: "pasted" }, "input.paste"),
    "pasted",
  );
});

test("double Backspace reopens a resolved bracket while preserving its opener", () => {
  let time = 100;
  let state = EditorState.create({
    doc: "before [[ kept | node-1 ]] after",
    selection: { anchor: 10, head: 14 },
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const command = doubleBackspaceReopenCommand(() => time);

  assert.equal(command(view), true);
  assert.equal(state.doc.toString(), "before [[ kept | node-1 ]] after");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 7, to: 26 },
  );

  time = 500;
  assert.equal(command(view), true);
  assert.equal(state.doc.toString(), "before [[ kept after");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 10, to: 14 },
  );
});

test("double Backspace from after a pending chip reopens it for editing", () => {
  let time = 100;
  let state = EditorState.create({
    doc: "[[ draft ]]",
    selection: { anchor: "[[ draft ]]".length },
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorView["dispatch"]>[0]) {
      state = state.update(spec).state;
    },
  } as unknown as EditorView;
  const command = doubleBackspaceReopenCommand(() => time);

  assert.equal(command(view), true);
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 0, to: "[[ draft ]]".length },
  );

  time = 500;
  assert.equal(command(view), true);
  assert.equal(state.doc.toString(), "[[ draft");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 3, to: 8 },
  );
});
