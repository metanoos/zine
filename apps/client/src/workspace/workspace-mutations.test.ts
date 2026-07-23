import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { folderTab, folderTabPath, rebaseFolderTab } from "./folder-tabs.js";
import { isValidTagToken } from "./path-operations.js";

const appSource = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");
const mutationSource = readFileSync(
  new URL("./useWorkspaceMutations.ts", import.meta.url),
  "utf8",
);

test("App mounts the extracted workspace mutation controller", () => {
  assert.match(
    appSource,
    /const\s*\{[\s\S]*moveNodes,[\s\S]*renameNode,[\s\S]*\}\s*=\s*useWorkspaceMutations\(\{/,
  );
  for (const name of ["createStart", "createCommit", "moveNodes", "deleteNodes", "renameNode"]) {
    assert.match(mutationSource, new RegExp(`function ${name}\\b`));
    assert.doesNotMatch(appSource, new RegExp(`function ${name}\\b`));
  }
  assert.match(mutationSource, /forkMintedNodes,\s*adoptScannedNodes/);
  assert.match(mutationSource, /backendRef\.current\.deleteLocalPath\(/);
  assert.match(mutationSource, /blocksPendingMintSourceMutation/);
  assert.match(mutationSource, /reconcileFailedPathMutation/);
});

test("folder-tab paths preserve their sentinel while rebasing", () => {
  const tab = folderTab("drafts/notes");
  assert.equal(folderTabPath(tab), "drafts/notes");
  assert.equal(rebaseFolderTab(tab, "drafts", "archive"), "folder://archive/drafts/notes");
  assert.equal(rebaseFolderTab("plain.md", "drafts", "archive"), "plain.md");
});

test("folder names retain the unchanged Nostr tag-token contract", () => {
  assert.equal(isValidTagToken("drafts_2026"), true);
  assert.equal(isValidTagToken("研究-notes"), true);
  assert.equal(isValidTagToken("draft notes"), false);
  assert.equal(isValidTagToken("-drafts"), false);
});
