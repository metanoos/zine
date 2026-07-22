import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { finalizeEvent } from "nostr-tools/pure";
import type { Event as NostrEvent } from "nostr-tools";

import {
  captureRendezvousOutboxSession,
  drainRendezvousEvents,
  enqueueRendezvousEvent,
  IndexedDbRendezvousOutbox,
  MemoryRendezvousOutbox,
  pendingRendezvousEvents,
  removeRendezvousEvent,
} from "./rendezvous-outbox.js";
import {
  activateVaultStorage,
  deactivateVaultStorage,
  fenceVaultStorageSession,
} from "../storage/vault-storage.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const KEY_A = new Uint8Array(32).fill(0x11);
const KEY_B = new Uint8Array(32).fill(0x22);
const provenanceSource = readFileSync(new URL("./provenance.ts", import.meta.url), "utf8");

class FakeStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, String(value)); }
}

function event(createdAt: number) {
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [["z", "file"], ["x", "a".repeat(64)]],
    content: JSON.stringify({
      snapshot: `coin-${createdAt}`,
      coin: { version: 1, origin: { kind: "direct" } },
    }),
  }, SECRET);
}

function completionAttestation(coin: NostrEvent): NostrEvent {
  return finalizeEvent({
    kind: 4294,
    created_at: coin.created_at,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", coin.pubkey]],
    content: "{}",
  }, SECRET);
}

test("rendezvous outbox preserves event ids until explicit completion", async () => {
  const store = new MemoryRendezvousOutbox();
  const first = event(1);
  const second = event(2);
  await enqueueRendezvousEvent(first, store, 10);
  await enqueueRendezvousEvent(second, store, 20);
  await enqueueRendezvousEvent(first, store, 30);
  assert.deepEqual((await pendingRendezvousEvents(store)).map((record) => record.eventId), [first.id, second.id]);
  await removeRendezvousEvent(first.id, store);
  assert.deepEqual((await pendingRendezvousEvents(store)).map((record) => record.eventId), [second.id]);
});

test("rendezvous outbox retains proven pair relays across configuration churn", async () => {
  const store = new MemoryRendezvousOutbox();
  const coin = event(9);
  const oldRelay = "wss://old.example";
  const additionalRelay = "wss://mirror.example";
  await enqueueRendezvousEvent(
    coin,
    store,
    10,
    captureRendezvousOutboxSession(),
    [oldRelay],
  );
  await enqueueRendezvousEvent(
    coin,
    store,
    20,
    captureRendezvousOutboxSession(),
    [additionalRelay],
  );
  assert.deepEqual(await pendingRendezvousEvents(store), [{
    eventId: coin.id,
    queuedAt: 10,
    relayUrls: [oldRelay, additionalRelay],
  }]);
  let observed: readonly string[] = [];
  await drainRendezvousEvents(async (_eventId, provenRelayUrls) => {
    observed = provenRelayUrls;
    return false;
  }, store);
  assert.deepEqual(observed, [oldRelay, additionalRelay]);
});

test("rendezvous outbox durably returns the exact completion attestation to retry", async () => {
  const store = new MemoryRendezvousOutbox();
  const coin = event(10);
  const attestation = completionAttestation(coin);
  await enqueueRendezvousEvent(
    coin,
    store,
    10,
    captureRendezvousOutboxSession(),
    ["wss://old.example"],
    attestation,
  );
  assert.equal(
    (await pendingRendezvousEvents(store))[0]?.completionAttestation?.id,
    attestation.id,
  );
  let observed: NostrEvent | undefined;
  await drainRendezvousEvents(async (_eventId, _relayUrls, storedAttestation) => {
    observed = storedAttestation;
    return false;
  }, store);
  assert.deepEqual(observed, attestation);
});

test("rendezvous outbox does not expire work that has never reached the DHT", async () => {
  const store = new MemoryRendezvousOutbox();
  await enqueueRendezvousEvent(event(1), store, 1_000);
  assert.equal((await pendingRendezvousEvents(store)).length, 1);
});

