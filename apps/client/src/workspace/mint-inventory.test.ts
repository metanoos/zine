import assert from "node:assert/strict";
import test from "node:test";

import type { FileState } from "./workspace-core.js";
import { listMintCoins, renderMintCoinReferences } from "./mint-inventory.js";

function file(nodeId: string, ...text: string[]): FileState {
  return {
    nodeId,
    tags: [],
    runs: text.map((part, index) => ({ voice: `voice-${index}`, text: part })),
  };
}

test("listMintCoins derives the citable collection only from Mint files", () => {
  const files: Record<string, FileState> = {
    "draft.md": file("root-node", "ordinary"),
    "scan/source.md": file("scan-node", "scanned"),
    "mint/2026-07-17_120000-new.md": file("new-node", "new ", "coin"),
    "mint/2026-07-16_120000-old.md": file("old-node", "old coin"),
    "mint/unstepped.md": file("", "not citable"),
    "mint/empty.md": file("empty-node", ""),
    "mint/folder": { kind: "folder", nodeId: "folder-node", tags: [], runs: [] },
  };

  assert.deepEqual(listMintCoins(files), [
    {
      path: "mint/2026-07-17_120000-new.md",
      nodeId: "new-node",
      text: "new coin",
    },
    {
      path: "mint/2026-07-16_120000-old.md",
      nodeId: "old-node",
      text: "old coin",
    },
  ]);
});

test("renderMintCoinReferences keeps the Reply prompt bounded", () => {
  const rendered = renderMintCoinReferences([
    { path: "mint/a.md", nodeId: "a", text: "alpha" },
    { path: "mint/b.md", nodeId: "b", text: "beta" },
  ], 1);

  assert.equal(rendered, '- "alpha" (nodeId a)');
});
