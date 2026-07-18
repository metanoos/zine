import type { Event } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";

import {
  activeVaultStorageId,
  activeVaultStorageMigratesLegacy,
  vaultStorageGeneration,
  vaultStorageSessionAcceptsWork,
} from "../storage/vault-storage.js";

const DB_NAME = "zine-rendezvous-outbox";
const DB_VERSION = 2;
const LEGACY_EVENTS_STORE = "events";
const LEGACY_META_STORE = "meta";
const EVENTS_STORE = "vault-events";
const META_STORE = "vault-meta";
const USAGE_KEY = "usage";
const BROWSER_SCOPE = "browser";
const HEX_64 = /^[0-9a-f]{64}$/;

/** The queue stores immutable event ids, not complete trace snapshots. Send
 * durably enqueues the id before publication. A crash in that narrow window
 * leaves a harmless unresolvable record; a later idempotent Send makes the same
 * event fetchable and eligible for removal. Byte backpressure remains explicit
 * instead of discarding old work. */
export const MAX_RENDEZVOUS_OUTBOX_BYTES = 16 * 1024 * 1024;

export interface PendingRendezvousEvent {
  eventId: string;
  queuedAt: number;
}

export interface RendezvousOutboxStorage {
  add(scope: string, record: PendingRendezvousEvent): Promise<"added" | "exists">;
  remove(scope: string, eventId: string): Promise<void>;
  list(scope: string): Promise<PendingRendezvousEvent[]>;
}

interface StoredRendezvousEvent extends PendingRendezvousEvent {
  scope: string;
}

interface OutboxUsage {
  scope: string;
  key: typeof USAGE_KEY;
  totalBytes: number;
  count: number;
}

export interface RendezvousOutboxSession {
  readonly scope: string;
  readonly generation: number;
}

/** Capture the active encrypted-vault boundary once for a complete enqueue or
 * drain. Browser reader builds retain one ordinary browser-local queue. */
export function captureRendezvousOutboxSession(): RendezvousOutboxSession {
  return {
    scope: activeVaultStorageId() ?? BROWSER_SCOPE,
    generation: vaultStorageGeneration(),
  };
}

export function isRendezvousOutboxSessionCurrent(
  session: RendezvousOutboxSession,
): boolean {
  return vaultStorageSessionAcceptsWork() &&
    session.generation === vaultStorageGeneration() &&
    session.scope === (activeVaultStorageId() ?? BROWSER_SCOPE);
}