test("rendezvous outbox has no artificial event-count limit", async () => {
  const store = new MemoryRendezvousOutbox();
  for (let index = 0; index < 257; index++) {
    await enqueueRendezvousEvent(event(index + 1), store, index + 1);
  }
  assert.equal((await pendingRendezvousEvents(store)).length, 257);
});

test("rendezvous outbox applies byte backpressure without discarding completed Mints", async () => {
  const first = event(1);
  const store = new MemoryRendezvousOutbox(100);
  await enqueueRendezvousEvent(first, store, 10);
  await assert.rejects(enqueueRendezvousEvent(event(2), store, 20), /outbox is full/);
  assert.deepEqual((await pendingRendezvousEvents(store)).map((record) => record.eventId), [first.id]);
});

test("removing a scoped record releases exactly its accounted quota", async () => {
  const first = event(1);
  const firstRecord = { eventId: first.id, queuedAt: 10 };
  const exactBytes = new TextEncoder().encode(JSON.stringify(firstRecord)).byteLength;
  const store = new MemoryRendezvousOutbox(exactBytes);
  await enqueueRendezvousEvent(first, store, firstRecord.queuedAt);
  await removeRendezvousEvent(first.id, store);
  await enqueueRendezvousEvent(event(2), store, 20);
  assert.equal((await pendingRendezvousEvents(store)).length, 1);
});

test("rendezvous outbox drains terminal work and retains independent retryable failures", async () => {
  const store = new MemoryRendezvousOutbox();
  const completed = event(1);
  const retryable = event(2);
  const failed = event(3);
  await enqueueRendezvousEvent(completed, store, 10);
  await enqueueRendezvousEvent(retryable, store, 20);
  await enqueueRendezvousEvent(failed, store, 30);

  const report = await drainRendezvousEvents(async (eventId) => {
    if (eventId === failed.id) throw new Error("offline");
    return eventId === completed.id;
  }, store);
  assert.deepEqual(report, { pending: 2, completed: 1 });
  assert.deepEqual(
    (await pendingRendezvousEvents(store)).map((record) => record.eventId),
    [retryable.id, failed.id],
  );
});

test("Mint-side retry completes without any later Cite or Send", async () => {
  const store = new MemoryRendezvousOutbox();
  const coin = event(41);
  let now = 1_000;
  assert.equal(coin.tags.some((tag) => tag[0] === "q"), false);
  await enqueueRendezvousEvent(coin, store, 10);
  assert.deepEqual(
    await drainRendezvousEvents(
      async () => false,
      store,
      captureRendezvousOutboxSession(),
      { now: () => now },
    ),
    { pending: 1, completed: 0 },
  );
  assert.deepEqual(await pendingRendezvousEvents(store), [{
    eventId: coin.id,
    queuedAt: 10,
    retryAttempts: 1,
    nextAttemptAt: 6_000,
  }]);
  let attempts = 0;
  assert.deepEqual(
    await drainRendezvousEvents(
      async (eventId) => {
        attempts++;
        return eventId === coin.id;
      },
      store,
      captureRendezvousOutboxSession(),
      { now: () => now },
    ),
    { pending: 1, completed: 0 },
  );
  assert.equal(attempts, 0, "durable backoff survives independent drain invocations");
  now = 6_000;
  assert.deepEqual(
    await drainRendezvousEvents(
      async (eventId) => eventId === coin.id,
      store,
      captureRendezvousOutboxSession(),
      { now: () => now },
    ),
    { pending: 0, completed: 1 },
  );
});

