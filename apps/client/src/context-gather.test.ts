import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { gatherContextSnapshot, promptContextFiles } from "./context-gather.js";
import type { FileState, FolderRef } from "./workspace-core.js";

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

const folder: FolderRef = { id: "folder-1", label: "Root" };
const rootScope = [{ kind: "folder" as const, path: "" }] as const;

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
