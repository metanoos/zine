import assert from "node:assert/strict";
import test from "node:test";

import { createContextSnapshot } from "./context-snapshot.js";
import {
  SnapshotCoordinator,
  type SnapshotDependencies,
} from "./snapshot-coordinator.js";

const base: SnapshotDependencies = {
  focus: "file:draft.md@0",
  targetRevision: "head:hash",
  mounts: ["folder:"],
  shields: [],
  providerFingerprint: "provider",
  modelVoicePromptHash: "voice",
  lensId: "default",
  operation: "extend",
  operationInputsHash: "inputs",
  promptLayerVersions: ["preamble:1", "extend:1"],
};

function snapshot(complete = true) {
  return createContextSnapshot({
    target: {
      kind: "file", folderId: "f", path: "draft.md", traceId: "t",
      headId: "h", body: "draft",
    },
    mounts: [],
    shields: [],
    inputs: [],
    renderedBlock: "ctx",
    failures: complete ? [] : [{ stage: "chain", path: "x", message: "missing" }],
  });
}

test("identical consumers coalesce in-flight work and reuse the complete snapshot", async () => {
  const coordinator = new SnapshotCoordinator();
  let gathers = 0;
  const gather = async () => {
    gathers += 1;
    await Promise.resolve();
    return snapshot();
  };
  const first = coordinator.request(base, gather);
  const second = coordinator.request({ ...base, shields: [] }, gather);
  assert.equal(first, second);
  assert.equal(await first, await second);
  assert.equal(await coordinator.request(base, gather), await first);
  assert.equal(gathers, 1);
});

test("a dependency change aborts superseded gather work", async () => {
  const coordinator = new SnapshotCoordinator();
  const firstSignal: { current: AbortSignal | null } = { current: null };
  const first = coordinator.request(base, async (signal) => {
    firstSignal.current = signal;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return snapshot();
  });
  const second = coordinator.request({ ...base, focus: "file:other.md@0" }, async () => snapshot());
  await second;
  await assert.rejects(first, { name: "AbortError" });
  assert.equal(firstSignal.current?.aborted, true);
});

test("incomplete snapshots are returned for diagnosis but never cached", async () => {
  const coordinator = new SnapshotCoordinator();
  let gathers = 0;
  const gather = async () => {
    gathers += 1;
    return snapshot(false);
  };
  await coordinator.request(base, gather);
  await coordinator.request(base, gather);
  assert.equal(gathers, 2);
});
