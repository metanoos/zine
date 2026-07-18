import assert from "node:assert/strict";
import test from "node:test";

import { resolvePostWriteTraceId } from "./stepped-file-identity.js";

test("post-write identity prefers the backend-persisted fork over stale live state", async () => {
  let resolutions = 0;
  const traceId = await resolvePostWriteTraceId({
    nodeId: "owned-head",
    priorTraceId: "foreign-trace",
    readPersistedTraceId: () => "owned-fork",
    resolveTraceIdentity: async () => {
      resolutions++;
      return "resolved-trace";
    },
  });

  assert.equal(traceId, "owned-fork");
  assert.equal(resolutions, 0, "durable local identity avoids an unnecessary relay read");
});

test("post-write identity resolves the returned head before falling back to prior state", async () => {
  const traceId = await resolvePostWriteTraceId({
    nodeId: "new-head",
    priorTraceId: "old-trace",
    readPersistedTraceId: () => null,
    resolveTraceIdentity: async (nodeId) => nodeId === "new-head" ? "new-trace" : null,
  });

  assert.equal(traceId, "new-trace");
});

test("post-write identity retains prior state only when durable resolution is unavailable", async () => {
  const traceId = await resolvePostWriteTraceId({
    nodeId: "offline-head",
    priorTraceId: "known-trace",
    readPersistedTraceId: () => null,
    resolveTraceIdentity: async () => {
      throw new Error("relay offline");
    },
  });

  assert.equal(traceId, "known-trace");
});
