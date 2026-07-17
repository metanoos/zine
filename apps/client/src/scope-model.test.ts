import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyContextMount,
  applyScopeClick,
  contextMountState,
  mountedScopeLabel,
  pathInEffectiveScope,
  pathInTraceScopes,
  rebaseContextMountAfterMove,
  rebaseTraceRefsAfterMove,
  selectionForGroupAction,
  topLevelSelectedPaths,
  type ContextMounts,
  type ScopeRef,
} from "./scope-model.js";

const visible: ScopeRef[] = [
  { kind: "folder", path: "drafts" },
  { kind: "file", path: "drafts/a.md" },
  { kind: "file", path: "drafts/b.md" },
  { kind: "file", path: "final.md" },
];

test("plain tree click replaces the tree selection with the clicked trace", () => {
  const result = applyScopeClick(
    [{ kind: "file", path: "old.md" }],
    visible[1],
    visible,
    "old.md",
    { additive: false, range: false },
  );
  assert.deepEqual(result, { scopes: [visible[1]], anchorPath: "drafts/a.md" });
});

test("Cmd/Ctrl-click adds and removes tree selections", () => {
  const added = applyScopeClick(
    [visible[1]],
    visible[3],
    visible,
    visible[1].path,
    { additive: true, range: false },
  );
  assert.deepEqual(added.scopes, [visible[1], visible[3]]);

  const removed = applyScopeClick(
    added.scopes,
    visible[1],
    visible,
    added.anchorPath,
    { additive: true, range: false },
  );
  assert.deepEqual(removed.scopes, [visible[3]]);
});

test("Shift-click selects a visible range and keeps the original anchor", () => {
  const result = applyScopeClick(
    [visible[1]],
    visible[3],
    visible,
    visible[1].path,
    { additive: false, range: true },
  );
  assert.deepEqual(result.scopes, visible.slice(1, 4));
  assert.equal(result.anchorPath, visible[1].path);
});

test("Cmd/Ctrl+Shift-click adds a visible selection range", () => {
  const result = applyScopeClick(
    [visible[3]],
    visible[2],
    visible,
    visible[0].path,
    { additive: true, range: true },
  );
  assert.deepEqual(result.scopes, [visible[3], ...visible.slice(0, 3)]);
});

test("multi-selection still derives a replay path union", () => {
  const selection: ScopeRef[] = [
    { kind: "folder", path: "drafts" },
    { kind: "file", path: "final.md" },
  ];
  assert.equal(pathInTraceScopes(selection, new Set(), "drafts/sub/note.md"), true);
  assert.equal(pathInTraceScopes(selection, new Set(), "final.md"), true);
  assert.equal(pathInTraceScopes(selection, new Set(), "archive/old.md"), false);
});

test("drag and context actions keep a selected group", () => {
  const selection: ScopeRef[] = [visible[1], visible[3]];
  assert.deepEqual(selectionForGroupAction(selection, visible[1]), selection);
  assert.deepEqual(
    selectionForGroupAction(selection, { kind: "folder", path: "archive" }),
    [{ kind: "folder", path: "archive" }],
  );
});

test("group actions prune selected descendants", () => {
  assert.deepEqual(
    topLevelSelectedPaths([
      { kind: "folder", path: "drafts" },
      { kind: "file", path: "drafts/a.md" },
      { kind: "file", path: "final.md" },
    ]),
    ["drafts", "final.md"],
  );
});

test("moving selected items carries every selected coordinate", () => {
  assert.deepEqual(
    rebaseTraceRefsAfterMove(
      [
        { kind: "file", path: "draft.md" },
        { kind: "folder", path: "notes" },
        { kind: "file", path: "notes/todo.md" },
        { kind: "file", path: "blocked.md" },
      ],
      ["draft.md", "notes"],
      "archive",
    ),
    [
      { kind: "file", path: "archive/draft.md" },
      { kind: "folder", path: "archive/notes" },
      { kind: "file", path: "archive/notes/todo.md" },
      { kind: "file", path: "blocked.md" },
    ],
  );
});

