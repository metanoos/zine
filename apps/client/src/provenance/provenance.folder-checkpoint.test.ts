import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";

import {
  acceptedCurrentOperationCheckpoint,
  assertTraceTraversalBudget,
  bufferFocusInStorage,
  drainFocusBufferFromStorage,
  folderReconciliationSuffix,
  membersFromNode,
  planManifestUpsert,
  renamedManifestMember,
  requireCurrentFolderMutationSnapshot,
  requireFolderMutationContinuation,
  resolveVerifiedFolderTraceIdentityAtHead,
  runFolderMutationCoordinated,
  runFolderMutationSerialized,
  type FolderMutationLockManager,
  type FolderMutationRun,
  type ManifestFileEntry,
  verifiedFolderNodesFromRelayResults,
} from "./provenance.js";

const OPERATION_ID = "77".repeat(32);

test("independent focus appends drain without a shared in-memory snapshot", () => {
  const values = new Map<string, string>();
  const storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
  } satisfies Storage;
  const folderId = "focus-cross-window-test";
  bufferFocusInStorage(storage, folderId, {
    type: "focus", op: "mount", selection: { kind: "file", path: "a.md" },
    panelIndex: 0, timestamp: 1,
  });
  bufferFocusInStorage(storage, folderId, {
    type: "focus", op: "mount", selection: { kind: "file", path: "b.md" },
    panelIndex: 1, timestamp: 2,
  });
  assert.deepEqual(
    drainFocusBufferFromStorage(storage, folderId).map((delta) =>
      delta.type === "focus" && delta.selection.kind !== "coin" ? delta.selection.path : ""
    ),
    ["a.md", "b.md"],
  );
  assert.deepEqual(drainFocusBufferFromStorage(storage, folderId), []);
});

function checkpointEvent(
  id: string,
  cause: "child-advance" | "explicit-step",
): Event {
  return {
    id,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [["z", "folder"]],
    content: JSON.stringify({ operationId: OPERATION_ID, folderCheckpoint: { cause } }),
    sig: "b".repeat(128),
  };
}

async function signedFolderNode(
  secret: Uint8Array,
  previous?: Event,
  createdAtOffset = 0,
): Promise<Event> {
  const bodyHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[]")),
  ).toString("hex");
  const traceId = previous?.tags.find((tag) => tag[0] === "f")?.[1] ?? previous?.id;
  const createdAt = (previous?.created_at ?? 0) + 1 + createdAtOffset;
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [
      ["z", "folder"],
      ...(traceId ? [["f", traceId]] : []),
      ["action", previous ? "edit" : "import"],
      ...(previous ? [["e", previous.id, "", "prev"]] : []),
      ["x", bodyHash],
    ],
    content: JSON.stringify({
      steppedAt: createdAt * 1_000,
      snapshot: { members: [] },
      contentHash: bodyHash,
      operationId: OPERATION_ID,
      folderCheckpoint: {
        version: 1,
        cause: previous ? "explicit-step" : "genesis",
      },
    }),
  }, secret);
}

const original: ManifestFileEntry = {
  kind: "file",
  relativePath: "essay.md",
  latestNodeId: "aa".repeat(32),
  contentHash: "bb".repeat(32),
};

class TestFolderLockManager implements FolderMutationLockManager {
  private tails = new Map<string, Promise<void>>();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => blocked);
    this.tails.set(name, tail);
    return previous.then(callback).finally(() => {
      release();
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
  }
}

async function signedMalformedFolderSnapshot(secret: Uint8Array): Promise<Event> {
  const canonicalBody = JSON.stringify([
    [original.relativePath, original.kind, original.contentHash],
  ]);
  const bodyHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalBody)),
  ).toString("hex");
  return finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "folder"],
      ["q", original.latestNodeId],
      ["action", "import"],
      ["x", bodyHash],
    ],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot: {
        members: [
          original,
          {
            kind: "file",
            relativePath: "silently-dropped.md",
            latestNodeId: "cc".repeat(32),
          },
        ],
      },
      contentHash: bodyHash,
      operationId: OPERATION_ID,
      folderCheckpoint: { version: 1, cause: "genesis" },
    }),
  }, secret);
}

