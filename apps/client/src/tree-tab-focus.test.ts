import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./App.css", import.meta.url), "utf8");

function sourceBetween(start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

test("the singular semantic focus is reflected in the directory tree", () => {
  assert.match(source, /const focusedTabPath = focusDirectoryPath\(uiFocus\)/);
  assert.match(source, /node\.path === focusedTabPath/);
  assert.match(source, /isTabFocused \? " tree-row-tab-focused" : ""/);
  assert.match(source, /aria-current=\{isTabFocused \? "true" : undefined\}/);
  assert.match(css, /\.tree-row-tab-focused\s*\{[^}]*box-shadow:\s*inset 4px 0 0 var\(--accent\)/s);
  assert.match(css, /\.tree-row-selected\.tree-row-tab-focused\s*\{/);
});

test("tree selection stays distinct from panel focus", () => {
  assert.match(
    css,
    /\.tree-row-selected\s*\{[^}]*background:\s*var\(--surface-sunken\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--rule-strong\)/s,
  );
  assert.match(
    css,
    /\.tree-row-selected\.tree-row-tab-focused\s*\{[^}]*inset 0 0 0 1px var\(--rule-strong\),[^}]*inset 4px 0 0 var\(--accent\)/s,
  );
  assert.match(source, /const isTraceActive = isActive && focused/);
});

test("plain row clicks focus while modifiers only change operation selection", () => {
  const handler = source.slice(
    source.indexOf("function onRowActivate(item: ActivatableTreeItem"),
    source.indexOf("// dismiss the context menu"),
  );
  assert.match(handler, /if \(!e\.metaKey && !e\.ctrlKey && !e\.shiftKey\)/);
  assert.match(handler, /onSelectionChange\(\[\]\);[\s\S]*?activateTreeItem\(item/);
  assert.match(handler, /applyScopeClick\([\s\S]*?onSelectionChange\(result\.scopes\)/);
  assert.match(source, /className="tree-expand-btn"[\s\S]*?onToggleFolder\(node\.path\)/);
});

test("folder row focus selects replay without opening a folder tab", () => {
  const selectFolder = sourceBetween(
    "function selectFolder(path: string) {",
    "function openFolder(path: string) {",
  );
  assert.match(selectFolder, /commitUiFocus\(locateFocus\(\{ kind: "folder", path, nodeId \}/);
  assert.doesNotMatch(selectFolder, /activateLiveTab|folderTab\(/);

  const openFolder = sourceBetween(
    "function openFolder(path: string) {",
    "function selectSpan(nodeId: string, phrase: string) {",
  );
  assert.match(openFolder, /activateLiveTab\(folderTab\(path\)/);
  assert.match(source, /onActivateFolder=\{selectFolder\}/);
  assert.match(source, /onOpenFolder=\{openFolder\}/);
});
