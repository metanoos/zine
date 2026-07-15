/**
 * Focus-delta routing: which mounted folder owns the path being focused?
 *
 * Every `focus` observation is recorded onto the **owning folder's** kind-4292
 * chain (protocol §3.3 — focus is per-folder, panel-occupancy telemetry). The
 * two App.tsx write sites (the selection effect and `closeTab`) route through
 * `ownerFolderOf` rather than "the active folder," so a file from folder F2
 * sitting in a panel never contaminates F1's replay — F2 owns it, so F2 gets
 * the observation. See protocol/trace-provenance.md §3.3 (focus) and §8 (the
 * per-folder buffer these observations drain from).
 *
 * `panelIndex` stays as the literal window slot. It is sparse-stable across
 * the folder's lifetime: a panel may go empty and refill, but slot N is always
 * slot N. Dense per-folder indices would renumber when the active set changes,
 * corrupting replay of older sessions; sparse slots are stable forever.
 *
 * This module is pure (no React, no relay) so the routing contract is testable
 * in isolation. Today the caller passes one entry in `mounted`; multi-mount
 * will pass the full set. The call sites depend only on this signature.
 */

/** One mounted folder's membership, as seen by the focus router. */
export interface MountedFolder {
  folderId: string;
  /** Relative paths — the keys of that folder's `files` map. */
  members: Set<string>;
}

/** Which mounted folder owns `path`? Returns the owner's id, or null if the
 *  path is unowned (scratch buffer, stale selection, transient switch state).
 *  A path belongs to at most one folder: folders are addressed by genesis id
 *  and membership is relative paths under that folder's namespace, so two
 *  mounted folders never claim the same path.
 *
 *  Returns the first owner in `mounted` order. Callers should keep `mounted`
 *  disjoint; if they don't, the earliest claim wins (a deliberate, stable
 *  rule — never throws, since focus is advisory). */
export function ownerFolderOf(path: string, mounted: MountedFolder[]): string | null {
  for (const f of mounted) if (f.members.has(path)) return f.folderId;
  return null;
}

/** Convenience: build a single-entry `mounted` snapshot from the active
 *  folder's `files` map keys. This is the shape every call site uses today
 *  (one mounted folder); multi-mount will generalize this caller-side, not
 *  here. Extracted so the shape lives in one place. */
export function activeMounted(folderId: string | null, paths: Iterable<string>): MountedFolder[] {
  if (!folderId) return [];
  return [{ folderId, members: new Set(paths) }];
}
