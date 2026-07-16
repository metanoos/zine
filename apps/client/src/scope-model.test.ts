import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyScopeClick,
  mountsForGroupAction,
  mountedScopeLabel,
  pathIsMounted,
  pathInEffectiveScopes,
  pathInScopes,
  rebaseMountsAfterMove,
  topLevelMountedPaths,
  type ScopeRef,
} from "./scope-model.js";

const visible: ScopeRef[] = [
  { kind: "folder", path: "drafts" },
  { kind: "file", path: "drafts/a.md" },
  { kind: "file", path: "drafts/b.md" },
  { kind: "file", path: "final.md" },
];

test("plain tree click replaces mounts with the clicked trace", () => {
  const result = applyScopeClick(
    [{ kind: "file", path: "old.md" }],
    visible[1],
    visible,
    "old.md",
    { additive: false, range: false },
  );
  assert.deepEqual(result, { scopes: [visible[1]], anchorPath: "drafts/a.md" });
});

test("Cmd/Ctrl-click adds and removes explicit mounts", () => {
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

test("Shift-click mounts a visible range and keeps the original anchor", () => {
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

test("Cmd/Ctrl+Shift-click adds a visible range of mounts", () => {
  const result = applyScopeClick(
    [visible[3]],
    visible[2],
    visible,
    visible[0].path,
    { additive: true, range: true },
  );
  assert.deepEqual(result.scopes, [visible[3], ...visible.slice(0, 3)]);
});

test("mounted folders derive descendant scope while mounted files are exact", () => {
  assert.equal(pathInScopes([{ kind: "folder", path: "drafts" }], "drafts"), true);
  assert.equal(pathInScopes([{ kind: "folder", path: "drafts" }], "drafts/a.md"), true);
  assert.equal(pathInScopes([{ kind: "folder", path: "drafts" }], "final.md"), false);
  assert.equal(pathInScopes([{ kind: "file", path: "drafts/a.md" }], "drafts/a.md"), true);
  assert.equal(pathInScopes([{ kind: "file", path: "drafts/a.md" }], "drafts/b.md"), false);
});

test("multiple mounts derive a scope union and a root mount includes everything", () => {
  const scopes: ScopeRef[] = [
    { kind: "folder", path: "drafts" },
    { kind: "file", path: "final.md" },
  ];
  assert.equal(pathInScopes(scopes, "drafts/sub/note.md"), true);
  assert.equal(pathInScopes(scopes, "final.md"), true);
  assert.equal(pathInScopes(scopes, "archive/old.md"), false);
  assert.equal(pathInScopes([{ kind: "folder", path: "" }], "anything/here.md"), true);
});

test("mounted scope labels name the exact replay union", () => {
  assert.equal(
    mountedScopeLabel([{ kind: "folder", path: "" }], "My Zine"),
    "My Zine/",
  );
  assert.equal(
    mountedScopeLabel([
      { kind: "folder", path: "drafts" },
      { kind: "file", path: "final.md" },
    ]),
    "drafts/ + final.md",
  );
  assert.equal(mountedScopeLabel([]), "Nothing mounted");
});

test("mounted rows are exact while a mounted folder derives descendant scope", () => {
  const mounts: ScopeRef[] = [{ kind: "folder", path: "drafts" }];

  assert.equal(pathIsMounted(mounts, "drafts"), true);
  assert.equal(pathIsMounted(mounts, "drafts/a.md"), false);
  assert.equal(pathInEffectiveScopes(mounts, new Set(), "drafts/a.md"), true);
});

test("drag and context actions keep the group when their target is mounted", () => {
  const mounts: ScopeRef[] = [
    { kind: "file", path: "drafts/a.md" },
    { kind: "file", path: "final.md" },
  ];

  assert.deepEqual(mountsForGroupAction(mounts, mounts[0]), mounts);
});

test("drag and context actions mount an unmounted target alone", () => {
  const mounts: ScopeRef[] = [
    { kind: "file", path: "drafts/a.md" },
    { kind: "file", path: "final.md" },
  ];
  const target: ScopeRef = { kind: "folder", path: "archive" };

  assert.deepEqual(mountsForGroupAction(mounts, target), [target]);
});

test("group actions prune mounts already carried by a mounted ancestor", () => {
  const mounts: ScopeRef[] = [
    { kind: "folder", path: "drafts" },
    { kind: "file", path: "drafts/a.md" },
    { kind: "file", path: "final.md" },
  ];

  assert.deepEqual(topLevelMountedPaths(mounts), ["drafts", "final.md"]);
});

test("mounted children remain actionable when the synthetic root is also mounted", () => {
  const mounts: ScopeRef[] = [
    { kind: "folder", path: "" },
    { kind: "file", path: "draft.md" },
    { kind: "file", path: "notes.md" },
  ];

  assert.deepEqual(topLevelMountedPaths(mounts), ["draft.md", "notes.md"]);
});

test("moving mounted items carries every mount into the target folder", () => {
  const mounts: ScopeRef[] = [
    { kind: "file", path: "draft.md" },
    { kind: "folder", path: "notes" },
    { kind: "file", path: "notes/todo.md" },
    { kind: "file", path: "blocked.md" },
  ];

  assert.deepEqual(
    rebaseMountsAfterMove(mounts, ["draft.md", "notes"], "archive"),
    [
      { kind: "file", path: "archive/draft.md" },
      { kind: "folder", path: "archive/notes" },
      { kind: "file", path: "archive/notes/todo.md" },
      { kind: "file", path: "blocked.md" },
    ],
  );
});

test("moving a nested mount to root keeps its basename", () => {
  assert.deepEqual(
    rebaseMountsAfterMove(
      [{ kind: "file", path: "archive/draft.md" }],
      ["archive/draft.md"],
      "",
    ),
    [{ kind: "file", path: "draft.md" }],
  );
});

test("a shielded child folder blocks recursive inclusion from a mounted parent", () => {
  const scopes: ScopeRef[] = [{ kind: "folder", path: "drafts" }];
  const shielded = new Set(["drafts/private"]);

  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/public.md"), true);
  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private"), false);
  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/secret.md"), false);
});

test("directly mounted shielded files and folders start a new inclusion root", () => {
  const shielded = new Set(["drafts/private", "notes/secret.md"]);

  assert.equal(
    pathInEffectiveScopes(
      [{ kind: "file", path: "notes/secret.md" }],
      shielded,
      "notes/secret.md",
    ),
    true,
  );
  assert.equal(
    pathInEffectiveScopes(
      [{ kind: "folder", path: "drafts/private" }],
      shielded,
      "drafts/private/secret.md",
    ),
    true,
  );
});

test("an explicit child mount overrides a boundary inherited from another mount", () => {
  const scopes: ScopeRef[] = [
    { kind: "folder", path: "drafts" },
    { kind: "folder", path: "drafts/private" },
  ];
  const shielded = new Set(["drafts/private"]);

  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/secret.md"), true);
});

test("nested shielded descendants remain blocked below an explicitly mounted shielded folder", () => {
  const scopes: ScopeRef[] = [{ kind: "folder", path: "drafts/private" }];
  const shielded = new Set(["drafts/private", "drafts/private/deeper"]);

  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/visible.md"), true);
  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/deeper"), false);
  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/deeper/hidden.md"), false);
});

test("a mount inside a shielded ancestor starts inside that shielded branch", () => {
  const scopes: ScopeRef[] = [{ kind: "folder", path: "drafts/private/selected" }];
  const shielded = new Set(["drafts/private"]);

  assert.equal(pathInEffectiveScopes(scopes, shielded, "drafts/private/selected/note.md"), true);
});
