import type { FolderRef } from "./workspace-core.js";
import { listLocalFolders, localFolderFileCount, localUpdatedAt } from "./local-store.js";

/**
 * Folder discovery: the localStorage-backed list of folders this browser knows
 * about. The registry (this file) tracks which folder is active + the ordered
 * list for the switcher; local-store tracks each folder's *content*. This
 * merges both so a folder that has content but no registry entry (e.g. created
 * by a direct local-store write) is still discoverable.
 */

const STORAGE_KEY = "zine.folders";
const ACTIVE_KEY = "zine.activeFolder";

/** Cap on the number of folders the picker keeps. On overflow, prune chaff
 *  first (auto-provisioned folders with no files/label untouched for >7d),
 *  then the oldest by `lastOpened`. See `rememberFolder`. */
export const MAX_KNOWN_FOLDERS = 20;
/** A folder untouched longer than this is eligible for prune-on-overflow when
 *  it also has no local files and no label — the signature of an
 *  auto-provisioned folder the user never wrote to. */
const STALE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

/** Read the known-folder list, most-recently-used FIRST. Merges the registry
 *  with any folders that have local content but no registry entry, then sorts
 *  by `lastOpened` descending (falling back to content-recency for entries
 *  predating the stamp). */
export function listFolders(): FolderRef[] {
  let raw: FolderRef[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as FolderRef[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  const byId = new Map<string, FolderRef>();
  // Include folders with local content first (so they're always discoverable)…
  for (const f of listLocalFolders()) byId.set(f.id, f);
  // …then overlay registry entries (which may carry labels/lastOpened the
  // content store doesn't, and may include desktop folders with no local
  // content).
  for (const f of raw) {
    if (typeof f?.id === "string") byId.set(f.id, f);
  }
  const merged = [...byId.values()];
  merged.sort((a, b) => recencyOf(b) - recencyOf(a) || (b.id < a.id ? -1 : 1));
  return merged;
}

/** The recency key for MRU ordering: `lastOpened` when present, else the
 *  newest local-file `updatedAt` (content-recency), else 0. */
function recencyOf(f: FolderRef): number {
  if (typeof f.lastOpened === "number" && f.lastOpened > 0) return f.lastOpened;
  return localUpdatedAt(f.id);
}

/** Persist the folder list. */
function persist(folders: FolderRef[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(folders));
}

/** Record (or update) a folder reference and return the new MRU-sorted list.
 *  Stamps `lastOpened = now` so the picker surfaces recently-opened folders
 *  first. Caps the list at `MAX_KNOWN_FOLDERS`: on overflow, drops
 *  auto-provisioned chaff (no local files, no label, untouched >7d) before
 *  falling back to the oldest entry. */
export function rememberFolder(ref: FolderRef): FolderRef[] {
  const stamped: FolderRef = { ...ref, lastOpened: Date.now() };
  const folders = listFolders().filter((f) => f.id !== ref.id);
  folders.push(stamped);
  const capped = capFolders(folders);
  persist(capped);
  // Return MRU-sorted so callers updating state (`setKnownFolders`) render the
  // picker in the same order it'll be persisted.
  return capped.sort((a, b) => recencyOf(b) - recencyOf(a) || (b.id < a.id ? -1 : 1));
}

/** Trim a folder list to `MAX_KNOWN_FOLDERS`. Prunes auto-provisioned chaff
 *  first (no local files, no label, untouched >7d), then the oldest by
 *  recency. Never touches entries with a label or local files until no chaff
 *  remains — those are folders the user deliberately created or wrote to. */
function capFolders(folders: FolderRef[]): FolderRef[] {
  if (folders.length <= MAX_KNOWN_FOLDERS) return folders;
  const now = Date.now();
  const isChaff = (f: FolderRef): boolean =>
    !f.label && localFolderFileCount(f.id) === 0 &&
    now - recencyOf(f) > STALE_PRUNE_MS;
  // Drop chaff, oldest chaff first, until under cap or no chaff remains.
  const chaff = folders.filter(isChaff).sort((a, b) => recencyOf(a) - recencyOf(b));
  const keep = new Set(folders.filter((f) => !isChaff(f)).map((f) => f.id));
  let removed = folders.length - keep.size;
  for (const c of chaff) {
    if (folders.length - removed <= MAX_KNOWN_FOLDERS) break;
    keep.delete(c.id);
    removed++;
  }
  // Still over cap after clearing chaff: drop oldest remaining by recency.
  const survivors = folders.filter((f) => keep.has(f.id));
  if (survivors.length > MAX_KNOWN_FOLDERS) {
    survivors.sort((a, b) => recencyOf(b) - recencyOf(a));
    survivors.splice(MAX_KNOWN_FOLDERS);
  }
  return survivors;
}

/** Forget a folder reference (the relay data is untouched). */
export function forgetFolder(id: string): FolderRef[] {
  const folders = listFolders().filter((f) => f.id !== id);
  persist(folders);
  if (getActiveFolder() === id) {
    // Fall back to the most-recently-used remaining folder, if any.
    const last = folders.length > 0 ? folders[0] : null;
    setActiveFolder(last?.id ?? null);
  }
  return folders;
}

/** The id of the folder to auto-open on boot, or null. */
export function getActiveFolder(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

/** Set the active folder id (or null to clear). */
export function setActiveFolder(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

/** Look up a known folder ref by id. */
export function findFolder(id: string): FolderRef | undefined {
  return listFolders().find((f) => f.id === id);
}

/**
 * Mint a fresh folderId (pre-Phase-5). Uses crypto.randomUUID (browser + Tauri
 * webview). The id is what keys the kind-34290 manifest and the `#D` tag on
 * every kind-4290 node, so it must be unique and stable for the folder's
 * lifetime.
 *
 * Legacy: the client now uses the genesis node's event id as the folder
 * identity (spec §3.1: trace identity IS the genesis node id), via
 * `createFolderGenesis` in provenance.ts. This UUID mint is kept for
 * backward compatibility with existing UUID-keyed folders in localStorage.
 * New folders should use `createFolderGenesis` instead.
 */
export function newFolderId(): string {
  return crypto.randomUUID();
}