function recordBytes(record: PendingRendezvousEvent): number {
  // Persisted IndexedDB rows also carry their vault scope. Quota accounting is
  // defined over the logical record so add/remove always use identical bytes.
  return new TextEncoder().encode(JSON.stringify({
    eventId: record.eventId,
    queuedAt: record.queuedAt,
  })).byteLength;
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
export class IndexedDbRendezvousOutbox implements RendezvousOutboxStorage {
  private database: Promise<IDBDatabase> | null = null;
  private legacyMigration: Promise<void> | null = null;

  constructor(private readonly factory?: Pick<IDBFactory, "open">) {}

  private open(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    const factory = this.factory ?? (typeof indexedDB === "undefined" ? null : indexedDB);
    if (!factory) {
      throw new Error("durable rendezvous storage is unavailable in this runtime");
    }
    let rejected = false;
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(EVENTS_STORE)) {
          db.createObjectStore(EVENTS_STORE, { keyPath: ["scope", "eventId"] });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE, { keyPath: ["scope", "key"] });
        }
      };
      request.onsuccess = () => {
        if (rejected) {
          request.result.close();
        } else {
          resolve(request.result);
        }
      };
      request.onerror = () => {
        rejected = true;
        reject(request.error ?? new Error("could not open rendezvous outbox"));
      };
      request.onblocked = () => {
        rejected = true;
        reject(new Error("rendezvous outbox upgrade is blocked"));
      };
    });
    this.database = opening;
    void opening.catch(() => {
      if (this.database === opening) this.database = null;
    });
    return opening;
  }

  /** Version 1 had one install-global queue. Only the vault explicitly chosen
   * by the multi-vault bootstrap to adopt legacy state may claim those records. */
  private async migrateLegacyIfAuthorized(db: IDBDatabase, scope: string): Promise<void> {
    if (
      scope === BROWSER_SCOPE ||
      activeVaultStorageId() !== scope ||
      !activeVaultStorageMigratesLegacy() ||
      !db.objectStoreNames.contains(LEGACY_EVENTS_STORE)
    ) return;
    if (this.legacyMigration) return this.legacyMigration;

    const migration = (async () => {
      const stores = [LEGACY_EVENTS_STORE, EVENTS_STORE, META_STORE];
      if (db.objectStoreNames.contains(LEGACY_META_STORE)) stores.push(LEGACY_META_STORE);
      const transaction = db.transaction(stores, "readwrite");
      const done = transactionDone(transaction);
      try {
        const legacyEvents = transaction.objectStore(LEGACY_EVENTS_STORE);
        const events = transaction.objectStore(EVENTS_STORE);
        const meta = transaction.objectStore(META_STORE);
        const records = (await requestResult(legacyEvents.getAll()) as unknown[])
          .map(validateRecord);
        const usageKey: [string, typeof USAGE_KEY] = [scope, USAGE_KEY];
        const usage = (await requestResult(meta.get(usageKey)) as OutboxUsage | undefined) ?? {
          scope,
          key: USAGE_KEY,
          totalBytes: 0,
          count: 0,
        };
        let totalBytes = usage.totalBytes;
        let count = usage.count;
        for (const record of records) {
          const eventKey: [string, string] = [scope, record.eventId];
          if (await requestResult(events.get(eventKey))) continue;
          const bytes = recordBytes(record);
          if (totalBytes + bytes > MAX_RENDEZVOUS_OUTBOX_BYTES) {
            throw new Error(
              `legacy rendezvous outbox cannot fit in vault ${scope} ` +
              `(${totalBytes} of ${MAX_RENDEZVOUS_OUTBOX_BYTES} bytes already used)`,
            );
          }
          events.add({ scope, ...record } satisfies StoredRendezvousEvent);
          totalBytes += bytes;
          count++;
        }
        meta.put({ scope, key: USAGE_KEY, totalBytes, count } satisfies OutboxUsage);
        legacyEvents.clear();
        if (db.objectStoreNames.contains(LEGACY_META_STORE)) {
          transaction.objectStore(LEGACY_META_STORE).clear();
        }
        await done;
      } catch (error) {
        try {
          transaction.abort();
        } catch {
          // A failed request may already have aborted the versioned migration.
        }
        await done.catch(() => undefined);
        throw error;
      }
    })();
    this.legacyMigration = migration.catch((error) => {
      this.legacyMigration = null;
      throw error;
    });
    return this.legacyMigration;
  }

  async add(scope: string, record: PendingRendezvousEvent): Promise<"added" | "exists"> {
    const db = await this.open();
    await this.migrateLegacyIfAuthorized(db, scope);
    const transaction = db.transaction([EVENTS_STORE, META_STORE], "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const meta = transaction.objectStore(META_STORE);
    const eventKey: [string, string] = [scope, record.eventId];
    const usageKey: [string, typeof USAGE_KEY] = [scope, USAGE_KEY];
    const existing = await requestResult(events.get(eventKey));
    if (existing) {
      await done;
      return "exists";
    }
    const usage = (await requestResult(meta.get(usageKey)) as OutboxUsage | undefined) ?? {
      scope,
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
    events.add({ scope, ...record } satisfies StoredRendezvousEvent);
    meta.put({
      scope,
      key: USAGE_KEY,
      totalBytes: usage.totalBytes + bytes,
      count: usage.count + 1,
    } satisfies OutboxUsage);
    await done;
    return "added";
  }

  async remove(scope: string, eventId: string): Promise<void> {
    const db = await this.open();
    await this.migrateLegacyIfAuthorized(db, scope);
    const transaction = db.transaction([EVENTS_STORE, META_STORE], "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const meta = transaction.objectStore(META_STORE);
    const eventKey: [string, string] = [scope, eventId];
    const usageKey: [string, typeof USAGE_KEY] = [scope, USAGE_KEY];
    const existing = await requestResult(events.get(eventKey)) as StoredRendezvousEvent | undefined;
    if (existing) {
      const usage = (await requestResult(meta.get(usageKey)) as OutboxUsage | undefined) ?? {
        scope,
        key: USAGE_KEY,
        totalBytes: recordBytes(existing),
        count: 1,
      };
      events.delete(eventKey);
      meta.put({
        scope,
        key: USAGE_KEY,
        totalBytes: Math.max(0, usage.totalBytes - recordBytes(existing)),
        count: Math.max(0, usage.count - 1),
      } satisfies OutboxUsage);
    }
    await done;
  }

  async list(scope: string): Promise<PendingRendezvousEvent[]> {
    const db = await this.open();
    await this.migrateLegacyIfAuthorized(db, scope);
    const transaction = db.transaction(EVENTS_STORE, "readonly");
    const done = transactionDone(transaction);
    const range = IDBKeyRange.bound([scope, ""], [scope, "\uffff"]);
    const records = await requestResult(
      transaction.objectStore(EVENTS_STORE).getAll(range),
    ) as unknown[];
    await done;
    return records.map(validateRecord)
      .sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));
  }

  async close(): Promise<void> {
    const database = this.database;
    this.database = null;
    this.legacyMigration = null;
    if (!database) return;
    const opened = await database.catch(() => null);
    opened?.close();
  }
}

