import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";

import {
  directoryFolderTraces,
  directoryTraceCoordinate,
  folderCheckpointLogObservations,
  gatherContextSnapshot,
  promptContextFiles,
  temporalFolderEventPaths,
  temporalTraceEventPath,
  temporalTraceEventPaths,
} from "./context-gather.js";
import type { KEdit } from "../provenance/provenance.js";
import type { FileState, FolderRef } from "../workspace/workspace-core.js";

function file(text: string): FileState {
  return {
    runs: text ? [{ voice: "author", text }] : [],
    nodeId: "",
    tags: [],
  };
}

function steppedFile(path: string): FileState {
  return { ...file(`body:${path}`), nodeId: `head:${path}`, traceId: `trace:${path}` };
}

test("shielded descendant folder traces are not fetched for a parent mount", () => {
  const files: Record<string, FileState> = {
    private: {
      kind: "folder",
      runs: [],
      nodeId: "private-head",
      traceId: "private-trace",
      tags: [],
    },
    "private/draft.md": steppedFile("private/draft.md"),
  };
  assert.deepEqual(
    directoryFolderTraces(
      "root-trace",
      files,
      [{ kind: "folder", path: "" }],
      new Set(["private"]),
    ),
    [{ folderId: "root-trace", path: "" }],
  );
  assert.deepEqual(
    directoryFolderTraces(
      "root-trace",
      files,
      [{ kind: "folder", path: "private" }],
      new Set(["private"]),
    ).map((trace) => trace.path),
    ["", "private"],
  );
});

test("a selected repeated folder occurrence keeps its own recursive path", () => {
  const shared = {
    kind: "folder" as const,
    runs: [],
    nodeId: "shared-head",
    traceId: "shared-trace",
    tags: [],
  };
  assert.deepEqual(
    directoryFolderTraces(
      "root-trace",
      { a: shared, b: shared },
      [{ kind: "folder", path: "b" }],
    ).map((trace) => trace.path),
    ["", "b"],
  );
});

function event(path: string): Event {
  return {
    id: `head:${path}`,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [["action", "edit"]],
    content: JSON.stringify({ steppedAt: 1_000, snapshot: `body:${path}`, deltas: [] }),
    sig: "b".repeat(128),
  };
}

async function tracedEvent(path: string): Promise<Event> {
  const snapshot = `body:${path}`;
  const contentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot)),
  ).toString("hex");
  const kedit: KEdit = {
    op: "ins",
    from: 0,
    to: 0,
    text: snapshot,
    voice: "a".repeat(64),
    t: 900,
    tx: 0,
  };
  return finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["F", path], ["f", folder.id], ["action", "edit"]],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot,
      contentHash,
      operationId: TEST_OPERATION_ID,
      deltas: [],
      kedits: [kedit],
    }),
  }, Uint8Array.from([...new Uint8Array(31), 1]));
}

const rootScope = [{ kind: "folder" as const, path: "" }] as const;
const TEST_OPERATION_ID = "1".repeat(64);
const FOLDER_MEMBER_NODE_ID = "a".repeat(64);
const FOLDER_SECRET = Uint8Array.from([...new Uint8Array(31), 2]);
const EMPTY_FOLDER_HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const folderGenesis = finalizeEvent({
  kind: 4290,
  created_at: 1,
  tags: [["z", "folder"], ["action", "import"], ["x", EMPTY_FOLDER_HASH]],
  content: JSON.stringify({
    steppedAt: 1_000,
    snapshot: { members: [] },
    contentHash: EMPTY_FOLDER_HASH,
    operationId: TEST_OPERATION_ID,
    deltas: [],
    folderCheckpoint: { version: 1, cause: "genesis" },
  }),
}, FOLDER_SECRET);
const folder: FolderRef = { id: folderGenesis.id, label: "Root" };

async function folderNode(
  members: Array<{
    kind: "file" | "folder";
    relativePath: string;
    latestNodeId: string;
    contentHash: string;
  }>,
  prev: Event,
  deltas: unknown[],
  operationId: string,
): Promise<Event> {
  return folderNodeFor(folderGenesis, FOLDER_SECRET, members, prev, deltas, operationId);
}

async function folderNodeFor(
  genesis: Event,
  secret: Uint8Array,
  members: Array<{
    kind: "file" | "folder";
    relativePath: string;
    latestNodeId: string;
    contentHash: string;
  }>,
  prev: Event,
  deltas: unknown[],
  operationId: string,
): Promise<Event> {
  const body = JSON.stringify(
    members.map((member) => [member.relativePath, member.kind, member.contentHash]),
  );
  const contentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
  ).toString("hex");
  return finalizeEvent({
    kind: 4290,
    created_at: prev.created_at + 1,
    tags: [
      ["z", "folder"],
      ["f", genesis.id],
      ...members.map((member) => ["q", member.latestNodeId]),
      ["action", "edit"],
      ["e", prev.id, "", "prev"],
      ["x", contentHash],
    ],
    content: JSON.stringify({
      steppedAt: (prev.created_at + 1) * 1_000,
      snapshot: { members },
      deltas,
      contentHash,
      operationId,
      folderCheckpoint: { version: 1, cause: "structure-change" },
    }),
  }, secret);
}

