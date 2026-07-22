import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = [
  readFileSync(new URL("../app/AppShell.tsx", import.meta.url), "utf8"),
  readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8"),
].join("\n");

function sourceBetween(start: string, end: string): string {
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(startAt, -1, `missing source marker: ${start}`);
  assert.notEqual(endAt, -1, `missing source marker: ${end}`);
  return source.slice(startAt, endAt);
}

test("selecting a live tab moves focus without changing context mounts", () => {
  const handler = sourceBetween("onSelectTab={(p) => {", "onCloseTab={(p) =>");
  assert.match(handler, /chooseDirectorySelection\(\[\]\)/);
  assert.match(handler, /commitUiFocus\(locateFocus\(/);
  assert.doesNotMatch(handler, /setContextMount|setScope|setShielded/);
});

test("tree operation selection is independent while replay follows focus", () => {
  assert.match(source, /onSelectionChange\(result\.scopes\)/);
  assert.match(source, /selectedItems=\{directorySelection\}/);
  assert.match(source, /targets=\{replayTargets\}/);
  assert.match(source, /const target = focusReplayTarget\(uiFocusRef\.current\)/);
  assert.match(source, /const playbackScopes = target \? \[target\] : \[\]/);
  assert.doesNotMatch(source, /playbackScopes = \[\.\.\.directorySelectionRef\.current\]/);
});

test("folder tabs focus their underlying folder for playback", () => {
  assert.match(
    source,
    /isFolderTab\(path\)[\s\S]*folderPath = folderTabPath\(path\)[\s\S]*kind: "folder"/,
  );
});

test("clicking a replay projection exits replay and focuses a live tab", () => {
  const handler = sourceBetween("onSelectTab={(p) => {", "onCloseTab={(p) =>");
  assert.match(handler, /if \(panel\.replayOwned\) \{[\s\S]*?activateLiveTab\(p, focusRefForTab\(p\)\);[\s\S]*?return;/);
  assert.match(source, /replay projections may become frontmost[\s\S]*?never steal or rewrite this value/);
});

test("node-only Coin focus clears directory operation selection and keeps its tab locus", () => {
  const selectSpan = sourceBetween(
    "function selectSpan(nodeId: string, phrase: string) {",
    "/** Replace, clear, or exclude within the one prompt-context mount. */",
  );
  assert.match(
    selectSpan,
    /chooseDirectorySelection\(\[\]\);[\s\S]*?locateFocus\(\{ kind: "coin", nodeId, phrase \}, host\.panelIndex, host\.tabPath\)/,
  );
  assert.doesNotMatch(selectSpan, /setContextMount|setScope|setShielded/);
});
