import test from "node:test";
import assert from "node:assert/strict";
import type { Event, Filter } from "nostr-tools";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

import {
  citationTargetSet,
  createCoCitationSweepBudget,
  fetchPeerEvents,
  intersectCitationTargets,
  retainCompletedCoinCoCitations,
} from "./co-citation.js";
import { sha256HexLocal } from "./provenance.js";

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

function nodeId(value: number): string {
  return value.toString(16).padStart(64, "0");
}

async function completedCoin(phrase: string): Promise<{ coin: Event; attestation: Event }> {
  const secret = generateSecretKey();
  const hash = await sha256HexLocal(phrase);
  const coin = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "coin.md"],
      ["f", "f".repeat(64)],
      ["action", "import"],
      ["x", hash],
    ],
    content: JSON.stringify({
      snapshot: phrase,
      contentHash: hash,
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, secret);
  const attestation = finalizeEvent({
    kind: 4294,
    created_at: 2,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, secret);
  return { coin, attestation };
}

test("citationTargetSet collects and dedupes ordinary q targets", () => {
  const first = nodeId(1);
  const second = nodeId(2);
  const third = nodeId(3);
  assert.deepEqual(
    [...citationTargetSet([
      peerEvent("pk-a", [first, second]),
      peerEvent("pk-a", [second, third]),
    ])].sort(),
    [first, second, third],
  );
});

test("citationTargetSet rejects malformed ordinary q targets before intersection", () => {
  assert.deepEqual(
    [...citationTargetSet([peerEvent("pk-a", ["shared-but-not-an-event-id"])])],
    [],
  );
});

test("citationTargetSet ignores invalid uppercase Q content coordinates", () => {
  assert.deepEqual(
    [...citationTargetSet([peerEvent("pk-a", [], [["Q", "invalid-hash", ""]])])],
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
  const removed = nodeId(10);
  const stillLive = nodeId(11);
  const historical = peerEvent("pk-a", [removed]);
  historical.id = nodeId(12);
  const current = peerEvent("pk-a", [stillLive]);
  current.id = nodeId(13);
  current.tags.push(["e", historical.id, "", "prev"]);

  assert.deepEqual([...citationTargetSet([historical, current])], [stillLive]);
});

test("peer fetch resolves signed TraceHeads instead of reviving a bounded historical citation", async () => {
  const secret = generateSecretKey();
  const cited = nodeId(14);
  const historical = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["q", cited, ""]],
    content: JSON.stringify({ snapshot: "old citation" }),
  }, secret);
  const current = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["e", historical.id, "", "prev"]],
    content: JSON.stringify({ snapshot: "citation removed" }),
  }, secret);
  const traceHead = finalizeEvent({
    kind: 34290,
    created_at: 2,
    tags: [["d", historical.id]],
    content: JSON.stringify({ head: current.id }),
  }, secret);
  const queries: Array<{ kinds?: number[]; ids?: string[] }> = [];
  const budget = createCoCitationSweepBudget(undefined, { deadlineMs: 60_000 });
  try {
    const byPeer = await fetchPeerEvents(
      [historical.pubkey],
      100,
      budget,
      async (filter) => {
        queries.push({ kinds: filter.kinds, ids: filter.ids });
        if (filter.kinds?.includes(34290)) return [traceHead];
        if (filter.ids) {
          return [historical, current].filter((event) => filter.ids?.includes(event.id));
        }
        // A reverse 4290 window could contain only the stale citation. The
        // implementation must never use such a window to establish a head.
        return [historical];
      },
    );
    assert.deepEqual(byPeer.get(historical.pubkey)?.map((event) => event.id), [current.id]);
    assert.deepEqual([...citationTargetSet(byPeer.get(historical.pubkey) ?? [])], []);
    assert.equal(
      queries.some((query) => query.kinds?.includes(4290) && !query.ids),
      false,
      "currentness must not depend on a bounded reverse node scan",
    );
  } finally {
    budget.dispose();
  }
});