async function repeatedFolderFixture(): Promise<{
  childGenesis: Event;
  rootHead: Event;
  files: Record<string, FileState>;
}> {
  const childSecret = Uint8Array.from([...new Uint8Array(31), 7]);
  const childGenesis = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "folder"], ["action", "import"], ["x", EMPTY_FOLDER_HASH]],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot: { members: [] },
      contentHash: EMPTY_FOLDER_HASH,
      operationId: "7".repeat(64),
      deltas: [],
      folderCheckpoint: { version: 1, cause: "genesis" },
    }),
  }, childSecret);
  const member = (relativePath: string) => ({
    kind: "folder" as const,
    relativePath,
    latestNodeId: childGenesis.id,
    contentHash: EMPTY_FOLDER_HASH,
  });
  const rootHead = await folderNode(
    [member("a"), member("b")],
    folderGenesis,
    ["a", "b"].map((relativePath) => ({
      type: "add",
      kind: "folder",
      relativePath,
      nodeId: childGenesis.id,
      timestamp: 2_000,
    })),
    "8".repeat(64),
  );
  const childState: FileState = {
    kind: "folder",
    runs: [],
    nodeId: childGenesis.id,
    traceId: childGenesis.id,
    tags: [],
  };
  return {
    childGenesis,
    rootHead,
    files: { "draft.md": file("draft"), a: childState, b: childState },
  };
}

test("repeated folder occurrences share one immutable verified-chain load", async () => {
  const fixture = await repeatedFolderFixture();
  let childFetches = 0;
  const snapshot = await gatherContextSnapshot(
    folder,
    fixture.files,
    [...rootScope],
    "draft.md",
    new Set(),
    {
      rootFolderNodeId: fixture.rootHead.id,
      fetchFolderNodes: async (folderId) => {
        if (folderId === folder.id) return [folderGenesis, fixture.rootHead];
        if (folderId === fixture.childGenesis.id) {
          childFetches += 1;
          return [fixture.childGenesis];
        }
        return [];
      },
    },
  );

  assert.equal(snapshot.completeness.complete, true, JSON.stringify(snapshot.completeness.failures));
  assert.equal(childFetches, 1);
});

test("aggregate folder budget rejects oversized initial traces", async () => {
  const fixture = await repeatedFolderFixture();
  const snapshot = await gatherContextSnapshot(
    folder,
    fixture.files,
    [...rootScope],
    "draft.md",
    new Set(),
    {
      rootFolderNodeId: fixture.rootHead.id,
      folderTraversalLimits: { maxEvents: 2 },
      fetchFolderNodes: async (folderId) =>
        folderId === folder.id
          ? [folderGenesis, fixture.rootHead]
          : folderId === fixture.childGenesis.id ? [fixture.childGenesis] : [],
    },
  );

  assert.equal(snapshot.completeness.complete, false);
  assert.ok(snapshot.completeness.failures.some((failure) =>
    /aggregate folder history exceeds 2 signed events/.test(failure.message)
  ), JSON.stringify(snapshot.completeness.failures));
});

async function folderRenameChain(deltas: Array<Record<string, unknown>>): Promise<Event[]> {
  const rename = deltas.find((delta) => delta.type === "rename");
  if (
    !rename ||
    (rename.kind !== "file" && rename.kind !== "folder") ||
    typeof rename.fromPath !== "string" ||
    typeof rename.toPath !== "string" ||
    typeof rename.nodeId !== "string"
  ) {
    throw new Error("folderRenameChain needs one complete rename delta");
  }
  const member: {
    kind: "file" | "folder";
    relativePath: string;
    latestNodeId: string;
    contentHash: string;
  } = {
    kind: rename.kind,
    relativePath: rename.fromPath,
    latestNodeId: rename.nodeId,
    contentHash: "c".repeat(64),
  };
  const added = await folderNode(
    [member],
    folderGenesis,
    [{
      type: "add",
      kind: member.kind,
      relativePath: member.relativePath,
      nodeId: member.latestNodeId,
      timestamp: 800,
    }],
    "2".repeat(64),
  );
  const renamed = await folderNode(
    [{ ...member, relativePath: rename.toPath }],
    added,
    deltas,
    "3".repeat(64),
  );
  return [folderGenesis, added, renamed];
}

test("nested workspace paths resolve to their direct folder trace coordinate", () => {
  const files: Record<string, FileState> = {
    notes: { kind: "folder", runs: [], nodeId: "folder-head", traceId: "folder-trace", tags: [] },
    "notes/draft.md": steppedFile("notes/draft.md"),
  };
  assert.deepEqual(directoryTraceCoordinate("root-trace", files, "top.md"), {
    folderId: "root-trace",
    relativePath: "top.md",
  });
  assert.deepEqual(directoryTraceCoordinate("root-trace", files, "notes/draft.md"), {
    folderId: "folder-trace",
    relativePath: "draft.md",
  });
  assert.equal(directoryTraceCoordinate("root-trace", files, "missing/draft.md"), null);
});

