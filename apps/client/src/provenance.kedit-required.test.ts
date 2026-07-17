import assert from "node:assert/strict";
import test from "node:test";

import { publishEdit, type PublishEditInput } from "./provenance.js";

const base = {
  prevEventId: null,
  previousSnapshot: "",
  relativePath: "draft.md",
  folderId: "folder",
  deltas: [],
  snapshot: "changed",
  contentHash: "hash",
} satisfies Omit<PublishEditInput, "kedits">;

test("publisher rejects a file Step that omits its KEdit array", async () => {
  await assert.rejects(
    publishEdit(base as unknown as PublishEditInput),
    /required KEdit array/,
  );
});

test("publisher rejects an empty KEdit array for changed content", async () => {
  await assert.rejects(
    publishEdit({ ...base, kedits: [] }),
    /do not reproduce the signed snapshot/,
  );
});

test("publisher rejects KEdits whose replay differs from the signed snapshot", async () => {
  await assert.rejects(
    publishEdit({
      ...base,
      kedits: [{
        op: "ins",
        from: 0,
        to: 0,
        text: "other",
        voice: "voice",
        t: 1,
        tx: 0,
      }],
    }),
    /do not reproduce the signed snapshot/,
  );
});

test("publisher rejects a genesis transition that claims a non-empty pre-state", async () => {
  await assert.rejects(
    publishEdit({
      ...base,
      previousSnapshot: "not genesis",
      kedits: [],
    }),
    /genesis KEdits must start from the empty snapshot/,
  );
});
