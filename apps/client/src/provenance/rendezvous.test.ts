import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools";

import {
  createBoundedRelaySampleCollector,
  quoteHash,
  sha256HexLocal,
  type RelaySampleBounds,
} from "./provenance.js";
import {
  discoverCoinCitations,
  isPublicRendezvousRelayUrl,
  publishSentCoinCitations,
  type RendezvousAdapters,
  verifiedCandidateFromEvents,
  verifiedCoinCoordinate,
} from "./rendezvous.js";

const FOLDER = "f".repeat(64);
const minterAttestationByCoin = new Map<string, Event>();
const minterSecretByCoin = new Map<string, Uint8Array>();

async function directCoin(phrase: string): Promise<Event> {
  const x = await sha256HexLocal(phrase);
  const secret = generateSecretKey();
  const coin = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [
      ["z", "file"],
      ["F", "coin.md"],
      ["f", FOLDER],
      ["action", "import"],
      ["x", x],
    ],
    content: JSON.stringify({
      snapshot: phrase,
      contentHash: x,
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, secret);
  const attestation = finalizeEvent({
    kind: 4294,
    created_at: 1,
    tags: [
      ["e", coin.id, "", "target"],
      ["k", "4290"],
      ["p", coin.pubkey],
    ],
    content: "{}",
  }, secret);
  minterAttestationByCoin.set(coin.id, attestation);
  minterSecretByCoin.set(coin.id, secret);
  return coin;
}

function minterAttestation(coin: Event): Event {
  const attestation = minterAttestationByCoin.get(coin.id);
  assert.ok(attestation);
  return attestation;
}

function eventMap(events: Event[]): Map<string, Event> {
  const map = new Map<string, Event>();
  for (const event of events) {
    map.set(event.id, event);
    const attestation = minterAttestationByCoin.get(event.id);
    if (attestation) map.set(attestation.id, attestation);
  }
  return map;
}

function sampledEvents(
  events: Map<string, Event>,
  filter: { ids?: string[]; kinds?: number[]; authors?: string[]; "#e"?: string[] },
): Event[] {
  const requestedIds = filter.ids ? new Set(filter.ids) : null;
  const targetIds = filter["#e"] ? new Set(filter["#e"]) : null;
  const authors = filter.authors ? new Set(filter.authors) : null;
  return [...events.values()].filter((event) =>
    (!requestedIds || requestedIds.has(event.id)) &&
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    (!authors || authors.has(event.pubkey)) &&
    (!targetIds || event.tags.some((tag) => tag[0] === "e" && targetIds.has(tag[1] ?? "")))
  );
}

function carrying(targetId: string | string[], extraTags: string[][] = []): Event {
  const targetIds = Array.isArray(targetId) ? targetId : [targetId];
  return finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [
      ["z", "file"],
      ["F", "essay.md"],
      ["f", FOLDER],
      ["action", "cite"],
      ...targetIds.map((id) => ["q", id, ""]),
      ...extraTags,
    ],
    content: JSON.stringify({ snapshot: "cites a coin", contentHash: "a".repeat(64) }),
  }, generateSecretKey());
}

