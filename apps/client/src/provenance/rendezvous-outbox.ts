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
const MAX_PROVEN_RELAY_URLS = 32;
const MAX_RELAY_URL_LENGTH = 2_048;
const MAX_DRAIN_RECORDS = 8;
const MAX_DRAIN_WINDOW_MS = 20_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
const MAX_RETRY_ATTEMPTS = 32;

/** The queue stores immutable Coin genesis ids plus the exact signed completion
 * attestation needed to restore the public pair after relay/config churn. Byte
 * backpressure remains explicit instead of discarding old work. */
export const MAX_RENDEZVOUS_OUTBOX_BYTES = 16 * 1024 * 1024;

export interface PendingRendezvousEvent {
  eventId: string;
  queuedAt: number;
  /** Per-Coin durable retry posture. Omitted until the first failed attempt. */
  retryAttempts?: number;
  nextAttemptAt?: number;
  /** Exact same-minter completion proof. Legacy rows may omit it and retain
   * their read-only retry posture. */
  completionAttestation?: Event;
  /** Stranger-readable relays already proven to contain both Coin and
   * same-minter attestation. Retained across later relay-config changes. */
  relayUrls?: string[];
}

export interface RendezvousOutboxStorage {
  add(scope: string, record: PendingRendezvousEvent): Promise<"added" | "exists">;
  defer(scope: string, eventId: string, retryAttempts: number, nextAttemptAt: number): Promise<void>;
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
    ...(record.completionAttestation
      ? { completionAttestation: record.completionAttestation }
      : {}),
    ...(record.relayUrls && record.relayUrls.length > 0
      ? { relayUrls: record.relayUrls }
      : {}),
  })).byteLength;
}

function validateCompletionAttestation(
  value: unknown,
  eventId: string,
  index: number,
): Event | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error(
      `the rendezvous publication outbox contains an invalid completion attestation at index ${index}`,
    );
  }
  const attestation = value as Event;
  let validSignature = false;
  try {
    validSignature = verifyEvent(attestation);
  } catch {
    validSignature = false;
  }
  const tags = Array.isArray(attestation.tags) ? attestation.tags : [];
  const targets = tags.filter((tag) => tag[0] === "e");
  const kinds = tags.filter((tag) => tag[0] === "k");
  const authors = tags.filter((tag) => tag[0] === "p");
  const geohashes = tags.filter((tag) => tag[0] === "g");
  let validContent = false;
  try {
    const parsed = JSON.parse(attestation.content) as unknown;
    validContent = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.keys(parsed).every((key) => key === "message") &&
      ((parsed as { message?: unknown }).message === undefined ||
        typeof (parsed as { message?: unknown }).message === "string");
  } catch {
    validContent = false;
  }
  if (
    !validSignature ||
    attestation.kind !== 4294 ||
    !Array.isArray(attestation.tags) ||
    targets.length !== 1 ||
    targets[0]?.[1] !== eventId ||
    targets[0]?.[2] !== "" ||
    targets[0]?.[3] !== "target" ||
    kinds.length !== 1 ||
    kinds[0]?.[1] !== "4290" ||
    authors.length > 1 ||
    (authors.length === 1 && authors[0]?.[1] !== attestation.pubkey) ||
    geohashes.length > 1 ||
    tags.some((tag) => !["e", "k", "p", "g"].includes(tag[0] ?? "")) ||
    !validContent
  ) {
    throw new Error(
      `the rendezvous publication outbox contains an invalid completion attestation at index ${index}`,
    );
  }
  return attestation;
}

function validateRelayUrls(value: unknown, index: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_PROVEN_RELAY_URLS) {
    throw new Error(`the rendezvous publication outbox contains invalid relay locators at index ${index}`);
  }
  const urls: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MAX_RELAY_URL_LENGTH) {
      throw new Error(`the rendezvous publication outbox contains an invalid relay locator at index ${index}`);
    }
    try {
      const parsed = new URL(entry);
      if (
        (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") ||
        parsed.username ||
        parsed.password
      ) throw new Error("invalid relay URL");
    } catch {
      throw new Error(`the rendezvous publication outbox contains an invalid relay locator at index ${index}`);
    }
    if (!urls.includes(entry)) urls.push(entry);
  }
  return urls.length > 0 ? urls : undefined;
}

