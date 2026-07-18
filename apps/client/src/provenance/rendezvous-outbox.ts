import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

const DB_NAME = "zine-rendezvous-outbox";
const DB_VERSION = 1;
const EVENTS_STORE = "events";
const META_STORE = "meta";
const USAGE_KEY = "usage";
const HEX_64 = /^[0-9a-f]{64}$/;

/** The queue stores immutable event ids, not complete trace snapshots. Send has
 * already published the exact signed event before enqueue, so a retry can fetch
 * those bytes from the configured relays without duplicating them in browser
 * storage. Byte backpressure remains explicit instead of discarding old work. */
export const MAX_RENDEZVOUS_OUTBOX_BYTES = 16 * 1024 * 1024;

export interface PendingRendezvousEvent {
  eventId: string;
  queuedAt: number;
}

export interface RendezvousOutboxStorage {
  add(record: PendingRendezvousEvent): Promise<"added" | "exists">;
  remove(eventId: string): Promise<void>;
  list(): Promise<PendingRendezvousEvent[]>;
}

interface OutboxUsage {
  key: typeof USAGE_KEY;
  totalBytes: number;
  count: number;
}

function recordBytes(record: PendingRendezvousEvent): number {
  return new TextEncoder().encode(JSON.stringify(record)).byteLength;
}

function validateRecord(value: unknown, index: number): PendingRendezvousEvent {
  const record = value as Partial<PendingRendezvousEvent>;
  if (!HEX_64.test(record.eventId ?? "") || !Number.isFinite(record.queuedAt)) {
    throw new Error(`the rendezvous publication outbox contains an invalid event id at index ${index}`);
  }
  return { eventId: record.eventId!, queuedAt: record.queuedAt! };
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

/** Transactional O(1) enqueue/remove for the desktop webview. No operation
 * serializes or scans the rest of the queue on the UI thread. */
class IndexedDbRendezvousOutbox implements RendezvousOutboxStorage {
  private database: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    if (typeof indexedDB === "undefined") {
      throw new Error("durable rendezvous storage is unavailable in this runtime");
    }
    this.database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          db.createObjectStore(EVENTS_STORE, { keyPath: "eventId" });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("could not open rendezvous outbox"));
      request.onblocked = () => reject(new Error("rendezvous outbox upgrade is blocked"));
    });
    return this.database;
  }

  async add(record: PendingRendezvousEvent): Promise<"added" | "exists"> {
    const db = await this.open();
    const transaction = db.transaction([EVENTS_STORE, META_STORE], "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const meta = transaction.objectStore(META_STORE);
    const existing = await requestResult(events.get(record.eventId));
    if (existing) {
      await done;
      return "exists";
    }
    const usage = (await requestResult(meta.get(USAGE_KEY)) as OutboxUsage | undefined) ?? {
      key: USAGE_KEY,
      totalBytes: 0,
      count: 0,
    };
    const bytes = recordBytes(record);
    if (usage.totalBytes + bytes > MAX_RENDEZVOUS_OUTBOX_BYTES) {
      transaction.abort();
      await done.catch(() => undefined);
      throw new Error(
        `rendezvous outbox is full (${usage.totalBytes} of ${MAX_RENDEZVOUS_OUTBOX_BYTES} bytes); indexing must catch up before Send can complete`,
      );
    }
    events.add(record);
    meta.put({
      key: USAGE_KEY,
      totalBytes: usage.totalBytes + bytes,
      count: usage.count + 1,
    } satisfies OutboxUsage);
    await done;
    return "added";
  }

  async remove(eventId: string): Promise<void> {
    const db = await this.open();
    const transaction = db.transaction([EVENTS_STORE, META_STORE], "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const meta = transaction.objectStore(META_STORE);
    const existing = await requestResult(events.get(eventId)) as PendingRendezvousEvent | undefined;
    if (existing) {
      const usage = (await requestResult(meta.get(USAGE_KEY)) as OutboxUsage | undefined) ?? {
        key: USAGE_KEY,
        totalBytes: recordBytes(existing),
        count: 1,
      };
      events.delete(eventId);
      meta.put({
        key: USAGE_KEY,
        totalBytes: Math.max(0, usage.totalBytes - recordBytes(existing)),
        count: Math.max(0, usage.count - 1),
      } satisfies OutboxUsage);
    }
    await done;
  }

  async list(): Promise<PendingRendezvousEvent[]> {
    const db = await this.open();
    const transaction = db.transaction(EVENTS_STORE, "readonly");
    const done = transactionDone(transaction);
    const records = await requestResult(transaction.objectStore(EVENTS_STORE).getAll()) as unknown[];
    await done;
    return records.map(validateRecord)
      .sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    if (database) (await database).close();
  }
}

/** In-memory adapter for deterministic unit tests. Production uses IndexedDB. */
export class MemoryRendezvousOutbox implements RendezvousOutboxStorage {
  readonly records = new Map<string, PendingRendezvousEvent>();
  private totalBytes = 0;

  constructor(private readonly maxBytes = MAX_RENDEZVOUS_OUTBOX_BYTES) {}

  async add(record: PendingRendezvousEvent): Promise<"added" | "exists"> {
    if (this.records.has(record.eventId)) return "exists";
    const bytes = recordBytes(record);
    if (this.totalBytes + bytes > this.maxBytes) {
      throw new Error("rendezvous outbox is full; indexing must catch up before Send can complete");
    }
    this.records.set(record.eventId, record);
    this.totalBytes += bytes;
    return "added";
  }

  async remove(eventId: string): Promise<void> {
    const existing = this.records.get(eventId);
    if (!existing) return;
    this.records.delete(eventId);
    this.totalBytes = Math.max(0, this.totalBytes - recordBytes(existing));
  }

  async list(): Promise<PendingRendezvousEvent[]> {
    return [...this.records.values()].map(validateRecord)
      .sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));
  }
}