test("rendezvous accepts only public clearnet WebSocket relays", () => {
  assert.equal(isPublicRendezvousRelayUrl("wss://relay.example"), true);
  assert.equal(isPublicRendezvousRelayUrl("ws://127.0.0.1:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("ws://192.168.1.5:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("ws://[::ffff:127.0.0.1]:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("ws://[::ffff:192.168.1.5]:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("wss://[::ffff:8.8.8.8]"), true);
  assert.equal(isPublicRendezvousRelayUrl("wss://private.example.onion"), false);
  assert.equal(isPublicRendezvousRelayUrl("wss://secret@relay.example"), false);
  assert.equal(isPublicRendezvousRelayUrl("https://relay.example"), false);
});

test("verified Coin coordinate requires the exact same-key minter attestation", async () => {
  const coin = await directCoin("same\n passage");
  const attestation = minterAttestation(coin);
  assert.equal(await verifiedCoinCoordinate(coin), null);
  assert.equal(
    await verifiedCoinCoordinate(coin, [attestation]),
    await quoteHash("same passage"),
  );

  const wrongKey = finalizeEvent({
    kind: 4294,
    created_at: 1,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, generateSecretKey());
  assert.equal(await verifiedCoinCoordinate(coin, [wrongKey]), null);

  const wrongTarget = finalizeEvent({
    kind: 4294,
    created_at: 1,
    tags: [["e", "0".repeat(64), "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, minterSecretByCoin.get(coin.id)!);
  assert.equal(await verifiedCoinCoordinate(coin, [wrongTarget]), null);

  const tampered = { ...coin, content: coin.content.replace("same\\n passage", "other") };
  assert.equal(await verifiedCoinCoordinate(tampered, [attestation]), null);
});

test("candidate verification requires the signed carrying q and matching H", async () => {
  const coin = await directCoin("a distinctive passage");
  const sent = carrying(coin.id);
  const coordinate = await quoteHash("a distinctive passage");
  const pointer = { eventId: sent.id, relayUrl: "wss://relay.example" };
  const candidate = await verifiedCandidateFromEvents(
    pointer,
    sent,
    new Map([[coin.id, coin]]),
    coordinate,
    new Map([[coin.id, [minterAttestation(coin)]]]),
  );
  assert.equal(candidate?.signerPubkey, sent.pubkey);
  assert.equal(candidate?.targetNodeId, coin.id);
  assert.equal(
    await verifiedCandidateFromEvents(
      pointer,
      sent,
      new Map([[coin.id, coin]]),
      "0".repeat(64),
      new Map([[coin.id, [minterAttestation(coin)]]]),
    ),
    null,
  );
});

test("legacy LLM scope q-tags never become global social candidates", async () => {
  const coin = await directCoin("private prompt scope");
  const scoped = carrying(coin.id, [["scope", "llm"]]);
  const candidate = await verifiedCandidateFromEvents(
    { eventId: scoped.id, relayUrl: "wss://relay.example" },
    scoped,
    new Map([[coin.id, coin]]),
    await quoteHash("private prompt scope"),
    new Map([[coin.id, [minterAttestation(coin)]]]),
  );
  assert.equal(candidate, null);
});

test("versioned mixed-role LLM citations verify only the ordinary target", async () => {
  const social = await directCoin("public social citation");
  const privateScope = await directCoin("private prompt scope");
  const scoped = carrying([social.id, privateScope.id], [
    ["scope", "llm"],
    ["scope", "llm", "targets-v1"],
    ["scope", "llm", privateScope.id],
  ]);
  const candidate = await verifiedCandidateFromEvents(
    { eventId: scoped.id, relayUrl: "wss://relay.example" },
    scoped,
    new Map([[social.id, social], [privateScope.id, privateScope]]),
    await quoteHash("public social citation"),
    new Map([
      [social.id, [minterAttestation(social)]],
      [privateScope.id, [minterAttestation(privateScope)]],
    ]),
  );

  assert.equal(candidate?.targetNodeId, social.id);
  assert.equal(
    await verifiedCandidateFromEvents(
      { eventId: scoped.id, relayUrl: "wss://relay.example" },
      scoped,
      new Map([[social.id, social], [privateScope.id, privateScope]]),
      await quoteHash("private prompt scope"),
      new Map([
        [social.id, [minterAttestation(social)]],
        [privateScope.id, [minterAttestation(privateScope)]],
      ]),
    ),
    null,
  );
});

test("malformed versioned LLM scope fails closed", async () => {
  const coin = await directCoin("malformed private scope");
  const scoped = carrying(coin.id, [
    ["scope", "llm"],
    ["scope", "llm", "targets-v1"],
    ["scope", "llm", "not-an-event-id"],
  ]);
  assert.equal(
    await verifiedCandidateFromEvents(
      { eventId: scoped.id, relayUrl: "wss://relay.example" },
      scoped,
      new Map([[coin.id, coin]]),
      await quoteHash("malformed private scope"),
      new Map([[coin.id, [minterAttestation(coin)]]]),
    ),
    null,
  );
});

function samplerBounds(ids: string[], overrides: Partial<RelaySampleBounds> = {}): RelaySampleBounds {
  return {
    requestedIds: ids,
    maxUniqueEvents: ids.length,
    maxTotalBytes: 1_000_000,
    maxEventBytes: 500_000,
    maxContentLength: 250_000,
    maxTags: 100,
    maxTagValues: 8,
    maxTagValueLength: 1_000,
    ...overrides,
  };
}

test("bounded relay collector rejects unrequested, oversized, and replay-flood input", async () => {
  const coin = await directCoin("bounded sample");
  const unexpected = await directCoin("unexpected sample");
  const unrequested = createBoundedRelaySampleCollector(samplerBounds([coin.id]));
  assert.match(unrequested.accept(unexpected).error ?? "", /unrequested/);

  const contentBound = createBoundedRelaySampleCollector(
    samplerBounds([coin.id], { maxContentLength: 4 }),
  );
  assert.match(contentBound.accept(coin).error ?? "", /content exceeds/);

  const eventBytes = new TextEncoder().encode(JSON.stringify(coin)).byteLength;
  const replayBound = createBoundedRelaySampleCollector(
    samplerBounds([coin.id], { maxTotalBytes: eventBytes + 1 }),
  );
  assert.equal(replayBound.accept(coin).accepted, true);
  assert.match(replayBound.accept(coin).error ?? "", /total byte/);
  assert.equal(replayBound.events().length, 1);
});

function adaptersForEvents(
  events: Map<string, Event>,
  overrides: Partial<RendezvousAdapters> = {},
): Partial<RendezvousAdapters> {
  return {
    enabled: () => true,
    publicationRelayUrls: () => ["wss://relay.example"],
    sample: async (_urls, filter) => ({
      hits: sampledEvents(events, filter)
        .map((event) => ({ event, relays: ["wss://relay.example"] })),
      errors: [],
    }),
    publishPointer: async () => undefined,
    lookupPointers: async () => [],
    ...overrides,
  };
}

test("publication batches every ordinary q citation without truncation", async () => {
  const coins = await Promise.all(
    Array.from({ length: 130 }, (_, index) => directCoin(`batch citation ${index}`)),
  );
  const sent = carrying(coins.map((coin) => coin.id));
  const events = eventMap([sent, ...coins]);
  const requestSizes: number[] = [];
  const attestationTargetSizes: number[] = [];
  const published = new Set<string>();
  const adapters = adaptersForEvents(events, {
    sample: async (_urls, filter) => {
      requestSizes.push(filter.ids?.length ?? filter["#e"]?.length ?? 0);
      if (filter.kinds?.includes(4294)) {
        attestationTargetSizes.push(filter["#e"]?.length ?? 0);
      }
      return {
        hits: sampledEvents(events, filter)
          .map((event) => ({ event, relays: ["wss://relay.example"] })),
        errors: [],
      };
    },
    publishPointer: async (coordinate) => {
      published.add(coordinate);
    },
  });
  const report = await publishSentCoinCitations(sent, { adapters });
  assert.equal(report.complete, true);
  assert.equal(published.size, 130);
  assert.equal(report.pointersPublished, 130);
  assert.ok(requestSizes.length > 1);
  assert.ok(requestSizes.every((size) => size <= 129));
  assert.ok(attestationTargetSizes.length > 1);
  assert.ok(attestationTargetSizes.every((size) => size <= 32));
});

test("publication indexes an ordinary citation without fetching mixed LLM scope", async () => {
  const social = await directCoin("published social citation");
  const privateScope = await directCoin("unpublished prompt scope");
  const sent = carrying([social.id, privateScope.id], [
    ["scope", "llm"],
    ["scope", "llm", "targets-v1"],
    ["scope", "llm", privateScope.id],
  ]);
  const events = eventMap([sent, social, privateScope]);
  const fetchedIds = new Set<string>();
  const published: string[] = [];
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events, {
      sample: async (_urls, filter) => {
        for (const id of filter.ids ?? []) fetchedIds.add(id);
        for (const id of filter["#e"] ?? []) fetchedIds.add(id);
        return {
          hits: sampledEvents(events, filter)
            .map((event) => ({ event, relays: ["wss://relay.example"] })),
          errors: [],
        };
      },
      publishPointer: async (coordinate) => {
        published.push(coordinate);
      },
    }),
  });

  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 1);
  assert.deepEqual(published, [await quoteHash("published social citation")]);
  assert.equal(fetchedIds.has(social.id), true);
  assert.equal(fetchedIds.has(privateScope.id), false);
});

test("publication rejects a bare Coin genesis until its minter attestation is fetchable", async () => {
  const coin = await directCoin("unfinished compound Mint");
  const sent = carrying(coin.id);
  // Deliberately omit the attestation created by directCoin.
  const events = new Map([[sent.id, sent], [coin.id, coin]]);
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events),
  });

  assert.equal(report.complete, false);
  assert.equal(report.pointersPublished, 0);
  assert.ok(report.failures.some((failure) =>
    failure.stage === "target-missing" && failure.targetNodeId === coin.id
  ));
});