test("a new member is a structure change", () => {
  const plan = planManifestUpsert([], original, 10);
  assert.equal(plan.unchanged, false);
  if (plan.unchanged) return;
  assert.deepEqual(plan.folderCheckpoint, { version: 1, cause: "structure-change" });
  assert.deepEqual(plan.deltas, [{
    type: "add",
    kind: "file",
    relativePath: "essay.md",
    nodeId: original.latestNodeId,
    timestamp: 10,
  }]);
});

test("an existing member's new head is advance without reordering", () => {
  const sibling: ManifestFileEntry = {
    kind: "file",
    relativePath: "sibling.md",
    latestNodeId: "cc".repeat(32),
    contentHash: "dd".repeat(32),
  };
  const advanced = {
    ...original,
    latestNodeId: "ee".repeat(32),
    contentHash: "ff".repeat(32),
  };
  const plan = planManifestUpsert([original, sibling], advanced, 20);
  assert.equal(plan.unchanged, false);
  if (plan.unchanged) return;
  assert.deepEqual(plan.members.map((member) => member.relativePath), ["essay.md", "sibling.md"]);
  assert.deepEqual(plan.folderCheckpoint, {
    version: 1,
    cause: "child-advance",
    sourceNodeId: advanced.latestNodeId,
  });
  assert.deepEqual(plan.deltas, [{
    type: "advance",
    kind: "file",
    relativePath: "essay.md",
    previousNodeId: original.latestNodeId,
    nodeId: advanced.latestNodeId,
    timestamp: 20,
  }]);
});

test("an identical member head is a no-op", () => {
  assert.deepEqual(planManifestUpsert([original], { ...original }, 30), { unchanged: true });
});

test("one operation can still apply several distinct sibling transitions", () => {
  const first = planManifestUpsert([], original, 30);
  assert.equal(first.unchanged, false);
  if (first.unchanged) return;
  const sibling: ManifestFileEntry = {
    kind: "file",
    relativePath: "appendix.md",
    latestNodeId: "cc".repeat(32),
    contentHash: "dd".repeat(32),
  };
  const second = planManifestUpsert(first.members, sibling, 31);
  assert.equal(second.unchanged, false);
  if (second.unchanged) return;
  assert.deepEqual(
    second.members.map((member) => member.relativePath),
    ["essay.md", "appendix.md"],
  );
});

test("a rename verifies a named file's signed snapshot without requiring optional x", async () => {
  const snapshot = "renamed";
  const nextContentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot)),
  ).toString("hex");
  const nextNode = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [["z", "file"]],
    content: JSON.stringify({ contentHash: nextContentHash, snapshot }),
  }, new Uint8Array(32).fill(9));
  assert.deepEqual(
    await renamedManifestMember(original, "renamed.md", nextNode.id, nextNode),
    {
      ...original,
      relativePath: "renamed.md",
      latestNodeId: nextNode.id,
      contentHash: nextContentHash,
    },
  );
  const mismatched = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [["z", "file"]],
    content: JSON.stringify({ contentHash: "34".repeat(32), snapshot }),
  }, new Uint8Array(32).fill(9));
  await assert.rejects(
    renamedManifestMember(original, "renamed.md", mismatched.id, mismatched),
    /cannot verify renamed folder member node/,
  );
});

test("a child content hash cannot change without a new immutable node", () => {
  assert.throws(
    () => planManifestUpsert([original], { ...original, contentHash: "cc".repeat(32) }, 40),
    /same node with a different content hash/,
  );
});

