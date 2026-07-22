import test from "node:test";
import assert from "node:assert/strict";
import type { Event, Filter } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

import {
  completedMintsFromEvents,
  createCoMintSweepBudget,
  fetchPeerMintEvents,
  intersectCompletedMintCoordinates,
  type CompletedPeerMint,
} from "./co-mint.js";
import { quoteHash, relayFairEventOrder, sha256HexLocal } from "./provenance.js";

const FOLDER = "f".repeat(64);

interface MintFixture {
  coin: Event;
  attestation: Event;
  secret: Uint8Array;
}

function attestation(coin: Event, secret: Uint8Array): Event {
  return finalizeEvent({
    kind: 4294,
    created_at: 2,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, secret);
}

async function directMint(phrase: string): Promise<MintFixture> {
  const secret = generateSecretKey();
  const voice = getPublicKey(secret);
  const hash = await sha256HexLocal(phrase);
  const coin = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "coin.md"],
      ["f", FOLDER],
      ["action", "import"],
      ["x", hash],
    ],
    content: JSON.stringify({
      snapshot: phrase,
      contentHash: hash,
      operationId: "cd".repeat(32),
      deltas: [],
      kedits: [{
        op: "ins",
        from: 0,
        to: 0,
        text: phrase,
        voice,
        t: 1_000,
        tx: 0,
      }],
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, secret);
  return { coin, attestation: attestation(coin, secret), secret };
}

async function sourceNode(snapshot: string): Promise<Event> {
  const secret = generateSecretKey();
  const voice = getPublicKey(secret);
  const hash = await sha256HexLocal(snapshot);
  return finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["F", "source.md"], ["f", FOLDER], ["action", "import"]],
    content: JSON.stringify({
      snapshot,
      contentHash: hash,
      operationId: "ef".repeat(32),
      kedits: [{ op: "ins", from: 0, to: 0, text: snapshot, voice, t: 1_000, tx: 0 }],
    }),
  }, secret);
}

async function extractedMint(
  source: Event,
  phrase: string,
  range: { start: number; end: number },
): Promise<MintFixture> {
  const secret = generateSecretKey();
  const voice = getPublicKey(secret);
  const sourceSnapshot = (JSON.parse(source.content) as { snapshot: string }).snapshot;
  const sourceHash = await sha256HexLocal(sourceSnapshot);
  const hash = await sha256HexLocal(phrase);
  const coin = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "coin.md"],
      ["f", FOLDER],
      ["action", "import"],
      ["x", hash],
      ["e", source.id, "", "extracted-from"],
    ],
    content: JSON.stringify({
      snapshot: phrase,
      contentHash: hash,
      operationId: "12".repeat(32),
      deltas: [],
      kedits: [{ op: "ins", from: 0, to: 0, text: phrase, voice, t: 1_000, tx: 0 }],
      coin: {
        version: 1,
        origin: {
          kind: "extracted",
          sourceNodeId: source.id,
          sourceContentHash: sourceHash,
          range,
        },
      },
    }),
  }, secret);
  return { coin, attestation: attestation(coin, secret), secret };
}

function ordinaryCitation(targetId: string): { event: Event; secret: Uint8Array } {
  const secret = generateSecretKey();
  const event = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "essay.md"],
      ["f", FOLDER],
      ["action", "cite"],
      ["q", targetId, ""],
    ],
    content: JSON.stringify({ snapshot: "discussion", contentHash: "0".repeat(64) }),
  }, secret);
  return { event, secret };
}

function ordinaryCitationBy(
  secret: Uint8Array,
  targetId: string,
  createdAt: number,
): Event {
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [
      ["z", "file"],
      ["F", `essay-${createdAt}.md`],
      ["f", FOLDER],
      ["action", "cite"],
      ["q", targetId, ""],
    ],
    content: JSON.stringify({ snapshot: `discussion ${createdAt}` }),
  }, secret);
}

