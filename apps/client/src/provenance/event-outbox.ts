import type { Event, Filter } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";

const STORAGE_KEY = "zine.pending-trace-events";

export interface PendingTraceEvent {
  event: Event;
  queuedAt: number;
}

function isSignedEvent(value: unknown): value is Event {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<Event>;
  return (
    typeof event.id === "string" &&
    typeof event.pubkey === "string" &&
    typeof event.created_at === "number" &&
    typeof event.kind === "number" &&
    Array.isArray(event.tags) &&
    typeof event.content === "string" &&
    typeof event.sig === "string"
  );
}

function readOutbox(): PendingTraceEvent[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the local signed-event outbox is corrupt JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("the local signed-event outbox has an invalid shape");
  }
  return parsed.map((value, index) => {
    const record = value as Partial<PendingTraceEvent>;
    if (
      !isSignedEvent(record.event) ||
      !Number.isFinite(record.queuedAt) ||
      !verifyEvent(record.event)
    ) {
      throw new Error(`the local signed-event outbox contains an invalid event at index ${index}`);
    }
    return { event: record.event, queuedAt: record.queuedAt! };
  });
}

function writeOutbox(records: readonly PendingTraceEvent[]): void {
  if (records.length === 0) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

/** Persist an already-signed event before any relay attempt. Event ids dedupe
 * retries while insertion order preserves file-before-folder dependencies. */
export function enqueueLocalEvent(event: Event): void {
  if (!verifyEvent(event)) throw new Error(`refusing to queue invalid signed event ${event.id}`);
  const records = readOutbox();
  if (records.some((record) => record.event.id === event.id)) return;
  records.push({ event, queuedAt: Date.now() });
  writeOutbox(records);
}

/** Mark one event durable on the home relay. */
export function removeLocalEvent(eventId: string): void {
  const records = readOutbox();
  const next = records.filter((record) => record.event.id !== eventId);
  if (next.length !== records.length) writeOutbox(next);
}

export function pendingLocalEvents(): PendingTraceEvent[] {
  return readOutbox();
}

export function pendingLocalEventById(eventId: string): Event | null {
  return readOutbox().find((record) => record.event.id === eventId)?.event ?? null;
}

function matchesPrefixes(value: string, prefixes: readonly string[] | undefined): boolean {
  return !prefixes || prefixes.length === 0 || prefixes.some((prefix) => value.startsWith(prefix));
}

/** Match the NIP-01 filter fields used by provenance readers so queued Steps
 * participate in ordinary get-node, chain, and folder-manifest resolution. */
export function pendingLocalEventsMatching(filter: Filter): Event[] {
  let events = readOutbox().map((record) => record.event).filter((event) => {
    if (!matchesPrefixes(event.id, filter.ids)) return false;
    if (!matchesPrefixes(event.pubkey, filter.authors)) return false;
    if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
    if (filter.since !== undefined && event.created_at < filter.since) return false;
    if (filter.until !== undefined && event.created_at > filter.until) return false;
    for (const [key, wanted] of Object.entries(filter)) {
      if (!key.startsWith("#") || !Array.isArray(wanted) || wanted.length === 0) continue;
      const tagName = key.slice(1);
      const tagValues = wanted as string[];
      if (!event.tags.some((tag) => tag[0] === tagName && tagValues.includes(tag[1]))) return false;
    }
    return true;
  });
  if (filter.limit !== undefined) events = events.slice(-filter.limit);
  return events;
}

export function pendingLocalEventCount(): number {
  return readOutbox().length;
}