/** In-memory adapter for deterministic unit tests. Production uses IndexedDB. */
export class MemoryRendezvousOutbox implements RendezvousOutboxStorage {
  readonly records = new Map<string, Map<string, PendingRendezvousEvent>>();
  private readonly totalBytes = new Map<string, number>();

  constructor(private readonly maxBytes = MAX_RENDEZVOUS_OUTBOX_BYTES) {}

  async add(scope: string, record: PendingRendezvousEvent): Promise<"added" | "exists"> {
    const records = this.records.get(scope) ?? new Map<string, PendingRendezvousEvent>();
    if (records.has(record.eventId)) return "exists";
    const bytes = recordBytes(record);
    const totalBytes = this.totalBytes.get(scope) ?? 0;
    if (totalBytes + bytes > this.maxBytes) {
      throw new Error("rendezvous outbox is full; indexing must catch up before Send can complete");
    }
    records.set(record.eventId, record);
    this.records.set(scope, records);
    this.totalBytes.set(scope, totalBytes + bytes);
    return "added";
  }

  async remove(scope: string, eventId: string): Promise<void> {
    const records = this.records.get(scope);
    const existing = records?.get(eventId);
    if (!existing) return;
    records!.delete(eventId);
    if (records!.size === 0) this.records.delete(scope);
    this.totalBytes.set(
      scope,
      Math.max(0, (this.totalBytes.get(scope) ?? recordBytes(existing)) - recordBytes(existing)),
    );
  }

  async list(scope: string): Promise<PendingRendezvousEvent[]> {
    return [...(this.records.get(scope)?.values() ?? [])].map(validateRecord)
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
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
): Promise<void> {
  if (!verifyEvent(event)) {
    throw new Error("refusing to queue an invalid rendezvous event");
  }
  await storage.add(session.scope, { eventId: event.id, queuedAt: now });
}

export async function removeRendezvousEvent(
  eventId: string,
  storage: RendezvousOutboxStorage = productionStorage(),
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
): Promise<void> {
  await storage.remove(session.scope, eventId);
}

export async function pendingRendezvousEvents(
  storage: RendezvousOutboxStorage = productionStorage(),
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
): Promise<PendingRendezvousEvent[]> {
  return storage.list(session.scope);
}

/** Drain independent Send-side indexing work without allowing one unavailable
 * relay or coordinate to starve later events. Per-id removal means a concurrent
 * enqueue can never be erased by an old whole-queue snapshot. */
export async function drainRendezvousEvents(
  process: (eventId: string) => Promise<boolean>,
  storage: RendezvousOutboxStorage = productionStorage(),
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
): Promise<{ pending: number; completed: number }> {
  const records = await storage.list(session.scope);
  let completed = 0;
  for (const record of records) {
    if (!isRendezvousOutboxSessionCurrent(session)) break;
    try {
      const terminal = await process(record.eventId);
      if (!isRendezvousOutboxSessionCurrent(session)) break;
      if (terminal) {
        await storage.remove(session.scope, record.eventId);
        completed++;
      }
    } catch {
      // Retryable failures remain durable for the next pass.
    }
  }
  return { pending: (await storage.list(session.scope)).length, completed };
}
