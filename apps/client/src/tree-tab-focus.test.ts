import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

test("the focused panel tab is reflected in the directory tree", () => {
  assert.match(source, /const focusedTabPath = activeTab/);
  assert.match(source, /node\.path === focusedTabPath/);
  assert.match(source, /isTabFocused \? " tree-row-tab-focused" : ""/);
  assert.match(source, /aria-current=\{isTabFocused \? "true" : undefined\}/);
  assert.match(css, /\.tree-row-tab-focused\s*\{[^}]*box-shadow:\s*inset 3px 0 0 var\(--accent\)/s);
  assert.match(css, /\.tree-row-mounted\.tree-row-tab-focused\s*\{/);
});
