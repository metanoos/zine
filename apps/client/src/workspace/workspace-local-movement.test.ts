import test from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

// @ts-expect-error minimal localStorage shim for signer-resolution coverage
globalThis.localStorage = {
  values: new Map<string, string>(),
  getItem(key: string) {
    return this.values.get(key) ?? null;
  },
  setItem(key: string, value: string) {
    this.values.set(key, value);
  },
  removeItem(key: string) {
    this.values.delete(key);
  },
  clear() {
    this.values.clear();
  },
};

import {
  buildRemoteAbsenceIndex,
  completeDeletion,
  completeBackgroundPush,
  completeStagedWrite,
  completedEmptyGenesisBootstrapHead,
  crashPadDraftForPull,
  consumeRecursivePullBudget,
  consumeUniqueRecursivePullSignedEvents,
  folderCheckpointExtendsExpectedForOperation,
  folderEntryMatchesStructuralExpectation,
  folderTraceIdentityFromNode,
  folderWriteSigner,
  localFolderCoordinate,
  localManifestProjectionMatches,
  localTreeFolderCoordinate,
  localFileSigner,
  ownershipDisposition,
  pendingMoveForPath,
  planRemoteAbsenceReconciliation,
  previousStepCitationTargets,
  publishEmptyGenesisIfNeeded,
  runRootMutationAfterRecovery,
  runRootMutationSerialized,
  sameBodyDescendantCanFastForward,
  stageFileStepAfterPendingRecovery,
  structuralShieldJournal,
} from "./workspace-local.js";
import { traceSignedEventBytes } from "../provenance/provenance.js";
import { authorVoice, loadKeys } from "../identity/keys-store.js";
import {
  clearStructuralOperation,
  failStructuralOperation,
  hasPendingStructuralPathMutation,
  loadLocalFolder,
  loadLocalShielded,
  saveLocalFile,
  saveLocalShielded,
  stageStructuralOperation,
} from "./local-store.js";

test("a newer crash-pad body is the local side of pull reconciliation", () => {
  const primary = {
    kind: "file" as const,
    content: "stepped",
    tags: [],
    nodeId: "head-1",
    updatedAt: 1,
  };
  const pad = {
    ...primary,
    content: "unstepped draft",
    kedits: [{ op: "ins" as const, from: 7, to: 7, text: " draft", t: 2, tx: 1, voice: "a" }],
    updatedAt: 2,
  };
  assert.equal(crashPadDraftForPull(primary, pad), pad);
  assert.equal(crashPadDraftForPull(primary, { ...primary }), undefined);
});

test("same-body remote descendants still advance the local immutable head", () => {
  const event = (id: string): Event => ({
    id,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [],
    content: "",
    sig: "b".repeat(128),
  });
  const chain = [event("local"), event("metadata-only")];
  assert.equal(
    sameBodyDescendantCanFastForward(chain, "local", "metadata-only", false),
    true,
  );
  assert.equal(
    sameBodyDescendantCanFastForward(chain, "local", "metadata-only", true),
    false,
  );
  assert.equal(
    sameBodyDescendantCanFastForward(chain, "sibling", "metadata-only", false),
    false,
  );
});

test("an exact clean member permits a newer sibling-only Root checkpoint", () => {
  const entry = {
    kind: "file" as const,
    relativePath: "kept.md",
    latestNodeId: "kept-head",
    contentHash: "ab".repeat(32),
  };
  const exact = {
    kind: "file" as const,
    content: "kept",
    tags: [],
    nodeId: "kept-head",
    updatedAt: Date.now(),
  };
  assert.equal(localManifestProjectionMatches(exact, entry, "kept"), true);
  assert.equal(
    localManifestProjectionMatches(
      { ...exact, pendingOperationId: "operation" },
      entry,
      "kept",
    ),
    false,
  );
  assert.equal(localManifestProjectionMatches(exact, entry, "edited"), false);
});