test("folder checkpoint observations preserve nested structure and explicit Steps", () => {
  const node = event("folder");
  node.content = JSON.stringify({
    steppedAt: 2_000,
    deltas: [
      { type: "remove", kind: "file", relativePath: "old.md" },
      { type: "add", kind: "folder", relativePath: "new" },
    ],
    folderCheckpoint: { version: 1, cause: "structure-change" },
  });
  assert.deepEqual(folderCheckpointLogObservations(node, "notes"), [
    { steppedAt: 2_000, action: "remove", relativePath: "notes/old.md" },
    { steppedAt: 2_000, action: "add", relativePath: "notes/new" },
  ]);
  node.content = JSON.stringify({
    steppedAt: 3_000,
    folderCheckpoint: { version: 1, cause: "explicit-step" },
  });
  assert.deepEqual(folderCheckpointLogObservations(node, "notes"), [
    { steppedAt: 3_000, action: "step", relativePath: "notes" },
  ]);
});

test("folder history keeps the path mounted when each checkpoint occurred", () => {
  const child = event("child-head");
  child.id = "child-head";
  child.created_at = 2;
  child.content = JSON.stringify({
    steppedAt: 2_000,
    deltas: [{ type: "add", kind: "file", relativePath: "draft.md" }],
    folderCheckpoint: { version: 1, cause: "structure-change" },
  });
  const parentAt = (id: string, relativePath: string, steppedAt: number): Event => ({
    ...event(id),
    id,
    created_at: steppedAt / 1_000,
    content: JSON.stringify({
      steppedAt,
      snapshot: {
        members: [{
          kind: "folder",
          relativePath,
          latestNodeId: child.id,
          contentHash: "a".repeat(64),
        }],
      },
      deltas: [],
    }),
  });
  const paths = temporalFolderEventPaths([
    {
      folderId: "root",
      path: "",
      chain: [parentAt("parent-old", "old", 1_000), parentAt("parent-new", "new", 3_000)],
    },
    { folderId: "child", path: "new", chain: [child] },
  ]);

  assert.equal(paths.get(child.id), "old");
  assert.deepEqual(folderCheckpointLogObservations(child, paths.get(child.id) ?? "new"), [{
    steppedAt: 2_000,
    action: "add",
    relativePath: "old/draft.md",
  }]);
});

test("child genesis uses the first later parent mount instead of today's path", () => {
  const genesis = event("child-genesis");
  genesis.id = "child-genesis";
  genesis.created_at = 1;
  const parentAt = (id: string, relativePath: string, steppedAt: number): Event => ({
    ...event(id),
    id,
    created_at: steppedAt / 1_000,
    content: JSON.stringify({
      steppedAt,
      snapshot: { members: [{
        kind: "folder",
        relativePath,
        latestNodeId: genesis.id,
        contentHash: "a".repeat(64),
      }] },
      deltas: [],
    }),
  });
  const paths = temporalFolderEventPaths([
    {
      folderId: "root",
      path: "",
      chain: [parentAt("mounted-old", "old", 2_000), parentAt("renamed-new", "new", 3_000)],
    },
    { folderId: "child", path: "new", chain: [genesis] },
  ]);

  assert.equal(paths.get(genesis.id), "old");
});

test("file history follows the membership path that pinned each immutable Step", () => {
  const first = event("first-file");
  first.id = "first-file";
  const second = event("second-file");
  second.id = "second-file";
  const parentAt = (
    id: string,
    relativePath: string,
    latestNodeId: string,
    steppedAt: number,
  ): Event => ({
    ...event(id),
    id,
    content: JSON.stringify({
      steppedAt,
      snapshot: { members: [{
        kind: "file",
        relativePath,
        latestNodeId,
        contentHash: "b".repeat(64),
      }] },
      deltas: [],
    }),
  });
  const paths = temporalTraceEventPaths([
    {
      folderId: "root",
      path: "",
      chain: [
        parentAt("file-old", "old.md", first.id, 1_000),
        parentAt("file-moved", "new.md", first.id, 2_000),
        parentAt("file-advanced", "new.md", second.id, 3_000),
      ],
    },
  ], [{ traceId: "file-trace", path: "new.md", chain: [first, second] }]);

  assert.equal(paths.get(first.id), "old.md");
  assert.equal(paths.get(second.id), "new.md");
});

test("temporal paths preserve repeated folder and file occurrences", () => {
  const folderHead = { ...event("child"), id: "child-head" };
  folderHead.content = JSON.stringify({
    steppedAt: 2_000,
    snapshot: { members: [{
      kind: "file",
      relativePath: "x.md",
      latestNodeId: "file-head",
      contentHash: "c".repeat(64),
    }] },
    deltas: [],
  });
  const rootHead = { ...event("root"), id: "root-head" };
  rootHead.content = JSON.stringify({
    steppedAt: 3_000,
    snapshot: { members: [
      { kind: "folder", relativePath: "a", latestNodeId: "child-head", contentHash: "d".repeat(64) },
      { kind: "folder", relativePath: "b", latestNodeId: "child-head", contentHash: "d".repeat(64) },
    ] },
    deltas: [],
  });
  const fileHead = { ...event("file"), id: "file-head" };
  const paths = temporalTraceEventPaths([
    { folderId: "root", path: "", chain: [rootHead] },
    { folderId: "child", path: "a", chain: [folderHead] },
    { folderId: "child", path: "b", chain: [folderHead] },
  ], [
    { traceId: "file", path: "a/x.md", chain: [fileHead] },
    { traceId: "file", path: "b/x.md", chain: [fileHead] },
  ]);

  assert.equal(temporalTraceEventPath(paths, folderHead.id, "a"), "a");
  assert.equal(temporalTraceEventPath(paths, folderHead.id, "b"), "b");
  assert.equal(temporalTraceEventPath(paths, fileHead.id, "a/x.md"), "a/x.md");
  assert.equal(temporalTraceEventPath(paths, fileHead.id, "b/x.md"), "b/x.md");
});

