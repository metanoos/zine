import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { shouldPreserveEmptyParentAfterDelete } from "./useWorkspaceMutations.js";
import { loadLocalFolder, saveLocalFile } from "./local-store.js";
import { createLocalWorkspace } from "./workspace-local.js";

const stored = new Map<string, string>();
// @ts-expect-error minimal browser storage for the local-only backend check
globalThis.localStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
};

const mutationSource = readFileSync(
  new URL("./useWorkspaceMutations.ts", import.meta.url),
  "utf8",
);
const workspaceCoreSource = readFileSync(
  new URL("./workspace-core.ts", import.meta.url),
  "utf8",
);
const workspaceLocalSource = readFileSync(
  new URL("./workspace-local.ts", import.meta.url),
  "utf8",
);
const sidebarSource = readFileSync(
  new URL("./WorkspaceSidebar.tsx", import.meta.url),
  "utf8",
);

test("permanent deletion never retains generated Oblivion containers", () => {
  assert.equal(shouldPreserveEmptyParentAfterDelete("notes"), true);
  assert.equal(shouldPreserveEmptyParentAfterDelete("oblivion"), false);
  assert.equal(
    shouldPreserveEmptyParentAfterDelete("oblivion/2026-07-22_120000"),
    false,
  );
  assert.equal(
    shouldPreserveEmptyParentAfterDelete("oblivion/2026-07-22_120000-2"),
    false,
  );
  assert.equal(
    shouldPreserveEmptyParentAfterDelete("oblivion/2026-07-22_120000/notes"),
    true,
  );
});

test("hard deletion from Oblivion removes only the local retained copy", () => {
  assert.match(workspaceCoreSource, /deleteLocalPath\(relativePath: string, isFolder: boolean\)/);
  assert.match(workspaceLocalSource, /async deleteLocalPath\(relativePath: string, isFolder: boolean\)/);

  const hardDelete = mutationSource.slice(
    mutationSource.indexOf("function hardDelete("),
    mutationSource.indexOf("function renameNode("),
  );
  assert.match(hardDelete, /backendRef\.current\.deleteLocalPath\(path, isFolderDelete\)/);
  assert.doesNotMatch(hardDelete, /backendRef\.current\.deletePath\(/);
});

test("the local-only backend removes a retained folder recursively", async () => {
  stored.clear();
  saveLocalFile("root", "kept.md", { content: "keep", tags: [], nodeId: "kept" });
  saveLocalFile("root", "oblivion/2026-07-22_120000/notes", {
    kind: "folder",
    content: "",
    tags: [],
    nodeId: "notes-folder",
  });
  saveLocalFile("root", "oblivion/2026-07-22_120000/notes/draft.md", {
    content: "discard",
    tags: [],
    nodeId: "draft",
  });

  const workspace = createLocalWorkspace();
  await workspace.attach({ id: "root", label: "root" });
  await assert.rejects(
    workspace.deleteLocalPath("kept.md", false),
    /local-only deletion is reserved for Oblivion/,
  );
  await workspace.deleteLocalPath("oblivion/2026-07-22_120000/notes", true);

  assert.deepEqual(Object.keys(loadLocalFolder("root")?.files ?? {}), ["kept.md"]);
});

test("Oblivion deletion shares the Root mutation lane and commits one bulk removal", () => {
  const localDelete = workspaceLocalSource.slice(
    workspaceLocalSource.indexOf("async deleteLocalPath("),
    workspaceLocalSource.indexOf("async movePath("),
  );
  assert.match(localDelete, /runWorkspaceRootMutation\(id, operationId/);
  assert.match(localDelete, /pushTimerKey\(id, path\)/);
  assert.equal((localDelete.match(/deleteLocalFilesDurably\(/g) ?? []).length, 1);
  assert.doesNotMatch(localDelete, /deleteLocalFileDurably\(/);
});

test("Oblivion delete offers relay revocation as an explicit opt-in", () => {
  assert.match(sidebarSource, /Also request relay revocation/);
  assert.match(sidebarSource, /checked=\{deleteWithRevocation\}/);
  assert.match(sidebarSource, /await Promise\.all\(deleteRevocationTargets\.map\(onRevoke\)\)/);
  assert.match(sidebarSource, /onDelete\(confirmedPaths\)/);
});