test("a folder member cannot adopt an unrelated head without verified lineage", () => {
  const current: ManifestFileEntry = {
    kind: "folder",
    relativePath: "notes",
    latestNodeId: "11".repeat(32),
    contentHash: "22".repeat(32),
  };
  const unrelated: ManifestFileEntry = {
    ...current,
    latestNodeId: "33".repeat(32),
    contentHash: "44".repeat(32),
  };
  assert.throws(
    () => planManifestUpsert([current], unrelated, 50),
    /do not form one forward lineage/,
  );
  const plan = planManifestUpsert([current], unrelated, 50, "entry-newer");
  assert.equal(plan.unchanged, false);
});

test("folder mutation serialization prevents sibling appends and survives a failed predecessor", async () => {
  const runs = new Map<string, FolderMutationRun>();
  const order: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });

  const first = runFolderMutationSerialized(runs, "folder", async () => {
    order.push("first:start");
    await blocked;
    order.push("first:end");
    throw new Error("relay unavailable");
  });
  const second = runFolderMutationSerialized(runs, "folder", async () => {
    order.push("second");
    return "head-2";
  });
  assert.deepEqual(order, ["first:start"]);
  release();
  await assert.rejects(first, /relay unavailable/);
  assert.equal(await second, "head-2");
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("two browser contexts share one folder mutation lane across the read barrier", async () => {
  const lockManager = new TestFolderLockManager();
  const contextA = new Map<string, FolderMutationRun>();
  const contextB = new Map<string, FolderMutationRun>();
  let head = "genesis";
  let firstRead!: () => void;
  let releaseFirst!: () => void;
  const entered = new Promise<void>((resolve) => { firstRead = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const reads: string[] = [];

  const first = runFolderMutationCoordinated(
    contextA,
    "folder",
    async () => {
      const previous = head;
      reads.push(previous);
      firstRead();
      await blocked;
      head = `${previous}>a`;
      return head;
    },
    lockManager,
  );
  await entered;
  let secondEntered = false;
  const second = runFolderMutationCoordinated(
    contextB,
    "folder",
    async () => {
      secondEntered = true;
      const previous = head;
      reads.push(previous);
      head = `${previous}>b`;
      return head;
    },
    lockManager,
  );

  await Promise.resolve();
  assert.equal(secondEntered, false);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["genesis>a", "genesis>a>b"]);
  assert.deepEqual(reads, ["genesis", "genesis>a"]);
});

test("bounded post-publish verification preserves fixed-owner sibling detection", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 5]);
  const genesis = await signedFolderNode(ownerSecret);
  const head = await signedFolderNode(ownerSecret, genesis);
  const checkpoint = await signedFolderNode(ownerSecret, head);
  const current = await requireFolderMutationContinuation(
    genesis.id,
    [genesis, head],
    [checkpoint],
    genesis.pubkey,
  );
  assert.equal(current.head.id, checkpoint.id);

  const sibling = await signedFolderNode(ownerSecret, head, 1);
  await assert.rejects(
    requireFolderMutationContinuation(
      genesis.id,
      [genesis, head],
      [checkpoint, sibling],
      genesis.pubkey,
    ),
    /has 2 accepted owner heads/,
  );
});

test("a delayed sibling from a cached ancestor fails complete mutation revalidation", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 4]);
  const genesis = await signedFolderNode(ownerSecret);
  const cachedHead = await signedFolderNode(ownerSecret, genesis);
  const cached = await requireCurrentFolderMutationSnapshot(
    genesis.id,
    [genesis, cachedHead],
    genesis.pubkey,
  );
  const ourCheckpoint = await signedFolderNode(ownerSecret, cached.head);
  const delayedSibling = await signedFolderNode(ownerSecret, genesis, 1);
  await assert.rejects(
    requireCurrentFolderMutationSnapshot(
      genesis.id,
      [...cached.chain, ourCheckpoint, delayedSibling],
      genesis.pubkey,
    ),
    /has 2 accepted owner heads/,
  );
});

test("folder snapshot parsing rejects instead of dropping one malformed member", () => {
  const event = checkpointEvent("malformed", "explicit-step");
  event.content = JSON.stringify({
    snapshot: { members: [original, { ...original, contentHash: undefined }] },
  });
  assert.throws(() => membersFromNode(event), /member 1 is malformed/);
});

