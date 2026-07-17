import { test } from "node:test";
import assert from "node:assert/strict";

import { ownerFolderOf, activeMount } from "./focus-routing.js";

test("ownerFolderOf returns the active folder for a member path", () => {
  const mounted = activeMount("F1", ["essays/draft.md", "essays/notes.md"]);
  assert.equal(ownerFolderOf("essays/draft.md", mounted), "F1");
  assert.equal(ownerFolderOf("essays/notes.md", mounted), "F1");
});

test("ownerFolderOf rejects an unowned or stale path", () => {
  const mounted = activeMount("F1", ["essays/draft.md"]);
  assert.equal(ownerFolderOf("scratch/tmp.md", mounted), null);
  assert.equal(ownerFolderOf("essays/draft.md.bak", mounted), null);
});

test("activeMount is empty when no folder is mounted", () => {
  assert.equal(activeMount(null, ["a.md", "b.md"]), null);
  assert.equal(ownerFolderOf("any.md", null), null);
});

test("activeMount snapshots the one folder's current paths", () => {
  const mounted = activeMount("F1", ["essays/draft.md", "notes.md"]);
  assert.equal(mounted?.folderId, "F1");
  assert.equal(mounted?.members.has("essays/draft.md"), true);
  assert.equal(mounted?.members.has("notes.md"), true);
  assert.equal(mounted?.members.has("missing.md"), false);
});
