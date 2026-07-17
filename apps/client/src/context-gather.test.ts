import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { gatherContextSnapshot } from "./context-gather.js";
import type { FileState, FolderRef } from "./workspace-core.js";

function steppedFile(path: string): FileState {
  return {
    runs: [{ voice: "author", text: `body:${path}` }],
    nodeId: `head:${path}`,
    traceId: `trace:${path}`,
    tags: [],
  };
}

function event(path: string): Event {
  return {
    id: `head:${path}`,
    pubkey: "a".repeat(64),
    created_at: 1,
    kind: 4290,
    tags: [["action", "edit"]],
    content: JSON.stringify({
      steppedAt: 1_000,
      snapshot: `body:${path}`,
      deltas: [],
    }),
    sig: "b".repeat(128),
  };
}

const folder: FolderRef = { id: "folder-1", label: "Root" };

test("multi-mount snapshots preserve the selected union and shield decisions", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": steppedFile("draft.md"),
      "notes/a.md": steppedFile("notes/a.md"),
      "private/b.md": steppedFile("private/b.md"),
      "other.md": steppedFile("other.md"),
    },
    [
      { kind: "file", path: "draft.md" },
      { kind: "folder", path: "notes" },
    ],
    "draft.md",
    new Set(["private"]),
    {
      fetchChain: async (_folderId, path) => [event(path)],
      fetchFolderNodes: async () => [],
    },
  );

  assert.deepEqual(snapshot.mounts, [
    { kind: "file", path: "draft.md" },
    { kind: "folder", path: "notes" },
  ]);
  assert.deepEqual(snapshot.inputs.map((input) => input.path), ["draft.md", "notes/a.md"]);
  assert.deepEqual(
    snapshot.shields.map(({ path, decision }) => [path, decision]),
    [
      ["draft.md", "included"],
      ["notes/a.md", "included"],
      ["other.md", "outside-mount"],
      ["private/b.md", "shielded"],
    ],
  );
});

test("bounded parallel fetches produce canonical fingerprints", async () => {
  const files = Object.fromEntries(
    ["draft.md", "b.md", "a.md", "c.md"].map((path) => [path, steppedFile(path)]),
  );
  const gather = (reverse: boolean) => gatherContextSnapshot(
    folder,
    files,
    [{ kind: "folder", path: "" }],
    "draft.md",
    new Set(),
    {
      concurrency: 2,
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

test("missing chains make the snapshot incomplete instead of sending partial context", async () => {
  const snapshot = await gatherContextSnapshot(
    folder,
    {
      "draft.md": steppedFile("draft.md"),
      "missing.md": steppedFile("missing.md"),
    },
    [{ kind: "folder", path: "" }],
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
    [{ kind: "folder", path: "" }],
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