test("peer fetch rejects a same-trace TraceHead from another signer under a limited query", async () => {
  const peerSecret = generateSecretKey();
  const attackerSecret = generateSecretKey();
  const historical = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["q", nodeId(15), ""]],
    content: JSON.stringify({ snapshot: "old citation" }),
  }, peerSecret);
  const current = finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [["z", "file"], ["e", historical.id, "", "prev"]],
    content: JSON.stringify({ snapshot: "current peer head" }),
  }, peerSecret);
  const peerHead = finalizeEvent({
    kind: 34290,
    created_at: 3,
    tags: [["d", historical.id]],
    content: JSON.stringify({ head: current.id }),
  }, peerSecret);
  const injectedHead = finalizeEvent({
    kind: 34290,
    created_at: 4,
    tags: [["d", historical.id]],
    content: JSON.stringify({ head: nodeId(16) }),
  }, attackerSecret);
  const headQueries: Filter[] = [];
  const budget = createCoCitationSweepBudget(undefined, { deadlineMs: 60_000 });
  try {
    const byPeer = await fetchPeerEvents(
      [historical.pubkey],
      1,
      budget,
      async (filter) => {
        if (filter.kinds?.includes(34290)) {
          headQueries.push(filter);
          // Simulate a hostile relay ignoring the second query's author filter
          // and spending its one-result limit on another signer's same-d head.
          return filter["#d"] ? [injectedHead] : [peerHead];
        }
        return [historical, current].filter((event) => filter.ids?.includes(event.id));
      },
    );
    assert.deepEqual(byPeer.get(historical.pubkey)?.map((event) => event.id), [current.id]);
    assert.equal(headQueries.length, 2);
    assert.deepEqual(headQueries[1]?.authors, [historical.pubkey]);
  } finally {
    budget.dispose();
  }
});

test("citationTargetSet emits no active signal from a deleted trace head", () => {
  const historical = peerEvent("pk-a", [nodeId(20)]);
  historical.id = nodeId(21);
  const deleted = peerEvent("pk-a", []);
  deleted.id = nodeId(22);
  deleted.tags.push(["e", historical.id, "", "prev"], ["action", "delete"]);

  assert.deepEqual([...citationTargetSet([historical, deleted])], []);
});

test("intersectCitationTargets detects peers citing the same trace", () => {
  const shared = nodeId(30);
  const results = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [shared, nodeId(31)])]],
    ["pk-b", [peerEvent("pk-b", [shared, nodeId(32)])]],
  ]));
  assert.equal(results.length, 1);
  assert.equal(results[0].peerA, "pk-a");
  assert.equal(results[0].peerB, "pk-b");
  assert.deepEqual(results[0].targetIds, [shared]);
  assert.deepEqual(results[0].samples, [{ nodeId: shared }]);
});

test("intersectCitationTargets returns no match for different traces", () => {
  assert.equal(intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [nodeId(40)])]],
    ["pk-b", [peerEvent("pk-b", [nodeId(41)])]],
  ])).length, 0);
});

test("intersectCitationTargets handles several peers and targets", () => {
  const one = nodeId(50);
  const two = nodeId(51);
  const three = nodeId(52);
  const four = nodeId(53);
  const results = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [one, two, three])]],
    ["pk-b", [peerEvent("pk-b", [two, three, four])]],
    ["pk-c", [peerEvent("pk-c", [nodeId(54)])]],
  ]));
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].targetIds.sort(), [two, three].sort());
});

test("intersectCitationTargets needs at least two peers", () => {
  assert.deepEqual(intersectCitationTargets(new Map()), []);
  assert.deepEqual(intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [nodeId(60)])]],
  ])), []);
});