test("bounded drains rotate slow failures and reach later and concurrently enqueued Coins", async () => {
  const store = new MemoryRendezvousOutbox();
  const oldest = event(51);
  const middle = event(52);
  const newest = event(53);
  const concurrent = event(54);
  await enqueueRendezvousEvent(oldest, store, 10);
  await enqueueRendezvousEvent(middle, store, 20);
  await enqueueRendezvousEvent(newest, store, 30);

  let now = 1_000;
  const firstPass: string[] = [];
  assert.deepEqual(
    await drainRendezvousEvents(
      async (eventId) => {
        firstPass.push(eventId);
        if (firstPass.length === 1) {
          await enqueueRendezvousEvent(concurrent, store, 40);
        }
        now += 6;
        return false;
      },
      store,
      captureRendezvousOutboxSession(),
      { maxRecords: 8, maxDurationMs: 10, now: () => now },
    ),
    { pending: 4, completed: 0 },
  );
  assert.deepEqual(firstPass, [oldest.id, newest.id]);

  const secondPass: string[] = [];
  assert.deepEqual(
    await drainRendezvousEvents(
      async (eventId) => {
        secondPass.push(eventId);
        return true;
      },
      store,
      captureRendezvousOutboxSession(),
      { maxRecords: 8, maxDurationMs: 10, now: () => now },
    ),
    { pending: 2, completed: 2 },
  );
  assert.deepEqual(secondPass, [middle.id, concurrent.id]);

  now = 6_012;
  assert.deepEqual(
    await drainRendezvousEvents(
      async () => true,
      store,
      captureRendezvousOutboxSession(),
      { now: () => now },
    ),
    { pending: 0, completed: 2 },
  );
});

test("a drain never erases an event enqueued while network work is in flight", async () => {
  const store = new MemoryRendezvousOutbox();
  const first = event(1);
  const concurrent = event(2);
  await enqueueRendezvousEvent(first, store, 10);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let processing!: () => void;
  const started = new Promise<void>((resolve) => { processing = resolve; });
  const drain = drainRendezvousEvents(async () => {
    processing();
    await blocked;
    return true;
  }, store);
  await started;
  await enqueueRendezvousEvent(concurrent, store, 20);
  release();
  assert.deepEqual(await drain, { pending: 1, completed: 1 });
  assert.deepEqual((await pendingRendezvousEvents(store)).map((record) => record.eventId), [concurrent.id]);
});

test("rendezvous outbox rejects corrupt records instead of dropping them", async () => {
  const store = new MemoryRendezvousOutbox();
  store.records.set("browser", new Map([["bad", { eventId: "bad", queuedAt: 1 }]]));
  await assert.rejects(pendingRendezvousEvents(store), /invalid event id/);
});

test("rendezvous outbox rejects incomplete or unbounded retry metadata", async () => {
  const store = new MemoryRendezvousOutbox();
  const coin = event(55);
  store.records.set("browser", new Map([[coin.id, {
    eventId: coin.id,
    queuedAt: 1,
    retryAttempts: 1,
  }]]));
  await assert.rejects(pendingRendezvousEvents(store), /invalid event id/);
  store.records.set("browser", new Map([[coin.id, {
    eventId: coin.id,
    queuedAt: 1,
    retryAttempts: 33,
    nextAttemptAt: 1,
  }]]));
  await assert.rejects(pendingRendezvousEvents(store), /invalid event id/);
});

