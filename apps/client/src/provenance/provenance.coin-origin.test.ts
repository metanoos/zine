import assert from "node:assert/strict";
import test from "node:test";
import type { Event } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  coinOriginFromEvent,
  isCoinEvent,
  sha256HexLocal,
  verifiedFileSourceSnapshot,
} from "./provenance.js";

const ROOT = "f".repeat(64);
const HASH = "a".repeat(64);
const SOURCE = "b".repeat(64);

test("extracted source authentication rejects invalid signatures and signed hash lies", async () => {
  const secret = generateSecretKey();
  const snapshot = "source words";
  const contentHash = await sha256HexLocal(snapshot);
  const valid = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"]],
    content: JSON.stringify({ snapshot, contentHash }),
  }, secret);
  assert.equal(await verifiedFileSourceSnapshot(valid, valid.id), snapshot);

  const invalidSignature = JSON.parse(JSON.stringify(valid)) as Event;
  invalidSignature.sig = "0".repeat(128);
  assert.equal(await verifiedFileSourceSnapshot(invalidSignature, valid.id), null);

  const wrongHash = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"]],
    content: JSON.stringify({ snapshot, contentHash: "0".repeat(64) }),
  }, secret);
  assert.equal(await verifiedFileSourceSnapshot(wrongHash, wrongHash.id), null);
  assert.equal(await verifiedFileSourceSnapshot(valid, SOURCE), null);
});

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

test("Coin origin envelopes reject impossible ranges and unknown fields", () => {
  const impossible = event({
    snapshot: "tiny",
    contentHash: HASH,
    coin: {
      version: 1,
      origin: {
        kind: "extracted",
        sourceNodeId: SOURCE,
        sourceContentHash: HASH,
        range: { start: 0, end: 1_000 },
      },
    },
  }, [["e", SOURCE, "", "extracted-from"]]);
  const extraOriginField = event({
    snapshot: "tiny",
    contentHash: HASH,
    coin: { version: 1, origin: { kind: "direct", discussion: true } },
  });
  const extraRangeField = event({
    snapshot: "tiny",
    contentHash: HASH,
    coin: {
      version: 1,
      origin: {
        kind: "extracted",
        sourceNodeId: SOURCE,
        sourceContentHash: HASH,
        range: { start: 7, end: 11, unit: "utf16" },
      },
    },
  }, [["e", SOURCE, "", "extracted-from"]]);

  for (const malformed of [impossible, extraOriginField, extraRangeField]) {
    assert.equal(coinOriginFromEvent(malformed), null);
    assert.equal(isCoinEvent(malformed), false);
  }
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