function validateRecord(value: unknown, index: number): PendingRendezvousEvent {
  const record = value as Partial<PendingRendezvousEvent>;
  if (
    !HEX_64.test(record.eventId ?? "") ||
    !Number.isFinite(record.queuedAt) ||
    (record.retryAttempts !== undefined && (
      !Number.isInteger(record.retryAttempts) ||
      record.retryAttempts < 0 ||
      record.retryAttempts > MAX_RETRY_ATTEMPTS
    )) ||
    (record.nextAttemptAt !== undefined && (
      !Number.isFinite(record.nextAttemptAt) || record.nextAttemptAt < 0
    )) ||
    ((record.retryAttempts === undefined) !== (record.nextAttemptAt === undefined))
  ) {
    throw new Error(`the rendezvous publication outbox contains an invalid event id at index ${index}`);
  }
  const relayUrls = validateRelayUrls(record.relayUrls, index);
  const completionAttestation = validateCompletionAttestation(
    record.completionAttestation,
    record.eventId!,
    index,
  );
  return {
    eventId: record.eventId!,
    queuedAt: record.queuedAt!,
    ...(record.retryAttempts !== undefined ? { retryAttempts: record.retryAttempts } : {}),
    ...(record.nextAttemptAt !== undefined ? { nextAttemptAt: record.nextAttemptAt } : {}),
    ...(completionAttestation ? { completionAttestation } : {}),
    ...(relayUrls ? { relayUrls } : {}),
  };
}

