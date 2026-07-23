import { test } from "node:test";
import assert from "node:assert/strict";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Event, Filter } from "nostr-tools";

import {
  createBoundedRelaySampleCollector,
  quoteHash,
  sha256HexLocal,
  type RelaySampleBounds,
} from "./provenance.js";
import {
  discoverCompletedCoinMints,
  isPublicRendezvousRelayUrl,
  isValidTraceAttestationForTarget,
  publishCompletedCoinMint,
  type RendezvousAdapters,
  validTraceAttestationTargetId,
  verifiedCandidateFromEvents,
  verifiedCoinCoordinate,
  verifiedExtractedCoinSourceEvidence,
} from "./rendezvous.js";

const FOLDER = "f".repeat(64);

interface MintFixture {
  coin: Event;
  attestation: Event;
  secret: Uint8Array;
}

function genesisTransaction(text: string, actor: string) {
  return {
    sequence: 0,
    timestamp: 1_000,
    actor,
    changes: [{ op: "insert" as const, from: 0, to: 0, text }],
    selectionBefore: null,
    selectionAfter: null,
  };
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
      operationId: "ab".repeat(32),
      deltas: [],
      editorTransactions: [genesisTransaction(phrase, voice)],
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, secret);
  return { coin, attestation: minterAttestation(coin, secret), secret };
}

