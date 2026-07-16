import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { inlineCitationDeltas, reconstructFromChain } from "./provenance.js";

test("inline coin citations carry range, quote, pinned node, and quote hash", () => {
  assert.deepEqual(
    inlineCitationDeltas([
      {
        sourceEventId: "coin-node",
        newValue: "copied passage",
        positionStart: 12,
        positionEnd: 26,
        sourceContentHash: "quote-hash",
      },
    ], 1234),
    [
      {
        type: "cite",
        role: "inline",
        op: "add",
        position: { start: 12, end: 26 },
        newValue: "copied passage",
        sourceEventId: "coin-node",
        sourceContentHash: "quote-hash",
        timestamp: 1234,
      },
    ],
  );
});

test("inline citation metadata is not replayed as a second body edit", () => {
  const markup = "[[ copied passage | coin-node ]]";
  const event = {
    content: JSON.stringify({
      deltas: [
        {
          type: "insert",
          position: { start: 0, end: 0 },
          newValue: markup,
        },
        {
          type: "cite",
          role: "inline",
          position: { start: 3, end: 17 },
          newValue: "copied passage",
          sourceEventId: "coin-node",
        },
      ],
    }),
  } as Event;

  assert.equal(reconstructFromChain([event]), markup);
});
