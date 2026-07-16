import test from "node:test";
import assert from "node:assert/strict";
import type { Event } from "nostr-tools";

import { citationTargetSet, intersectCitationTargets } from "./co-citation.js";

function peerEvent(pubkey: string, targets: string[], extraTags: string[][] = []): Event {
  return {
    id: `${pubkey}-${targets.join("-")}-${extraTags.length}`,
    pubkey,
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ...targets.map((id) => ["q", id, ""]), ...extraTags],
    content: JSON.stringify({ snapshot: "" }),
    sig: "sig",
  } as Event;
}

test("citationTargetSet collects and dedupes ordinary q targets", () => {
  assert.deepEqual(
    [...citationTargetSet([
      peerEvent("pk-a", ["trace-1", "trace-2"]),
      peerEvent("pk-a", ["trace-2", "trace-3"]),
    ])].sort(),
    ["trace-1", "trace-2", "trace-3"],
  );
});

test("citationTargetSet ignores legacy uppercase Q content coordinates", () => {
  assert.deepEqual(
    [...citationTargetSet([peerEvent("pk-a", [], [["Q", "legacy-hash", ""]])])],
    [],
  );
});

test("citationTargetSet excludes folder membership and LLM scope q edges", () => {
  const folder = peerEvent("pk-a", ["member"]);
  folder.tags[0] = ["z", "folder"];
  const llm = peerEvent("pk-a", ["context"], [["scope", "llm"]]);
  assert.deepEqual([...citationTargetSet([folder, llm])], []);
});

test("citationTargetSet uses only the current head when a citation is removed", () => {
  const historical = peerEvent("pk-a", ["removed"]);
  historical.id = "a1";
  const current = peerEvent("pk-a", ["still-live"]);
  current.id = "a2";
  current.tags.push(["e", "a1", "", "prev"]);

  assert.deepEqual([...citationTargetSet([historical, current])], ["still-live"]);
});

test("citationTargetSet emits no active signal from a deleted trace head", () => {
  const historical = peerEvent("pk-a", ["removed"]);
  historical.id = "a1";
  const deleted = peerEvent("pk-a", []);
  deleted.id = "a2";
  deleted.tags.push(["e", "a1", "", "prev"], ["action", "delete"]);

  assert.deepEqual([...citationTargetSet([historical, deleted])], []);
});

test("intersectCitationTargets detects peers citing the same trace", () => {
  const results = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", ["shared", "only-a"])]],
    ["pk-b", [peerEvent("pk-b", ["shared", "only-b"])]],
  ]));
  assert.equal(results.length, 1);
  assert.equal(results[0].peerA, "pk-a");
  assert.equal(results[0].peerB, "pk-b");
  assert.deepEqual(results[0].targetIds, ["shared"]);
  assert.deepEqual(results[0].samples, [{ nodeId: "shared" }]);
});

test("intersectCitationTargets returns no match for different traces", () => {
  assert.equal(intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", ["trace-a"])]],
    ["pk-b", [peerEvent("pk-b", ["trace-b"])]],
  ])).length, 0);
});

test("intersectCitationTargets handles several peers and targets", () => {
  const results = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", ["one", "two", "three"])]],
    ["pk-b", [peerEvent("pk-b", ["two", "three", "four"])]],
    ["pk-c", [peerEvent("pk-c", ["different"])]],
  ]));
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].targetIds.sort(), ["three", "two"]);
});

test("intersectCitationTargets needs at least two peers", () => {
  assert.deepEqual(intersectCitationTargets(new Map()), []);
  assert.deepEqual(intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", ["trace"])]],
  ])), []);
});
