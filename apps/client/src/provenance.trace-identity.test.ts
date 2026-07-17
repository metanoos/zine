import { test } from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";

import {
  nextReplaceableCreatedAt,
  resolveTraceChainAtHead,
  resolveTraceChainCandidates,
  resolveTraceIdentity,
} from "./provenance.js";

test("replaceable TraceHead timestamps advance across same-second writes", () => {
  assert.equal(nextReplaceableCreatedAt(100), 100);
  assert.equal(nextReplaceableCreatedAt(100, 100), 101);
  assert.equal(nextReplaceableCreatedAt(100, 105), 106);
  assert.equal(nextReplaceableCreatedAt(110, 105), 110);
});

function node(id: string, prev?: string): Event {
  return {
    id,
    pubkey: "pk",
    created_at: 0,
    kind: 4290,
    tags: [
      ["z", "file"],
      ...(prev ? [["e", prev, "", "prev"]] : []),
    ],
    content: JSON.stringify({ snapshot: id }),
    sig: "",
  };
}

function loader(events: Event[]) {
  const byId = new Map(events.map((event) => [event.id, event]));
  return async (ids: readonly string[]) => ids.flatMap((id) => byId.get(id) ?? []);
}

test("trace identity is the genesis reached through prev links", async () => {
  const events = [node("g"), node("a1", "g"), node("a2", "a1")];
  assert.equal(await resolveTraceIdentity("a2", loader(events)), "g");
});

test("an exact folder-member head resolves a renamed chain without coordinates", async () => {
  const genesis = node("g");
  genesis.tags.push(["F", "old-name.md"]);
  const moved = node("a1", "g");
  moved.tags.push(["F", "new-name.md"]);

  const resolved = await resolveTraceChainAtHead("g", "a1", loader([genesis, moved]));
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.equal(resolved.source, "exact-head");
    assert.deepEqual(resolved.chain.map((event) => event.id), ["g", "a1"]);
  }
});

test("newer valid TraceHead candidate supersedes an ancestor candidate", async () => {
  const events = [node("g"), node("a1", "g"), node("a2", "a1")];
  const resolved = await resolveTraceChainCandidates("g", ["a1", "a2"], loader(events));
  assert.equal(resolved.status, "resolved");
  if (resolved.status === "resolved") {
    assert.deepEqual(resolved.chain.map((event) => event.id), ["g", "a1", "a2"]);
  }
});

test("incomparable valid TraceHead candidates remain a conflict", async () => {
  const events = [node("g"), node("left", "g"), node("right", "g")];
  const resolved = await resolveTraceChainCandidates("g", ["left", "right"], loader(events));
  assert.equal(resolved.status, "conflict");
  if (resolved.status === "conflict") {
    assert.deepEqual(new Set(resolved.candidateHeadIds), new Set(["left", "right"]));
  }
});

test("candidate that does not walk to the declared genesis is rejected", async () => {
  const events = [node("other"), node("bad", "other")];
  const resolved = await resolveTraceChainCandidates("g", ["bad"], loader(events));
  assert.equal(resolved.status, "broken");
});

test("prev cycles are rejected", async () => {
  const events = [node("a", "b"), node("b", "a")];
  assert.equal(await resolveTraceIdentity("a", loader(events)), null);
  const resolved = await resolveTraceChainCandidates("g", ["a"], loader(events));
  assert.equal(resolved.status, "broken");
});
