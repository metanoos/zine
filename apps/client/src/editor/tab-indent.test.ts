import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { indentWithTab } from "@codemirror/commands";
import { EditorState, type Transaction } from "@codemirror/state";
import { MARKDOWN_TAB_WIDTH, markdownIndentExtensions } from "./tab-indent.js";

const source = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

type CommandTarget = Parameters<NonNullable<typeof indentWithTab.run>>[0];

function runCommand(command: NonNullable<typeof indentWithTab.run>, doc: string): string {
  let state = EditorState.create({ doc, extensions: markdownIndentExtensions });
  const target = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  } as CommandTarget;

  assert.equal(command(target), true);
  return state.doc.toString();
}

test("the press binds Tab to one four-space Markdown indentation unit", () => {
  assert.match(source, /import \{[^}]*indentWithTab[^}]*\} from "@codemirror\/commands"/s);
  assert.match(source, /\.\.\.markdownIndentExtensions/);
  assert.match(source, /keymap\.of\(\[[\s\S]*?\bindentWithTab,/);
  assert.equal(MARKDOWN_TAB_WIDTH, 4);
  assert.equal(runCommand(indentWithTab.run!, "line"), "    line");
});

test("Shift+Tab removes the same four-space indentation unit", () => {
  assert.ok(indentWithTab.shift, "indentWithTab should provide a Shift+Tab command");
  assert.equal(runCommand(indentWithTab.shift, "    line"), "line");
});

test("one Tab nests both unordered and ordered Markdown list items", () => {
  assert.equal(runCommand(indentWithTab.run!, "- child"), "    - child");
  assert.equal(runCommand(indentWithTab.run!, "1. child"), "    1. child");
});
