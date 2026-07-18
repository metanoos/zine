import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { finalizeEvent } from "nostr-tools/pure";

import {
  drainRendezvousEvents,
  enqueueRendezvousEvent,
  MemoryRendezvousOutbox,
  pendingRendezvousEvents,
  removeRendezvousEvent,
} from "./rendezvous-outbox.js";

const SECRET = Uint8Array.from([...new Uint8Array(31), 1]);
const provenanceSource = readFileSync(new URL("./provenance.ts", import.meta.url), "utf8");
function event(createdAt: number) {
  return finalizeEvent({
    kind: 4290,
    created_at: createdAt,
    tags: [["z", "file"], ["q", "a".repeat(64)]],
    content: JSON.stringify({ snapshot: `event-${createdAt}` }),
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

test("rendezvous outbox applies byte backpressure without discarding old Sends", async () => {
  const first = event(1);
  const store = new MemoryRendezvousOutbox(100);
  await enqueueRendezvousEvent(first, store, 10);
  await assert.rejects(enqueueRendezvousEvent(event(2), store, 20), /outbox is full/);
  assert.deepEqual((await pendingRendezvousEvents(store)).map((record) => record.eventId), [first.id]);
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
  store.records.set("bad", { eventId: "bad", queuedAt: 1 });
  await assert.rejects(pendingRendezvousEvents(store), /invalid event id/);
});

test("Send awaits durable enqueue and surfaces partial-success storage failures", () => {
  const queue = provenanceSource.match(
    /async function queueRendezvousPublication[\s\S]*?(?=function rendezvousQueueFailure)/,
  )?.[0];
  const send = provenanceSource.match(
    /export async function sendStep[\s\S]*?(?=\/\*\* Publish one exact historical node)/,
  )?.[0];
  assert.ok(queue);
  assert.ok(send);
  assert.match(queue, /await enqueueRendezvousEvent\(event\)/);
  assert.match(send, /await queueRendezvousPublication\(event\)/);
  assert.match(send, /if \(queueError\) throw rendezvousQueueFailure\(event\.id, queueError\)/);
});
