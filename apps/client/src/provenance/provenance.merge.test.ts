/**
 * Branch detection + unilateral merge helpers (protocol §3.8 Merging).
 * Pure unit tests — no relay. (Wire-shape merge against a live relay is not
 * covered here; add an integration test if that coverage is needed.)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isNoConflictMerge, listUncitedHeads } from "./provenance.js";
import type { Event } from "nostr-tools";

function fakeEvent(id: string, prev?: string): Event {
  return {
    id,
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: prev ? [["e", prev, "", "prev"]] : [],
    content: "{}",
    sig: "",
  };
}

test("listUncitedHeads: linear chain has one head", () => {
  const g = fakeEvent("g");
  const n1 = fakeEvent("n1", "g");
  const n2 = fakeEvent("n2", "n1");
  const heads = listUncitedHeads([g, n1, n2]);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].id, "n2");
});

test("listUncitedHeads: concurrent split yields two heads (branch detection)", () => {
  // G → N1 → N2a
  //        ↘ N2b
  const g = fakeEvent("g");
  const n1 = fakeEvent("n1", "g");
  const n2a = fakeEvent("n2a", "n1");
  const n2b = fakeEvent("n2b", "n1");
  const heads = listUncitedHeads([g, n1, n2a, n2b]);
  assert.equal(heads.length, 2);
  const ids = new Set(heads.map((h) => h.id));
  assert.ok(ids.has("n2a"));
  assert.ok(ids.has("n2b"));
});

test("listUncitedHeads: empty set", () => {
  assert.deepEqual(listUncitedHeads([]), []);
});

test("isNoConflictMerge: true only when our head is still the fork point", () => {
  assert.equal(isNoConflictMerge("n3", "n3"), true);
  assert.equal(isNoConflictMerge("n5", "n3"), false);
  assert.equal(isNoConflictMerge(null, "n3"), false);
  assert.equal(isNoConflictMerge("n3", null), false);
});