test("structural recovery accepts only the journaled folder identity and head", () => {
  const expected = {
    traceId: "11".repeat(32),
    nodeId: "22".repeat(32),
  };
  const entry = {
    kind: "folder" as const,
    relativePath: "notes",
    latestNodeId: expected.nodeId,
    contentHash: "33".repeat(32),
  };
  assert.equal(
    folderEntryMatchesStructuralExpectation(entry, expected, entry.contentHash),
    true,
  );
  assert.equal(
    folderEntryMatchesStructuralExpectation(
      { ...entry, latestNodeId: "44".repeat(32) },
      expected,
      entry.contentHash,
    ),
    false,
  );
  assert.equal(
    folderEntryMatchesStructuralExpectation(
      { ...entry, contentHash: "55".repeat(32) },
      expected,
      entry.contentHash,
    ),
    false,
  );
});

test("a relay failure retains the structural projection until the next mutation recovers it", async () => {
  localStorage.clear();
  const operationId = "d2".repeat(32);
  stageStructuralOperation("root", {
    version: 2,
    kind: "move",
    operationId,
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true,
    moves: [{ oldRel: "notes", newRel: "archive/notes" }],
    expectedFolder: {
      traceId: "11".repeat(32),
      nodeId: "22".repeat(32),
    },
    expectedFolders: {
      notes: {
        traceId: "11".repeat(32),
        nodeId: "22".repeat(32),
      },
    },
  });

  await assert.rejects(Promise.reject(new Error("relay unavailable")), /relay unavailable/);
  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    true,
  );

  let nextMutationRan = false;
  await runRootMutationAfterRecovery(
    new Map(),
    "root",
    "d3".repeat(32),
    async () => clearStructuralOperation("root", operationId),
    async () => {
      assert.equal(
        hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
        false,
      );
      nextMutationRan = true;
    },
  );
  assert.equal(nextMutationRan, true);
});

test("a new file gesture cannot replace an unrecovered exact signed Step", async () => {
  const order: string[] = [];
  let durableHead = "old-head";
  await assert.rejects(
    stageFileStepAfterPendingRecovery(
      "old-operation",
      async () => {
        order.push("recover");
        throw new Error("folder propagation failed");
      },
      async () => {
        order.push("stage-new");
        durableHead = "wrong-sibling";
      },
    ),
    /folder propagation failed/,
  );
  assert.deepEqual(order, ["recover"]);
  assert.equal(durableHead, "old-head");

  const recoveredId = await stageFileStepAfterPendingRecovery(
    "old-operation",
    async () => {
      order.push("recover-again");
      durableHead = "persisted-signed-head";
    },
    async () => {
      order.push(`stage-after:${durableHead}`);
      return "new-descendant";
    },
  );
  assert.equal(recoveredId, "new-descendant");
  assert.deepEqual(order, [
    "recover",
    "recover-again",
    "stage-after:persisted-signed-head",
  ]);
});

test("verified remote absence removes clean members and preserves dirty ones", () => {
  localStorage.clear();
  saveLocalFile("root", "old", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "old-folder-head",
    traceId: "old-folder",
  });
  saveLocalFile("root", "old/draft.md", {
    content: "clean",
    tags: [],
    nodeId: "clean-head",
  });
  saveLocalFile("root", "dirty.md", {
    content: "dirty",
    tags: [],
    nodeId: "dirty-head",
    pendingOperationId: "operation",
  });
  saveLocalFile("root", "oblivion/kept.md", {
    content: "private",
    tags: [],
    nodeId: "private-head",
  });

  const plan = planRemoteAbsenceReconciliation(
    loadLocalFolder("root"),
    "",
    new Set(["renamed", "current.md"]),
  );
  assert.deepEqual(plan.deletions, ["old/draft.md", "old"]);
  assert.deepEqual(plan.conflicts, ["dirty.md"]);
});

test("remote rename treats the clean old coordinate as an authoritative absence", () => {
  localStorage.clear();
  saveLocalFile("root", "old.md", {
    content: "same trace",
    tags: [],
    nodeId: "file-head",
  });
  assert.deepEqual(
    planRemoteAbsenceReconciliation(
      loadLocalFolder("root"),
      "",
      new Set(["new.md"]),
    ),
    { deletions: ["old.md"], conflicts: [] },
  );
});