// Forgery vectors for the durable completion attestation. Each case mutates
// exactly one field of a valid same-minter attestation and asserts the outbox
// rejects it — at enqueue time (signature/structure-aware) or at load time
// (via pendingRendezvousEvents -> validateRecord). The cross-minter case is
// covered by the explicit pubkey-binding check at enqueue.
test("rendezvous outbox rejects forged completion attestations at enqueue", async () => {
  const baseCoin = event(71);
  const cloneTags = (attestation: NostrEvent) =>
    attestation.tags.map((tag) => [...tag] as string[]);

  const vectors: Array<[string, (attestation: NostrEvent) => NostrEvent]> = [
    // Re-sign with the same key after mutating a structural field, so the
    // signature is valid and only validateCompletionAttestation's structural
    // checks can catch the forgery.
    ["wrong kind", (a) => reSigned(a, { kind: 4293 })],
    ["two e targets", (a) => reSigned(a, { tags: [...cloneTags(a), ["e", "1".repeat(64), "", "target"]] })],
    ["wrong target id", (a) => reSigned(a, { tags: [["e", "e".repeat(64), "", "target"], ...cloneTags(a).slice(1)] })],
    ["non-empty relay hint", (a) => reSigned(a, { tags: [["e", baseCoin.id, "wss://x.example", "target"], ...cloneTags(a).slice(1)] })],
    ["non-target marker", (a) => reSigned(a, { tags: [["e", baseCoin.id, "", "reply"], ...cloneTags(a).slice(1)] })],
    ["wrong k value", (a) => reSigned(a, { tags: [cloneTags(a)[0]!, ["k", "1"], ...cloneTags(a).slice(2)] })],
    ["second p tag", (a) => reSigned(a, { tags: [...cloneTags(a), ["p", "e".repeat(64)]] })],
    ["p tag mismatched from pubkey", (a) => reSigned(a, { tags: [cloneTags(a)[0]!, cloneTags(a)[1]!, ["p", "e".repeat(64)]] })],
    ["two g tags", (a) => reSigned(a, { tags: [...cloneTags(a), ["g", "x"], ["g", "y"]] })],
    ["unknown tag", (a) => reSigned(a, { tags: [...cloneTags(a), ["surprise", "x"]] })],
    ["array content", (a) => reSigned(a, { content: "[1,2]" })],
    ["object content with unknown key", (a) => reSigned(a, { content: JSON.stringify({ a: 1 }) })],
  ];

  for (const [label, mutate] of vectors) {
    const store = new MemoryRendezvousOutbox();
    const forged = mutate(completionAttestation(baseCoin));
    await assert.rejects(
      enqueueRendezvousEvent(baseCoin, store, 10, undefined, [], forged),
      /invalid completion attestation at index 0|refusing to queue a completion attestation/,
      `forgery vector "${label}" must be rejected`,
    );
    assert.equal((await pendingRendezvousEvents(store)).length, 0, `"${label}" must not be persisted`);
  }
});

test("rendezvous outbox rejects a completion attestation signed by another minter", async () => {
  const coin = event(72);
  const foreignSecret = Uint8Array.from([...new Uint8Array(31), 9]);
  // The attestation is validly signed by the foreign key, with a p tag matching
  // the foreign pubkey (so validateCompletionAttestation's self-consistency
  // check passes). It targets the coin id with the right shape. Only the
  // cross-minter check (attestation.pubkey !== coin.pubkey) catches the forgery.
  const { getPublicKey } = await import("nostr-tools/pure");
  const foreignPubkey = getPublicKey(foreignSecret);
  const foreignAttestation = finalizeEvent({
    kind: 4294,
    created_at: coin.created_at,
    tags: [["e", coin.id, "", "target"], ["k", "4290"], ["p", foreignPubkey]],
    content: "{}",
  }, foreignSecret);
  const store = new MemoryRendezvousOutbox();
  await assert.rejects(
    enqueueRendezvousEvent(coin, store, 10, undefined, [], foreignAttestation),
    /refusing to queue a completion attestation from another minter/,
  );
  assert.equal((await pendingRendezvousEvents(store)).length, 0);
});

// Helper for the forgery vectors: re-sign an event after mutating one field.
// Re-signing keeps the signature valid so the structural validators (kind, tag
// shape, content shape) are the only thing that can catch each forgery.
function reSigned(
  original: NostrEvent,
  patch: Partial<{ kind: number; tags: string[][]; content: string }>,
): NostrEvent {
  return finalizeEvent({
    kind: patch.kind ?? original.kind,
    created_at: original.created_at,
    tags: (patch.tags ?? original.tags.map((tag) => [...tag])) as never,
    content: patch.content ?? original.content,
  }, SECRET);
}

