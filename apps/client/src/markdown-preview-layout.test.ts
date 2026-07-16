import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { analyzeMarkdownListLines, markdownListIndent } from "./markdown-preview.js";

const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");
const markdownSource = readFileSync(new URL("./markdown-preview.ts", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule for ${selector}`);
  return match[1];
}

test("preview horizontal rules do not create full-height empty line boxes", () => {
  const line = rule(".panel-mode-preview .md-hr-line");
  assert.match(line, /font-size:\s*0\s*;/);
  assert.match(line, /line-height:\s*0\s*;/);
  assert.match(line, /margin:\s*0\.2rem 0\s*;/);

  const widget = rule(".panel-mode-preview .md-hr");
  assert.match(widget, /display:\s*inline-block\s*;/);
  assert.match(widget, /width:\s*100%\s*;/);
  assert.match(widget, /vertical-align:\s*middle\s*;/);
  assert.doesNotMatch(widget, /display:\s*block\s*;/);
});

test("preview derives nested list depth from Markdown content indentation", () => {
  const twoSpace = analyzeMarkdownListLines([
    "- parent",
    "  - child",
    "    - grandchild",
    "  - sibling",
    "- root sibling",
  ]);
  assert.deepEqual(twoSpace.map((item) => item?.depth ?? null), [0, 1, 2, 1, 0]);

  const fourSpace = analyzeMarkdownListLines([
    "- parent",
    "    - child",
    "        1. grandchild",
  ]);
  assert.deepEqual(fourSpace.map((item) => item?.depth ?? null), [0, 1, 2]);
});

test("preview treats up-to-three-space markers as siblings unless they reach parent content", () => {
  const items = analyzeMarkdownListLines([
    "- parent",
    " - one-space sibling",
    "  - two-space sibling",
    "    - child",
  ]);

  assert.deepEqual(items.map((item) => item?.depth ?? null), [0, 0, 0, 1]);
  assert.equal(analyzeMarkdownListLines(["    - indented code"])[0], null);
});

test("preview keeps lazy list continuations but resets nesting across block boundaries", () => {
  const lazyContinuation = analyzeMarkdownListLines([
    "- parent",
    "lazy continuation",
    "  - child",
  ]);
  assert.deepEqual(lazyContinuation.map((item) => item?.depth ?? null), [0, null, 1]);

  const newBlock = analyzeMarkdownListLines([
    "- parent",
    "",
    "new paragraph",
    "  - new top-level list",
  ]);
  assert.deepEqual(newBlock.map((item) => item?.depth ?? null), [0, null, null, 0]);

  const fenced = analyzeMarkdownListLines(["```", "- code", "```", "- prose"]);
  assert.deepEqual(fenced.map((item) => item?.depth ?? null), [null, null, null, 0]);
});

test("preview gives every list level a readable base and nesting indent", () => {
  const list = rule(".panel-mode-preview .md-li-line");
  assert.match(list, /padding-left:\s*calc\(1\.75rem \+ var\(--md-list-indent, 0rem\)\)\s*;/);
  assert.deepEqual([0, 1, 2].map(markdownListIndent), ["0rem", "1.25rem", "2.5rem"]);
  assert.doesNotMatch(
    css,
    /\.panel-mode-preview \.md-(?:ul|task|ol)-line\s*\{[^}]*padding-left\s*:/,
  );
});

test("ordered and unordered markers use the same non-wrapping line gutter", () => {
  const list = rule(".panel-mode-preview .md-li-line");
  assert.match(list, /position:\s*relative\s*;/);

  const gutter = rule(".panel-mode-preview .md-li-line::before");
  assert.match(gutter, /position:\s*absolute\s*;/);

  const unordered = rule(".panel-mode-preview .md-ul-line::before");
  assert.match(unordered, /content:\s*"•"\s*;/);

  const ordered = rule(".panel-mode-preview .md-ol-line::before");
  assert.match(ordered, /content:\s*attr\(data-md-marker\)\s*;/);
  assert.match(ordered, /text-align:\s*right\s*;/);
  assert.doesNotMatch(markdownSource, /class OrderedListWidget/);
});
