import assert from "node:assert/strict";
import test from "node:test";

import { planManifestUpsert, type ManifestFileEntry } from "./provenance.js";

const original: ManifestFileEntry = {
  kind: "file",
  relativePath: "essay.md",
  latestNodeId: "aa".repeat(32),
  contentHash: "bb".repeat(32),
};

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
