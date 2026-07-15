/**
 * Co-citation detector — pure logic tests (protocol/rendezvous.md §4).
 *
 * Follows the provenance.inbound.test.ts convention: pure set-intersection
 * logic is unit-tested with hand-built fake events; the relay fetch
 * (fetchPeerEvents / detectCoCitations) is excluded — it's relay-bound and
 * no relay mock exists in the codebase.
 *
 * What's tested: qHashSet extraction, quoteBytesByHash parsing, and
 * intersectQHashes pairwise intersection. The load-bearing property: two peers
 * who quoted the same passage (same H) are detected; two who didn't, aren't.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { qHashSet, quoteBytesByHash, intersectQHashes } from "./co-citation.js";
import type { Event } from "nostr-tools";

/** Build a file-node event with given Q-tags + an optional content body
 *  (for cite deltas). Mirrors the wire shape publishEdit emits. */
function peerEvent(pubkey: string, qTags: string[][], content?: object): Event {
  return {
    id: Math.random().toString(36).slice(2),
    pubkey,
    created_at: 0,
    kind: 4290,
    tags: [["z", "file"], ...qTags],
    content: content ? JSON.stringify(content) : JSON.stringify({}),
    sig: "",
  };
}

/** A content-cite delta carrying the verbatim quote + its hash. */
function contentDelta(hash: string, quote: string): object {
  return { type: "cite", role: "content", op: "add", hash, quote, timestamp: 1 };
}

// --- qHashSet: extract H values from Q-tags -----------------------------

test("qHashSet: returns empty for events with no Q-tags", () => {
  const ev = peerEvent("pk-a", []);
  assert.deepEqual([...qHashSet([ev])], []);
});

test("qHashSet: collects all Q-tag values across multiple events", () => {
  const ev1 = peerEvent("pk-a", [["Q", "hash1", "", "implicit"]]);
  const ev2 = peerEvent("pk-a", [["Q", "hash2", ""], ["Q", "hash3", ""]]);
  const hashes = qHashSet([ev1, ev2]);
  assert.deepEqual([...hashes].sort(), ["hash1", "hash2", "hash3"]);
});

test("qHashSet: dedupes the same H across events", () => {
  const ev1 = peerEvent("pk-a", [["Q", "same", ""]]);
  const ev2 = peerEvent("pk-a", [["Q", "same", ""]]);
  assert.deepEqual([...qHashSet([ev1, ev2])], ["same"]);
});

test("qHashSet: does NOT pick up lowercase q tags (node-citations)", () => {
  const ev = peerEvent("pk-a", [["q", "node-id-123", ""], ["Q", "hash-abc", ""]]);
  const hashes = qHashSet([ev]);
  assert.deepEqual([...hashes], ["hash-abc"]);
});

// --- quoteBytesByHash: extract verbatim quotes from content-cite deltas --

test("quoteBytesByHash: extracts quote bytes keyed by hash", () => {
  const ev = peerEvent("pk-a", [["Q", "h1", ""]], {
    deltas: [contentDelta("h1", "the quoted passage")],
  });
  const quotes = quoteBytesByHash([ev]);
  assert.equal(quotes.get("h1"), "the quoted passage");
});

test("quoteBytesByHash: skips non-content cite roles", () => {
  const ev = peerEvent("pk-a", [["Q", "h1", ""]], {
    deltas: [
      contentDelta("h1", "the real quote"),
      { type: "cite", role: "tag", op: "add", sourceEventId: "node-x", timestamp: 1 },
    ],
  });
  const quotes = quoteBytesByHash([ev]);
  assert.equal(quotes.size, 1);
  assert.equal(quotes.get("h1"), "the real quote");
});

test("quoteBytesByHash: handles malformed JSON gracefully (no throw)", () => {
  const ev = peerEvent("pk-a", [], {});
  ev.content = "not valid json {{{";
  assert.doesNotThrow(() => quoteBytesByHash([ev]));
  assert.equal(quoteBytesByHash([ev]).size, 0);
});

// --- intersectQHashes: the core detection algorithm ---------------------

test("intersectQHashes: detects two peers sharing one quote", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "shared-h", ""]])]],
    ["pk-b", [peerEvent("pk-b", [["Q", "shared-h", ""]])]],
  ]);
  const results = intersectQHashes(eventsByPeer);
  assert.equal(results.length, 1);
  assert.equal(results[0].peerA, "pk-a");
  assert.equal(results[0].peerB, "pk-b");
  assert.deepEqual(results[0].hashes, ["shared-h"]);
});

test("intersectQHashes: no match when peers quoted different passages", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "hash-a", ""]])]],
    ["pk-b", [peerEvent("pk-b", [["Q", "hash-b", ""]])]],
  ]);
  assert.equal(intersectQHashes(eventsByPeer).length, 0);
});

test("intersectQHashes: one peer with no Q-tags produces no matches", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "h", ""]])]],
    ["pk-b", [peerEvent("pk-b", [])]], // no quotes
  ]);
  assert.equal(intersectQHashes(eventsByPeer).length, 0);
});

test("intersectQHashes: three peers, one shared between A and B only", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "shared", ""]])]],
    ["pk-b", [peerEvent("pk-b", [["Q", "shared", ""]])]],
    ["pk-c", [peerEvent("pk-c", [["Q", "different", ""]])]],
  ]);
  const results = intersectQHashes(eventsByPeer);
  assert.equal(results.length, 1); // only A↔B
  assert.equal(results[0].peerA, "pk-a");
  assert.equal(results[0].peerB, "pk-b");
});

test("intersectQHashes: multiple shared hashes in one pair", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "h1", ""], ["Q", "h2", ""], ["Q", "h3", ""]])]],
    ["pk-b", [peerEvent("pk-b", [["Q", "h2", ""], ["Q", "h3", ""], ["Q", "h4", ""]])]],
  ]);
  const results = intersectQHashes(eventsByPeer);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].hashes.sort(), ["h2", "h3"]); // h1 and h4 are unshared
});

test("intersectQHashes: samples carry verbatim quotes from both peers", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "h1", ""]], {
      deltas: [contentDelta("h1", "passage as A quoted it")],
    })]],
    ["pk-b", [peerEvent("pk-b", [["Q", "h1", ""]], {
      deltas: [contentDelta("h1", "passage as B quoted it")],
    })]],
  ]);
  const results = intersectQHashes(eventsByPeer);
  assert.equal(results[0].samples.length, 1);
  assert.equal(results[0].samples[0].quoteA, "passage as A quoted it");
  assert.equal(results[0].samples[0].quoteB, "passage as B quoted it");
});

test("intersectQHashes: empty peer map produces no results", () => {
  assert.equal(intersectQHashes(new Map()).length, 0);
});

test("intersectQHashes: single peer produces no pairs (need ≥2)", () => {
  const eventsByPeer = new Map([
    ["pk-a", [peerEvent("pk-a", [["Q", "h", ""]])]],
  ]);
  assert.equal(intersectQHashes(eventsByPeer).length, 0);
});