test("folder mutation planning rejects a signed nonconformant current snapshot", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 9]);
  const malformed = await signedMalformedFolderSnapshot(ownerSecret);
  await assert.rejects(
    requireCurrentFolderMutationSnapshot(
      malformed.id,
      [malformed],
      malformed.pubkey,
    ),
    /unsafe: folder snapshot has malformed members/,
  );
});

test("home reconciliation republishes only an exact verified federated suffix", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 6]);
  const genesis = await signedFolderNode(ownerSecret);
  const homeHead = await signedFolderNode(ownerSecret, genesis);
  const externalHead = await signedFolderNode(ownerSecret, homeHead);
  assert.deepEqual(
    folderReconciliationSuffix([genesis, homeHead], [genesis, homeHead, externalHead])
      .map((event) => event.id),
    [externalHead.id],
  );
  assert.deepEqual(
    folderReconciliationSuffix([], [genesis, homeHead, externalHead])
      .map((event) => event.id),
    [genesis.id, homeHead.id, externalHead.id],
  );
  assert.throws(
    () => folderReconciliationSuffix([genesis, externalHead], [genesis, homeHead]),
    /does not extend/,
  );
});

test("an invalid genesis-id collision cannot choose a folder's trust root", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 9]);
  const genesis = await signedFolderNode(ownerSecret);
  const head = await signedFolderNode(ownerSecret, genesis);
  const collision = {
    ...genesis,
    pubkey: "ff".repeat(32),
    sig: "00".repeat(64),
  };
  assert.deepEqual(
    verifiedFolderNodesFromRelayResults(
      genesis.id,
      [head, { ...head, sig: "00".repeat(64) }],
      [collision, genesis],
    ).map((event) => event.id),
    [head.id, genesis.id],
  );
});

test("individual trace histories fail closed on event and signed-byte ceilings", () => {
  const event = checkpointEvent("budget", "child-advance");
  assert.throws(
    () => assertTraceTraversalBudget([event, { ...event, id: "second" }], { maxEvents: 1 }),
    /exceeds 1 signed events/,
  );
  assert.throws(
    () => assertTraceTraversalBudget([event], { maxSignedBytes: 1 }),
    /exceeds 1 signed bytes/,
  );
});

test("a recursive operation may have derived checkpoints before its current explicit endpoint", () => {
  const rollup = checkpointEvent("rollup", "child-advance");
  const explicit = checkpointEvent("explicit", "explicit-step");
  assert.equal(
    acceptedCurrentOperationCheckpoint([rollup, explicit], explicit, explicit).id,
    explicit.id,
  );
  assert.throws(
    () => acceptedCurrentOperationCheckpoint([rollup, explicit], explicit, rollup),
    /not the current checkpoint/,
  );
});

test("a durably published losing sibling is reported as a conflict, not success", () => {
  const published = checkpointEvent("published", "child-advance");
  const competing = checkpointEvent("competing", "child-advance");
  assert.throws(
    () => acceptedCurrentOperationCheckpoint([published, competing], competing, published),
    /not the current checkpoint accepted by the home relay/,
  );
});

test("a folder f tag is not identity authority without one verified owner chain", async () => {
  const ownerSecret = Uint8Array.from([...new Uint8Array(31), 7]);
  const attackerSecret = Uint8Array.from([...new Uint8Array(31), 8]);
  const genesis = await signedFolderNode(ownerSecret);
  const validHead = await signedFolderNode(ownerSecret, genesis);
  assert.equal(
    await resolveVerifiedFolderTraceIdentityAtHead(
      validHead,
      async () => [genesis, validHead],
    ),
    genesis.id,
  );

  const forgedHead = await signedFolderNode(attackerSecret, genesis);
  assert.equal(
    await resolveVerifiedFolderTraceIdentityAtHead(
      forgedHead,
      async () => [genesis, forgedHead],
    ),
    null,
  );
});