test("temporal paths follow causal parent order when signed clocks roll back", () => {
  const first = { ...event("first"), id: "first" };
  const second = { ...event("second"), id: "second" };
  const parent = (id: string, path: string, nodeId: string, steppedAt: number): Event => ({
    ...event(id),
    id,
    content: JSON.stringify({
      steppedAt,
      snapshot: { members: [{
        kind: "file",
        relativePath: path,
        latestNodeId: nodeId,
        contentHash: "e".repeat(64),
      }] },
      deltas: [],
    }),
  });
  const paths = temporalTraceEventPaths([{
    folderId: "root",
    path: "",
    chain: [
      parent("parent-old", "old.md", first.id, 5_000),
      parent("parent-new", "new.md", second.id, 1_000),
    ],
  }], [{ traceId: "file", path: "new.md", chain: [first, second] }]);

  assert.equal(paths.get(first.id), "old.md");
  assert.equal(paths.get(second.id), "new.md");
});

test("prompt context excludes Mint, Scan, and Oblivion from Root", () => {
  const files: Record<string, FileState> = {
    "draft.md": file("ordinary draft"),
    "notes/idea.md": file("nested ordinary draft"),
    mint: file("system folder placeholder"),
    "mint/coin.md": file("minted phrase"),
    scan: file("system folder placeholder"),
    "scan/imported.md": file("foreign intake"),
    oblivion: file("system folder placeholder"),
    "oblivion/deleted.md": file("deleted draft"),
    "minted/ordinary.md": file("similar prefix, ordinary folder"),
  };

  assert.deepEqual(Object.keys(promptContextFiles(files)).sort(), [
    "draft.md",
    "minted/ordinary.md",
    "notes/idea.md",
  ]);
});

test("bounded parallel fetches still produce canonical snapshots", async () => {
  const files = Object.fromEntries(
    ["draft.md", "b.md", "a.md", "c.md"].map((path) => [path, steppedFile(path)]),
  );
  let active = 0;
  let maxActive = 0;
  const snapshot = await gatherContextSnapshot(
    folder,
    files,
    [...rootScope],
    "draft.md",
    new Set(),
    {
      concurrency: 2,
      fetchChain: async (_folderId, path) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, path === "a.md" ? 4 : 1));
        active -= 1;
        return [event(path)];
      },
      fetchFolderNodes: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return [folderGenesis];
      },
    },
  );
  assert.equal(maxActive <= 2, true);
  assert.equal(
    snapshot.completeness.complete,
    true,
    JSON.stringify(snapshot.completeness.failures),
  );
  assert.deepEqual(snapshot.inputs.map((entry) => entry.path), ["a.md", "b.md", "c.md", "draft.md"]);
});

test("context resolves an exact stable file chain instead of the current coordinate", async () => {
  const oldStep = { ...event("old.md"), id: "old-step" };
  oldStep.content = JSON.stringify({ steppedAt: 500, snapshot: "body:old.md", deltas: [] });
  const currentStep = { ...event("new.md"), id: "head:new.md" };
  currentStep.tags = [...currentStep.tags, ["e", oldStep.id, "", "prev"]];
  let exactLoads = 0;
  const snapshot = await gatherContextSnapshot(
    folder,
    { "new.md": steppedFile("new.md") },
    [...rootScope],
    "new.md",
    new Set(),
    {
      fetchChain: async () => {
        throw new Error("coordinate history must not be used");
      },
      resolveFileChainAtHead: async (headId) => {
        exactLoads += 1;
        assert.equal(headId, "head:new.md");
        return { traceId: oldStep.id, chain: [oldStep, currentStep] };
      },
      fetchFolderNodes: async () => [folderGenesis],
    },
  );

  assert.equal(exactLoads, 1);
  assert.deepEqual(
    snapshot.deltaLog.filter((entry) => entry.source === "file").map((entry) => entry.nodeId),
    [oldStep.id, currentStep.id],
  );
});

test("delta log preserves signed causal order when steppedAt rolls backward", async () => {
  const genesis = { ...event("draft.md"), id: "causal-genesis" };
  genesis.content = JSON.stringify({ steppedAt: 5_000, snapshot: "first", deltas: [] });
  const head = { ...event("draft.md"), id: "causal-head" };
  head.tags = [...head.tags, ["e", genesis.id, "", "prev"]];
  head.content = JSON.stringify({ steppedAt: 1_000, snapshot: "second", deltas: [] });
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": {
        ...file("second"),
        nodeId: head.id,
        traceId: genesis.id,
      },
    },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      resolveFileChainAtHead: async () => ({ traceId: genesis.id, chain: [genesis, head] }),
      fetchFolderNodes: async () => [folderGenesis],
    },
  );

  assert.deepEqual(
    snapshot.deltaLog.filter((entry) => entry.source === "file").map((entry) => entry.nodeId),
    [genesis.id, head.id],
  );
});