test("rendezvous outbox rejects invalid relay locators on load", async () => {
  const coin = event(81);
  const vectors: Array<[string, unknown]> = [
    ["non-array relayUrls", "not-an-array"],
    ["too many entries", Array(33).fill("wss://relay.example")],
    ["oversized entry", [`wss://relay.example/${"a".repeat(2_100)}`]],
    ["non-websocket protocol", ["ftp://relay.example"]],
    ["http protocol", ["http://relay.example"]],
    ["userinfo credentials", ["wss://user:pass@relay.example"]],
    ["malformed url", ["wss://[::1"]],
    ["loopback literal", ["ws://127.0.0.1:4869"]],
    ["private ip literal", ["ws://192.168.1.1:4869"]],
    ["onion hostname", ["ws://abc.onion"]],
    ["empty string", [""]],
  ];
  for (const [label, relayUrls] of vectors) {
    const store = new MemoryRendezvousOutbox();
    store.records.set("browser", new Map([[coin.id, {
      eventId: coin.id,
      queuedAt: 1,
      relayUrls: relayUrls as never,
    }]]));
    await assert.rejects(
      pendingRendezvousEvents(store),
      /relay locator/,
      `corrupt-row vector "${label}" must be rejected`,
    );
  }
});

test("rendezvous outbox rejects invalid proven relay URLs at enqueue before writing", async () => {
  const coin = event(82);
  for (const url of ["ftp://relay.example", "wss://user:pass@relay.example", "ws://127.0.0.1:4869", "ws://abc.onion"]) {
    const store = new MemoryRendezvousOutbox();
    await assert.rejects(
      enqueueRendezvousEvent(coin, store, 10, undefined, [url]),
      /relay locator/,
    );
    assert.equal((await pendingRendezvousEvents(store)).length, 0, `${url} must not be persisted`);
  }
});

