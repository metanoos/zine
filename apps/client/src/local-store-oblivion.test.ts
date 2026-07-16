import test from "node:test";
import assert from "node:assert/strict";

import { loadLocalFolder } from "./local-store.js";

const storage = new Map<string, string>();

// @ts-expect-error minimal localStorage shim for the persistence migration
globalThis.localStorage = {
  get length() {
    return storage.size;
  },
  clear() {
    storage.clear();
  },
  getItem(key: string) {
    return storage.get(key) ?? null;
  },
  key(index: number) {
    return [...storage.keys()][index] ?? null;
  },
  removeItem(key: string) {
    storage.delete(key);
  },
  setItem(key: string, value: string) {
    storage.set(key, value);
  },
};

test("legacy movement journals resume with the Oblivion vocabulary", () => {
  localStorage.setItem(
    "zine.folder.folder-1",
    JSON.stringify({
      id: "folder-1",
      files: {
        "oblivion/stamp/draft.md": {
          content: "draft",
          tags: [],
          nodeId: "node-1",
          updatedAt: 1,
          pendingMove: { kind: "archive", fromPath: "draft.md" },
        },
      },
    }),
  );

  assert.deepEqual(
    loadLocalFolder("folder-1")?.files["oblivion/stamp/draft.md"].pendingMove,
    { kind: "to-oblivion", fromPath: "draft.md" },
  );
});
