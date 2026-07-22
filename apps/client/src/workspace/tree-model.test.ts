import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDirectoryTree,
  sortDirectoryChildren,
  treeNodeDisplayName,
} from "./tree-model.js";

test("directory regions stay in their product-defined order", () => {
  const tree = buildDirectoryTree([], "my root");
  assert.deepEqual(tree.map((node) => node.name), ["my root", "scan", "mint", "oblivion"]);
  assert.deepEqual(tree.map(treeNodeDisplayName), ["my root", "scan", "mint", "oblivion"]);
  assert.deepEqual(tree.map((node) => node.path), ["", "scan", "mint", "oblivion"]);
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

test("mint contents can use their generated timestamp as activity", () => {
  const [, , mint] = buildDirectoryTree([
    { path: "mint/2026-07-15_100000-zeta.md", type: "file" },
    { path: "mint/2026-07-15_120000-alpha.md", type: "file" },
    { path: "mint/2026-07-15_110000-middle.md", type: "file" },
  ], "root", "newest");

  assert.deepEqual(mint.children?.map((node) => node.name), [
    "2026-07-15_120000-alpha.md",
    "2026-07-15_110000-middle.md",
    "2026-07-15_100000-zeta.md",
  ]);
  assert.deepEqual(mint.children?.map(treeNodeDisplayName), [
    "alpha.md",
    "middle.md",
    "zeta.md",
  ]);
});

test("Mint paths become Coin rows only after transaction completion", () => {
  const [, , mint] = buildDirectoryTree([
    { path: "mint/2026-07-15_120000-complete.md", type: "file", coinComplete: true },
    { path: "mint/2026-07-15_110000-legacy.md", type: "file" },
  ], "root");

  assert.deepEqual(
    mint.children?.map((node) => [treeNodeDisplayName(node), node.systemKind]),
    [
      ["complete.md", "minted"],
      ["legacy.md", "mint-pending"],
    ],
  );
});

test("oblivion hides timestamp buckets and keeps retained paths as identity", () => {
  const [, , , oblivion] = buildDirectoryTree([
    { path: "oblivion/2026-07-14_090000/old.md", type: "file" },
    { path: "oblivion/2026-07-15_090000/new.md", type: "file" },
  ], "root");

  assert.deepEqual(oblivion.children?.map((node) => node.name), [
    "new.md",
    "old.md",
  ]);
  assert.deepEqual(oblivion.children?.map((node) => node.path), [
    "oblivion/2026-07-15_090000/new.md",
    "oblivion/2026-07-14_090000/old.md",
  ]);
});

test("oblivion does not merge same-named items from different timestamp buckets", () => {
  const [, , , oblivion] = buildDirectoryTree([
    { path: "oblivion/2026-07-14_090000/draft.md", type: "file" },
    { path: "oblivion/2026-07-15_090000/draft.md", type: "file" },
  ], "root");

  assert.equal(oblivion.children?.length, 2);
  assert.deepEqual(oblivion.children?.map(treeNodeDisplayName), ["draft.md", "draft.md"]);
  assert.notEqual(oblivion.children?.[0].path, oblivion.children?.[1].path);
});

test("Scan preserves imported folder wrappers above Mint and Oblivion", () => {
  const [, scan, , oblivion] = buildDirectoryTree([
    { path: "scan/project/readme.md", type: "file" },
    { path: "scan/project/src/index.ts", type: "file" },
    { path: "oblivion/2026-07-15_090000/old.md", type: "file" },
  ], "root");

  assert.equal(scan.systemKind, "scan");
  assert.deepEqual(scan.children?.map((node) => node.name), ["project"]);
  assert.deepEqual(scan.children?.[0]?.children?.map((node) => node.name), [
    "src",
    "readme.md",
  ]);
  assert.equal(oblivion.systemKind, "oblivion");
});

test("system-region sorting supports oldest and natural filename order", () => {
  const [, , mint] = buildDirectoryTree([
    { path: "mint/2026-07-15_120000-item-10.md", type: "file" },
    { path: "mint/2026-07-15_100000-item-2.md", type: "file" },
    { path: "mint/2026-07-15_110000-item-1.md", type: "file" },
  ], "root");
  const children = mint.children ?? [];

  assert.deepEqual(sortDirectoryChildren(children, "oldest").map(treeNodeDisplayName), [
    "item-2.md",
    "item-1.md",
    "item-10.md",
  ]);
  assert.deepEqual(sortDirectoryChildren(children, "name-asc").map(treeNodeDisplayName), [
    "item-1.md",
    "item-2.md",
    "item-10.md",
  ]);
  assert.deepEqual(sortDirectoryChildren(children, "name-desc").map(treeNodeDisplayName), [
    "item-10.md",
    "item-2.md",
    "item-1.md",
  ]);
});

test("one selected order applies to root, scan, mint, and oblivion", () => {
  const entries = [
    { path: "alpha.md", type: "file" as const, updatedAt: 300 },
    { path: "zeta.md", type: "file" as const, updatedAt: 100 },
    { path: "mint/2026-07-15_120000-alpha.md", type: "file" as const },
    { path: "mint/2026-07-15_100000-zeta.md", type: "file" as const },
    { path: "scan/alpha.md", type: "file" as const, updatedAt: 300 },
    { path: "scan/zeta.md", type: "file" as const, updatedAt: 100 },
    { path: "oblivion/2026-07-15_120000/alpha.md", type: "file" as const },
    { path: "oblivion/2026-07-15_100000/zeta.md", type: "file" as const },
  ];
  const sectionNames = (order: "name-asc" | "name-desc" | "newest" | "oldest") =>
    buildDirectoryTree(entries, "root", order).map((section) =>
      section.children?.map(treeNodeDisplayName),
    );

  assert.deepEqual(sectionNames("name-asc"), [
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
  ]);
  assert.deepEqual(sectionNames("name-desc"), [
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
  ]);
  assert.deepEqual(sectionNames("newest"), [
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
    ["alpha.md", "zeta.md"],
  ]);
  assert.deepEqual(sectionNames("oldest"), [
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
    ["zeta.md", "alpha.md"],
  ]);
});

test("chronological directory sorting uses each folder's latest descendant", () => {
  const [root] = buildDirectoryTree([
    { path: "older/child.md", type: "file", updatedAt: 100 },
    { path: "recent/child.md", type: "file", updatedAt: 300 },
  ], "root", "newest");

  assert.deepEqual(root.children?.map((node) => node.name), ["recent", "older"]);
});