test("vaults independently enqueue and drain even when they Send the same event id", async () => {
  const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: new FakeStorage(),
    configurable: true,
    writable: true,
  });
  const store = new MemoryRendezvousOutbox();
  const shared = event(10);
  try {
    activateVaultStorage("vault-a", KEY_A);
    const sessionA = captureRendezvousOutboxSession();
    await enqueueRendezvousEvent(shared, store, 10, sessionA);

    activateVaultStorage("vault-b", KEY_B);
    const sessionB = captureRendezvousOutboxSession();
    await enqueueRendezvousEvent(shared, store, 20, sessionB);

    assert.deepEqual(await pendingRendezvousEvents(store, sessionA), [{
      eventId: shared.id,
      queuedAt: 10,
    }]);
    assert.deepEqual(await pendingRendezvousEvents(store, sessionB), [{
      eventId: shared.id,
      queuedAt: 20,
    }]);

    assert.deepEqual(
      await drainRendezvousEvents(async () => true, store, sessionB),
      { pending: 0, completed: 1 },
    );
    assert.equal((await pendingRendezvousEvents(store, sessionA)).length, 1);
  } finally {
    deactivateVaultStorage();
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        value: previousStorage,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test("a delayed vault-A drain cannot complete or remove work after vault B activates", async () => {
  const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: new FakeStorage(),
    configurable: true,
    writable: true,
  });
  const store = new MemoryRendezvousOutbox();
  const pending = event(11);
  let release!: () => void;
  let markStarted!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  try {
    activateVaultStorage("vault-a", KEY_A);
    const sessionA = captureRendezvousOutboxSession();
    await enqueueRendezvousEvent(pending, store, 10, sessionA);
    const drain = drainRendezvousEvents(async () => {
      markStarted();
      await blocked;
      return true;
    }, store, sessionA);
    await started;

    activateVaultStorage("vault-b", KEY_B);
    release();

    assert.deepEqual(await drain, { pending: 1, completed: 0 });
    assert.deepEqual(await pendingRendezvousEvents(store, sessionA), [{
      eventId: pending.id,
      queuedAt: 10,
    }]);
    assert.deepEqual(await pendingRendezvousEvents(store), []);
  } finally {
    release?.();
    deactivateVaultStorage();
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        value: previousStorage,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test("work captured after the pre-lock fence cannot begin a new drain", async () => {
  const previousStorage = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: new FakeStorage(),
    configurable: true,
    writable: true,
  });
  const store = new MemoryRendezvousOutbox();
  const pending = event(12);
  try {
    activateVaultStorage("vault-a", KEY_A);
    await enqueueRendezvousEvent(pending, store, 10);
    fenceVaultStorageSession();
    const closingSession = captureRendezvousOutboxSession();
    let processed = 0;
    const report = await drainRendezvousEvents(async () => {
      processed++;
      return true;
    }, store, closingSession);
    assert.equal(processed, 0);
    assert.deepEqual(report, { pending: 1, completed: 0 });
  } finally {
    deactivateVaultStorage();
    if (previousStorage) {
      Object.defineProperty(globalThis, "localStorage", {
        value: previousStorage,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    }
  }
});

test("a transient IndexedDB open failure is retried instead of cached forever", async () => {
  let opens = 0;
  const factory = {
    open() {
      opens++;
      const request = { error: new Error(`open failed ${opens}`) } as unknown as IDBOpenDBRequest;
      queueMicrotask(() => request.onerror?.(new Event("error")));
      return request;
    },
  } as Pick<IDBFactory, "open">;
  const storage = new IndexedDbRendezvousOutbox(factory);

  await assert.rejects(storage.list("vault-test"), /open failed 1/);
  await assert.rejects(storage.list("vault-test"), /open failed 2/);
  await storage.close();
  assert.equal(opens, 2);
});

test("completed Mint durably enqueues after the public completion pair", () => {
  const queue = provenanceSource.match(
    /async function queueCompletedMintRendezvous[\s\S]*?(?=function scheduleRendezvousPublication)/,
  )?.[0];
  const send = provenanceSource.match(
    /export async function sendStep[\s\S]*?(?=\/\*\* Publish one exact historical node)/,
  )?.[0];
  const mint = provenanceSource.match(
    /export async function completeCoinMint[\s\S]*?(?=\/\*\* Step the immutable)/,
  )?.[0];
  assert.ok(queue);
  assert.ok(send);
  assert.ok(mint);
  assert.match(queue, /assertRendezvousSessionCurrent\(session\)[\s\S]*?await enqueueRendezvousEvent\([\s\S]*?provenRelayUrls[\s\S]*?assertRendezvousSessionCurrent\(session\)/);
  assert.match(
    queue,
    /if \(!loadKademliaConfig\(\)\.enabled\) \{[\s\S]*?throw error;/,
    "a Coins-disable race must retain the Mint journal instead of skipping its durable index enqueue",
  );
  assert.doesNotMatch(send, /Rendezvous|rendezvous/);
  const completionAt = mint.indexOf("const completion = await attestNodeToRelays");
  const enqueueAt = mint.indexOf("await queueCompletedMintRendezvous(");
  assert.ok(completionAt >= 0 && enqueueAt > completionAt);
  assert.match(mint, /if \(rendezvousQueued\) scheduleRendezvousPublication\(coin\)/);
});

test("disabling Coins aborts an active Mint-indexing drain and retains its outbox row", () => {
  const subscription = provenanceSource.match(
    /subscribeKademliaConfig\(\(\) => \{[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(subscription);
  assert.match(subscription, /if \(loadKademliaConfig\(\)\.enabled\) return/);
  assert.match(subscription, /resetRendezvousOutboxRetry\(\)/);
  assert.match(subscription, /for \(const controller of rendezvousFlushControllers\) controller\.abort\(reason\)/);
  assert.match(subscription, /Coins disabled during rendezvous indexing/);

  const drain = provenanceSource.match(
    /export async function flushRendezvousPublicationOutbox[\s\S]*?(?=\/\*\* A completed Coin enters)/,
  )?.[0];
  assert.ok(drain);
  assert.match(drain, /retryRelayUrls = \[\.\.\.new Set\(\[\.\.\.provenRelayUrls, \.\.\.currentRelayUrls\]\)\]/);
  assert.match(drain, /publishCompletedCoinMint\(event, \{/);
  assert.match(drain, /fetchLocalEventById\(eventId, controller\.signal\)/);
  assert.doesNotMatch(drain, /fetchEventById\(eventId\)/);
  assert.match(drain, /controller\.signal\.aborted[\s\S]*?return false/);
});

// Send-side citation indexing was replaced by Mint-side Coin genesis indexing.
// The active drain contract is covered by the co-located Mint-indexing test.