async function sourceNode(snapshot: string): Promise<Event> {
  const secret = generateSecretKey();
  const voice = getPublicKey(secret);
  const contentHash = await sha256HexLocal(snapshot);
  return finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["F", "source.md"], ["f", FOLDER], ["action", "import"]],
    content: JSON.stringify({
      snapshot,
      contentHash,
      operationId: "ef".repeat(32),
      editorTransactions: [genesisTransaction(snapshot, voice)],
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
  const sourceContent = JSON.parse(source.content) as { snapshot: string };
  const sourceHash = await sha256HexLocal(sourceContent.snapshot);
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
      editorTransactions: [genesisTransaction(phrase, voice)],
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
  return { coin, attestation: minterAttestation(coin, secret), secret };
}

function minterAttestation(coin: Event, secret: Uint8Array): Event {
  return finalizeEvent({
    kind: 4294,
    created_at: coin.created_at,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, secret);
}

function minterAttestationWithMessage(
  coin: Event,
  secret: Uint8Array,
  message: string,
  createdAt: number,
): Event {
  return finalizeEvent({
    kind: 4294,
    created_at: createdAt,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: JSON.stringify({ message }),
  }, secret);
}

function ordinaryCitation(targetId: string): Event {
  const secret = generateSecretKey();
  return finalizeEvent({
    kind: 4290,
    created_at: 2,
    tags: [
      ["z", "file"],
      ["F", "essay.md"],
      ["f", FOLDER],
      ["action", "cite"],
      ["q", targetId, ""],
    ],
    content: JSON.stringify({ snapshot: "ordinary citation", contentHash: "0".repeat(64) }),
  }, secret);
}

function sampledEvents(events: ReadonlyMap<string, Event>, filter: Filter): Event[] {
  const ids = filter.ids ? new Set(filter.ids) : null;
  const kinds = filter.kinds ? new Set(filter.kinds) : null;
  const authors = filter.authors ? new Set(filter.authors) : null;
  const targets = filter["#e"] ? new Set(filter["#e"]) : null;
  return [...events.values()].filter((event) =>
    (!ids || ids.has(event.id)) &&
    (!kinds || kinds.has(event.kind)) &&
    (!authors || authors.has(event.pubkey)) &&
    (!targets || event.tags.some((tag) => tag[0] === "e" && targets.has(tag[1] ?? "")))
  ).slice(0, filter.limit ?? Number.POSITIVE_INFINITY);
}

function adaptersForEvents(
  events: ReadonlyMap<string, Event>,
  overrides: Partial<RendezvousAdapters> = {},
): Partial<RendezvousAdapters> {
  return {
    enabled: () => true,
    publicationRelayUrls: () => ["wss://relay.example"],
    sample: async (urls, filter) => ({
      hits: sampledEvents(events, filter).map((event) => ({ event, relays: urls })),
      errors: [],
    }),
    publishPointer: async () => undefined,
    lookupPointers: async () => [],
    ...overrides,
  };
}

test("rendezvous accepts only public clearnet WebSocket relays", () => {
  assert.equal(isPublicRendezvousRelayUrl("wss://relay.example"), true);
  assert.equal(isPublicRendezvousRelayUrl("ws://127.0.0.1:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("ws://192.168.1.5:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("ws://[::ffff:127.0.0.1]:4869"), false);
  assert.equal(isPublicRendezvousRelayUrl("wss://[::ffff:8.8.8.8]"), true);
  assert.equal(isPublicRendezvousRelayUrl("wss://private.example.onion"), false);
  assert.equal(isPublicRendezvousRelayUrl("wss://secret@relay.example"), false);
  assert.equal(isPublicRendezvousRelayUrl("https://relay.example"), false);
});

test("completed Coin admission requires a valid same-minter attestation", async () => {
  const { coin, attestation } = await directMint("same\n passage");
  assert.equal(await verifiedCoinCoordinate(coin), null);
  assert.equal(await verifiedCoinCoordinate(coin, [attestation]), await quoteHash("same passage"));

  const wrongMinter = minterAttestation(coin, generateSecretKey());
  assert.equal(await verifiedCoinCoordinate(coin, [wrongMinter]), null);

  const thirdPartySecret = generateSecretKey();
  const thirdParty = finalizeEvent({
    kind: 4294,
    created_at: 2,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, thirdPartySecret);
  assert.equal(validTraceAttestationTargetId(thirdParty), coin.id);
  assert.equal(isValidTraceAttestationForTarget(coin, thirdParty), true);
  assert.equal(await verifiedCoinCoordinate(coin, [thirdParty]), null);

  const wrongAdvisoryAuthor = finalizeEvent({
    kind: 4294,
    created_at: 3,
    tags: [
      ["e", coin.id, "", "target"],
      ["k", "4290"],
      ["p", getPublicKey(thirdPartySecret)],
    ],
    content: "{}",
  }, thirdPartySecret);
  assert.equal(validTraceAttestationTargetId(wrongAdvisoryAuthor), coin.id);
  assert.equal(isValidTraceAttestationForTarget(coin, wrongAdvisoryAuthor), false);

  const wrongTarget = finalizeEvent({
    kind: 4294,
    created_at: 1,
    tags: [["e", "0".repeat(64), "", "target"], ["k", "4290"]],
    content: "{}",
  }, generateSecretKey());
  assert.equal(await verifiedCoinCoordinate(coin, [wrongTarget]), null);

  const tampered = { ...coin, content: coin.content.replace("same\\n passage", "other") };
  assert.equal(await verifiedCoinCoordinate(tampered, [attestation]), null);
});

test("extracted Mint membership does not require a public containing source", async () => {
  const source = await sourceNode("before exact passage after");
  const { coin, attestation } = await extractedMint(source, "exact passage", {
    start: 7,
    end: 20,
  });
  assert.equal(
    await verifiedCoinCoordinate(coin, [attestation]),
    await quoteHash("exact passage"),
  );
  assert.equal(await verifiedExtractedCoinSourceEvidence(coin), false);
  assert.equal(await verifiedExtractedCoinSourceEvidence(coin, source), true);
  assert.equal(
    await verifiedExtractedCoinSourceEvidence(coin, await sourceNode("exact passage")),
    false,
  );
});

test("rendezvous rejects an extracted Coin whose range cannot contain its snapshot", async () => {
  const source = await sourceNode("tiny");
  const minted = await extractedMint(source, "tiny", { start: 0, end: 1_000 });
  assert.equal(await verifiedCoinCoordinate(minted.coin, [minted.attestation]), null);
  const candidates = await discoverCompletedCoinMints("tiny", {
    adapters: adaptersForEvents(
      new Map([[minted.coin.id, minted.coin], [minted.attestation.id, minted.attestation]]),
      { lookupPointers: async () => [
        { eventId: minted.coin.id, relayUrl: "wss://relay.example" },
      ] },
    ),
  });
  assert.deepEqual(candidates, []);
});

test("Mint-side publication stores H -> completed Coin genesis without any q citation", async () => {
  const { coin, attestation } = await directMint("mint-driven coordinate");
  const events = new Map([[coin.id, coin], [attestation.id, attestation]]);
  const puts: Array<{ coordinate: string; eventId: string; relayUrl: string }> = [];
  const report = await publishCompletedCoinMint(coin, {
    adapters: adaptersForEvents(events, {
      publishPointer: async (coordinate, pointer) => {
        puts.push({ coordinate, ...pointer });
      },
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 1);
  assert.deepEqual(puts, [{
    coordinate: await quoteHash("mint-driven coordinate"),
    eventId: coin.id,
    relayUrl: "wss://relay.example",
  }]);
});

test("Mint-side retry republishes the exact durable pair before fresh verification", async () => {
  const minted = await directMint("relay lost pair");
  const relayEvents = new Map<string, Event>();
  const republished: string[] = [];
  const report = await publishCompletedCoinMint(minted.coin, {
    completionAttestation: minted.attestation,
    adapters: adaptersForEvents(relayEvents, {
      publishPair: async (relayUrls, coin, attestation) => {
        republished.push(coin.id, attestation.id);
        relayEvents.set(coin.id, coin);
        relayEvents.set(attestation.id, attestation);
        return relayUrls;
      },
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 1);
  assert.deepEqual(republished, [minted.coin.id, minted.attestation.id]);
});

test("missing or wrong-minter completion proof remains retryable and publishes no pointer", async () => {
  const { coin } = await directMint("pending mint");
  const wrongMinter = minterAttestation(coin, generateSecretKey());
  for (const events of [
    new Map([[coin.id, coin]]),
    new Map([[coin.id, coin], [wrongMinter.id, wrongMinter]]),
  ]) {
    let puts = 0;
    const report = await publishCompletedCoinMint(coin, {
      adapters: adaptersForEvents(events, {
        publishPointer: async () => { puts++; },
      }),
    });
    assert.equal(report.complete, false);
    assert.equal(puts, 0);
    assert.equal(report.failures.some((failure) => failure.stage === "coin-missing"), true);
  }
});

test("corrupt local genesis abandons the outbox row without claiming a pointer", async () => {
  const secret = generateSecretKey();
  // Kind-4290 without Coin origin metadata — never a verified Coin genesis.
  const notACoin = finalizeEvent({
    kind: 4290,
    created_at: 1,
    tags: [["z", "file"], ["F", "note.md"], ["f", FOLDER], ["action", "import"]],
    content: JSON.stringify({
      snapshot: "not a coin",
      contentHash: await sha256HexLocal("not a coin"),
      operationId: "cd".repeat(32),
      editorTransactions: [
        genesisTransaction("not a coin", getPublicKey(secret)),
      ],
    }),
  }, secret);
  let puts = 0;
  const report = await publishCompletedCoinMint(notACoin, {
    adapters: adaptersForEvents(new Map([[notACoin.id, notACoin]]), {
      publishPointer: async () => { puts++; },
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 0);
  assert.equal(puts, 0);
  assert.equal(report.failures.some((failure) => failure.stage === "pair-invalid"), true);
});

test("durable wrong-minter completion attestation abandons without claiming a pointer", async () => {
  const { coin } = await directMint("durable wrong minter");
  const wrongMinter = minterAttestation(coin, generateSecretKey());
  let puts = 0;
  const report = await publishCompletedCoinMint(coin, {
    completionAttestation: wrongMinter,
    adapters: adaptersForEvents(new Map([[coin.id, coin], [wrongMinter.id, wrongMinter]]), {
      publishPointer: async () => { puts++; },
    }),
  });
  assert.equal(report.complete, true);
  assert.equal(report.pointersPublished, 0);
  assert.equal(puts, 0);
  assert.equal(report.failures.some((failure) => failure.stage === "pair-invalid"), true);
});

test("disabled rendezvous leaves the indexing row retryable", async () => {
  const { coin, attestation } = await directMint("coins off");
  let puts = 0;
  const report = await publishCompletedCoinMint(coin, {
    completionAttestation: attestation,
    adapters: adaptersForEvents(new Map([[coin.id, coin], [attestation.id, attestation]]), {
      enabled: () => false,
      publishPointer: async () => { puts++; },
    }),
  });
  assert.equal(report.complete, false);
  assert.equal(report.pointersPublished, 0);
  assert.equal(puts, 0);
});

test("global discovery matches independent minters with different Coin ids and the same H", async () => {
  const first = await directMint("independently minted");
  const second = await directMint("  independently\n minted  ");
  assert.notEqual(first.coin.id, second.coin.id);
  const events = new Map([
    [first.coin.id, first.coin],
    [first.attestation.id, first.attestation],
    [second.coin.id, second.coin],
    [second.attestation.id, second.attestation],
  ]);
  const candidates = await discoverCompletedCoinMints("independently minted", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [
        { eventId: first.coin.id, relayUrl: "wss://relay.example" },
        { eventId: second.coin.id, relayUrl: "wss://relay.example" },
      ],
    }),
  });
  assert.deepEqual(candidates.map((candidate) => candidate.coinNodeId).sort(), [
    first.coin.id,
    second.coin.id,
  ].sort());
  assert.equal(new Set(candidates.map((candidate) => candidate.coordinate)).size, 1);
});

test("ordinary q citations alone never become rendezvous candidates", async () => {
  const minted = await directMint("cited but not pointer subject");
  const citation = ordinaryCitation(minted.coin.id);
  const events = new Map([
    [citation.id, citation],
    [minted.coin.id, minted.coin],
    [minted.attestation.id, minted.attestation],
  ]);
  const candidates = await discoverCompletedCoinMints("cited but not pointer subject", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [
        { eventId: citation.id, relayUrl: "wss://relay.example" },
      ],
    }),
  });
  assert.deepEqual(candidates, []);
});

test("discovery admits extracted Coins without sources and records public source evidence when found", async () => {
  const source = await sourceNode("prefix extracted words suffix");
  const minted = await extractedMint(source, "extracted words", { start: 7, end: 22 });
  const pointer = { eventId: minted.coin.id, relayUrl: "wss://relay.example" };
  const withoutSource = new Map([
    [minted.coin.id, minted.coin],
    [minted.attestation.id, minted.attestation],
  ]);
  const first = await discoverCompletedCoinMints("extracted words", {
    adapters: adaptersForEvents(withoutSource, { lookupPointers: async () => [pointer] }),
  });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.originKind, "extracted");
  assert.equal(first[0]?.sourceEvidenceVerified, false);

  const withSource = new Map(withoutSource);
  withSource.set(source.id, source);
  const second = await discoverCompletedCoinMints("extracted words", {
    adapters: adaptersForEvents(withSource, { lookupPointers: async () => [pointer] }),
  });
  assert.equal(second[0]?.sourceEvidenceVerified, true);
});

test("candidate verification binds the pointer directly to the completed Coin", async () => {
  const minted = await directMint("direct pointer subject");
  const coordinate = await quoteHash("direct pointer subject");
  const pointer = { eventId: minted.coin.id, relayUrl: "wss://relay.example" };
  assert.equal(
    (await verifiedCandidateFromEvents(
      pointer,
      minted.coin,
      coordinate,
      [minted.attestation],
    ))?.signerPubkey,
    minted.coin.pubkey,
  );
  const citation = ordinaryCitation(minted.coin.id);
  assert.equal(
    await verifiedCandidateFromEvents(
      { eventId: citation.id, relayUrl: pointer.relayUrl },
      citation,
      coordinate,
      [minted.attestation],
    ),
    null,
  );
});

test("discovery merges one completed Coin observed on several public relays", async () => {
  const minted = await directMint("replicated Mint");
  const events = new Map([
    [minted.coin.id, minted.coin],
    [minted.attestation.id, minted.attestation],
  ]);
  const candidates = await discoverCompletedCoinMints("replicated Mint", {
    adapters: adaptersForEvents(events, {
      lookupPointers: async () => [
        { eventId: minted.coin.id, relayUrl: "wss://a.example" },
        { eventId: minted.coin.id, relayUrl: "wss://b.example" },
      ],
    }),
  });
  assert.equal(candidates.length, 1);
  assert.deepEqual(candidates[0]?.relayUrls, ["wss://a.example", "wss://b.example"]);
});

test("rendezvous relay samples carry explicit hostile-input bounds", async () => {
  const minted = await directMint("bounded rendezvous");
  const events = new Map([
    [minted.coin.id, minted.coin],
    [minted.attestation.id, minted.attestation],
  ]);
  const observed: RelaySampleBounds[] = [];
  await publishCompletedCoinMint(minted.coin, {
    adapters: adaptersForEvents(events, {
      sample: async (urls, filter, _timeout, bounds) => {
        observed.push(bounds);
        return {
          hits: sampledEvents(events, filter).map((event) => ({ event, relays: urls })),
          errors: [],
        };
      },
    }),
  });
  assert.equal(observed.length >= 2, true);
  assert.equal(observed.every((bounds) => bounds.maxTotalBytes > 0), true);
  assert.deepEqual(observed[0]?.requestedIds, [minted.coin.id]);
});

test("bounded relay collector rejects unrequested and oversized input", async () => {
  const minted = await directMint("bounded sample");
  const unexpected = await directMint("unexpected sample");
  const bounds: RelaySampleBounds = {
    requestedIds: [minted.coin.id],
    maxUniqueEvents: 1,
    maxTotalBytes: 1_000_000,
    maxEventBytes: 500_000,
    maxContentLength: 4,
    maxTags: 100,
    maxTagValues: 8,
    maxTagValueLength: 1_000,
  };
  const unrequested = createBoundedRelaySampleCollector({ ...bounds, maxContentLength: 250_000 });
  assert.match(unrequested.accept(unexpected.coin).error ?? "", /unrequested/);
  const contentBound = createBoundedRelaySampleCollector(bounds);
  assert.match(contentBound.accept(minted.coin).error ?? "", /content exceeds/);
});

test("caller cancellation aborts a pending Kademlia lookup", async () => {
  const controller = new AbortController();
  const pending = discoverCompletedCoinMints("cancel me", {
    signal: controller.signal,
    adapters: {
      enabled: () => true,
      lookupPointers: async (_coordinate, signal) => new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    },
  });
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
});

test("one hostile relay cannot monopolize completed-Coin verification slots", async () => {
  const phrase = "relay-fair completed Mint";
  const hostile = await Promise.all(
    Array.from({ length: 63 }, () => directMint(phrase)),
  );
  const honest = await directMint(phrase);
  const hostileEvents = new Map(hostile.map((mint) => [mint.coin.id, mint.coin]));
  const honestEvents = new Map([
    [honest.coin.id, honest.coin],
    [honest.attestation.id, honest.attestation],
  ]);
  let hostileAttestationCalls = 0;
  let activeHostileAttestationCalls = 0;
  let maxActiveHostileAttestationCalls = 0;
  const candidates = await discoverCompletedCoinMints(phrase, {
    adapters: adaptersForEvents(new Map(), {
      lookupPointers: async () => [
        ...hostile.map((mint) => ({
          eventId: mint.coin.id,
          relayUrl: "wss://hostile.example",
        })),
        { eventId: honest.coin.id, relayUrl: "wss://honest.example" },
      ],
      sample: async (urls, filter) => {
        const relayUrl = urls[0]!;
        if (relayUrl === "wss://hostile.example" && filter.kinds?.includes(4294)) {
          hostileAttestationCalls++;
          activeHostileAttestationCalls++;
          maxActiveHostileAttestationCalls = Math.max(
            maxActiveHostileAttestationCalls,
            activeHostileAttestationCalls,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          activeHostileAttestationCalls--;
          return { hits: [], errors: [] };
        }
        const events = relayUrl === "wss://hostile.example" ? hostileEvents : honestEvents;
        return {
          hits: sampledEvents(events, filter).map((event) => ({ event, relays: urls })),
          errors: [],
        };
      },
    }),
  });
  assert.equal(hostileAttestationCalls, 63, "each hostile Coin receives one bounded relay query");
  assert.equal(maxActiveHostileAttestationCalls, 1);
  assert.deepEqual(candidates.map((candidate) => candidate.eventId), [honest.coin.id]);
});

test("one Coin's newer attestations cannot starve another Coin on the same relay", async () => {
  const phrase = "per-Coin attestation fairness";
  const attacker = await directMint(phrase);
  const honest = await directMint(phrase);
  const noise = Array.from({ length: 8 }, (_, index) =>
    minterAttestationWithMessage(
      attacker.coin,
      attacker.secret,
      `attacker refresh ${index}`,
      100 + index,
    )
  );
  const relayEvents = new Map<string, Event>([
    [attacker.coin.id, attacker.coin],
    [honest.coin.id, honest.coin],
    ...noise.map((event): [string, Event] => [event.id, event]),
    [honest.attestation.id, honest.attestation],
  ]);
  const attestationFilters: Filter[] = [];
  const candidates = await discoverCompletedCoinMints(phrase, {
    adapters: adaptersForEvents(relayEvents, {
      lookupPointers: async () => [
        { eventId: attacker.coin.id, relayUrl: "wss://shared.example" },
        { eventId: honest.coin.id, relayUrl: "wss://shared.example" },
      ],
      sample: async (urls, filter) => {
        if (filter.kinds?.includes(4294)) attestationFilters.push(filter);
        return {
          hits: sampledEvents(relayEvents, filter).map((event) => ({ event, relays: urls })),
          errors: [],
        };
      },
    }),
  });

  assert.ok(candidates.some((candidate) => candidate.eventId === honest.coin.id));
  assert.deepEqual(
    attestationFilters.map((filter) => [filter.authors, filter["#e"], filter.limit]),
    [
      [[attacker.coin.pubkey], [attacker.coin.id], 4],
      [[honest.coin.pubkey], [honest.coin.id], 4],
    ],
  );
});

test("internal discovery deadline returns candidates already verified by honest relays", async () => {
  const honest = await directMint("partial deadline success");
  const honestEvents = new Map([
    [honest.coin.id, honest.coin],
    [honest.attestation.id, honest.attestation],
  ]);
  const slowId = "d".repeat(64);
  const candidates = await discoverCompletedCoinMints("partial deadline success", {
    deadlineMs: 500,
    adapters: adaptersForEvents(honestEvents, {
      lookupPointers: async () => [
        { eventId: honest.coin.id, relayUrl: "wss://honest.example" },
        { eventId: slowId, relayUrl: "wss://slow.example" },
      ],
      sample: async (urls, filter, _perRelayMs, bounds) => {
        if (urls[0] !== "wss://slow.example") {
          return {
            hits: sampledEvents(honestEvents, filter).map((event) => ({ event, relays: urls })),
            errors: [],
          };
        }
        return new Promise((_, reject) => {
          const abort = () => reject(bounds.signal?.reason ?? new Error("aborted"));
          if (bounds.signal?.aborted) abort();
          else bounds.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    }),
  });
  assert.deepEqual(candidates.map((candidate) => candidate.eventId), [honest.coin.id]);
});
