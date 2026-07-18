import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { eventMeta } from "./provenance.js";

test("eventMeta exposes operation grouping and folder checkpoint cause", () => {
  const operationId = "ab".repeat(32);
  const event: Event = {
    id: "node",
    pubkey: "owner",
    created_at: 7,
    kind: 4290,
    tags: [["z", "folder"]],
    content: JSON.stringify({
      steppedAt: 7_123,
      operationId,
      folderCheckpoint: {
        version: 1,
        cause: "child-advance",
        sourceNodeId: "cd".repeat(32),
      },
    }),
    sig: "",
  };

  assert.deepEqual(eventMeta(event), {
    userTags: [],
    action: undefined,
    relativePath: undefined,
    folderId: undefined,
    z: "folder",
    operationId,
    folderCheckpoint: {
      version: 1,
      cause: "child-advance",
      sourceNodeId: "cd".repeat(32),
    },
    citationCount: 0,
    citationTargets: [],
    steppedAtMs: 7_123,
    createdAtSec: 7,
  });
});