test("recursive absence planning shares one workspace enumeration", () => {
  const stored: NonNullable<ReturnType<typeof loadLocalFolder>>["files"] = {};
  for (let index = 0; index < 2_000; index++) {
    const folder = `folder-${index.toString().padStart(4, "0")}`;
    stored[folder] = {
      kind: "folder",
      content: "",
      tags: [],
      nodeId: `${folder}-head`,
      traceId: `${folder}-trace`,
      updatedAt: 1,
    };
    stored[`${folder}/note.md`] = {
      kind: "file",
      content: "note",
      tags: [],
      nodeId: `${folder}-note-head`,
      updatedAt: 1,
    };
  }
  let enumerations = 0;
  const files = new Proxy(stored, {
    ownKeys(target) {
      enumerations++;
      return Reflect.ownKeys(target);
    },
  });
  const local = { id: "root", files };
  const index = buildRemoteAbsenceIndex(local);
  for (let folderIndex = 0; folderIndex < 2_000; folderIndex++) {
    const folder = `folder-${folderIndex.toString().padStart(4, "0")}`;
    assert.deepEqual(
      planRemoteAbsenceReconciliation(local, folder, new Set(), {}, [], index),
      { deletions: [`${folder}/note.md`], conflicts: [] },
    );
  }
  assert.equal(enumerations, 1);
});

test("flat local paths resolve to direct recursive folder coordinates", () => {
  localStorage.clear();
  saveLocalFile("root", "projects", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "projects-head",
    traceId: "projects-genesis",
  });
  saveLocalFile("root", "projects/drafts", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "drafts-head",
    traceId: "drafts-genesis",
  });

  assert.deepEqual(localFolderCoordinate("root", "readme.md"), {
    folderId: "root",
    folderPath: "",
    relativePath: "readme.md",
  });
  assert.deepEqual(localFolderCoordinate("root", "projects/plan.md"), {
    folderId: "projects-genesis",
    folderPath: "projects",
    relativePath: "plan.md",
  });
  assert.deepEqual(localFolderCoordinate("root", "projects/drafts/idea.md"), {
    folderId: "drafts-genesis",
    folderPath: "projects/drafts",
    relativePath: "idea.md",
  });
});

test("private Scan paths resolve inside their own recursive folder tree", () => {
  localStorage.clear();
  saveLocalFile("root", "scan/project", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "project-head",
    traceId: "project-genesis",
  });
  saveLocalFile("root", "scan/project/src", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "src-head",
    traceId: "src-genesis",
  });

  const scanTree = {
    storageRootId: "root",
    folderId: "scan-genesis",
    storagePath: "scan",
  };
  assert.deepEqual(localTreeFolderCoordinate(scanTree, "scan/readme.md"), {
    folderId: "scan-genesis",
    folderPath: "scan",
    relativePath: "readme.md",
  });
  assert.deepEqual(
    localTreeFolderCoordinate(scanTree, "scan/project/src/main-ts.md"),
    {
      folderId: "src-genesis",
      folderPath: "scan/project/src",
      relativePath: "main-ts.md",
    },
  );
  assert.throws(
    () => localTreeFolderCoordinate(scanTree, "outside/main.md"),
    /not a member inside scan/,
  );
});

test("folder heads recover their recursive trace identity without file-chain resolution", () => {
  const event = (id: string, tags: string[][]): Event => ({
    id,
    kind: 4290,
    pubkey: "owner",
    created_at: 1,
    content: "{}",
    sig: "",
    tags,
  });
  assert.equal(
    folderTraceIdentityFromNode(event("folder-genesis", [["z", "folder"]])),
    "folder-genesis",
  );
  assert.equal(
    folderTraceIdentityFromNode(event("folder-head", [
      ["z", "folder"],
      ["f", "folder-genesis"],
      ["e", "folder-genesis", "", "prev"],
    ])),
    "folder-genesis",
  );
  assert.equal(
    folderTraceIdentityFromNode(event("file-head", [["z", "file"]])),
    null,
  );
});

