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
  rebaseContextMountAfterRename,
  rebaseShieldedAfterMove,
  rebaseShieldedPath,
  rebaseTraceRefsAfterMove,
  removeDeletedShieldedPaths,
  revertShieldedPathChange,
  selectionForGroupAction,
  shieldedPathChange,
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

test("rebaseContextMountAfterRename covers exact, descendant, ancestor, and unrelated cases", () => {
  // (a) scope IS the renamed node -> exact rewrite.
  assert.deepEqual(
    rebaseContextMountAfterRename(
      [{ kind: "folder", path: "drafts/old" }],
      "drafts/old",
      "drafts/new",
      true,
    ),
    [{ kind: "folder", path: "drafts/new" }],
  );
  // (a') file rename of a file scope mount -> exact rewrite.
  assert.deepEqual(
    rebaseContextMountAfterRename(
      [{ kind: "file", path: "notes/a.md" }],
      "notes/a.md",
      "notes/b.md",
      false,
    ),
    [{ kind: "file", path: "notes/b.md" }],
  );
  // (b) scope is an ANCESTOR of the renamed node (parent folder of the node)
  //     -> unchanged. The renamed node lives inside scope, scope's path is
  //     not itself rewritten.
  assert.deepEqual(
    rebaseContextMountAfterRename(
      [{ kind: "folder", path: "drafts" }],
      "drafts/old",
      "drafts/new",
      true,
    ),
    [{ kind: "folder", path: "drafts" }],
  );
  // (c) scope is a DESCENDANT of a renamed folder -> prefix rewrite.
  assert.deepEqual(
    rebaseContextMountAfterRename(
      [{ kind: "file", path: "drafts/old/notes.md" }],
      "drafts/old",
      "drafts/new",
      true,
    ),
    [{ kind: "file", path: "drafts/new/notes.md" }],
  );
  // (c') a file rename MUST NOT prefix-rewrite a descendant-looking path,
  //      because a file has no descendants. Only an exact match rewrites.
  assert.deepEqual(
    rebaseContextMountAfterRename(
      [{ kind: "file", path: "notes/a.md/extra" }],
      "notes/a.md",
      "notes/b.md",
      false,
    ),
    [{ kind: "file", path: "notes/a.md/extra" }],
  );
  // (d) unrelated mount -> unchanged (and the same array reference is returned).
  const unrelated: ContextMounts = [{ kind: "folder", path: "other" }];
  assert.equal(
    rebaseContextMountAfterRename(unrelated, "drafts/old", "drafts/new", true),
    unrelated,
  );
  // Empty mount stays empty.
  assert.deepEqual(
    rebaseContextMountAfterRename([], "drafts/old", "drafts/new", true),
    [],
  );
  // A regression that rewrote every path to destPath (ignoring the ancestor
  // and unrelated cases) would fail the (b) and (d) assertions above.
});

test("moving or renaming a shield boundary carries its nested exclusions", () => {
  assert.deepEqual(
    rebaseShieldedPath(
      new Set(["private", "private/deeper", "untouched"]),
      "private",
      "archive/private",
    ),
    new Set(["archive/private", "archive/private/deeper", "untouched"]),
  );
  assert.deepEqual(
    rebaseShieldedPath(new Set(["notes/draft.md"]), "notes/draft.md", "notes/final.md"),
    new Set(["notes/final.md"]),
  );
});

test("moving content out of an inherited shield keeps the destination shielded", () => {
  assert.deepEqual(
    rebaseShieldedAfterMove(
      new Set(["private"]),
      ["private/a.md", "private/sub"],
      "archive",
    ),
    new Set(["private", "archive/a.md", "archive/sub"]),
  );
});

test("hard delete drops contained shield boundaries without removing ancestors", () => {
  assert.deepEqual(
    removeDeletedShieldedPaths(
      new Set(["private", "private/deleted/secret", "other"]),
      ["private/deleted"],
    ),
    new Set(["private", "other"]),
  );
});

test("failed moves reverse only their own shield changes", () => {
  const before = new Set(["private"]);
  const movedOut = rebaseShieldedPath(before, "private/a.md", "archive/a.md");
  assert.deepEqual(
    revertShieldedPathChange(movedOut, shieldedPathChange(before, movedOut)),
    before,
  );

  // Moving an unshielded source into a shielded destination changes no explicit
  // boundary. A failed move must not install a new shield at the old source.
  const movedIn = rebaseShieldedPath(before, "public/a.md", "private/a.md");
  assert.deepEqual(shieldedPathChange(before, movedIn), { added: [], removed: [] });
  assert.deepEqual(
    revertShieldedPathChange(movedIn, shieldedPathChange(before, movedIn)),
    before,
  );
});