let defaultStorage: RendezvousOutboxStorage | null = null;

function productionStorage(): RendezvousOutboxStorage {
  defaultStorage ??= new IndexedDbRendezvousOutbox();
  return defaultStorage;
}

/** Factory reset owns every install-local queue, including IndexedDB state
 * that localStorage.clear() cannot reach. */
export async function clearRendezvousOutbox(): Promise<void> {
  if (defaultStorage instanceof IndexedDbRendezvousOutbox) {
    await defaultStorage.close();
  }
  defaultStorage = null;
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("could not clear rendezvous outbox"));
    request.onblocked = () => reject(new Error("clearing the rendezvous outbox is blocked"));
  });
}

/** Persist a carrying event id after the exact signed event has reached at
 * least one configured publication relay. */
export async function enqueueRendezvousEvent(
  event: Event,
  storage: RendezvousOutboxStorage = productionStorage(),
  now = Date.now(),
): Promise<void> {
  if (!verifyEvent(event)) {
    throw new Error("refusing to queue an invalid rendezvous event");
  }
  await storage.add({ eventId: event.id, queuedAt: now });
}

export async function removeRendezvousEvent(
  eventId: string,
  storage: RendezvousOutboxStorage = productionStorage(),
): Promise<void> {
  await storage.remove(eventId);
}

export async function pendingRendezvousEvents(
  storage: RendezvousOutboxStorage = productionStorage(),
): Promise<PendingRendezvousEvent[]> {
  return storage.list();
}

/** Drain independent Send-side indexing work without allowing one unavailable
 * relay or coordinate to starve later events. Per-id removal means a concurrent
 * enqueue can never be erased by an old whole-queue snapshot. */
export async function drainRendezvousEvents(
  process: (eventId: string) => Promise<boolean>,
  storage: RendezvousOutboxStorage = productionStorage(),
): Promise<{ pending: number; completed: number }> {
  const records = await storage.list();
  let completed = 0;
  for (const record of records) {
    try {
      if (await process(record.eventId)) {
        await storage.remove(record.eventId);
        completed++;
      }
    } catch {
      // Retryable failures remain durable for the next pass.
    }
  }
  return { pending: (await storage.list()).length, completed };
}
