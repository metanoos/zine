import test from "node:test";
import assert from "node:assert/strict";

import { buildDirectoryTree } from "./tree-model.js";

test("directory regions are root, mint, oblivion", () => {
  const tree = buildDirectoryTree([], "my root");
  assert.deepEqual(tree.map((node) => node.name), ["my root", "mint", "oblivion"]);
  assert.deepEqual(tree.map((node) => node.path), ["", "mint", "oblivion"]);
});

test("root stays folder-first and alphabetic", () => {
  const [root] = buildDirectoryTree([
    { path: "zeta.md", type: "file" },
    { path: "beta/note.md", type: "file" },
    { path: "alpha.md", type: "file" },
  ], "root");

  assert.deepEqual(root.children?.map((node) => node.name), [
    "beta",
    "alpha.md",
    "zeta.md",
  ]);
});

test("mint contents are newest-first by generated timestamp name", () => {
  const [, mint] = buildDirectoryTree([
    { path: "mint/2026-07-15_100000-zeta.md", type: "file" },
    { path: "mint/2026-07-15_120000-alpha.md", type: "file" },
    { path: "mint/2026-07-15_110000-middle.md", type: "file" },
  ], "root");

  assert.deepEqual(mint.children?.map((node) => node.name), [
    "2026-07-15_120000-alpha.md",
    "2026-07-15_110000-middle.md",
    "2026-07-15_100000-zeta.md",
  ]);
});

test("oblivion timestamp folders fall back to reverse name order", () => {
  const [, , oblivion] = buildDirectoryTree([
    { path: "oblivion/2026-07-14_090000/old.md", type: "file" },
    { path: "oblivion/2026-07-15_090000/new.md", type: "file" },
  ], "root");

  assert.deepEqual(oblivion.children?.map((node) => node.name), [
    "2026-07-15_090000",
    "2026-07-14_090000",
  ]);
});