function relayFilter(events: readonly Event[], filter: Filter): Event[] {
  const ids = filter.ids ? new Set(filter.ids) : null;
  const kinds = filter.kinds ? new Set(filter.kinds) : null;
  const authors = filter.authors ? new Set(filter.authors) : null;
  const targets = filter["#e"] ? new Set(filter["#e"]) : null;
  return events.filter((event) =>
    (!ids || ids.has(event.id)) &&
    (!kinds || kinds.has(event.kind)) &&
    (!authors || authors.has(event.pubkey)) &&
    (!targets || event.tags.some((tag) => tag[0] === "e" && targets.has(tag[1] ?? "")))
  ).slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
}

function evidenceMap(...fixtures: MintFixture[]): Map<string, readonly Event[]> {
  return new Map(fixtures.map((fixture) => [fixture.coin.id, [fixture.attestation]]));
}

test("mutual peers match independent completed Mints by H, not Coin id", async () => {
  const first = await directMint("shared\n words");
  const second = await directMint("  shared words  ");
  assert.notEqual(first.coin.id, second.coin.id);
  const a = await completedMintsFromEvents([first.coin], evidenceMap(first));
  const b = await completedMintsFromEvents([second.coin], evidenceMap(second));
  const matches = intersectCompletedMintCoordinates(new Map([
    [first.coin.pubkey, a],
    [second.coin.pubkey, b],
  ]));
  assert.equal(matches.length, 1);
  assert.deepEqual(matches[0]?.coordinates, [await quoteHash("shared words")]);
  assert.deepEqual(
    matches[0]?.samples.map((sample) => sample.coinNodeId).sort(),
    [first.coin.id, second.coin.id].sort(),
  );
});

test("ordinary q citations alone never create mutual-peer membership", async () => {
  const target = (await directMint("target")).coin.id;
  const first = ordinaryCitation(target);
  const second = ordinaryCitation(target);
  const firstEvidence = new Map([[first.event.id, [attestation(first.event, first.secret)]]]);
  const secondEvidence = new Map([[second.event.id, [attestation(second.event, second.secret)]]]);
  const byPeer = new Map([
    [first.event.pubkey, await completedMintsFromEvents([first.event], firstEvidence)],
    [second.event.pubkey, await completedMintsFromEvents([second.event], secondEvidence)],
  ]);
  assert.deepEqual(intersectCompletedMintCoordinates(byPeer), []);
});

test("missing and wrong-minter attestations exclude an otherwise valid Coin", async () => {
  const minted = await directMint("completion required");
  assert.deepEqual(await completedMintsFromEvents([minted.coin], new Map()), []);
  const wrong = attestation(minted.coin, generateSecretKey());
  assert.deepEqual(
    await completedMintsFromEvents([minted.coin], new Map([[minted.coin.id, [wrong]]])),
    [],
  );
  assert.equal(
    (await completedMintsFromEvents([minted.coin], evidenceMap(minted))).length,
    1,
  );
});

test("direct and extracted completed Mints are admitted without requiring source publication", async () => {
  const direct = await directMint("direct words");
  const source = await sourceNode("prefix extracted words suffix");
  const extracted = await extractedMint(source, "extracted words", { start: 7, end: 22 });
  const attestations = evidenceMap(direct, extracted);
  const withoutSource = await completedMintsFromEvents(
    [direct.coin, extracted.coin],
    attestations,
  );
  assert.deepEqual(withoutSource.map((mint) => mint.originKind), ["direct", "extracted"]);
  assert.equal(withoutSource[1]?.sourceEvidenceVerified, false);

  const withSource = await completedMintsFromEvents(
    [extracted.coin],
    attestations,
    new Map([[source.id, source]]),
  );
  assert.equal(withSource[0]?.sourceEvidenceVerified, true);
});

test("co-Mint admission rejects an impossible extracted-origin range", async () => {
  const source = await sourceNode("tiny");
  const minted = await extractedMint(source, "tiny", { start: 0, end: 1_000 });
  assert.deepEqual(
    await completedMintsFromEvents([minted.coin], evidenceMap(minted)),
    [],
  );
});