test("recursive deletion accepts only descendant folder checkpoints from the same gesture", () => {
  const operationId = "ab".repeat(32);
  const otherOperationId = "cd".repeat(32);
  const event = (id: string, previous: string | null, op: string): Event => ({
    id,
    kind: 4290,
    pubkey: "owner",
    created_at: 1,
    content: JSON.stringify({ operationId: op }),
    sig: "",
    tags: [
      ["z", "folder"],
      ...(previous ? [["e", previous, "", "prev"]] : []),
    ],
  });
  const expected = event("expected", null, "ef".repeat(32));
  const derived = event("derived", expected.id, operationId);
  const secondDerived = event("second-derived", derived.id, operationId);
  assert.equal(
    folderCheckpointExtendsExpectedForOperation(
      [expected, derived, secondDerived],
      secondDerived.id,
      expected.id,
      operationId,
    ),
    true,
  );
  const unrelated = event("unrelated", derived.id, otherOperationId);
  assert.equal(
    folderCheckpointExtendsExpectedForOperation(
      [expected, derived, unrelated],
      unrelated.id,
      expected.id,
      operationId,
    ),
    false,
  );
});

test("recursive attach budget rejects depth, fan-out, members, and bytes before mutating", () => {
  const budget = { folderOccurrences: 0, members: 0, signedBytes: 0 };
  const limits = {
    maxFolderOccurrences: 2,
    maxDepth: 1,
    maxMembers: 3,
    maxSignedBytes: 4,
  };
  assert.equal(
    consumeRecursivePullBudget(
      budget,
      { folderOccurrences: 1, members: 2, signedBytes: 3, depth: 1 },
      limits,
    ),
    null,
  );
  assert.match(
    consumeRecursivePullBudget(budget, { folderOccurrences: 2 }, limits) ?? "",
    /occurrences/,
  );
  assert.deepEqual(budget, { folderOccurrences: 1, members: 2, signedBytes: 3 });
  assert.match(consumeRecursivePullBudget(budget, { depth: 2 }, limits) ?? "", /depth/);
  assert.match(consumeRecursivePullBudget(budget, { members: 2 }, limits) ?? "", /members/);
  assert.match(consumeRecursivePullBudget(budget, { signedBytes: 2 }, limits) ?? "", /bytes/);
});

test("recursive pull charges complete signed events once across repeated aliases", () => {
  const event: Event = {
    id: "12".repeat(32),
    pubkey: "34".repeat(32),
    created_at: 1,
    kind: 4290,
    tags: Array.from({ length: 32 }, (_, index) => [
      "tag",
      `${index}`.repeat(64),
    ]),
    content: "{}",
    sig: "56".repeat(64),
  };
  const exactBytes = traceSignedEventBytes(event);
  assert.ok(exactBytes > new TextEncoder().encode(event.content).byteLength);

  const budget = { folderOccurrences: 0, members: 0, signedBytes: 0 };
  const charged = new Set<string>();
  assert.equal(
    consumeUniqueRecursivePullSignedEvents(
      budget,
      charged,
      [event, event],
      { maxSignedBytes: exactBytes },
    ),
    null,
  );
  assert.equal(budget.signedBytes, exactBytes);
  assert.deepEqual([...charged], [event.id]);

  // The same immutable history mounted at another path is cache work, not a
  // second budget charge.
  assert.equal(
    consumeUniqueRecursivePullSignedEvents(
      budget,
      charged,
      [event],
      { maxSignedBytes: exactBytes },
    ),
    null,
  );
  assert.equal(budget.signedBytes, exactBytes);

  const next = { ...event, id: "78".repeat(32) };
  assert.match(
    consumeUniqueRecursivePullSignedEvents(
      budget,
      charged,
      [next],
      { maxSignedBytes: exactBytes + traceSignedEventBytes(next) - 1 },
    ) ?? "",
    /signed bytes/,
  );
  assert.equal(charged.has(next.id), false);
  assert.equal(budget.signedBytes, exactBytes);
});

