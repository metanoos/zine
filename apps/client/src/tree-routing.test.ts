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
    },
  );

  assert.deepEqual(activations, ["file:draft.md"]);
});
