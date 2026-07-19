import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";

import {
  clearFolderStepOperation,
  clearStructuralConflict,
  clearStructuralOperation,
  createDesktopOperationCrashPadReceiptV1,
  deleteLocalFile,
  deleteLocalFiles,
  failStructuralOperation,
  hasPendingStructuralPathMutation,
  loadLocalFolder,
  loadPad,
  mirrorPad,
  moveLocalFile,
  pendingFolderStepOperation,
  pendingFolderStepOperations,
  pendingStructuralOperations,
  saveLocalFile,
  saveLocalFolderHead,
  saveLocalShielded,
  stageFolderStepOperation,
  stageStructuralOperation,
} from "./local-store.js";

const values = new Map<string, string>();
let failWrites = false;
let storageWriteError: Error | null = null;
const folderExpectation = {
  traceId: "11".repeat(32),
  nodeId: "22".repeat(32),
};
// @ts-expect-error minimal storage surface for pure persistence tests
globalThis.localStorage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => {
    if (failWrites) throw new Error("storage unavailable");
    if (storageWriteError) throw storageWriteError;
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

test("bulk deletion persists several paths in one storage write", () => {
  values.clear();
  saveLocalFile("root", "a.md", { content: "a", tags: [], nodeId: "a" });
  saveLocalFile("root", "nested/b.md", { content: "b", tags: [], nodeId: "b" });
  saveLocalFile("root", "kept.md", { content: "kept", tags: [], nodeId: "kept" });
  let writes = 0;
  const originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = (key: string, value: string) => {
    writes++;
    originalSetItem.call(globalThis.localStorage, key, value);
  };
  try {
    assert.equal(deleteLocalFiles("root", ["a.md", "nested/b.md"]), true);
  } finally {
    globalThis.localStorage.setItem = originalSetItem;
  }
  assert.equal(writes, 1);
  assert.deepEqual(Object.keys(loadLocalFolder("root")?.files ?? {}), ["kept.md"]);
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
  assert.deepEqual(pendingFolderStepOperations("root"), [{
    relativePath: "notes",
    operationId,
  }]);
  clearFolderStepOperation("root", "notes");
  assert.equal(pendingFolderStepOperation("root", "notes"), null);
  assert.equal(loadLocalFolder("root")?.files["draft.md"]?.pendingOperationId, operationId);
});

test("a pending file operation preserves the exact verified signed event", () => {
  values.clear();
  const operationId = "ef".repeat(32);
  const event = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "draft.md"],
      ["f", "root"],
      ["operation", operationId],
    ],
    content: JSON.stringify({ snapshot: "draft", kedits: [] }),
  }, new Uint8Array(32).fill(7));
  assert.equal(saveLocalFile("root", "draft.md", {
    content: "draft",
    tags: [],
    nodeId: event.id,
    pendingOperationId: operationId,
    pendingSignedEvent: event,
  }), true);
  assert.deepEqual(loadLocalFolder("root")?.files["draft.md"]?.pendingSignedEvent, event);

  const raw = JSON.parse(values.get("zine.folder.root")!) as {
    files: Record<string, { pendingSignedEvent: Event }>;
  };
  raw.files["draft.md"]!.pendingSignedEvent.content = "tampered";
  values.set("zine.folder.root", JSON.stringify(raw));
  assert.equal(loadLocalFolder("root"), null);
});

test("structural operations preserve their causal id and exact path set until cleared", () => {
  values.clear();
  const operationId = "cd".repeat(32);
  stageStructuralOperation("root", {
    version: 2,
    kind: "move",
    operationId,
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true,
    moves: [
      { oldRel: "notes", newRel: "archive/notes" },
      { oldRel: "notes/draft.md", newRel: "archive/notes/draft.md" },
    ],
    expectedFolder: folderExpectation,
    expectedFolders: { notes: folderExpectation },
  });

  assert.deepEqual(pendingStructuralOperations("root"), [{
    version: 2,
    kind: "move",
    operationId,
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true,
    moves: [
      { oldRel: "notes", newRel: "archive/notes" },
      { oldRel: "notes/draft.md", newRel: "archive/notes/draft.md" },
    ],
    expectedFolder: folderExpectation,
    expectedFolders: { notes: folderExpectation },
  }]);
  clearStructuralOperation("root", operationId);
  assert.deepEqual(pendingStructuralOperations("root"), []);
});

test("optimistic structural projections remain retryable until the journal clears", () => {
  values.clear();
  const operationId = "d1".repeat(32);
  stageStructuralOperation("root", {
    version: 2,
    kind: "move",
    operationId,
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true,
    moves: [{ oldRel: "notes", newRel: "archive/notes" }],
    expectedFolder: folderExpectation,
    expectedFolders: { notes: folderExpectation },
  });

  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    true,
  );
  assert.equal(hasPendingStructuralPathMutation("root", "notes", null), false);
  clearStructuralOperation("root", operationId);
  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    false,
  );
});

