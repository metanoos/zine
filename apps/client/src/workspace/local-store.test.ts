import assert from "node:assert/strict";
import test from "node:test";

import {
  clearFolderStepOperation,
  createDesktopOperationCrashPadReceiptV1,
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

test("crash pads atomically retain an accepted desktop operation receipt", () => {
  values.clear();
  const runs = [
    { voice: "author", text: "draft" },
    { voice: "ab".repeat(32), text: "\nMODEL" },
  ];
  const receipt = createDesktopOperationCrashPadReceiptV1({
    intentId: "artifact-intent-12345678",
    content: "draft\nMODEL",
    runs,
    kedits: [],
    modelVoicePubkey: "ab".repeat(32),
  });
  assert.equal(mirrorPad("root", "draft.md", {
    content: "draft\nMODEL",
    tags: [],
    nodeId: "head-2",
    traceId: "genesis-1",
    runs,
    kedits: [],
    voicePubkey: "ab".repeat(32),
    desktopOperationReceipt: receipt,
  }), true);

  assert.deepEqual(loadPad("root")?.["draft.md"]?.desktopOperationReceipt, receipt);
  mirrorPad("root", "draft.md", {
    content: "draft\nMODEL!",
    tags: [],
    nodeId: "head-2",
  });
  assert.deepEqual(
    loadPad("root")?.["draft.md"]?.desktopOperationReceipt,
    undefined,
    "a changed buffer must not retain a receipt for different exact state",
  );
});

test("receipt-bearing pads fail closed when runs, KEdits, or model metadata are tampered", () => {
  values.clear();
  const receipt = createDesktopOperationCrashPadReceiptV1({
    intentId: "artifact-intent-12345678",
    content: "MODEL",
    runs: [{ voice: "cd".repeat(32), text: "MODEL" }],
    kedits: [],
    modelVoicePubkey: "cd".repeat(32),
  });
  const base = {
    kind: "file",
    content: "MODEL",
    tags: [],
    nodeId: "head-2",
    updatedAt: 1,
    runs: [{ voice: "cd".repeat(32), text: "MODEL" }],
    kedits: [],
    voicePubkey: "cd".repeat(32),
    desktopOperationReceipt: receipt,
  };
  for (const tampered of [
    { ...base, runs: [{ voice: "author", text: "MODEL" }] },
    { ...base, kedits: [{ op: "ins", from: 0, to: 0, text: "MODEL", voice: "author", t: 1, tx: 1 }] },
    { ...base, voicePubkey: "ef".repeat(32) },
    { ...base, runs: undefined },
  ]) {
    values.set("zine.pad.root", JSON.stringify({ "draft.md": tampered }));
    assert.equal(loadPad("root"), null);
  }
});

test("crash-pad receipt writes report persistence failure", () => {
  values.clear();
  failWrites = true;
  try {
    const runs = [{ voice: "cd".repeat(32), text: "draft\nMODEL" }];
    assert.equal(mirrorPad("root", "draft.md", {
      content: "draft\nMODEL",
      tags: [],
      nodeId: "head-2",
      runs,
      kedits: [],
      voicePubkey: "cd".repeat(32),
      desktopOperationReceipt: createDesktopOperationCrashPadReceiptV1({
        intentId: "artifact-intent-12345678",
        content: "draft\nMODEL",
        runs,
        kedits: [],
        modelVoicePubkey: "cd".repeat(32),
      }),
    }), false);
    assert.equal(loadPad("root"), null);
  } finally {
    failWrites = false;
  }
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
