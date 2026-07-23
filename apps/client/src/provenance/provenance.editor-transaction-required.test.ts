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
} satisfies Omit<PublishEditInput, "editorTransactions">;

test("publisher rejects a file Step that omits its EditorTransaction array", async () => {
  await assert.rejects(
    publishEdit(base as unknown as PublishEditInput),
    /required EditorTransaction array/,
  );
});

test("publisher rejects an empty EditorTransaction array for changed content", async () => {
  await assert.rejects(
    publishEdit({ ...base, editorTransactions: [] }),
    /do not reproduce the signed snapshot/,
  );
});

test("publisher rejects editor transactions whose replay differs from the signed snapshot", async () => {
  await assert.rejects(
    publishEdit({
      ...base,
      editorTransactions: [{
        sequence: 0,
        timestamp: 1,
        actor: "voice",
        changes: [{ op: "insert", from: 0, to: 0, text: "other" }],
        selectionBefore: null,
        selectionAfter: null,
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
      editorTransactions: [],
    }),
    /genesis EditorTransactions must start from the empty snapshot/,
  );
});