function mergeRecordLocators(
  current: PendingRendezvousEvent,
  incoming: PendingRendezvousEvent,
): PendingRendezvousEvent {
  const relayUrls = [...new Set([
    ...(current.relayUrls ?? []),
    ...(incoming.relayUrls ?? []),
  ])].slice(0, MAX_PROVEN_RELAY_URLS);
  return {
    eventId: current.eventId,
    queuedAt: Math.min(current.queuedAt, incoming.queuedAt),
    // A fresh enqueue may carry new public relay evidence. Wake the record
    // immediately instead of preserving an obsolete failure backoff.
    ...((current.completionAttestation ?? incoming.completionAttestation)
      ? { completionAttestation: current.completionAttestation ?? incoming.completionAttestation }
      : {}),
    ...(relayUrls.length > 0 ? { relayUrls } : {}),
  };
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
    const validRecord = validateRecord(record, 0);
    const db = await this.open();
    await this.migrateLegacyIfAuthorized(db, scope);
    const transaction = db.transaction([EVENTS_STORE, META_STORE], "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const meta = transaction.objectStore(META_STORE);
    const eventKey: [string, string] = [scope, validRecord.eventId];
    const usageKey: [string, typeof USAGE_KEY] = [scope, USAGE_KEY];
    const existing = await requestResult(events.get(eventKey)) as StoredRendezvousEvent | undefined;
    const usage = (await requestResult(meta.get(usageKey)) as OutboxUsage | undefined) ?? {
      scope,
      key: USAGE_KEY,
      totalBytes: existing ? recordBytes(existing) : 0,
      count: existing ? 1 : 0,
    };
    if (existing) {
      const current = validateRecord(existing, 0);
      const merged = mergeRecordLocators(current, validRecord);
      const extraBytes = recordBytes(merged) - recordBytes(current);
      if (usage.totalBytes + extraBytes > MAX_RENDEZVOUS_OUTBOX_BYTES) {
        transaction.abort();
        await done.catch(() => undefined);
        throw new Error(
          `rendezvous outbox is full (${usage.totalBytes} of ${MAX_RENDEZVOUS_OUTBOX_BYTES} bytes); completed-Mint indexing must catch up`,
        );
      }
      events.put({ scope, ...merged } satisfies StoredRendezvousEvent);
      meta.put({
        scope,
        key: USAGE_KEY,
        totalBytes: usage.totalBytes + extraBytes,
        count: usage.count,
      } satisfies OutboxUsage);
      await done;
      return "exists";
    }
    const bytes = recordBytes(validRecord);
    if (usage.totalBytes + bytes > MAX_RENDEZVOUS_OUTBOX_BYTES) {
      transaction.abort();
      await done.catch(() => undefined);
      throw new Error(
        `rendezvous outbox is full (${usage.totalBytes} of ${MAX_RENDEZVOUS_OUTBOX_BYTES} bytes); completed-Mint indexing must catch up`,
      );
    }
    events.add({ scope, ...validRecord } satisfies StoredRendezvousEvent);
    meta.put({
      scope,
      key: USAGE_KEY,
      totalBytes: usage.totalBytes + bytes,
      count: usage.count + 1,
    } satisfies OutboxUsage);
    await done;
    return "added";
  }

  async defer(
    scope: string,
    eventId: string,
    retryAttempts: number,
    nextAttemptAt: number,
  ): Promise<void> {
    if (
      !HEX_64.test(eventId) ||
      !Number.isInteger(retryAttempts) ||
      retryAttempts < 1 ||
      retryAttempts > MAX_RETRY_ATTEMPTS ||
      !Number.isFinite(nextAttemptAt) ||
      nextAttemptAt < 0
    ) throw new Error("invalid rendezvous retry state");
    const db = await this.open();
    await this.migrateLegacyIfAuthorized(db, scope);
    const transaction = db.transaction(EVENTS_STORE, "readwrite");
    const done = transactionDone(transaction);
    const events = transaction.objectStore(EVENTS_STORE);
    const eventKey: [string, string] = [scope, eventId];
    const existing = await requestResult(events.get(eventKey)) as StoredRendezvousEvent | undefined;
    if (existing) {
      const current = validateRecord(existing, 0);
      events.put({
        scope,
        ...current,
        retryAttempts,
        nextAttemptAt,
      } satisfies StoredRendezvousEvent);
    }
    await done;
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
    const validRecord = validateRecord(record, 0);
    const records = this.records.get(scope) ?? new Map<string, PendingRendezvousEvent>();
    const existing = records.get(validRecord.eventId);
    if (existing) {
      const merged = mergeRecordLocators(validateRecord(existing, 0), validRecord);
      const extraBytes = recordBytes(merged) - recordBytes(existing);
      const totalBytes = this.totalBytes.get(scope) ?? recordBytes(existing);
      if (totalBytes + extraBytes > this.maxBytes) {
        throw new Error("rendezvous outbox is full; completed-Mint indexing must catch up");
      }
      records.set(validRecord.eventId, merged);
      this.totalBytes.set(scope, totalBytes + extraBytes);
      return "exists";
    }
    const bytes = recordBytes(validRecord);
    const totalBytes = this.totalBytes.get(scope) ?? 0;
    if (totalBytes + bytes > this.maxBytes) {
      throw new Error("rendezvous outbox is full; completed-Mint indexing must catch up");
    }
    records.set(validRecord.eventId, validRecord);
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

  async defer(
    scope: string,
    eventId: string,
    retryAttempts: number,
    nextAttemptAt: number,
  ): Promise<void> {
    if (
      !HEX_64.test(eventId) ||
      !Number.isInteger(retryAttempts) ||
      retryAttempts < 1 ||
      retryAttempts > MAX_RETRY_ATTEMPTS ||
      !Number.isFinite(nextAttemptAt) ||
      nextAttemptAt < 0
    ) throw new Error("invalid rendezvous retry state");
    const records = this.records.get(scope);
    const existing = records?.get(eventId);
    if (!records || !existing) return;
    records.set(eventId, {
      ...validateRecord(existing, 0),
      retryAttempts,
      nextAttemptAt,
    });
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

/** Persist a completed Coin genesis id after its exact signed completion pair
 * has reached at least one configured publication relay. */
export async function enqueueRendezvousEvent(
  event: Event,
  storage: RendezvousOutboxStorage = productionStorage(),
  now = Date.now(),
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
  provenRelayUrls: readonly string[] = [],
  completionAttestation?: Event,
): Promise<void> {
  if (!verifyEvent(event)) {
    throw new Error("refusing to queue an invalid rendezvous event");
  }
  const relayUrls = validateRelayUrls([...provenRelayUrls], 0);
  const validatedAttestation = validateCompletionAttestation(
    completionAttestation,
    event.id,
    0,
  );
  if (validatedAttestation && validatedAttestation.pubkey !== event.pubkey) {
    throw new Error("refusing to queue a completion attestation from another minter");
  }
  await storage.add(session.scope, {
    eventId: event.id,
    queuedAt: now,
    ...(validatedAttestation ? { completionAttestation: validatedAttestation } : {}),
    ...(relayUrls ? { relayUrls } : {}),
  });
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

export interface RendezvousDrainOptions {
  /** Tests may tighten, never widen, the production work window. */
  maxRecords?: number;
  maxDurationMs?: number;
  now?: () => number;
}

function fairDueRecords(
  records: readonly PendingRendezvousEvent[],
  now: number,
): PendingRendezvousEvent[] {
  const due = records.filter((record) => (record.nextAttemptAt ?? 0) <= now)
    .sort((left, right) => left.queuedAt - right.queuedAt || left.eventId.localeCompare(right.eventId));
  const fair: PendingRendezvousEvent[] = [];
  let oldest = 0;
  let newest = due.length - 1;
  while (oldest <= newest) {
    fair.push(due[oldest++]!);
    if (oldest <= newest) fair.push(due[newest--]!);
  }
  return fair;
}

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * (2 ** Math.max(0, attempts - 1)));
}

/** Drain independent Mint-side indexing work without allowing one unavailable
 * relay or coordinate to starve later Coins. Each invocation owns a bounded
 * oldest/newest slice; failed records move behind durable per-id backoff.
 * Per-id mutation means a concurrent enqueue can never be erased by an old
 * whole-queue snapshot. */
export async function drainRendezvousEvents(
  process: (
    eventId: string,
    provenRelayUrls: readonly string[],
    completionAttestation?: Event,
  ) => Promise<boolean>,
  storage: RendezvousOutboxStorage = productionStorage(),
  session: RendezvousOutboxSession = captureRendezvousOutboxSession(),
  options: RendezvousDrainOptions = {},
): Promise<{ pending: number; completed: number }> {
  const records = await storage.list(session.scope);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const requestedMaxRecords = options.maxRecords === undefined ||
    !Number.isFinite(options.maxRecords)
    ? MAX_DRAIN_RECORDS
    : Math.floor(options.maxRecords);
  const requestedMaxDurationMs = options.maxDurationMs === undefined ||
    !Number.isFinite(options.maxDurationMs)
    ? MAX_DRAIN_WINDOW_MS
    : options.maxDurationMs;
  const maxRecords = Math.max(
    1,
    Math.min(MAX_DRAIN_RECORDS, requestedMaxRecords),
  );
  const maxDurationMs = Math.max(
    1,
    Math.min(MAX_DRAIN_WINDOW_MS, requestedMaxDurationMs),
  );
  let completed = 0;
  let attempted = 0;
  for (const record of fairDueRecords(records, startedAt)) {
    if (attempted >= maxRecords || now() - startedAt >= maxDurationMs) break;
    if (!isRendezvousOutboxSessionCurrent(session)) break;
    let terminal = false;
    try {
      terminal = await process(
        record.eventId,
        record.relayUrls ?? [],
        record.completionAttestation,
      );
    } catch {
      terminal = false;
    }
    attempted++;
    if (!isRendezvousOutboxSessionCurrent(session)) break;
    if (terminal) {
      await storage.remove(session.scope, record.eventId);
      completed++;
    } else {
      const retryAttempts = Math.min(
        MAX_RETRY_ATTEMPTS,
        (record.retryAttempts ?? 0) + 1,
      );
      await storage.defer(
        session.scope,
        record.eventId,
        retryAttempts,
        now() + retryDelayMs(retryAttempts),
      );
    }
  }
  return { pending: (await storage.list(session.scope)).length, completed };
}
