import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyContextMount,
  contextMountState,
  pathInEffectiveScope,
  type ContextMounts,
} from "../ai/scope-model.js";
import {
  applyMountScope,
  mountScopeFromParts,
  mountScopeKey,
  mountScopeParts,
  mountStateForPath,
  pathInMountScope,
  rebaseMountScopeAfterMove,
  type MountScope,
} from "./mount-scope.js";

test("LLM context and shared workspace mounts use the same resolver", () => {
  const mounts = [
    { kind: "folder" as const, path: "drafts" },
  ] satisfies ContextMounts;
  const shielded = new Set(["drafts/private"]);
  const scope = mountScopeFromParts(mounts, shielded);

  for (const path of [
    "drafts",
    "drafts/public.md",
    "drafts/private",
    "drafts/private/notes.md",
    "archive.md",
  ]) {
    assert.equal(
      pathInMountScope(scope, path),
      pathInEffectiveScope(mounts, shielded, path),
    );
    assert.equal(
      mountStateForPath(scope, path),
      contextMountState(mounts, shielded, path),
    );
  }
});

test("mount mutations remain identical through the context compatibility API", () => {
  const current: MountScope = {
    mount: { kind: "folder", path: "drafts" },
    shields: ["drafts/private/deeper"],
  };
  const target = { kind: "folder" as const, path: "drafts/private" };

  const direct = mountScopeParts(applyMountScope(current, target, false));
  const context = applyContextMount(
    [{ kind: "folder", path: "drafts" }],
    new Set(["drafts/private/deeper"]),
    target,
    false,
  );

  assert.deepEqual(direct, context);
  assert.deepEqual(direct.shielded, new Set(["drafts/private"]));
});

test("mount serialization is stable and folder moves rebase shields", () => {
  const left: MountScope = {
    mount: { kind: "folder", path: "drafts" },
    shields: ["drafts/private", "drafts/research", "drafts/private"],
  };
  const right: MountScope = {
    mount: { kind: "folder", path: "drafts" },
    shields: ["drafts/research", "drafts/private"],
  };

  assert.equal(mountScopeKey(left), mountScopeKey(right));
  assert.deepEqual(
    rebaseMountScopeAfterMove(left, ["drafts"], "archive"),
    {
      mount: { kind: "folder", path: "archive/drafts" },
      shields: [
        "archive/drafts/private",
        "archive/drafts/research",
      ],
    },
  );
});

test("a file mount never includes siblings", () => {
  const scope: MountScope = {
    mount: { kind: "file", path: "drafts/a.md" },
    shields: [],
  };

  assert.equal(pathInMountScope(scope, "drafts/a.md"), true);
  assert.equal(pathInMountScope(scope, "drafts/b.md"), false);
});
