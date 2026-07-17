import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";

import { coinOriginFromEvent, isCoinEvent } from "./provenance.js";

const ROOT = "f".repeat(64);
const HASH = "a".repeat(64);
const SOURCE = "b".repeat(64);

function event(content: unknown, extraTags: string[][] = []): Event {
  return {
    id: "node",
    pubkey: "author",
    created_at: 1,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["F", "coin.md"],
      ["f", ROOT],
      ["x", HASH],
      ["action", "import"],
      ...extraTags,
    ],
    content: JSON.stringify(content),
    sig: "signature",
  };
}

test("direct Coin envelopes are Coins without an extracted-from edge", () => {
  const direct = event({
    snapshot: "made here",
    contentHash: HASH,
    coin: { version: 1, origin: { kind: "direct" } },
  });

  assert.deepEqual(coinOriginFromEvent(direct), { kind: "direct" });
  assert.equal(isCoinEvent(direct), true);
});

test("extracted Coin envelopes retain the exact source receipt", () => {
  const extracted = event(
    {
      snapshot: "source words",
      contentHash: HASH,
      coin: {
        version: 1,
        origin: {
          kind: "extracted",
          sourceNodeId: SOURCE,
          sourceContentHash: HASH,
          range: { start: 8, end: 20 },
        },
      },
    },
    [["e", SOURCE, "", "extracted-from"]],
  );

  assert.deepEqual(coinOriginFromEvent(extracted), {
    kind: "extracted",
    sourceNodeId: SOURCE,
    sourceContentHash: HASH,
    range: { start: 8, end: 20 },
  });
});

test("extracted-from tags without a Coin envelope remain ordinary files", () => {
  const ordinary = event(
    { snapshot: "ordinary file", contentHash: HASH },
    [["e", SOURCE, "", "extracted-from"]],
  );

  assert.equal(coinOriginFromEvent(ordinary), null);
  assert.equal(isCoinEvent(ordinary), false);
});

test("ordinary file genesis is not mistaken for a direct Coin", () => {
  const file = event({ snapshot: "ordinary file", contentHash: HASH });
  assert.equal(coinOriginFromEvent(file), null);
  assert.equal(isCoinEvent(file), false);
});

test("Coin envelopes remain ordinary files when their wire invariants are malformed", () => {
  const directContent = {
    snapshot: "made here",
    contentHash: HASH,
    coin: { version: 1, origin: { kind: "direct" } },
  };
  const withoutHashTag = event(directContent);
  withoutHashTag.tags = withoutHashTag.tags.filter((tag) => tag[0] !== "x");
  const withPrev = event(directContent, [["e", "c".repeat(64), "", "prev"]]);
  const directWithSource = event(directContent, [["e", SOURCE, "", "extracted-from"]]);
  const extractedWithWrongSource = event({
    snapshot: "source words",
    contentHash: HASH,
    coin: {
      version: 1,
      origin: {
        kind: "extracted",
        sourceNodeId: SOURCE,
        sourceContentHash: HASH,
        range: { start: 0, end: 12 },
      },
    },
  }, [["e", "c".repeat(64), "", "extracted-from"]]);

  for (const malformed of [withoutHashTag, withPrev, directWithSource, extractedWithWrongSource]) {
    assert.equal(coinOriginFromEvent(malformed), null);
    assert.equal(isCoinEvent(malformed), false);
  }
});