test("structural journals exclude both path projections until commit or rollback", () => {
  values.clear();
  saveLocalShielded("root", new Set(["notes/private"]));
  const operation = {
    version: 2 as const,
    kind: "move" as const,
    operationId: "d2".repeat(32),
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true as const,
    moves: [{ oldRel: "notes", newRel: "archive/notes" }],
    expectedFolder: folderExpectation,
    expectedFolders: { notes: folderExpectation },
    shieldedPathsBefore: ["notes/private"],
    shieldedPathsDuring: ["archive/notes/private", "notes/private"],
    shieldedPathsAfter: ["archive/notes/private"],
  };
  stageStructuralOperation("root", operation);
  assert.deepEqual(loadLocalFolder("root")?.shieldedPaths, operation.shieldedPathsDuring);
  saveLocalShielded("root", new Set([...operation.shieldedPathsDuring, "other/private"]));
  clearStructuralOperation("root", operation.operationId);
  assert.deepEqual(loadLocalFolder("root")?.shieldedPaths, [
    ...operation.shieldedPathsAfter,
    "other/private",
  ].sort());

  const rollback = { ...operation, operationId: "d3".repeat(32) };
  stageStructuralOperation("root", rollback);
  saveLocalShielded("root", new Set([...rollback.shieldedPathsDuring, "other/second"]));
  failStructuralOperation("root", rollback, "conflict");
  assert.deepEqual(loadLocalFolder("root")?.shieldedPaths, [
    ...rollback.shieldedPathsBefore,
    "other/second",
  ].sort());
  assert.ok(loadLocalFolder("root")?.structuralConflicts?.[rollback.operationId]);
  clearStructuralConflict("root", rollback.operationId);
  assert.equal(loadLocalFolder("root")?.structuralConflicts, undefined);
});

test("folder creation journals retain the signed genesis across retry", () => {
  values.clear();
  const operationId = "ef".repeat(32);
  const genesisEvent = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [],
    content: JSON.stringify({ members: [], contentHash: "34".repeat(32) }),
  }, new Uint8Array(32).fill(7));
  const operation = {
    version: 1 as const,
    kind: "create-folder" as const,
    operationId,
    sourcePath: "notes",
    isFolder: true as const,
    genesisId: genesisEvent.id,
    contentHash: "34".repeat(32),
    genesisEvent,
  };
  stageStructuralOperation("root", operation);

  const recovered = pendingStructuralOperations("root");
  assert.deepEqual(recovered, [operation]);
  assert.equal(recovered[0]?.kind, "create-folder");
  if (recovered[0]?.kind === "create-folder") {
    assert.equal(recovered[0].genesisId, operation.genesisId);
    assert.deepEqual(recovered[0].genesisEvent, genesisEvent);
  }
});

test("terminal structural conflicts leave the retry barrier but remain recorded", () => {
  values.clear();
  const operation = {
    version: 2 as const,
    kind: "move" as const,
    operationId: "56".repeat(32),
    sourcePath: "a",
    targetPath: "b",
    isFolder: true as const,
    moves: [{ oldRel: "a", newRel: "b" }],
    expectedFolder: folderExpectation,
    expectedFolders: { a: folderExpectation },
  };
  stageStructuralOperation("root", operation);
  failStructuralOperation("root", operation, "target already exists");

  assert.deepEqual(pendingStructuralOperations("root"), []);
  assert.equal(
    loadLocalFolder("root")?.structuralConflicts?.[operation.operationId]?.reason,
    "target already exists",
  );
});

test("the exact Root folder head persists with the local projection", () => {
  values.clear();
  assert.equal(saveLocalFolderHead("root", "ab".repeat(32)), true);
  assert.equal(loadLocalFolder("root")?.nodeId, "ab".repeat(32));
});

test("malformed structural journals are ignored without hiding the workspace", () => {
  values.clear();
  values.set("zine.folder.root", JSON.stringify({
    id: "root",
    files: {},
    pendingStructuralOperations: {
      broken: { version: 1, kind: "move", operationId: "not-an-id" },
    },
  }));
  assert.deepEqual(loadLocalFolder("root")?.files, {});
  assert.deepEqual(pendingStructuralOperations("root"), []);
});

test("durable recovery journals surface rejected browser-storage writes", () => {
  values.clear();
  storageWriteError = new Error("quota exceeded");
  try {
    assert.equal(saveLocalFile("root", "draft.md", {
      content: "draft",
      tags: [],
      nodeId: "",
      pendingOperationId: "ab".repeat(32),
    }), false);
    assert.throws(
      () => stageFolderStepOperation("root", "notes", "ab".repeat(32)),
      /persist pending folder Step/,
    );
    assert.throws(
      () => stageStructuralOperation("root", {
        version: 2,
        kind: "delete",
        operationId: "cd".repeat(32),
        sourcePath: "draft.md",
        isFolder: false,
        affectedPaths: ["draft.md"],
        expectedFolders: {},
      }),
      /persist pending structural operation/,
    );
  } finally {
    storageWriteError = null;
  }

  const operationId = "ef".repeat(32);
  stageFolderStepOperation("root", "notes", operationId);
  stageStructuralOperation("root", {
    version: 2,
    kind: "delete",
    operationId,
    sourcePath: "draft.md",
    isFolder: false,
    affectedPaths: ["draft.md"],
    expectedFolders: {},
  });
  storageWriteError = new Error("storage disabled");
  try {
    assert.throws(
      () => clearFolderStepOperation("root", "notes"),
      /clear pending folder Step/,
    );
    assert.throws(
      () => clearStructuralOperation("root", operationId),
      /clear pending structural operation/,
    );
  } finally {
    storageWriteError = null;
  }
});

test("local move and delete report storage rejection without claiming durability", () => {
  values.clear();
  assert.equal(saveLocalFile("root", "draft.md", {
    content: "draft",
    tags: [],
    nodeId: "head",
  }), true);
  storageWriteError = new Error("quota exceeded");
  try {
    assert.equal(moveLocalFile("root", "draft.md", "moved.md"), false);
    assert.equal(deleteLocalFile("root", "draft.md"), false);
  } finally {
    storageWriteError = null;
  }
  assert.equal(loadLocalFolder("root")?.files["draft.md"]?.content, "draft");
  assert.equal(loadLocalFolder("root")?.files["moved.md"], undefined);
});