test("same-path replacement excludes folder history for the unrelated file identity", async () => {
  const current = await tracedEvent("draft.md");
  const currentPayload = JSON.parse(current.content) as { contentHash: string };
  const replacedNodeId = "f".repeat(64);
  const oldMember = {
    kind: "file" as const,
    relativePath: "draft.md",
    latestNodeId: replacedNodeId,
    contentHash: "e".repeat(64),
  };
  const withOld = await folderNode(
    [oldMember],
    folderGenesis,
    [{
      type: "add",
      kind: "file",
      relativePath: "draft.md",
      nodeId: replacedNodeId,
      timestamp: 1_500,
    }],
    "d".repeat(64),
  );
  const withoutOld = await folderNode(
    [],
    withOld,
    [{
      type: "remove",
      kind: "file",
      relativePath: "draft.md",
      nodeId: replacedNodeId,
      timestamp: 2_000,
    }],
    "e".repeat(64),
  );
  const withCurrent = await folderNode(
    [{
      ...oldMember,
      latestNodeId: current.id,
      contentHash: currentPayload.contentHash,
    }],
    withoutOld,
    [{
      type: "add",
      kind: "file",
      relativePath: "draft.md",
      nodeId: current.id,
      timestamp: 2_500,
    }],
    "9".repeat(64),
  );
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": {
        ...file("body:draft.md"),
        nodeId: current.id,
        traceId: current.id,
      },
    },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      rootFolderNodeId: withCurrent.id,
      resolveFileChainAtHead: async () => ({ traceId: current.id, chain: [current] }),
      fetchFolderNodes: async () => [folderGenesis, withOld, withoutOld, withCurrent],
    },
  );

  assert.equal(snapshot.completeness.complete, true, JSON.stringify(snapshot.completeness.failures));
  assert.deepEqual(
    snapshot.deltaLog.filter((entry) => entry.source === "folder").map((entry) => entry.action),
    ["add"],
  );
  assert.doesNotMatch(JSON.stringify(snapshot.deltaLog), new RegExp(replacedNodeId));
});