test("coordinate intersection deduplicates repeated same-H Coins from one peer", async () => {
  const coordinate = await quoteHash("same");
  const mint = (coinNodeId: string): CompletedPeerMint => ({
    coinNodeId,
    coordinate,
    text: "same",
    originKind: "direct",
    sourceEvidenceVerified: false,
  });
  const matches = intersectCompletedMintCoordinates(new Map([
    ["a".repeat(64), [mint("1".repeat(64)), mint("2".repeat(64))]],
    ["b".repeat(64), [mint("3".repeat(64))]],
  ]));
  assert.equal(matches[0]?.coordinates.length, 1);
  assert.equal(matches[0]?.samples.length, 2);
});

test("newer ordinary Steps cannot crowd an older completed Coin out of peer discovery", async () => {
  const owner = await directMint("owner Coin");
  const ordinary = Array.from({ length: 101 }, (_, index) =>
    ordinaryCitationBy(owner.secret, String(index).padStart(64, "0"), 1_000 + index)
  );
  const relayEvents = [...ordinary, owner.attestation, owner.coin];
  const queries: Filter[] = [];
  const budget = createCoMintSweepBudget(undefined, { deadlineMs: 60_000 });
  try {
    const byPeer = await fetchPeerMintEvents(
      [owner.coin.pubkey],
      1,
      budget,
      async (filter, bounds) => {
        queries.push(filter);
        assert.deepEqual(filter.authors, [owner.coin.pubkey]);
        assert.ok(bounds.maxUniqueEvents >= 1);
        return relayFilter(relayEvents, filter);
      },
    );
    assert.deepEqual(byPeer.get(owner.coin.pubkey)?.map((event) => event.id), [owner.coin.id]);
    assert.deepEqual(queries.map((filter) => filter.kinds), [[4294], [4290]]);
    assert.deepEqual(queries[1]?.ids, [owner.coin.id]);
  } finally {
    budget.dispose();
  }
});

test("relay-fair ordering admits an honest relay before a hostile relay's second event", async () => {
  const hostile = [
    ordinaryCitation("1".repeat(64)).event,
    ordinaryCitation("2".repeat(64)).event,
    ordinaryCitation("3".repeat(64)).event,
  ];
  const honest = await directMint("slower honest Mint");
  assert.deepEqual(
    relayFairEventOrder([hostile, [honest.coin]]).slice(0, 2).map((event) => event.id),
    [hostile[0]!.id, honest.coin.id],
  );
});

test("peer Mint fetch charges each sampled completion proof and Coin once", async () => {
  const owner = await directMint("single budget charge");
  const bytes = [owner.attestation, owner.coin].reduce(
    (total, event) => total + new TextEncoder().encode(JSON.stringify(event)).byteLength,
    0,
  );
  const budget = createCoMintSweepBudget(undefined, {
    maxBytes: bytes,
    deadlineMs: 60_000,
  });
  try {
    const byPeer = await fetchPeerMintEvents(
      [owner.coin.pubkey],
      1,
      budget,
      async (filter) => relayFilter([owner.attestation, owner.coin], filter),
    );
    assert.deepEqual(byPeer.get(owner.coin.pubkey)?.map((event) => event.id), [owner.coin.id]);
    budget.assertActive();
  } finally {
    budget.dispose();
  }
});

test("one co-Mint budget aborts cumulative hostile relay samples", async () => {
  const minted = await directMint("budget");
  const bytes = new TextEncoder().encode(JSON.stringify(minted.coin)).byteLength;
  const budget = createCoMintSweepBudget(undefined, {
    maxBytes: bytes,
    deadlineMs: 60_000,
  });
  try {
    budget.consume([minted.coin]);
    assert.throws(() => budget.consume([minted.coin]), /exceeded/);
    assert.throws(() => budget.assertActive(), /exceeded/);
  } finally {
    budget.dispose();
  }
});

test("co-Mint budget propagates caller cancellation", () => {
  const controller = new AbortController();
  const budget = createCoMintSweepBudget(controller.signal, { deadlineMs: 60_000 });
  try {
    controller.abort(new Error("cancel co-Mint sweep"));
    assert.throws(() => budget.assertActive(), /cancel co-Mint sweep/);
  } finally {
    budget.dispose();
  }
});
