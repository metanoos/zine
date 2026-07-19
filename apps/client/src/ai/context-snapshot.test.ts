import assert from "node:assert/strict";
import test from "node:test";

import { createContextSnapshot } from "./context-snapshot.js";

const target = {
  kind: "file" as const,
  folderId: "folder",
  path: "draft.md",
  traceId: "trace-draft",
  headId: "head-draft",
  body: "draft",
};

function makeSnapshot(order: string[]) {
  return createContextSnapshot({
    target,
    mount: { kind: "folder", path: "" },
    shields: [{ path: "private", decision: "shielded", boundary: "private" }],
    inputs: order.map((path) => ({
      path,
      traceId: `trace-${path}`,
      headId: `head-${path}`,
      body: path,
      citations: path === "b.md" ? ["z", "a", "z"] : [],
      deltaLog: [],
      unstepped: false,
    })),
    renderedBlock: "context",
    createdAt: 1,
  });
}

test("canonical ordering makes randomized gather completion fingerprint-identical", () => {
  const first = makeSnapshot(["b.md", "a.md"]);
  const second = makeSnapshot(["a.md", "b.md"]);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.inputs.map((entry) => entry.path), ["a.md", "b.md"]);
  assert.deepEqual(first.inputs[1].citations, ["a", "z"]);
});

test("canonicalization preserves causal sequence across a backward wall clock", () => {
  const laterClock = {
    seq: 1,
    steppedAt: 5_000,
    action: "edit",
    relativePath: "draft.md",
    source: "file" as const,
    prompt: null,
    summary: null,
    deltas: undefined,
    process: undefined,
    conformance: undefined,
    conformanceReason: undefined,
    nodeId: "genesis",
  };
  const earlierClock = { ...laterClock, seq: 2, steppedAt: 1_000, nodeId: "head" };
  const snapshot = createContextSnapshot({
    target,
    mount: null,
    shields: [],
    inputs: [{
      path: "draft.md",
      traceId: "genesis",
      headId: "head",
      body: "draft",
      citations: [],
      deltaLog: [earlierClock, laterClock],
      unstepped: false,
    }],
    deltaLog: [earlierClock, laterClock],
    renderedBlock: "context",
  });

  assert.deepEqual(snapshot.deltaLog.map((entry) => entry.nodeId), ["genesis", "head"]);
  assert.deepEqual(snapshot.inputs[0].deltaLog.map((entry) => entry.nodeId), ["genesis", "head"]);
});

test("snapshots are deeply immutable and account for UTF-8 bytes", () => {
  const snapshot = createContextSnapshot({
    target: { ...target, body: "你好" },
    mount: null,
    shields: [],
    inputs: [{
      path: "draft.md", traceId: null, headId: null, body: "你好",
      citations: [], deltaLog: [], unstepped: true,
    }],
    renderedBlock: "你好",
  });
  assert.equal(snapshot.budget.totalBytes, 6);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.inputs), true);
  assert.equal(Object.isFrozen(snapshot.inputs[0].citations), true);
});

test("completeness and total budget are explicit fail-closed state", () => {
  const snapshot = createContextSnapshot({
    target,
    mount: null,
    shields: [],
    inputs: [],
    renderedBlock: "12345",
    maxBytes: 4,
    failures: [{ stage: "chain", path: "source.md", message: "head unavailable" }],
  });
  assert.equal(snapshot.completeness.complete, false);
  assert.equal(snapshot.budget.overBudget, true);
});
