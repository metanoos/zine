import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";

import {
  directoryTraceCoordinate,
  folderCheckpointLogObservations,
  gatherContextSnapshot,
  promptContextFiles,
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

function folderEvent(deltas: unknown[]): Event {
  return {
    id: "folder-head",
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [["z", "folder"]],
    content: JSON.stringify({ steppedAt: 1_000, deltas }),
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
    tags: [["z", "file"], ["F", path], ["f", "folder-1"], ["action", "edit"]],
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

const folder: FolderRef = { id: "folder-1", label: "Root" };
const rootScope = [{ kind: "folder" as const, path: "" }] as const;
const TEST_OPERATION_ID = "1".repeat(64);

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
        return [];
      },
    },
  );
  assert.equal(maxActive <= 2, true);
  assert.equal(snapshot.completeness.complete, true);
  assert.deepEqual(snapshot.inputs.map((entry) => entry.path), ["a.md", "b.md", "c.md", "draft.md"]);
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
      fetchFolderNodes: async () => [],
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
      fetchFolderNodes: async () => [folderEvent([
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
          nodeId: "head:draft.md",
          timestamp: 950,
        },
      ])],
    },
  );

  assert.equal(snapshot.completeness.complete, true);
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
      "private/secret.md": file("hidden draft"),
    },
    [...rootScope],
    "draft.md",
    new Set(["private"]),
    {
      fetchChain: async () => [],
      fetchFolderNodes: async () => [folderEvent([{
        type: "rename",
        kind: "file",
        fromPath: "private/secret.md",
        toPath: "draft.md",
        nodeId: "head:draft.md",
        timestamp: 950,
      }])],
    },
  );

  assert.equal(snapshot.completeness.complete, true);
  assert.deepEqual(snapshot.deltaLog.map((entry) => ({
    action: entry.action,
    relativePath: entry.relativePath,
    fromPath: entry.fromPath,
  })), [{ action: "add", relativePath: "draft.md", fromPath: undefined }]);
  assert.doesNotMatch(snapshot.renderedBlock, /private\/secret\.md/);
  assert.doesNotMatch(JSON.stringify(snapshot.deltaLog), /private\/secret\.md/);
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
      fetchFolderNodes: async () => [],
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
      ["f", "folder-1"],
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
      fetchFolderNodes: async () => [],
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
      ["f", "folder-1"],
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
      fetchFolderNodes: async () => [],
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
      fetchFolderNodes: async () => [],
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
      fetchFolderNodes: async () => [],
    },
  );
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
});