test("citationTargetSet caps hostile per-event and per-peer target fan-out", () => {
  const tooManyInOneEvent = Array.from({ length: 200 }, (_, index) => nodeId(1_000 + index));
  assert.equal(citationTargetSet([peerEvent("pk-a", tooManyInOneEvent)]).size, 128);

  const tooManyTargets = Array.from(
    { length: 5 },
    (_, eventIndex) => peerEvent(
      "pk-a",
      Array.from({ length: 128 }, (_, targetIndex) => nodeId(4_000 + eventIndex * 128 + targetIndex)),
    ),
  );
  assert.equal(citationTargetSet(tooManyTargets).size, 512);

  const tooManyEvents = Array.from(
    { length: 150 },
    (_, index) => peerEvent("pk-a", [nodeId(2_000 + index)]),
  );
  assert.equal(citationTargetSet(tooManyEvents).size, 100);
});

test("citationTargetSet rejects events whose tag surface exceeds the local bound", () => {
  const oversized = peerEvent("pk-a", [nodeId(3_000)]);
  oversized.tags.push(...Array.from({ length: 4_096 }, () => ["extra", "value"]));
  assert.deepEqual([...citationTargetSet([oversized])], []);
});

test("citationTargetSet rejects an event whose content exceeds the local byte bound", () => {
  const oversized = peerEvent("pk-a", [nodeId(3_100)]);
  oversized.content = "x".repeat(2 * 1024 * 1024 + 1);
  assert.deepEqual([...citationTargetSet([oversized])], []);
});

test("one shared co-citation budget aborts cumulative relay samples", () => {
  const budget = createCoCitationSweepBudget(undefined, {
    maxBytes: 1,
    deadlineMs: 60_000,
  });
  try {
    assert.throws(
      () => budget.consume([peerEvent("pk-a", [nodeId(3_200)])]),
      /exceeded its 1-byte budget/,
    );
    assert.throws(() => budget.assertActive(), /exceeded its 1-byte budget/);
  } finally {
    budget.dispose();
  }
});

test("co-citation sweep budget propagates caller cancellation", () => {
  const controller = new AbortController();
  const budget = createCoCitationSweepBudget(controller.signal, { deadlineMs: 60_000 });
  try {
    controller.abort(new Error("view closed"));
    assert.throws(() => budget.assertActive(), /view closed/);
  } finally {
    budget.dispose();
  }
});

test("mutual-peer co-citation admits a cryptographically completed Coin", async () => {
  const { coin, attestation } = await completedCoin("shared completed Coin");
  const candidates = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [coin.id])]],
    ["pk-b", [peerEvent("pk-b", [coin.id])]],
  ]));
  const admitted = await retainCompletedCoinCoCitations(
    candidates,
    new Map([[coin.id, coin]]),
    new Map([[coin.id, [attestation]]]),
  );

  assert.equal(admitted.length, 1);
  assert.deepEqual(admitted[0]?.targetIds, [coin.id]);
});

test("ordinary q targets and unfinished Coins never trigger mutual-peer rendezvous", async () => {
  const secret = generateSecretKey();
  const ordinaryHash = await sha256HexLocal("ordinary file");
  const ordinary = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["F", "ordinary.md"], ["f", "f".repeat(64)]],
    content: JSON.stringify({ snapshot: "ordinary file", contentHash: ordinaryHash }),
  }, secret);
  const ordinaryAttestation = finalizeEvent({
    kind: 4294,
    created_at: 2,
    tags: [["e", ordinary.id, "", "target"], ["k", "4290"], ["p", ordinary.pubkey]],
    content: "{}",
  }, secret);
  const { coin: unfinishedCoin } = await completedCoin("unfinished Coin");
  const candidates = intersectCitationTargets(new Map([
    ["pk-a", [peerEvent("pk-a", [ordinary.id, unfinishedCoin.id])]],
    ["pk-b", [peerEvent("pk-b", [ordinary.id, unfinishedCoin.id])]],
  ]));
  const admitted = await retainCompletedCoinCoCitations(
    candidates,
    new Map([[ordinary.id, ordinary], [unfinishedCoin.id, unfinishedCoin]]),
    new Map([[ordinary.id, [ordinaryAttestation]]]),
  );

  assert.deepEqual(admitted, []);
});
