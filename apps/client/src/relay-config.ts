import { resolveRelayUrl } from "./identity.js";

/**
 * User-configurable relay set.
 *
 * Every *external* relay carries two independent toggles — `read` and `write`
 * — because the two directions have different costs and trust implications. A
 * relay you trust to back up your writing need not be one you trust as a read
 * source for someone else's; a cheap public read relay need not receive your
 * publishes. Modeling them as one `role` enum (or a single on/off) forces the
 * user to lie about one direction to control the other. Two booleans say
 * exactly what they mean.
 *
 * The home relay always leads the list and is **always on** — read+write, not
 * toggleable, not removable. It is the local node your writing lives on:
 *   - Desktop (Tauri): the bundled local sidecar at ws://127.0.0.1:4869.
 *   - Webapp: the same-origin hosted relay the page is served from (derived
 *     from location.origin + /relay by resolveRelayUrl()).
 *
 * Exposing toggles on the home relay was a footgun: a stale `write: false`
 * carried across runtimes silently broke every publish with no in-app hint,
 * and there is no legitimate reason for a user to turn their own local node
 * off. So the home relay is pinned read+write; `setRelayRead`/`setRelayWrite`
 * no-op on it, and the UI no longer renders toggles for it.
 *
 * Everything else in the list is the user's extra external relays, used by the
 * sampler and as additional read/write targets so writing can "get out" — sync
 * to other devices, federate to the wider Nostr network.
 */

export interface RelayEntry {
  /** Stable id (so toggles survive URL edits). */
  id: string;
  url: string;
  /** Whether this relay is consulted on reads. Independent of `write`. */
  read: boolean;
  /** Whether events are published to this relay. Independent of `read`. */
  write: boolean;
  /** True for the home relay — cannot be deleted, only toggled. */
  builtin?: boolean;
}

const STORAGE_KEY = "zine.relays";

/**
 * The home relay entry. One per install. URL is whatever resolveRelayUrl()
 * yields for this runtime — local sidecar on desktop, hosted relay on webapp.
 * Always read+write: the local node is never off, never toggleable.
 */
function builtinEntry(): RelayEntry {
  return {
    id: "builtin-home",
    url: resolveRelayUrl(),
    read: true,
    write: true,
    builtin: true,
  };
}

/**
 * Normalize a raw stored entry into the current shape. Reads the legacy
 * `enabled` + `role` ("read"|"write"|"both") fields from older versions and
 * folds them into the `read`/`write` booleans, so a stored list never needs a
 * manual migration step.
 */
function normalize(raw: Partial<RelayEntry> & { enabled?: boolean; role?: string }): RelayEntry | null {
  if (typeof raw.id !== "string" || typeof raw.url !== "string") return null;
  // Prefer the new fields when present; otherwise derive from legacy shape.
  const read = typeof raw.read === "boolean"
    ? raw.read
    : typeof raw.enabled === "boolean"
      ? raw.enabled && (raw.role === "read" || raw.role === "both" || !raw.role)
      : true;
  const write = typeof raw.write === "boolean"
    ? raw.write
    : typeof raw.enabled === "boolean"
      ? raw.enabled && (raw.role === "write" || raw.role === "both" || !raw.role)
      : true;
  return { id: raw.id, url: raw.url, read, write, builtin: raw.builtin === true ? true : undefined };
}

/** Read the persisted list, always ensuring the home entry leads it. */
export function loadRelays(): RelayEntry[] {
  let raw: unknown[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as unknown[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];

  const entries: RelayEntry[] = [];
  for (const item of raw) {
    const e = normalize(item as Parameters<typeof normalize>[0]);
    if (e) entries.push(e);
  }

  // The home entry must always be present, lead the list, and be read+write.
  // A prior version persisted a user-toggleable read/write on it; any stored
  // copy is replaced with the always-on entry so stale `write: false` values
  // (which silently broke every publish) are corrected on the next load. The
  // URL is refreshed against the current runtime so a moved webapp never shows
  // a stale address.
  const rest = entries.filter((e) => !e.builtin);
  const homeUrl = resolveRelayUrl();
  const trimmed = rest.filter((e) => e.url !== homeUrl);
  return [builtinEntry(), ...trimmed];
}

/** Persist the list. */
export function saveRelays(entries: RelayEntry[]): void {
  // Final guard: never let the home relay be removed, even by a buggy caller.
  if (!entries.some((e) => e.builtin)) {
    entries = [builtinEntry(), ...entries];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function addRelay(url: string): RelayEntry[] {
  const entries = loadRelays();
  const trimmed = url.trim();
  if (!trimmed) return entries;
  // Dedupe by URL — same relay added twice is just noise.
  if (entries.some((e) => e.url === trimmed)) return entries;
  const entry: RelayEntry = {
    id: `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    url: trimmed,
    read: true,
    write: true,
  };
  const next = [...entries, entry];
  saveRelays(next);
  return next;
}

export function removeRelay(id: string): RelayEntry[] {
  const entries = loadRelays();
  // Home relay is immune to deletion — surfaced as a no-op here and as a
  // disabled button in the UI. "Never removable" means never gone.
  const next = entries.filter((e) => e.id !== id || e.builtin);
  saveRelays(next);
  return next;
}

/**
 * Toggle the read direction. No-op for the home relay — it is always on, so a
 * stale or buggy caller cannot turn it off.
 */
export function setRelayRead(id: string, read: boolean): RelayEntry[] {
  if (id === "builtin-home") return loadRelays();
  const entries = loadRelays().map((e) => (e.id === id ? { ...e, read } : e));
  saveRelays(entries);
  return entries;
}

/**
 * Toggle the write direction. No-op for the home relay — it is always on, so a
 * stale or buggy caller cannot turn it off.
 */
export function setRelayWrite(id: string, write: boolean): RelayEntry[] {
  if (id === "builtin-home") return loadRelays();
  const entries = loadRelays().map((e) => (e.id === id ? { ...e, write } : e));
  saveRelays(entries);
  return entries;
}

/** Entries the provenance layer should publish to (write === true). */
export function writeRelays(entries: RelayEntry[] = loadRelays()): RelayEntry[] {
  return entries.filter((e) => e.write);
}

/** Entries the provenance layer should read from (read === true). */
export function readRelays(entries: RelayEntry[] = loadRelays()): RelayEntry[] {
  return entries.filter((e) => e.read);
}

/**
 * The full set of relay URLs the app should read from, derived from the
 * configured read set. Used by samplers that want one flat URL list. Dedupes
 * via Set. Currently has no live callers but is kept as a convenience.
 */
export function allReadUrls(): string[] {
  const urls = new Set<string>();
  for (const e of readRelays()) urls.add(e.url);
  return [...urls];
}
