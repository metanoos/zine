import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { coinOriginFromEvent, isCoinEvent } from "./provenance.js";

function event(content: unknown, tags: string[][] = []): Event {
  return {
    id: "node",
    pubkey: "author",
    created_at: 1,
    kind: 4290,
    tags,
    content: JSON.stringify(content),
    sig: "signature",
  };
}

test("direct Coin envelopes are Coins without an extracted-from edge", () => {
  const direct = event({
    snapshot: "made here",
    coin: { version: 1, origin: { kind: "direct" } },
  });

  assert.deepEqual(coinOriginFromEvent(direct), { kind: "direct" });
  assert.equal(isCoinEvent(direct), true);
});

test("extracted Coin envelopes retain the exact source receipt", () => {
  const hash = "a".repeat(64);
  const extracted = event(
    {
      snapshot: "source words",
      coin: {
        version: 1,
        origin: {
          kind: "extracted",
          sourceNodeId: "source-node",
          sourceContentHash: hash,
          range: { start: 8, end: 20 },
        },
      },
    },
    [["e", "source-node", "", "extracted-from"]],
  );

  assert.deepEqual(coinOriginFromEvent(extracted), {
    kind: "extracted",
    sourceNodeId: "source-node",
    sourceContentHash: hash,
    range: { start: 8, end: 20 },
  });
});

test("extracted-from tags without a Coin envelope remain ordinary files", () => {
  const ordinary = event(
    { snapshot: "ordinary file" },
    [["e", "source-node", "", "extracted-from"]],
  );

  assert.equal(coinOriginFromEvent(ordinary), null);
  assert.equal(isCoinEvent(ordinary), false);
});

test("ordinary file genesis is not mistaken for a direct Coin", () => {
  const file = event({ snapshot: "ordinary file" });
  assert.equal(coinOriginFromEvent(file), null);
  assert.equal(isCoinEvent(file), false);
});
