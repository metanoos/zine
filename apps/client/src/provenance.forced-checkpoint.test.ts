/**
 * Forced-checkpoint node shape (protocol §8: every explicit Step appends one
 * checkpoint carrying the snapshot).
 *
 * A deliberate Step appends a new node even when content is unchanged since
 * the last step. Such a node carries `deltas: []` (nothing changed) plus the
 * full `snapshot` (§R1: every node carries its full snapshot, so resolving any
 * version is one bounded fetch). These tests prove that shape round-trips
 * correctly through `reconstructFromChain` — the read side that any reader
 * (the press itself, a peer's relay, a future reader) uses to recover content.
 *
 * The dedup *decision* (skip the no-op branch when `force`) lives inline in
 * each `writeFile` implementation and is relay-dependent, so it isn't unit-
 * tested here — same convention as the inbound/merge tests. What IS testable
 * without a relay is the wire shape the forced path emits: a `deltas: []`
 * node must still reconstruct to its snapshot, and a chain of forced
 * checkpoints must stay content-stable and linear.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { reconstructFromChain } from "./provenance.js";
import type { Event } from "nostr-tools";

/** Build a file-node event mirroring the wire shape publishEdit emits:
 *  kind 4290, `z:file`, JSON content with `steppedAt` + `deltas` + `snapshot`. */
function fileNode(
  id: string,
  prev: string | null,
  content: { steppedAt: number; deltas: unknown[]; snapshot?: string },
): Event {
  return {
    id,
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [
      ["z", "file"],
      ["file", "draft.md"],
      ["folder", "f"],
      ["action", "edit"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify(content),
    sig: "",
  };
}

test("forced checkpoint: deltas:[] + snapshot reconstructs to the snapshot", () => {
  // A Step on unchanged content: no deltas, but the full snapshot is carried.
  const node = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [],
    snapshot: "hello world",
  });
  assert.equal(reconstructFromChain([node]), "hello world");
});

test("forced checkpoint: two in a row stay content-stable and linear", () => {
  // Edit steps n1 with content "hello". Then two forced Steps (n2, n3) step
  // the same content with deltas:[]. The chain must reconstruct to "hello"
  // at every point — the snapshots are authoritative (§R1).
  const n1 = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "hello", timestamp: 1000 }],
    snapshot: "hello",
  });
  const n2 = fileNode("n2", "n1", { steppedAt: 2000, deltas: [], snapshot: "hello" });
  const n3 = fileNode("n3", "n2", { steppedAt: 3000, deltas: [], snapshot: "hello" });
  assert.equal(reconstructFromChain([n1]), "hello");
  assert.equal(reconstructFromChain([n1, n2]), "hello");
  assert.equal(reconstructFromChain([n1, n2, n3]), "hello");
});

test("forced checkpoint after an edit still reconstructs (snapshot carries through)", () => {
  // n1: "hello". n2: real edit → "hello world". n3: forced Step, unchanged.
  const n1 = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "hello", timestamp: 1000 }],
    snapshot: "hello",
  });
  const n2 = fileNode("n2", "n1", {
    steppedAt: 2000,
    deltas: [{ type: "insert", position: { start: 5, end: 5 }, newValue: " world", timestamp: 2000 }],
    snapshot: "hello world",
  });
  const n3 = fileNode("n3", "n2", { steppedAt: 3000, deltas: [], snapshot: "hello world" });
  assert.equal(reconstructFromChain([n1, n2]), "hello world");
  assert.equal(reconstructFromChain([n1, n2, n3]), "hello world");
});

test("forced checkpoint: deltas:[] with no snapshot falls back to prior content", () => {
  // A malformed forced node that shed its snapshot but kept deltas:[]
  // must not zero out the content — reconstructFromChain skips empty deltas
  // and preserves the running content from the prior node's snapshot.
  const n1 = fileNode("n1", null, {
    steppedAt: 1000,
    deltas: [{ type: "insert", position: { start: 0, end: 0 }, newValue: "hello", timestamp: 1000 }],
    snapshot: "hello",
  });
  // n2 has no snapshot field and empty deltas — a reader must still see "hello".
  const n2 = fileNode("n2", "n1", { steppedAt: 2000, deltas: [] });
  assert.equal(reconstructFromChain([n1, n2]), "hello");
});