test("third-party attestation floods cannot crowd out a noncanonical minter attestation", async () => {
  const coin = await directCoin("flood-resistant completion");
  const sent = carrying(coin.id);
  const valid = finalizeEvent({
    kind: 4294,
    created_at: 2,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: JSON.stringify({ message: "minted deliberately" }),
  }, minterSecretByCoin.get(coin.id)!);
  const attackers = Array.from({ length: 128 }, (_, index) => finalizeEvent({
    kind: 4294,
    created_at: 10_000 + index,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, generateSecretKey()));
  const events = new Map([sent, coin, valid, ...attackers].map((event) => [event.id, event]));
  const attestationFilters: { authors?: string[]; targets?: string[] }[] = [];
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events, {
      sample: async (_urls, filter) => {
        if (filter.kinds?.includes(4294)) {
          attestationFilters.push({ authors: filter.authors, targets: filter["#e"] });
        }
        const matching = sampledEvents(events, filter)
          .sort((left, right) => right.created_at - left.created_at)
          .slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
        return {
          hits: matching.map((event) => ({ event, relays: ["wss://relay.example"] })),
          errors: [],
        };
      },
    }),
  });

  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 1);
  assert.deepEqual(attestationFilters, [{ authors: [coin.pubkey], targets: [coin.id] }]);
});