test("a context mount is singular and mounting another trace replaces it", () => {
  const result = applyContextMount(
    [{ kind: "folder", path: "drafts" }],
    new Set(["archive/private", "notes/private"]),
    { kind: "file", path: "notes/todo.md" },
    true,
  );

  assert.deepEqual(result.mounts, [{ kind: "file", path: "notes/todo.md" }]);
  assert.deepEqual(result.shielded, new Set(["archive/private", "notes/private"]));
  assert.equal(pathInEffectiveScope(result.mounts, result.shielded, "drafts/a.md"), false);
  assert.equal(pathInEffectiveScope(result.mounts, result.shielded, "notes/todo.md"), true);
});

test("mounting through a conflicting shield clears only that conflict", () => {
  const result = applyContextMount(
    [{ kind: "folder", path: "drafts" }],
    new Set(["notes", "notes/private", "archive"]),
    { kind: "file", path: "notes/todo.md" },
    true,
  );

  assert.deepEqual(result.mounts, [{ kind: "file", path: "notes/todo.md" }]);
  assert.deepEqual(result.shielded, new Set(["notes/private", "archive"]));
});

test("the exact mount and inherited folder inclusion are distinct states", () => {
  const mounts: ContextMounts = [{ kind: "folder", path: "drafts" }];
  const shielded = new Set(["drafts/private"]);

  assert.equal(contextMountState(mounts, shielded, "drafts"), "mounted");
  assert.equal(contextMountState(mounts, shielded, "drafts/a.md"), "included");
  assert.equal(contextMountState(mounts, shielded, "drafts/private"), "shielded");
  assert.equal(contextMountState(mounts, shielded, "drafts/private/b.md"), "unmounted");
  assert.equal(contextMountState(mounts, shielded, "archive"), "unmounted");
});

test("excluding an included descendant keeps the one mount and installs a shield", () => {
  const result = applyContextMount(
    [{ kind: "folder", path: "drafts" }],
    new Set(["drafts/private/deeper"]),
    { kind: "folder", path: "drafts/private" },
    false,
  );

  assert.deepEqual(result.mounts, [{ kind: "folder", path: "drafts" }]);
  assert.deepEqual(result.shielded, new Set(["drafts/private"]));
  assert.equal(contextMountState(result.mounts, result.shielded, "drafts"), "mounted");
  assert.equal(contextMountState(result.mounts, result.shielded, "drafts/public.md"), "included");
  assert.equal(contextMountState(result.mounts, result.shielded, "drafts/private"), "shielded");
});

test("unmounting the exact context root clears context", () => {
  assert.deepEqual(
    applyContextMount(
      [{ kind: "folder", path: "drafts" }],
      new Set(["drafts/private"]),
      { kind: "folder", path: "drafts" },
      false,
    ),
    { mounts: [], shielded: new Set() },
  );
});

test("folder and file mounts derive different effective scopes", () => {
  assert.equal(
    pathInEffectiveScope([{ kind: "folder", path: "drafts" }], new Set(), "drafts/a.md"),
    true,
  );
  assert.equal(
    pathInEffectiveScope([{ kind: "folder", path: "drafts" }], new Set(), "final.md"),
    false,
  );
  assert.equal(
    pathInEffectiveScope([{ kind: "file", path: "drafts/a.md" }], new Set(), "drafts/b.md"),
    false,
  );
});

test("the singular mount label and move rebase stay stable", () => {
  assert.equal(mountedScopeLabel([{ kind: "folder", path: "" }], "My Zine"), "My Zine/");
  assert.equal(mountedScopeLabel([{ kind: "file", path: "final.md" }]), "final.md");
  assert.equal(mountedScopeLabel([]), "Nothing mounted");
  assert.deepEqual(
    rebaseContextMountAfterMove(
      [{ kind: "file", path: "archive/draft.md" }],
      ["archive/draft.md"],
      "",
    ),
    [{ kind: "file", path: "draft.md" }],
  );
});
