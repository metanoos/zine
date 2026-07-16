/**
 * Vet chain-walker — unit tests.
 *
 * Tests checkpointsFromChain: extraction of CheckpointMeta from fake events.
 * Pure — hand-built events, no relay. Mirrors the provenance.inbound.test.ts
 * pattern (fileEvent helper building kind-4290 wire shapes).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkpointsFromChain } from "./vet-walker.js";
import type { Event } from "nostr-tools";

/** Build a kind-4290 file-node event with given content + tags. */
function nodeEvent(
  id: string,
  createdAtSec: number,
  content: object,
  tags: string[][] = [],
): Event {
  return {
    id,
    pubkey: "pk",
    created_at: createdAtSec,
    kind: 4290,
    tags: [["z", "file"], ...tags],
    content: JSON.stringify(content),
    sig: "",
  };
}

/** A body-edit delta (the shape publishEdit emits). */
function delta(
  type: "insert" | "delete" | "replace",
  start: number,
  end: number,
  newValue: string,
): object {
  return { type, position: { start, end }, newValue, timestamp: 1 };
}

// --- Basic extraction --------------------------------------------------

test("checkpointsFromChain: empty chain → empty", () => {
  assert.deepEqual(checkpointsFromChain([]), []);
});

test("checkpointsFromChain: extracts steppedAtMs from content.steppedAt", () => {
  const ev = nodeEvent("e1", 1000, { steppedAt: 5_000_000 });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.steppedAtMs, 5_000_000);
});

test("checkpointsFromChain: falls back to created_at when steppedAt absent", () => {
  const ev = nodeEvent("e1", 7000, {});
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.steppedAtMs, 7_000_000); // 7000 sec * 1000
});

test("checkpointsFromChain: sorts oldest-first", () => {
  const evs = [
    nodeEvent("e3", 9000, { steppedAt: 9_000_000 }),
    nodeEvent("e1", 1000, { steppedAt: 1_000_000 }),
    nodeEvent("e2", 5000, { steppedAt: 5_000_000 }),
  ];
  const cps = checkpointsFromChain(evs);
  assert.deepEqual(cps.map((c) => c.steppedAtMs), [1_000_000, 5_000_000, 9_000_000]);
});

// --- Anchor presence ---------------------------------------------------

test("checkpointsFromChain: anchored=true when event id is in anchoredIds", () => {
  const ev = nodeEvent("anchored-id", 1000, {});
  const [cp] = checkpointsFromChain([ev], new Set(["anchored-id"]));
  assert.equal(cp?.anchored, true);
});

test("checkpointsFromChain: anchored=undefined when id not in set", () => {
  const ev = nodeEvent("plain-id", 1000, {});
  const [cp] = checkpointsFromChain([ev], new Set(["other-id"]));
  assert.equal(cp?.anchored, undefined);
});

test("checkpointsFromChain: empty anchoredIds → all undefined", () => {
  const evs = [nodeEvent("a", 1, {}), nodeEvent("b", 2, {})];
  const cps = checkpointsFromChain(evs);
  assert.equal(cps[0]?.anchored, undefined);
  assert.equal(cps[1]?.anchored, undefined);
});

// --- Char delta + delta count -----------------------------------------

test("checkpointsFromChain: insert delta → positive charDelta", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [delta("insert", 0, 0, "hello world")],
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, 11); // +11 inserted, 0 region replaced
  assert.equal(cp?.deltaCount, 1);
});

test("checkpointsFromChain: delete delta → negative charDelta", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [delta("delete", 0, 10, "")], // delete 10 chars, insert nothing
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, -10);
});

test("checkpointsFromChain: replace delta → net delta", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [delta("replace", 0, 10, "hi")], // replace 10 chars with 2
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, -8); // +2 inserted, -10 region = net -8
});

test("checkpointsFromChain: multiple deltas → summed charDelta + count", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [
      delta("insert", 0, 0, "abc"), // +3
      delta("delete", 10, 15, ""), // -5
      delta("insert", 20, 20, "xy"), // +2
    ],
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, 0); // +3 -5 +2 = 0
  assert.equal(cp?.deltaCount, 3);
});

test("checkpointsFromChain: non-body-edit deltas (cite/focus) are NOT counted", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [
      delta("insert", 0, 0, "text"), // +4 — body edit
      { type: "cite", role: "tag", op: "add", sourceEventId: "x", timestamp: 1 }, // not a body edit
      { type: "focus", op: "mount", selection: {}, panelIndex: 0, timestamp: 1 }, // not a body edit
    ],
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, 4);
  assert.equal(cp?.deltaCount, 1); // only the insert
});

// --- Edge cases --------------------------------------------------------

test("checkpointsFromChain: malformed JSON content → no crash, zero deltas", () => {
  const ev = nodeEvent("e1", 1, {});
  ev.content = "not valid json {{{";
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, 0);
  assert.equal(cp?.deltaCount, 0);
});

test("checkpointsFromChain: no deltas field → charDelta 0, count 0", () => {
  const ev = nodeEvent("e1", 1, { snapshot: "just text" });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, 0);
  assert.equal(cp?.deltaCount, 0);
});

test("checkpointsFromChain: null newValue treated as zero-length insert", () => {
  const ev = nodeEvent("e1", 1, {
    deltas: [{ type: "delete", position: { start: 0, end: 5 }, newValue: null, timestamp: 1 }],
  });
  const [cp] = checkpointsFromChain([ev]);
  assert.equal(cp?.charDelta, -5); // 0 inserted - 5 region
});