test("structural shield journals cover old and new paths across a crash", () => {
  assert.deepEqual(
    structuralShieldJournal(
      ["notes/private", "elsewhere"],
      "notes",
      "archive/notes",
      true,
    ),
    {
      shieldedPathsBefore: ["elsewhere", "notes/private"],
      shieldedPathsDuring: ["archive/notes/private", "elsewhere", "notes/private"],
      shieldedPathsAfter: ["archive/notes/private", "elsewhere"],
    },
  );
  assert.deepEqual(
    structuralShieldJournal(["notes/private"], "notes", null, true),
    {
      shieldedPathsBefore: ["notes/private"],
      shieldedPathsDuring: ["notes/private"],
      shieldedPathsAfter: [],
    },
  );
  assert.deepEqual(
    structuralShieldJournal(["private"], "private/a.md", "public/a.md", false),
    {
      shieldedPathsBefore: ["private"],
      shieldedPathsDuring: ["private", "public/a.md"],
      shieldedPathsAfter: ["private", "public/a.md"],
    },
  );
});

test("active to Oblivion retains the active relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("draft.md", "oblivion/stamp/draft.md"),
    { kind: "to-oblivion", fromPath: "draft.md" },
  );
});

test("rapid restore before Oblivion sync remains one move from the original path", () => {
  assert.deepEqual(
    pendingMoveForPath(
      "oblivion/stamp/draft.md",
      "restored/draft.md",
      { kind: "to-oblivion", fromPath: "draft.md" },
    ),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("restore after a completed move to Oblivion extends from its local copy", () => {
  assert.deepEqual(
    pendingMoveForPath("oblivion/stamp/draft.md", "restored/draft.md"),
    { kind: "restore", fromPath: "oblivion/stamp/draft.md" },
  );
});

test("several active moves retain the first relay coordinate", () => {
  assert.deepEqual(
    pendingMoveForPath("notes/draft.md", "final/draft.md", {
      kind: "move",
      fromPath: "draft.md",
    }),
    { kind: "move", fromPath: "draft.md" },
  );
});

test("an explicit write returns the newly published checkpoint", async () => {
  let retried = false;
  const nodeId = await completeStagedWrite(
    async () => "new-node-id",
    () => {
      retried = true;
    },
  );

  assert.equal(nodeId, "new-node-id");
  assert.equal(retried, false);
});

test("a failed explicit write is surfaced and scheduled for retry", async () => {
  const failure = new Error("relay unavailable");
  let retries = 0;

  await assert.rejects(
    completeStagedWrite(
      async () => {
        throw failure;
      },
      () => {
        retries++;
      },
    ),
    failure,
  );
  assert.equal(retries, 1);
});

test("an unavailable prior Step reports the broken history instead of reading event.tags", () => {
  assert.throws(
    () => previousStepCitationTargets("notes/draft.md", "prior-node", []),
    /cannot load the previous Step for notes\/draft\.md at prior-node/,
  );
});

test("a scheduled first publish reports its persisted head to the UI", async () => {
  const order: string[] = [];
  const file = { runs: [], nodeId: "first-node", tags: [] };
  const nodeId = await completeBackgroundPush(
    async () => {
      order.push("publish");
      return "first-node";
    },
    () => {
      order.push("read");
      return file;
    },
    (persisted) => {
      order.push(`notify:${persisted?.nodeId}`);
    },
  );

  assert.equal(nodeId, "first-node");
  assert.deepEqual(order, ["publish", "read", "notify:first-node"]);
});

test("starter bootstrap persists an empty genesis before the body Step", async () => {
  const order: string[] = [];
  const genesis = await publishEmptyGenesisIfNeeded(
    true,
    null,
    async () => {
      order.push("publish-empty");
      return { id: "genesis" };
    },
    (node) => order.push(`persist:${node.id}`),
  );

  assert.equal(genesis?.id, "genesis");
  assert.deepEqual(order, ["publish-empty", "persist:genesis"]);
});

test("starter bootstrap resumes from an existing empty genesis", async () => {
  let publishes = 0;
  const genesis = await publishEmptyGenesisIfNeeded(
    true,
    "genesis",
    async () => {
      publishes++;
      return { id: "sibling" };
    },
    () => {},
  );

  assert.equal(genesis, null);
  assert.equal(publishes, 0);
});

test("starter bootstrap reuses a body Step whose manifest update failed", () => {
  assert.equal(
    completedEmptyGenesisBootstrapHead(
      true,
      null,
      [{ id: "genesis" }, { id: "body-step" }],
      "ayoooo, world!\n\n",
      "ayoooo, world!\n\n",
    ),
    "body-step",
  );
  assert.equal(
    completedEmptyGenesisBootstrapHead(
      true,
      null,
      [{ id: "genesis" }, { id: "old-body" }],
      "old",
      "new edit",
    ),
    null,
  );
});

test("deletion removes local copies only after every tombstone lands", async () => {
  const order: string[] = [];
  await completeDeletion(
    ["a.md", "b.md"],
    async (path) => {
      order.push(`remote:${path}`);
    },
    (path) => {
      order.push(`local:${path}`);
    },
  );

  assert.deepEqual(order.slice(0, 2).sort(), ["remote:a.md", "remote:b.md"]);
  assert.deepEqual(order.slice(2), ["local:a.md", "local:b.md"]);
});

test("failed tombstones leave local copies intact for retry", async () => {
  const deleted: string[] = [];
  await assert.rejects(
    completeDeletion(
      ["a.md"],
      async () => {
        throw new Error("relay unavailable");
      },
      (path) => deleted.push(path),
    ),
    /relay unavailable/,
  );
  assert.deepEqual(deleted, []);
});

test("ownership disposition distinguishes owned, foreign, and unverifiable nodes", () => {
  assert.equal(ownershipDisposition("alice", "alice"), "owned");
  assert.equal(ownershipDisposition("bob", "alice"), "foreign");
  assert.equal(ownershipDisposition(null, "alice"), "unverifiable");
});

test("folder membership keeps using a different locally held keychain owner", () => {
  localStorage.clear();
  const keys = loadKeys();
  const folderOwner = keys[0]!;
  const fileOwner = keys[1]!;
  const fileSigner = localFileSigner(fileOwner.pubkey);

  assert.ok(fileSigner);
  const signer = folderWriteSigner(folderOwner.pubkey, fileSigner);
  assert.ok(signer);
  assert.equal(getPublicKey(signer), folderOwner.pubkey);
});

test("a genuinely foreign folder still fails closed", () => {
  localStorage.clear();
  const fileSigner = localFileSigner(authorVoice());
  const foreignOwner = getPublicKey(generateSecretKey());

  assert.ok(fileSigner);
  assert.equal(folderWriteSigner(foreignOwner, fileSigner), null);
});

test("runRootMutationSerialized serializes per-root and cleans up an empty queue", async () => {
  // The per-root mutation serializer is the spine of crash-safe structural
  // gestures: every delete/move/rename/recovery flows through it. This test
  // pins its three load-bearing guarantees with two concurrent operations on
  // the same root:
  //   (1) strict non-overlap — task 2 cannot start until task 1 has resolved,
  //   (2) arrival-order execution (FIFO via the tail chain),
  //   (3) a failed operation does not reject the chained successor
  //       (`.catch(() => undefined)` on the tail), and
  //   (4) once both resolve, the runs map no longer carries the root
  //       (the empty queue is removable / GC-able).
  type Run = import("./workspace-local.js").RootMutationRun;
  const runs = new Map<string, Run>();
  const events: string[] = [];
  let task1Resolve: () => void = () => {};
  const task1Gate = new Promise<void>((resolve) => { task1Resolve = resolve; });

  const task1 = runRootMutationSerialized(runs, "root", "11".repeat(32), async () => {
    events.push("task1:start");
    await task1Gate;
    events.push("task1:end");
    return "task1-result" as const;
  });
  // Kick off task2 before task1 resolves: it must NOT start until task1 ends.
  const task2 = runRootMutationSerialized(runs, "root", "22".repeat(32), async () => {
    events.push("task2:start");
    events.push("task2:end");
    return "task2-result" as const;
  });
  // Yield once to let the first task reach its await; task2 must still be
  // queued and not have started.
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["task1:start"], "task2 must not start before task1 ends");

  task1Resolve();
  assert.equal(await task1, "task1-result");
  assert.equal(await task2, "task2-result");
  assert.deepEqual(events, [
    "task1:start",
    "task1:end",
    "task2:start",
    "task2:end",
  ], "tasks must run in arrival order with strict non-overlap");
  // Queue cleanup: an empty operations map should let the root entry go.
  assert.equal(runs.has("root"), false, "empty queue must be removed from the runs map");
});

test("runRootMutationSerialized does not let a failed task reject its successor", async () => {
  type Run = import("./workspace-local.js").RootMutationRun;
  const runs = new Map<string, Run>();
  const failing = runRootMutationSerialized(runs, "root", "11".repeat(32), async () => {
    throw new Error("boom");
  });
  await assert.rejects(failing, /boom/);

  // The successor must still run to completion despite the prior rejection.
  // This is the `.catch(() => undefined).then(task)` chain doing real work.
  const successorRan: string[] = [];
  const successor = runRootMutationSerialized(runs, "root", "22".repeat(32), async () => {
    successorRan.push("ran");
    return "ok" as const;
  });
  assert.equal(await successor, "ok");
  assert.deepEqual(successorRan, ["ran"]);
  assert.equal(runs.has("root"), false);
});

test("runRootMutationSerialized coalesces duplicate operation ids on the same root", async () => {
  type Run = import("./workspace-local.js").RootMutationRun;
  const runs = new Map<string, Run>();
  let callCount = 0;
  const operationId = "11".repeat(32);
  const first = runRootMutationSerialized(runs, "root", operationId, async () => {
    callCount++;
    return "first" as const;
  });
  // Second call with the same operationId must return the same in-flight
  // promise — recovery code relies on this coalescing so a duplicate resume
  // attempt cannot re-enter a journal that is already completing.
  const second = runRootMutationSerialized(runs, "root", operationId, async () => {
    callCount++;
    return "second" as const;
  });
  assert.equal(await first, "first");
  assert.equal(await second, "first");
  assert.equal(callCount, 1, "duplicate operationId must coalesce to one execution");
  assert.equal(runs.has("root"), false);
});

test("runRootMutationSerialized isolates a synchronous throw on the chained branch", async () => {
  // The chained branch (`queue.tail.catch(() => undefined).then(task)`)
  // delegates a synchronous throw inside `task` to `.then(task)`'s implicit
  // rejection handler. A regression that let the sync throw escape (or
  // reject the tail so the successor never runs) would corrupt serialization.
  // This pins: op #2's sync throw does not poison op #3, and the queue cleans
  // up to empty once all three resolve.
  type Run = import("./workspace-local.js").RootMutationRun;
  const runs = new Map<string, Run>();
  const events: string[] = [];
  const op1 = runRootMutationSerialized(runs, "root", "11".repeat(32), async () => {
    events.push("op1");
    return "ok1" as const;
  });
  // Non-async task that throws synchronously on the chained branch.
  const op2 = runRootMutationSerialized(runs, "root", "22".repeat(32), () => {
    events.push("op2-throws");
    throw new Error("sync boom");
  });
  const op3 = runRootMutationSerialized(runs, "root", "33".repeat(32), async () => {
    events.push("op3");
    return "ok3" as const;
  });
  assert.equal(await op1, "ok1");
  await assert.rejects(op2, /sync boom/);
  assert.equal(await op3, "ok3");
  assert.deepEqual(events, ["op1", "op2-throws", "op3"]);
  assert.equal(runs.has("root"), false, "queue cleaned up after all three resolved");
});

test("an unarchived recovery throw blocks successor mutations until the stuck journal entry is abandoned via failStructuralOperation (shield rollback, NOT forward-roll)", async () => {
  // Defect class surfaced in review: when structural recovery throws WITHOUT
  // calling failStructuralOperation (e.g. an unclassified throw like "cannot
  // fetch expected folder head" or "cannot find folder membership"), the
  // journal entry stays in pendingStructuralOperations. runRootMutationAfterRecovery
  // runs recover() before task(), so every later Root mutation re-runs that
  // recovery and re-throws — bricking the workspace for new writes. The only
  // in-app escape is for the UI to abandon the stuck entry (App.tsx's Dismiss
  // path when structuralConflictId is null).
  //
  // CRITICAL: the escape MUST use failStructuralOperation, NOT
  // clearStructuralOperation. clearStructuralOperation rolls shields
  // during->after (the SUCCESS semantic), which would move shields to the
  // destination even though the op never completed — unshielding content
  // still sitting at the source. failStructuralOperation rolls during->before,
  // restoring the original shield set so source content stays protected.
  // This test pins both the unblock AND the shield-rollback direction.
  localStorage.clear();
  saveLocalShielded("root", new Set(["notes/private"]));
  const stuckOperationId = "e1".repeat(32);
  const stuckOperation = {
    version: 2 as const,
    kind: "move" as const,
    operationId: stuckOperationId,
    sourcePath: "notes",
    targetPath: "archive/notes",
    isFolder: true as const,
    moves: [{ oldRel: "notes", newRel: "archive/notes" }],
    expectedFolder: {
      traceId: "11".repeat(32),
      nodeId: "22".repeat(32),
    },
    expectedFolders: {
      notes: {
        traceId: "11".repeat(32),
        nodeId: "22".repeat(32),
      },
    },
    shieldedPathsBefore: ["notes/private"],
    shieldedPathsDuring: ["archive/notes/private", "notes/private"],
    shieldedPathsAfter: ["archive/notes/private"],
  };
  stageStructuralOperation("root", stuckOperation);
  // Staging sets the live shield set to the during-union (both old and new
  // coordinates shielded across the crash window).
  assert.deepEqual(
    [...loadLocalShielded("root")].sort(),
    ["archive/notes/private", "notes/private"],
  );
  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    true,
  );

  type Run = import("./workspace-local.js").RootMutationRun;
  const runs = new Map<string, Run>();

  // A successor mutation whose recover() re-throws (the stuck op is still in
  // the journal and cannot make progress) MUST reject. This is the brick.
  const recoverThatReThrows = async () => {
    throw new Error("cannot fetch expected folder head 2222222222222222222222222222222222222222222222222222222222222222");
  };
  const blockedSuccessor = runRootMutationAfterRecovery(
    runs,
    "root",
    "f1".repeat(32),
    recoverThatReThrows,
    async () => "should-not-run",
  );
  await assert.rejects(blockedSuccessor, /cannot fetch expected folder head/);
  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    true,
    "stuck entry still in the journal — nothing cleared it",
  );

  // The UI escape: abandon the stuck entry via failStructuralOperation (the
  // production Dismiss path). Shields roll BACK to before — content still at
  // the source stays protected. A clearStructuralOperation here would have
  // rolled FORWARD to after, unshielding notes/private (the defect).
  failStructuralOperation(
    "root",
    stuckOperation,
    "abandoned by user: recovery could not classify the failure",
  );
  assert.deepEqual(
    [...loadLocalShielded("root")].sort(),
    ["notes/private"],
    "shields rolled BACK to before — source content stays shielded (NOT forward to archive/notes/private)",
  );
  assert.ok(
    loadLocalFolder("root")?.structuralConflicts?.[stuckOperationId],
    "abandoned op archived to structuralConflicts for an honest audit trail",
  );
  assert.equal(
    hasPendingStructuralPathMutation("root", "notes", "archive/notes"),
    false,
    "journal is clear — successor mutation can proceed",
  );

  // Now a successor mutation's recover() observes the journal is empty and
  // the task() proceeds.
  const successorAfterAbandon = runRootMutationAfterRecovery(
    runs,
    "root",
    "f2".repeat(32),
    async () => {},
    async () => "ok",
  );
  assert.equal(await successorAfterAbandon, "ok");
  assert.equal(runs.has("root"), false, "queue cleaned up");
});




