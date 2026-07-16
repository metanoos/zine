import test from "node:test";
import assert from "node:assert/strict";

import { pendingMoveForPath } from "./workspace-local.js";

test("active to Oblivion retains the active relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("draft.md", "oblivion/stamp/draft.md"),
    { kind: "to-oblivion", fromPath: "draft.md" },
  );
});

test("rapid restore before Oblivion sync remains one move from the original path", () => {
  assert.deepEqual(
    pendingMoveForPath(
      "oblivion/stamp/draft.md",
      "restored/draft.md",
      { kind: "to-oblivion", fromPath: "draft.md" },
    ),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("restore after a completed move to Oblivion extends from its local copy", () => {
  assert.deepEqual(
    pendingMoveForPath("oblivion/stamp/draft.md", "restored/draft.md"),
    { kind: "restore", fromPath: "oblivion/stamp/draft.md" },
  );
});

test("several active moves retain the first relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("notes/draft.md", "final/draft.md", {
      kind: "move",
      fromPath: "draft.md",
    }),
    { kind: "move", fromPath: "draft.md" },
  );
});
