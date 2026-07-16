/**
 * Tests for raw shielded-path detection. Shielding a folder marks its entire
 * subtree, while a shielded file marks only itself. The effective scope model
 * decides whether an explicit selection lifts that boundary.
 *
 * Exact mount versus derived-scope behavior is covered in scope-model.test.ts;
 * this file covers only the raw shielded-boundary predicate.
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { isShielded } from "./context-gather.js";
import { loadLocalShielded, saveLocalShielded } from "./local-store.js";

const store = new Map<string, string>();
// @ts-expect-error minimal localStorage shim for shield persistence
globalThis.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};

beforeEach(() => store.clear());

// --- empty set shields nothing -------------------------------------------

test("isShielded: empty set excludes nothing", () => {
  const shielded = new Set<string>();
  assert.equal(isShielded(shielded, "a.md"), false);
  assert.equal(isShielded(shielded, "notes/a.md"), false);
  assert.equal(isShielded(shielded, ""), false);
});

// --- shielded file excludes only itself ------------------------------------

test("isShielded: a shielded file excludes only that path", () => {
  const shielded = new Set(["notes/secret.md"]);
  assert.equal(isShielded(shielded, "notes/secret.md"), true);
  assert.equal(isShielded(shielded, "notes/other.md"), false);
  assert.equal(isShielded(shielded, "secret.md"), false);
});

// --- shielded folder excludes its whole subtree ----------------------------

test("isShielded: a shielded folder excludes every descendant", () => {
  const shielded = new Set(["notes"]);
  assert.equal(isShielded(shielded, "notes"), true);
  assert.equal(isShielded(shielded, "notes/a.md"), true);
  assert.equal(isShielded(shielded, "notes/sub/b.md"), true);
  assert.equal(isShielded(shielded, "notes/sub"), true);
  assert.equal(isShielded(shielded, "notes2/a.md"), false);
  assert.equal(isShielded(shielded, "notesfile.md"), false);
});

test("isShielded: nested folder excludes its subtree but not siblings above", () => {
  const shielded = new Set(["docs/archive"]);
  assert.equal(isShielded(shielded, "docs/archive/old.md"), true);
  assert.equal(isShielded(shielded, "docs/current.md"), false);
  assert.equal(isShielded(shielded, "docs"), false);
});

// --- string-prefix trap ----------------------------------------------------

test("isShielded: does not match on a bare string prefix", () => {
  // "note" is a prefix of "notes/x" as a string but not as a path segment.
  const shielded = new Set(["note"]);
  assert.equal(isShielded(shielded, "notes/x.md"), false);
  assert.equal(isShielded(shielded, "note/x.md"), true);
});

// --- multiple shielded entries compose -------------------------------------

test("isShielded: multiple shielded folders each exclude their own subtree", () => {
  const shielded = new Set(["drafts", "archive/2023"]);
  assert.equal(isShielded(shielded, "drafts/a.md"), true);
  assert.equal(isShielded(shielded, "archive/2023/x.md"), true);
  assert.equal(isShielded(shielded, "archive/2024/x.md"), false);
  assert.equal(isShielded(shielded, "final.md"), false);
});

test("isShielded: shielding the root excludes the whole attached tree", () => {
  const shielded = new Set([""]);
  assert.equal(isShielded(shielded, ""), true);
  assert.equal(isShielded(shielded, "drafts/a.md"), true);
  assert.equal(isShielded(shielded, "final.md"), true);
});

test("isShielded reports raw boundaries independently of effective scope", () => {
  const shielded = new Set(["drafts", "notes/secret.md"]);
  assert.equal(isShielded(shielded, "drafts/a.md"), true);
  assert.equal(isShielded(shielded, "notes/secret.md"), true);
});

test("shield persistence uses only shieldedPaths", () => {
  localStorage.setItem(
    "zine.folder.root",
    JSON.stringify({
      id: "root",
      files: {},
      frozenPaths: ["old-freeze"],
      shelvedPaths: ["old-shelf"],
    }),
  );

  assert.deepEqual([...loadLocalShielded("root")], []);

  saveLocalShielded("root", new Set(["notes/private.md"]));
  const saved = JSON.parse(store.get("zine.folder.root")!) as Record<string, unknown>;
  assert.deepEqual(saved.shieldedPaths, ["notes/private.md"]);
  assert.equal("frozenPaths" in saved, false);
  assert.equal("shelvedPaths" in saved, false);
});
