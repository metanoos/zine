import test from "node:test";
import assert from "node:assert/strict";

import {
  completeDeletion,
  completeStagedWrite,
  pendingMoveForPath,
} from "./workspace-local.js";

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

test("an explicit write returns the newly published checkpoint", async () => {
  let retried = false;
  const nodeId = await completeStagedWrite(
    async () => "new-node-id",
    () => {
      retried = true;
    },
  );

  assert.equal(nodeId, "new-node-id");
  assert.equal(retried, false);
});

test("a failed explicit write is surfaced and scheduled for retry", async () => {
  const failure = new Error("relay unavailable");
  let retries = 0;

  await assert.rejects(
    completeStagedWrite(
      async () => {
        throw failure;
      },
      () => {
        retries++;
      },
    ),
    failure,
  );
  assert.equal(retries, 1);
});

test("deletion removes local copies only after every tombstone lands", async () => {
  const order: string[] = [];
  await completeDeletion(
    ["a.md", "b.md"],
    async (path) => {
      order.push(`remote:${path}`);
    },
    (path) => {
      order.push(`local:${path}`);
    },
  );

  assert.deepEqual(order.slice(0, 2).sort(), ["remote:a.md", "remote:b.md"]);
  assert.deepEqual(order.slice(2), ["local:a.md", "local:b.md"]);
});

test("failed tombstones leave local copies intact for retry", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    completeDeletion(
      ["a.md"],
      async () => {
        throw new Error("relay unavailable");
      },
      (path) => deleted.push(path),
    ),
    /relay unavailable/,
  );
  assert.deepEqual(deleted, []);
});
