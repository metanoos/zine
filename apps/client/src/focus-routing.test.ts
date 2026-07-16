/**
 * Tests for `ownerFolderOf` and `activeMounted` — the focus-routing contract.
 *
 * The load-bearing property: each focus observation routes to the folder that
 * OWNS the focused path, never "the active folder." This is what keeps one
 * folder's replay free of files that belonged to another folder — see the
 * comment block on focus-routing.ts and protocol/trace-provenance.md §3.3/§8.
 *
 * The cross-folder panel-cycle case (panel 2 cycles F1:A → F2:X → F1:B) is the
 * scenario that motivated the change: each step must resolve to its owner, so
 * F1's replay mentions only A and B, and F2's only X. Today only one folder is
 * ever mounted, but these tests pin the contract multi-mount must satisfy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ownerFolderOf, activeMounted } from "./focus-routing.js";

test("ownerFolderOf: returns the owner for a member path", () => {
  const mounted = [
    { folderId: "F1", members: new Set(["essays/draft.md", "essays/notes.md"]) },
    { folderId: "F2", members: new Set(["refs/cite.md"]) },
  ];
  assert.equal(ownerFolderOf("essays/draft.md", mounted), "F1");
  assert.equal(ownerFolderOf("essays/notes.md", mounted), "F1");
  assert.equal(ownerFolderOf("refs/cite.md", mounted), "F2");
});

test("ownerFolderOf: returns null for an unowned path (scratch/stale)", () => {
  const mounted = [{ folderId: "F1", members: new Set(["essays/draft.md"]) }];
  assert.equal(ownerFolderOf("scratch/tmp.md", mounted), null);
  assert.equal(ownerFolderOf("essays/draft.md.bak", mounted), null);
});

test("ownerFolderOf: returns null when nothing is mounted", () => {
  assert.equal(ownerFolderOf("any.md", []), null);
});

test("ownerFolderOf: cross-folder panel cycle routes each step to its owner", () => {
  // Panel 2 cycles F1:A → F2:X → F1:B. Each observation must land on its owner,
  // so neither chain sees the foreign file.
  const mounted = [
    { folderId: "F1", members: new Set(["essays/draft.md", "essays/notes.md"]) }, // A and B
    { folderId: "F2", members: new Set(["refs/cite.md"]) },                       // X
  ];
  // F1 owns both A and B; F2 owns X. No foreign contamination is possible.
  assert.equal(ownerFolderOf("essays/draft.md", mounted), "F1"); // A → F1
  assert.equal(ownerFolderOf("refs/cite.md", mounted), "F2");    // X → F2
  assert.equal(ownerFolderOf("essays/notes.md", mounted), "F1"); // B → F1
});

test("ownerFolderOf: earliest claim wins on overlap (stable, never throws)", () => {
  // Callers should keep `mounted` disjoint, but the rule is defensive: a path
  // claimed by two folders resolves to the first one, not an error — focus is
  // advisory and must never throw.
  const mounted = [
    { folderId: "F1", members: new Set(["shared.md"]) },
    { folderId: "F2", members: new Set(["shared.md"]) },
  ];
  assert.equal(ownerFolderOf("shared.md", mounted), "F1");
});

test("activeMounted: empty when no folder id", () => {
  assert.deepEqual(activeMounted(null, ["a.md", "b.md"]), []);
  assert.deepEqual(activeMounted(undefined, ["a.md"]), []);
});

test("activeMounted: single-entry snapshot from the active folder's paths", () => {
  const mounted = activeMounted("F1", ["essays/draft.md", "notes.md"]);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0].folderId, "F1");
  assert.equal(mounted[0].members.has("essays/draft.md"), true);
  assert.equal(mounted[0].members.has("notes.md"), true);
  assert.equal(mounted[0].members.has("missing.md"), false);
});

test("activeMounted: the snapshot it builds is consumable by ownerFolderOf", () => {
  // End-to-end of the single-folder shape every App.tsx call site uses today.
  const mounted = activeMounted("F1", ["essays/draft.md", "essays/notes.md"]);
  assert.equal(ownerFolderOf("essays/draft.md", mounted), "F1");
  assert.equal(ownerFolderOf("scratch/tmp.md", mounted), null); // unowned → dropped
});