test("publication continues after one pointer Put fails and reports retryable coverage", async () => {
  const first = await directCoin("first pointer failure");
  const second = await directCoin("second pointer succeeds");
  const sent = carrying([first.id, second.id]);
  const events = eventMap([sent, first, second]);
  const failedCoordinate = await verifiedCoinCoordinate(first, [minterAttestation(first)]);
  const attempts: string[] = [];
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events, {
      publishPointer: async (coordinate) => {
        attempts.push(coordinate);
        if (coordinate === failedCoordinate) throw new Error("DHT unavailable");
      },
    }),
  });
  assert.equal(attempts.length, 2);
  assert.equal(report.pointersPublished, 1);
  assert.equal(report.complete, false);
  assert.ok(report.failures.some((failure) => failure.stage === "pointer-put"));
  assert.ok(report.failures.some((failure) => failure.targetNodeId === first.id));
});

test("publication cannot report success when rendezvous is disabled during a Put", async () => {
  const coin = await directCoin("disabled during publication");
  const sent = carrying(coin.id);
  const events = eventMap([sent, coin]);
  let enabled = true;
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events, {
      enabled: () => enabled,
      publishPointer: async () => {
        enabled = false;
      },
    }),
  });

  assert.equal(report.complete, false);
  assert.equal(report.pointersPublished, 0);
  assert.ok(report.failures.some((failure) =>
    failure.stage === "pointer-put" && /disabled during/.test(failure.error)
  ));
});

test("a redundant relay failure is terminal once every valid citation has coverage", async () => {
  const coin = await directCoin("redundant relay coverage");
  const sent = carrying(coin.id);
  const events = eventMap([sent, coin]);
  const report = await publishSentCoinCitations(sent, {
    adapters: adaptersForEvents(events, {
      publicationRelayUrls: () => ["wss://down.example", "wss://relay.example"],
      sample: async (urls, filter) => urls[0] === "wss://down.example"
        ? { hits: [], errors: [{ url: urls[0], error: "offline" }] }
        : {
            hits: sampledEvents(events, filter).map((event) => ({ event, relays: urls })),
            errors: [],
          },
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 1);
  assert.ok(report.failures.some((failure) => failure.relayUrl === "wss://down.example"));
});

test("signed non-Coin citations are terminal while missing targets remain retryable", async () => {
  const notCoin = carrying("1".repeat(64));
  const terminal = carrying(notCoin.id);
  const terminalEvents = new Map([terminal, notCoin].map((event) => [event.id, event]));
  const terminalReport = await publishSentCoinCitations(terminal, {
    adapters: adaptersForEvents(terminalEvents),
  });
  assert.equal(terminalReport.complete, true);
  assert.equal(terminalReport.pointersPublished, 0);

  const missing = carrying("2".repeat(64));
  const retryable = await publishSentCoinCitations(missing, {
    adapters: adaptersForEvents(new Map([[missing.id, missing]])),
  });
  assert.equal(retryable.complete, false);
  assert.ok(retryable.failures.some((failure) => failure.stage === "target-missing"));
});

test("discovery verifies a matching citation beyond the old aggregate caps", async () => {
  const coin = await directCoin("late matching citation");
  const filler = Array.from({ length: 140 }, (_, index) => index.toString(16).padStart(64, "0"));
  const sent = carrying([...filler, coin.id]);
  const events = eventMap([sent, coin]);
  const targetRequestSizes: number[] = [];
  const attestationTargetSizes: number[] = [];
  const candidates = await discoverCoinCitations("late matching citation", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [{ eventId: sent.id, relayUrl: "wss://relay.example" }],
      sample: async (_urls, filter) => {
        if (!filter.ids?.includes(sent.id)) {
          targetRequestSizes.push(filter.ids?.length ?? filter["#e"]?.length ?? 0);
        }
        if (filter.kinds?.includes(4294)) {
          attestationTargetSizes.push(filter["#e"]?.length ?? 0);
        }
        return {
          hits: sampledEvents(events, filter)
            .map((event) => ({ event, relays: ["wss://relay.example"] })),
          errors: [],
        };
      },
    }),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.targetNodeId, coin.id);
  assert.ok(targetRequestSizes.length > 1);
  assert.ok(targetRequestSizes.every((size) => size <= 128));
  assert.ok(attestationTargetSizes.every((size) => size <= 32));
});

test("discovery finds an ordinary citation without fetching mixed LLM scope", async () => {
  const social = await directCoin("discovered social citation");
  const privateScope = await directCoin("undiscovered prompt scope");
  const sent = carrying([social.id, privateScope.id], [
    ["scope", "llm"],
    ["scope", "llm", "targets-v1"],
    ["scope", "llm", privateScope.id],
  ]);
  const events = eventMap([sent, social, privateScope]);
  const fetchedIds = new Set<string>();
  const candidates = await discoverCoinCitations("discovered social citation", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [{ eventId: sent.id, relayUrl: "wss://relay.example" }],
      sample: async (_urls, filter) => {
        for (const id of filter.ids ?? []) fetchedIds.add(id);
        for (const id of filter["#e"] ?? []) fetchedIds.add(id);
        return {
          hits: sampledEvents(events, filter)
            .map((event) => ({ event, relays: ["wss://relay.example"] })),
          errors: [],
        };
      },
    }),
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.targetNodeId, social.id);
  assert.equal(fetchedIds.has(social.id), true);
  assert.equal(fetchedIds.has(privateScope.id), false);
});