test("context discovers a moved file's removed historical parent folder", async () => {
  const fileSecret = Uint8Array.from([...new Uint8Array(31), 3]);
  const oldFolderSecret = Uint8Array.from([...new Uint8Array(31), 4]);
  const oldFolderGenesis = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "folder"], ["action", "import"], ["x", EMPTY_FOLDER_HASH]],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot: { members: [] },
      contentHash: EMPTY_FOLDER_HASH,
      operationId: "6".repeat(64),
      deltas: [],
      folderCheckpoint: { version: 1, cause: "genesis" },
    }),
  }, oldFolderSecret);
  const oldBody = "old draft";
  const newBody = "current draft";
  const hash = async (text: string) => Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  ).toString("hex");
  const oldFileHash = await hash(oldBody);
  const fileGenesis = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "draft.md"],
      ["f", oldFolderGenesis.id],
      ["action", "import"],
    ],
    content: JSON.stringify({
      steppedAt: 1_200,
      snapshot: oldBody,
      contentHash: oldFileHash,
      operationId: "7".repeat(64),
      deltas: [],
      kedits: [{
        op: "ins",
        from: 0,
        to: 0,
        text: oldBody,
        voice: getPublicKey(fileSecret),
        t: 1_200,
        tx: 0,
      }],
    }),
  }, fileSecret);
  const oldFolderHead = await folderNodeFor(
    oldFolderGenesis,
    oldFolderSecret,
    [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: fileGenesis.id,
      contentHash: oldFileHash,
    }],
    oldFolderGenesis,
    [{
      type: "add",
      kind: "file",
      relativePath: "draft.md",
      nodeId: fileGenesis.id,
      timestamp: 1_300,
    }],
    "8".repeat(64),
  );
  const oldFolderHash = (JSON.parse(oldFolderHead.content) as { contentHash: string }).contentHash;
  const rootWithOld = await folderNode(
    [{
      kind: "folder",
      relativePath: "archive",
      latestNodeId: oldFolderHead.id,
      contentHash: oldFolderHash,
    }],
    folderGenesis,
    [{
      type: "add",
      kind: "folder",
      relativePath: "archive",
      nodeId: oldFolderHead.id,
      timestamp: 1_400,
    }],
    "9".repeat(64),
  );
  const rootWithoutOld = await folderNode(
    [],
    rootWithOld,
    [{
      type: "remove",
      kind: "folder",
      relativePath: "archive",
      nodeId: oldFolderHead.id,
      timestamp: 2_000,
    }],
    "a".repeat(64),
  );
  const newFileHash = await hash(newBody);
  const fileHead = finalizeEvent({
    kind: 4290,
    created_at: 3,
    tags: [
      ["z", "file"],
      ["F", "draft.md"],
      ["f", folder.id],
      ["action", "edit"],
      ["e", fileGenesis.id, "", "prev"],
    ],
    content: JSON.stringify({
      steppedAt: 3_000,
      snapshot: newBody,
      contentHash: newFileHash,
      operationId: "b".repeat(64),
      deltas: [{
        type: "replace",
        position: { start: 0, end: oldBody.length },
        newValue: newBody,
        timestamp: 3_000,
      }],
      kedits: [{
        op: "repl",
        from: 0,
        to: oldBody.length,
        text: newBody,
        voice: fileGenesis.pubkey,
        t: 3_000,
        tx: 0,
      }],
    }),
  }, fileSecret);
  const rootCurrent = await folderNode(
    [{
      kind: "file",
      relativePath: "draft.md",
      latestNodeId: fileHead.id,
      contentHash: newFileHash,
    }],
    rootWithoutOld,
    [{
      type: "add",
      kind: "file",
      relativePath: "draft.md",
      nodeId: fileHead.id,
      timestamp: 3_100,
    }],
    "c".repeat(64),
  );
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": {
        ...file(newBody),
        nodeId: fileHead.id,
        traceId: fileGenesis.id,
      },
    },
    [{ kind: "file", path: "draft.md" }],
    "draft.md",
    new Set(),
    {
      rootFolderNodeId: rootCurrent.id,
      fetchChain: async () => {
        throw new Error("the exact stable chain seam must win");
      },
      resolveFileChainAtHead: async () => ({
        traceId: fileGenesis.id,
        chain: [fileGenesis, fileHead],
      }),
      fetchEventById: async (headId) =>
        headId === oldFolderHead.id ? oldFolderHead : null,
      fetchFolderNodes: async (folderId) =>
        folderId === folder.id
          ? [folderGenesis, rootWithOld, rootWithoutOld, rootCurrent]
          : folderId === oldFolderGenesis.id
            ? [oldFolderGenesis, oldFolderHead]
            : [],
    },
  );

  assert.equal(snapshot.completeness.complete, true, JSON.stringify(snapshot.completeness.failures));
  assert.deepEqual(
    snapshot.deltaLog.filter((entry) => entry.source === "file").map((entry) => entry.relativePath),
    ["archive/draft.md", "draft.md"],
  );
  assert.deepEqual(
    snapshot.inputs[0].deltaLog.filter((entry) => entry.source === "file")
      .map((entry) => entry.nodeId),
    [fileGenesis.id, fileHead.id],
  );
  assert.ok(snapshot.deltaLog.some((entry) =>
    entry.source === "folder" &&
    entry.action === "add" &&
    entry.relativePath === "archive"
  ), JSON.stringify(snapshot.deltaLog));
  assert.ok(snapshot.deltaLog.some((entry) =>
    entry.source === "folder" &&
    entry.action === "add" &&
    entry.relativePath === "archive/draft.md"
  ), JSON.stringify(snapshot.deltaLog));
  assert.ok(snapshot.deltaLog.some((entry) =>
    entry.source === "folder" &&
    entry.action === "remove" &&
    entry.relativePath === "archive"
  ), JSON.stringify(snapshot.deltaLog));

  const shieldedSnapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": {
        ...file(newBody),
        nodeId: fileHead.id,
        traceId: fileGenesis.id,
      },
    },
    [{ kind: "file", path: "draft.md" }],
    "draft.md",
    new Set(["archive"]),
    {
      rootFolderNodeId: rootCurrent.id,
      resolveFileChainAtHead: async () => ({
        traceId: fileGenesis.id,
        chain: [fileGenesis, fileHead],
      }),
      fetchEventById: async (headId) =>
        headId === oldFolderHead.id ? oldFolderHead : null,
      fetchFolderNodes: async (folderId) =>
        folderId === folder.id
          ? [folderGenesis, rootWithOld, rootWithoutOld, rootCurrent]
          : folderId === oldFolderGenesis.id
            ? [oldFolderGenesis, oldFolderHead]
            : [],
    },
  );
  assert.doesNotMatch(JSON.stringify(shieldedSnapshot.deltaLog), /archive/);
  assert.deepEqual(
    shieldedSnapshot.inputs[0].deltaLog.filter((entry) => entry.source === "file")
      .map((entry) => entry.nodeId),
    [fileHead.id],
  );
});

test("context folder history stops at the persisted exact Root checkpoint", async () => {
  const draftMember = {
    kind: "file" as const,
    relativePath: "draft.md",
    latestNodeId: FOLDER_MEMBER_NODE_ID,
    contentHash: "c".repeat(64),
  };
  const pinned = await folderNode(
    [draftMember],
    folderGenesis,
    [{
      type: "add",
      kind: "file",
      relativePath: "draft.md",
      nodeId: FOLDER_MEMBER_NODE_ID,
      timestamp: 1_500,
    }],
    "4".repeat(64),
  );
  const laterMember = {
    kind: "file" as const,
    relativePath: "later.md",
    latestNodeId: "d".repeat(64),
    contentHash: "e".repeat(64),
  };
  const later = await folderNode(
    [draftMember, laterMember],
    pinned,
    [{
      type: "add",
      kind: "file",
      relativePath: "later.md",
      nodeId: laterMember.latestNodeId,
      timestamp: 2_500,
    }],
    "5".repeat(64),
  );
  const snapshot = await gatherContextSnapshot(
    folder,
    { "draft.md": file("draft") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      rootFolderNodeId: pinned.id,
      fetchChain: async () => [],
      fetchFolderNodes: async () => [folderGenesis, pinned, later],
    },
  );

  assert.equal(snapshot.completeness.complete, true, JSON.stringify(snapshot.completeness.failures));
  assert.match(snapshot.renderedBlock, /draft\.md/);
  assert.doesNotMatch(snapshot.renderedBlock, /later\.md/);
});

