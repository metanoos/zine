import assert from "node:assert/strict";
import test from "node:test";

import {
  clearFolderStepOperation,
  loadLocalFolder,
  loadPad,
  mirrorPad,
  pendingFolderStepOperation,
  saveLocalFile,
  stageFolderStepOperation,
} from "./local-store.js";

const values = new Map<string, string>();
let failWrites = false;
// @ts-expect-error minimal storage surface for pure persistence tests
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error("storage unavailable");
    values.set(key, value);
  },
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

test("Coin completion is explicit and survives later cache refreshes", () => {
  values.clear();
  saveLocalFile("root", "mint/complete.md", {
    content: "complete",
    tags: [],
    nodeId: "coin-id",
    coinComplete: true,
  });
  saveLocalFile("root", "mint/complete.md", {
    content: "complete",
    tags: [],
    nodeId: "coin-id",
  });
  saveLocalFile("root", "mint/legacy.md", {
    content: "legacy",
    tags: [],
    nodeId: "legacy-id",
  });

  assert.equal(loadLocalFolder("root")?.files["mint/complete.md"]?.coinComplete, true);
  assert.equal(loadLocalFolder("root")?.files["mint/legacy.md"]?.coinComplete, undefined);
});

test("local writes report storage failure to transaction coordinators", () => {
  values.clear();
  failWrites = true;
  try {
    assert.equal(saveLocalFile("root", "coin.md", {
      content: "coin",
      tags: [],
      nodeId: "coin-id",
    }), false);
    assert.equal(loadLocalFolder("root"), null);
  } finally {
    failWrites = false;
  }
});

test("crash pads reject records without the current kind discriminator", () => {
  values.clear();
  values.set("zine.pad.root", JSON.stringify({
    "draft.md": { content: "draft", tags: [], nodeId: "", updatedAt: 1 },
  }));
  assert.equal(loadPad("root"), null);
});

test("crash pads preserve stable trace identity with the buffered head", () => {
  values.clear();
  mirrorPad("root", "draft.md", {
    content: "draft",
    tags: [],
    nodeId: "head-2",
    traceId: "genesis-1",
  });

  assert.equal(loadPad("root")?.["draft.md"]?.nodeId, "head-2");
  assert.equal(loadPad("root")?.["draft.md"]?.traceId, "genesis-1");
});

test("staged file and recursive folder operations survive reload until cleared", () => {
  values.clear();
  const operationId = "ab".repeat(32);
  saveLocalFile("root", "draft.md", {
    content: "draft",
    tags: [],
    nodeId: "",
    pendingOperationId: operationId,
  });
  stageFolderStepOperation("root", "notes", operationId);

  assert.equal(loadLocalFolder("root")?.files["draft.md"]?.pendingOperationId, operationId);
  assert.equal(pendingFolderStepOperation("root", "notes"), operationId);
  clearFolderStepOperation("root", "notes");
  assert.equal(pendingFolderStepOperation("root", "notes"), null);
  assert.equal(loadLocalFolder("root")?.files["draft.md"]?.pendingOperationId, operationId);
});
