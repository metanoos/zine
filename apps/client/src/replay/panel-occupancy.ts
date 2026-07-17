export interface OccupancyEntry<T> {
  key: string;
  ownerFolderId: string;
  selection: T;
}

export interface OccupancyTransition<T> {
  op: "mount" | "unmount";
  panelIndex: number;
  entry: OccupancyEntry<T>;
}

/** Diff active edit-panel contents into ordered unmount/mount observations. */
export function occupancyTransitions<T>(
  previous: readonly (OccupancyEntry<T> | null)[],
  next: readonly (OccupancyEntry<T> | null)[],
): OccupancyTransition<T>[] {
  const out: OccupancyTransition<T>[] = [];
  const count = Math.max(previous.length, next.length);
  for (let panelIndex = 0; panelIndex < count; panelIndex++) {
    const before = previous[panelIndex] ?? null;
    const after = next[panelIndex] ?? null;
    if (before?.key === after?.key && before?.ownerFolderId === after?.ownerFolderId) continue;
    if (before) out.push({ op: "unmount", panelIndex, entry: before });
    if (after) out.push({ op: "mount", panelIndex, entry: after });
  }
  return out;
}
