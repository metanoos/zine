import test from "node:test";
import assert from "node:assert/strict";

import { deleteOutcomeMessage } from "./delete-confirmation.js";

test("deleting a trace outside Oblivion explains that it can be restored", () => {
  assert.equal(
    deleteOutcomeMessage(["draft.md"]),
    "It will be moved to Oblivion, where it can be restored.",
  );
  assert.equal(
    deleteOutcomeMessage(["draft.md", "notes/idea.md"]),
    "They will be moved to Oblivion, where they can be restored.",
  );
});

test("deleting from Oblivion retains the permanent-deletion warning", () => {
  assert.equal(
    deleteOutcomeMessage(["oblivion/2026-07-15_120000/draft.md"]),
    "Deleting it from Oblivion is permanent and cannot be undone.",
  );
});

test("mixed deletions explain both outcomes", () => {
  assert.equal(
    deleteOutcomeMessage(["draft.md", "oblivion/2026-07-15_120000/old.md"]),
    "Items outside Oblivion will be moved there and can be restored. Items already in Oblivion will be permanently deleted.",
  );
});