test("random fetch completion order does not change the snapshot fingerprint", async () => {
  const files = {
    "draft.md": steppedFile("draft.md"),
    "a.md": steppedFile("a.md"),
    "b.md": steppedFile("b.md"),
  };
  const gather = (reverse: boolean) => gatherContextSnapshot(
    folder,
    files,
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async (_folderId, path) => {
        const rank = path === "a.md" ? 1 : path === "b.md" ? 2 : 3;
        await new Promise((resolve) => setTimeout(resolve, reverse ? 4 - rank : rank));
        return [event(path)];
      },
      fetchFolderNodes: async () => [folderGenesis],
      maxBytes: 1_000_000,
    },
  );
  assert.equal((await gather(false)).fingerprint, (await gather(true)).fingerprint);
});

test("protocol-valid focus and rename folder deltas never create undefined context paths", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    { "draft.md": file("current draft") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async () => [],
      fetchFolderNodes: async () => folderRenameChain([
        {
          type: "focus",
          op: "mount",
          selection: { kind: "file", path: "draft.md" },
          panelIndex: 0,
          timestamp: 900,
        },
        {
          type: "rename",
          kind: "file",
          fromPath: "old.md",
          toPath: "draft.md",
          nodeId: FOLDER_MEMBER_NODE_ID,
          timestamp: 950,
        },
      ]),
    },
  );

  assert.equal(
    snapshot.completeness.complete,
    true,
    JSON.stringify(snapshot.completeness.failures),
  );
  assert.equal(snapshot.inputs[0].body, "current draft");
  assert.deepEqual(snapshot.inputs[0].deltaLog.map((entry) => ({
    action: entry.action,
    relativePath: entry.relativePath,
    fromPath: entry.fromPath,
  })), [{ action: "rename", relativePath: "draft.md", fromPath: "old.md" }]);
  assert.match(snapshot.renderedBlock, /old\.md → draft\.md\s+\(renamed\)/);
});

test("renames crossing a shield boundary never disclose the hidden endpoint", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": file("visible draft"),
      "secret.md": file("hidden draft"),
    },
    [...rootScope],
    "draft.md",
    new Set(["secret.md"]),
    {
      fetchChain: async () => [],
      fetchFolderNodes: async () => folderRenameChain([{
        type: "rename",
        kind: "file",
        fromPath: "secret.md",
        toPath: "draft.md",
        nodeId: FOLDER_MEMBER_NODE_ID,
        timestamp: 950,
      }]),
    },
  );

  assert.equal(
    snapshot.completeness.complete,
    true,
    JSON.stringify(snapshot.completeness.failures),
  );
  assert.deepEqual(snapshot.deltaLog.map((entry) => ({
    action: entry.action,
    relativePath: entry.relativePath,
    fromPath: entry.fromPath,
  })), [{ action: "add", relativePath: "draft.md", fromPath: undefined }]);
  assert.doesNotMatch(snapshot.renderedBlock, /secret\.md/);
  assert.doesNotMatch(JSON.stringify(snapshot.deltaLog), /secret\.md/);
});

test("unverified folder events fail context preparation instead of becoming process evidence", async () => {
  const injected = event("foreign-folder-event");
  injected.tags = [["z", "folder"], ["f", folder.id]];
  injected.content = JSON.stringify({
    steppedAt: 2_000,
    deltas: [{ type: "add", kind: "file", relativePath: "draft.md" }],
    folderCheckpoint: { version: 1, cause: "structure-change" },
  });
  const snapshot = await gatherContextSnapshot(
    folder,
    { "draft.md": file("draft") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async () => [],
      fetchFolderNodes: async () => [injected],
    },
  );

  assert.equal(snapshot.completeness.complete, false);
  assert.match(snapshot.completeness.failures[0]?.message ?? "", /verified folder chain/);
  assert.doesNotMatch(snapshot.renderedBlock, /joined directory/);
});

test("an unavailable folder trace makes context incomplete", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    { "draft.md": steppedFile("draft.md") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async () => [event("draft.md")],
      fetchFolderNodes: async () => [],
    },
  );

  assert.equal(snapshot.completeness.complete, false);
  assert.match(snapshot.completeness.failures[0]?.message ?? "", /folder trace is unavailable/);
});

