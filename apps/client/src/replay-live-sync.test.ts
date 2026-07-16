import assert from "node:assert/strict";
import test from "node:test";

import {
  appendReplayStepsAtLiveEnd,
  freshMountedReplayHeads,
  replayHeadSignature,
} from "./replay-live-sync.js";

test("fresh replay heads include mounted descendants and exclude other mounts", () => {
  const files = {
    "drafts/a.md": { nodeId: "new-a" },
    "drafts/private/secret.md": { nodeId: "new-secret" },
    "final.md": { nodeId: "new-final" },
    "known.md": { nodeId: "known" },
  };

  assert.deepEqual(
    freshMountedReplayHeads(
      files,
      new Set(["known"]),
      [{ kind: "folder", path: "drafts" }],
      new Set(["drafts/private"]),
    ),
    [{ path: "drafts/a.md", nodeId: "new-a" }],
  );
});

test("replay head signature changes for advance, removal, and rename", () => {
  const original = {
    "a.md": { nodeId: "a".repeat(64) },
    "b.md": { nodeId: "b".repeat(64) },
  };
  const baseline = replayHeadSignature(original);

  assert.notEqual(
    replayHeadSignature({ ...original, "a.md": { nodeId: "c".repeat(64) } }),
    baseline,
  );
  assert.notEqual(replayHeadSignature({ "a.md": original["a.md"] }), baseline);
  assert.notEqual(
    replayHeadSignature({ "renamed.md": original["a.md"], "b.md": original["b.md"] }),
    baseline,
  );
});

test("appending at live increments current and total together", () => {
  const live = {
    steps: [
      { id: "one", at: 1 },
      { id: "two", at: 2 },
    ],
    index: 1,
    snapshot: { preserved: true },
  };
  const next = appendReplayStepsAtLiveEnd(
    live,
    [{ id: "three", at: 3 }],
    (step) => step.id,
    (step) => step.at,
  );

  assert.equal(next.steps.length, 3);
  assert.equal(next.index, 2);
  assert.deepEqual(next.snapshot, { preserved: true });
});

test("an empty first timeline is represented by a changed head signature", () => {
  assert.notEqual(
    replayHeadSignature({ "first.md": { nodeId: "first-step" } }),
    replayHeadSignature({}),
  );
});

test("historical replay stays parked and duplicate live steps are ignored", () => {
  const steps = [
    { id: "one", at: 1 },
    { id: "two", at: 2 },
  ];
  const historical = { steps, index: 0 };
  const live = { steps, index: 1 };

  assert.equal(
    appendReplayStepsAtLiveEnd(historical, [{ id: "three", at: 3 }], (s) => s.id, (s) => s.at),
    historical,
  );
  assert.equal(
    appendReplayStepsAtLiveEnd(live, [{ id: "two", at: 2 }], (s) => s.id, (s) => s.at),
    live,
  );
});
