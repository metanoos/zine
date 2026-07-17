/**
 * Focus-delta routing inside the one mounted folder.
 *
 * Every `focus` observation is recorded onto the **owning folder's** kind-4292
 * chain (protocol §3.3 — focus is per-folder, panel-occupancy telemetry). The
 * App routes through `ownerFolderOf` so stale or scratch paths cannot leak into
 * the active folder's replay buffer. See protocol/trace-provenance.md §3.3
 * (focus) and §8 (the per-folder buffer these observations drain from).
 *
 * `panelIndex` stays as the literal window slot. It is sparse-stable across
 * the folder's lifetime: a panel may go empty and refill, but slot N is always
 * slot N. Dense per-folder indices would renumber when the active set changes,
 * corrupting replay of older sessions; sparse slots are stable forever.
 *
 * This module is pure (no React, no relay) so the routing contract is testable
 * in isolation.
 */

/** One mounted folder's membership, as seen by the focus router. */
export interface MountedFolder {
  folderId: string;
  /** Relative paths — the keys of that folder's `files` map. */
  members: Set<string>;
}

/** Return the active folder id when it owns `path`, otherwise null. */
export function ownerFolderOf(path: string, mounted: MountedFolder | null): string | null {
  return mounted?.members.has(path) ? mounted.folderId : null;
}

/** Build the active mount snapshot from the folder's `files` map keys. */
export function activeMount(folderId: string | null, paths: Iterable<string>): MountedFolder | null {
  if (!folderId) return null;
  return { folderId, members: new Set(paths) };
}