test("validated editor transactions enter the snapshot and every AI context as mechanical observations", async () => {
  const signed = await tracedEvent("draft.md");
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": {
        ...steppedFile("draft.md"),
        nodeId: signed.id,
        traceId: signed.id,
      },
    },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async () => [signed],
      fetchFolderNodes: async () => [folderGenesis],
    },
  );
  const entry = snapshot.inputs[0].deltaLog[0];
  assert.equal(entry.nodeId, signed.id);
  assert.equal(entry.process?.status, "complete");
  assert.equal(entry.conformance, "full");
  assert.equal(entry.process?.transactions[0].changes[0].inserted, "body:draft.md");
  assert.match(snapshot.renderedBlock, /\[FULL TRACE\]/);
  assert.match(snapshot.renderedBlock, /trace 1 tx \/ 1 ranges · \+13\/−0/);
});

test("invalid signed delta summaries are excluded from AI context evidence", async () => {
  const path = "draft.md";
  const genesis = await tracedEvent(path);
  const finalText = "final body";
  const contentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(finalText)),
  ).toString("hex");
  const head = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [
      ["z", "file"],
      ["F", path],
      ["f", folder.id],
      ["action", "edit"],
      ["e", genesis.id, "", "prev"],
    ],
    content: JSON.stringify({
      steppedAt: 2_000,
      snapshot: finalText,
      contentHash,
      operationId: TEST_OPERATION_ID,
      deltas: [{
        type: "replace",
        position: { start: 0, end: `body:${path}`.length },
        newValue: "forged summary",
        timestamp: 2_000,
      }],
      kedits: [{
        op: "repl",
        from: 0,
        to: `body:${path}`.length,
        text: finalText,
        voice: genesis.pubkey,
        t: 2_000,
        tx: 0,
      } satisfies KEdit],
    }),
  }, Uint8Array.from([...new Uint8Array(31), 1]));

  const snapshot = await gatherContextSnapshot(
    folder,
    {
      [path]: {
        ...steppedFile(path),
        runs: [{ voice: "author", text: finalText }],
        nodeId: head.id,
        traceId: genesis.id,
      },
    },
    [...rootScope],
    path,
    new Set(),
    {
      fetchChain: async () => [genesis, head],
      fetchFolderNodes: async () => [folderGenesis],
    },
  );
  const invalid = snapshot.inputs[0].deltaLog.find((entry) => entry.nodeId === head.id);
  assert.equal(invalid?.conformance, "invalid");
  assert.equal(invalid?.deltas, undefined);
  assert.equal(invalid?.process, undefined);
  assert.doesNotMatch(snapshot.renderedBlock, /forged summary/);
  assert.match(snapshot.renderedBlock, /\[INVALID\]/);
});

test("descendants of an invalid ancestor cannot contribute AI process evidence", async () => {
  const path = "draft.md";
  const signedGenesis = await tracedEvent(path);
  const invalidGenesis = { ...signedGenesis, sig: "0".repeat(128) };
  const finalText = "valid-looking child";
  const contentHash = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(finalText)),
  ).toString("hex");
  const head = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [
      ["z", "file"],
      ["F", path],
      ["f", folder.id],
      ["action", "edit"],
      ["e", signedGenesis.id, "", "prev"],
    ],
    content: JSON.stringify({
      steppedAt: 2_000,
      snapshot: finalText,
      contentHash,
      operationId: TEST_OPERATION_ID,
      deltas: [{
        type: "replace",
        position: { start: 0, end: `body:${path}`.length },
        newValue: finalText,
        timestamp: 2_000,
      }],
      kedits: [{
        op: "repl",
        from: 0,
        to: `body:${path}`.length,
        text: finalText,
        voice: signedGenesis.pubkey,
        t: 2_000,
        tx: 0,
      } satisfies KEdit],
    }),
  }, Uint8Array.from([...new Uint8Array(31), 1]));

  const snapshot = await gatherContextSnapshot(
    folder,
    {
      [path]: {
        ...steppedFile(path),
        runs: [{ voice: "author", text: finalText }],
        nodeId: head.id,
        traceId: signedGenesis.id,
      },
    },
    [...rootScope],
    path,
    new Set(),
    {
      fetchChain: async () => [invalidGenesis, head],
      fetchFolderNodes: async () => [folderGenesis],
    },
  );
  const child = snapshot.inputs[0].deltaLog.find((entry) => entry.nodeId === head.id);
  assert.equal(child?.conformance, "invalid");
  assert.equal(child?.deltas, undefined);
  assert.equal(child?.process, undefined);
});

test("missing chains name the incomplete path instead of yielding partial context", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    { "draft.md": steppedFile("draft.md"), "missing.md": steppedFile("missing.md") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      fetchChain: async (_folderId, path) => {
        if (path === "missing.md") throw new Error("relay unavailable");
        return [event(path)];
      },
      fetchFolderNodes: async () => [folderGenesis],
    },
  );
  assert.equal(snapshot.completeness.complete, false);
  assert.deepEqual(snapshot.completeness.failures.map((failure) => failure.path), ["missing.md"]);
  assert.match(snapshot.completeness.failures[0].message, /relay unavailable/);
});

test("an aborted gather rejects and cannot become a partial snapshot", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const pending = gatherContextSnapshot(
    folder,
    { "draft.md": steppedFile("draft.md") },
    [...rootScope],
    "draft.md",
    new Set(),
    {
      signal: controller.signal,
      fetchChain: async () => {
        await blocked;
        return [event("draft.md")];
      },
      fetchFolderNodes: async () => [folderGenesis],
    },
  );
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});
