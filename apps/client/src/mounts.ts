/**
 * Multi-mount registry for the desktop app — the list of (chain, directory)
 * pairs the user has mounted, plus which one is open right now.
 *
 * This sits ALONGSIDE the single-slot `zine.attachedFolder` (registry.ts),
 * which remains the workspace's source of truth for the *currently-open*
 * folder. The mounts list is the sidebar inventory: many pairs can be
 * remembered, exactly one (the active mount) is materialized into the
 * workspace at a time.
 *
 * Model:
 *   - A **chain** is the relay-resident truth — an append-only node history
 *     identified by its genesis event id. Lives on the relay. Directory-
 *     independent (every node carries the genesis id on its `f`/`D` tags).
 *   - A **mount** is the projection of a chain onto a directory. Volatile,
 *     disposable, fully reconstructable from the relay. Each entry is a
 *     `(id, path)` pair (the chain id + the working-tree path).
 *
 * Unmount drops the pair from this list; the chain is untouched on the
 * relay and can be reified into a fresh directory later (see `reifyMount`
 * in workspace.ts). There is no "delete traces on unmount" — the directory
 * is never the source of truth, so removing the binding costs nothing.
 *
 * Desktop-only by usage (paths only exist there). The webapp has no mounts:
 * it auto-provisions a single chain and never enters this registry.
 */

import type { AttachedFolder } from "./registry.js";

const MOUNTS_KEY = "zine.mounts";
const ACTIVE_MOUNT_KEY = "zine.activeMount";

/** Cap on remembered mounts, matching the known-folders limit (folders.ts).
 *  On overflow the oldest by `lastOpened` is dropped first. */
const MAX_MOUNTS = 20;

/** Read the mounts list. Synchronous, never throws; malformed storage is
 *  treated as empty (and cleared). Returned order is MRU-first (by
 *  `lastOpened`, falling back to insertion order). */
export function listMounts(): AttachedFolder[] {
  let raw: AttachedFolder[] = [];
  try {
    const stored = localStorage.getItem(MOUNTS_KEY);
    if (stored) raw = JSON.parse(stored) as AttachedFolder[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) {
    localStorage.removeItem(MOUNTS_KEY);
    return [];
  }
  // Filter malformed entries (id must be a string) so a single bad write
  // can't poison the whole list.
  const clean = raw.filter(
    (f): f is AttachedFolder => typeof f?.id === "string",
  );
  const sorted = clean.sort(
    (a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0),
  );
  if (clean.length !== raw.length) persist(sorted);
  return sorted;
}

/** Persist the mounts list. */
function persist(mounts: AttachedFolder[]): void {
  try {
    localStorage.setItem(MOUNTS_KEY, JSON.stringify(mounts));
  } catch {
    // Quota exceeded or disabled storage — the sidebar still works in-memory
    // for this session; the list just won't survive a reload. Non-fatal.
  }
}

/** Upsert a mount (by id), stamp `lastOpened`, cap the list, persist, and
 *  return the new MRU-sorted list so callers update state in lockstep. */
export function saveMount(folder: AttachedFolder): AttachedFolder[] {
  const stamped: AttachedFolder = { ...folder, lastOpened: Date.now() };
  const mounts = listMounts().filter((m) => m.id !== folder.id);
  mounts.push(stamped);
  // Cap: drop oldest by lastOpened (listMounts sorts MRU-first, so the tail
  // is the oldest). Keep the just-pushed one regardless.
  if (mounts.length > MAX_MOUNTS) {
    const keep = new Set([folder.id]);
    const sorted = mounts.sort(
      (a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0),
    );
    const trimmed = sorted.filter((m, i) => keep.has(m.id) || i < MAX_MOUNTS);
    persist(trimmed);
    return trimmed;
  }
  persist(mounts);
  return listMounts();
}

/** Remove a mount by id (the unmount action). Returns the new list. The
 *  chain is NOT affected — only the (chain, directory) binding is dropped.
 *  If the removed id was the active mount, the caller is responsible for
 *  switching (this function does not touch ACTIVE_MOUNT_KEY, so a mid-
 *  unmount switch can choose the fallback before clearing). */
export function removeMount(id: string): AttachedFolder[] {
  const mounts = listMounts().filter((m) => m.id !== id);
  persist(mounts);
  if (getActiveMount() === id) setActiveMount(null);
  return mounts;
}

/** The id of the currently-open mount, or null. */
export function getActiveMount(): string | null {
  return localStorage.getItem(ACTIVE_MOUNT_KEY);
}

/** Set the active mount id (or null to clear). */
export function setActiveMount(id: string | null): void {
  if (id) localStorage.setItem(ACTIVE_MOUNT_KEY, id);
  else localStorage.removeItem(ACTIVE_MOUNT_KEY);
}

/** Look up a mount by id. */
export function findMount(id: string): AttachedFolder | undefined {
  return listMounts().find((m) => m.id === id);
}
