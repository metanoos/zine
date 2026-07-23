import assert from "node:assert/strict";
import test from "node:test";

import {
  focusDirectoryPath,
  focusMatchesTrace,
  focusReplayTarget,
  locateFocus,
  rebaseUiFocus,
  refreshFocusNode,
  sameUiFocus,
} from "./ui-focus.js";

test("a borrowed tab locus does not make a different semantic trace active", () => {
  const file = { kind: "file" as const, path: "draft.md", nodeId: "file-head" };
  const folder = locateFocus(
    { kind: "folder", path: "essays", nodeId: "folder-head" },
    0,
    "draft.md",
  );

  assert.equal(focusMatchesTrace(folder, file), false);
  assert.equal(
    focusMatchesTrace(folder, { kind: "folder", path: "essays", nodeId: "older-head" }),
    true,
    "advancing node ids do not change the selected semantic identity",
  );
});

test("focus records one semantic trace and exact duplicate-tab locus", () => {
  const focus = locateFocus(
    { kind: "file", path: "draft.md", nodeId: "n1" },
    2,
    "draft.md",
  );

  assert.deepEqual(focus, {
    kind: "file",
    path: "draft.md",
    nodeId: "n1",
    panelIndex: 2,
    tabPath: "draft.md",
  });
  assert.equal(
    sameUiFocus(focus, { ...focus, panelIndex: 1 }),
    false,
    "the same trace in another panel is not the focused tab",
  );
});

test("refreshing a head preserves the focus locus", () => {
  const focus = locateFocus(
    { kind: "folder", path: "essays", nodeId: "old" },
    1,
    "folder://essays",
  );

  assert.deepEqual(refreshFocusNode(focus, "new"), {
    ...focus,
    nodeId: "new",
  });
  assert.equal(refreshFocusNode(focus, "old"), focus);
});

test("rename and move rebase semantic and tab paths together", () => {
  const focus = locateFocus(
    { kind: "folder", path: "drafts" },
    0,
    "folder://drafts",
  );
  const rebased = rebaseUiFocus(
    focus,
    (path) => path.replace(/^drafts/, "essays"),
    (tab) => tab.replace(/^folder:\/\/drafts/, "folder://essays"),
  );

  assert.deepEqual(rebased, {
    ...focus,
    path: "essays",
    tabPath: "folder://essays",
  });
});

test("directory and replay projections derive from focus only", () => {
  const folder = locateFocus({ kind: "folder", path: "essays" }, 0, "folder://essays");
  const coin = locateFocus(
    { kind: "coin", path: "Mint/idea.md", nodeId: "coin" },
    0,
    "Mint/idea.md",
  );
  const nodeOnly = locateFocus({ kind: "coin", nodeId: "remote" }, 0, "draft.md");

  assert.equal(focusDirectoryPath(folder), "essays");
  assert.deepEqual(focusReplayTarget(folder), { kind: "folder", path: "essays" });
  assert.deepEqual(focusReplayTarget(coin), { kind: "file", path: "Mint/idea.md" });
  assert.equal(focusDirectoryPath(nodeOnly), null);
  assert.equal(focusReplayTarget(nodeOnly), null);
});

test("the pathless Root folder remains a replay target", () => {
  const root = locateFocus({ kind: "folder", path: "" }, 0, "");
  assert.deepEqual(focusReplayTarget(root), { kind: "folder", path: "" });
});
