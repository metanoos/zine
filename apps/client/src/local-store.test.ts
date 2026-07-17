import assert from "node:assert/strict";
import test from "node:test";

import { loadLocalFolder, loadPad, saveLocalFile } from "./local-store.js";

const values = new Map<string, string>();
// @ts-expect-error minimal storage surface for pure persistence tests
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
  clear: () => values.clear(),
};

test("local folders reject file records without the current kind discriminator", () => {
  values.clear();
  values.set("zine.folder.root", JSON.stringify({
    id: "root",
    files: {
      "draft.md": { content: "draft", tags: [], nodeId: "", updatedAt: 1 },
    },
  }));
  assert.equal(loadLocalFolder("root"), null);
});

test("local writes persist the current file discriminator", () => {
  values.clear();
  saveLocalFile("root", "draft.md", {
    content: "draft",
    tags: [],
    nodeId: "",
  });
  assert.equal(loadLocalFolder("root")?.files["draft.md"]?.kind, "file");
});

test("crash pads reject records without the current kind discriminator", () => {
  values.clear();
  values.set("zine.pad.root", JSON.stringify({
    "draft.md": { content: "draft", tags: [], nodeId: "", updatedAt: 1 },
  }));
  assert.equal(loadPad("root"), null);
});