test("discovery merges relay locations for one carrying event", async () => {
  const coin = await directCoin("one carrying event on two relays");
  const sent = carrying(coin.id);
  const events = eventMap([sent, coin]);
  const candidates = await discoverCoinCitations("one carrying event on two relays", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [
        { eventId: sent.id, relayUrl: "wss://relay-b.example" },
        { eventId: sent.id, relayUrl: "wss://relay-a.example" },
      ],
      sample: async (urls, filter) => ({
        hits: sampledEvents(events, filter).map((event) => ({ event, relays: urls })),
        errors: [],
      }),
    }),
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.relayUrls, [
    "wss://relay-a.example",
    "wss://relay-b.example",
  ]);
  assert.deepEqual(candidates[0]?.targetNodeIds, [coin.id]);
});

test("discovery aggregates an exact Coin cited after an earlier coordinate match", async () => {
  const normalizedVariant = await directCoin("same\nphrase");
  const exact = await directCoin("same phrase");
  const filler = Array.from(
    { length: 128 },
    (_, index) => (index + 1).toString(16).padStart(64, "0"),
  );
  const sent = carrying([normalizedVariant.id, ...filler, exact.id]);
  const events = eventMap([sent, normalizedVariant, exact]);
  const candidates = await discoverCoinCitations("same phrase", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [{ eventId: sent.id, relayUrl: "wss://relay.example" }],
    }),
  });

  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.targetNodeIds, [normalizedVariant.id, exact.id]);
  assert.equal(candidates[0]?.targetNodeIds.includes(exact.id), true);
});

test("discovery rejects a DHT candidate whose Coin has no minter attestation", async () => {
  const coin = await directCoin("bare discovery target");
  const sent = carrying(coin.id);
  const events = new Map([[sent.id, sent], [coin.id, coin]]);
  const candidates = await discoverCoinCitations("bare discovery target", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [{ eventId: sent.id, relayUrl: "wss://relay.example" }],
    }),
  });
  assert.deepEqual(candidates, []);
});

test("discovery propagates AbortSignal into an in-flight relay query", async () => {
  const controller = new AbortController();
  const pointer = { eventId: "a".repeat(64), relayUrl: "wss://relay.example" };
  const pending = discoverCoinCitations("cancel me", {
    signal: controller.signal,
    adapters: adaptersForEvents(new Map(), {
      lookupPointers: async () => [pointer],
      sample: async (_urls, _filter, _timeout, bounds) => new Promise((_, reject) => {
        bounds.signal?.addEventListener("abort", () => reject(bounds.signal?.reason), { once: true });
      }),
    }),
  });
  controller.abort(new Error("modal closed"));
  await assert.rejects(pending, /modal closed/);
});
