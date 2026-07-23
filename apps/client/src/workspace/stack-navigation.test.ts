import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { stackFolderPath } from "./stack-navigation.js";
import type { FileState } from "./workspace-core.js";

const app = readFileSync(new URL("../app/App.tsx", import.meta.url), "utf8");

const folder = (nodeId: string, traceId?: string): FileState => ({
  kind: "folder",
  runs: [],
  nodeId,
  traceId,
  tags: [],
});

test("Stack folder identities resolve to Root and nested zine paths", () => {
  const files = {
    essays: folder("essays-head", "essays-genesis"),
    legacy: folder("legacy-genesis"),
    "draft.md": { runs: [], nodeId: "file-genesis", tags: [] },
  } satisfies Record<string, FileState>;

  assert.equal(stackFolderPath("root-genesis", "root-genesis", files), "");
  assert.equal(stackFolderPath("essays-genesis", "root-genesis", files), "essays");
  assert.equal(stackFolderPath("legacy-genesis", "root-genesis", files), "legacy");
  assert.equal(stackFolderPath("file-genesis", "root-genesis", files), null);
  assert.equal(stackFolderPath("foreign-folder", "root-genesis", files), null);
});

test("Stacks and Spaces route folder cards through the Press navigation handler", () => {
  assert.match(
    app,
    /function openFromStacks\(folderId: string\)[\s\S]*?stackFolderPath\(folderId, folder\?\.id \?\? null, files\)[\s\S]*?selectView\("editor"\)[\s\S]*?openFolder\(path\)/,
  );
  assert.match(app, /<ListingsView[\s\S]*?onOpenFolder=\{openFromStacks\}/);
  assert.match(
    app,
    /addEventListener\("zine:open-folder", onOpen\)[\s\S]*?removeEventListener\("zine:open-folder", onOpen\)/,
  );
  assert.match(
    app,
    /activeView === "globe"[\s\S]*?stackOpenError[\s\S]*?<GlobeView/,
    "Spaces must surface a failed folder-id lookup instead of ignoring the click",
  );
});
