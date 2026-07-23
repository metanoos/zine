import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("./WorkspaceSidebar.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");
const css = readFileSync(new URL("../app/App.css", import.meta.url), "utf8");

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
  assert.match(
    css,
    /\.tree-row-tab-focused,\s*\.action-palette-replay-target\s*\{[^}]*background:\s*var\(--accent-surface\);[^}]*color:\s*var\(--accent\);[^}]*box-shadow:\s*inset 2px 0 0 var\(--accent\)/s,
  );
  assert.match(
    css,
    /\.tree-row-tab-focused \.tree-name,\s*\.action-palette-replay-target-label\s*\{[^}]*color:\s*var\(--accent\)/s,
  );
  assert.match(css, /\.tree-row-selected\.tree-row-tab-focused\s*\{/);
});

test("tree selection stays distinct from panel focus", () => {
  assert.match(
    css,
    /\.tree-row-selected\s*\{[^}]*background:\s*var\(--surface-sunken\);[^}]*box-shadow:\s*inset 0 0 0 1px var\(--rule-strong\)/s,
  );
  assert.match(
    css,
    /\.tree-row-selected\.tree-row-tab-focused\s*\{[^}]*background:\s*var\(--accent-surface\);[^}]*inset 0 0 0 1px var\(--rule-strong\),[^}]*inset 2px 0 0 var\(--accent\)/s,
  );
  assert.match(source, /const isTraceActive = isActive && focused/);
  assert.match(
    source,
    /uiFocus\?\.panelIndex === idx &&\s*uiFocus\.tabPath === path/,
  );
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

  assert.match(
    css,
    /\.tab\.active\s*\{[^}]*box-shadow:\s*inset 0 2px 0 var\(--rule-strong\)/s,
  );
  assert.match(
    css,
    /\.tab\.trace-active\s*\{[^}]*box-shadow:\s*inset 0 2px 0 var\(--accent\)/s,
  );
  assert.match(
    css,
    /\.tab\.active\s*\{[^}]*box-shadow:\s*inset 0 2px 0 var\(--rule-strong\)[^}]*\}[\s\S]*?\.tab\.trace-active\s*\{[^}]*box-shadow:\s*inset 0 2px 0 var\(--accent\)/s,
  );
});
