import { test } from "node:test";
import assert from "node:assert/strict";

import { activateTreeItem } from "./tree-routing.js";

test("an empty synthetic Oblivion node activates as a folder, not a file", () => {
  const activations: string[] = [];

  activateTreeItem(
    { path: "oblivion", type: "folder" },
    {
      file: (path) => activations.push(`file:${path}`),
      folder: (path) => activations.push(`folder:${path}`),
      coin: (path) => activations.push(`coin:${path}`),
    },
  );

  assert.deepEqual(activations, ["folder:oblivion"]);
});

test("file nodes still activate the file handler", () => {
  const activations: string[] = [];

  activateTreeItem(
    { path: "draft.md", type: "file" },
    {
      file: (path) => activations.push(`file:${path}`),
      folder: (path) => activations.push(`folder:${path}`),
      coin: (path) => activations.push(`coin:${path}`),
    },
  );

  assert.deepEqual(activations, ["file:draft.md"]);
});

test("files retained in Oblivion are selection-only on row activation", () => {
  const activations: string[] = [];

  activateTreeItem(
    { path: "oblivion/2026-07-16_120000/draft.md", type: "file" },
    {
      file: (path) => activations.push(`file:${path}`),
      folder: (path) => activations.push(`folder:${path}`),
      coin: (path) => activations.push(`coin:${path}`),
    },
  );

  assert.deepEqual(activations, []);
});

test("minted file-shaped nodes activate the coin handler", () => {
  const activations: string[] = [];

  activateTreeItem(
    { path: "mint/2026-07-16_120000-quote.md", type: "file", systemKind: "minted" },
    {
      file: (path) => activations.push(`file:${path}`),
      folder: (path) => activations.push(`folder:${path}`),
      coin: (path) => activations.push(`coin:${path}`),
    },
  );

  assert.deepEqual(activations, ["coin:mint/2026-07-16_120000-quote.md"]);
});

test("incomplete Mint artifacts activate the inert file surface, not Coin handling", () => {
  const calls: string[] = [];
  activateTreeItem(
    { path: "mint/legacy.md", type: "file", systemKind: "mint-pending" },
    {
      file: (path) => calls.push(`file:${path}`),
      folder: (path) => calls.push(`folder:${path}`),
      coin: (path) => calls.push(`coin:${path}`),
    },
  );
  assert.deepEqual(calls, ["file:mint/legacy.md"]);
});
