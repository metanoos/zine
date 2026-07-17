export interface ReplayPanelState {
  tabs: string[];
  active: string;
  /** Session-owned, read-only replay surface. Never persisted as workspace layout. */
  replayOwned?: boolean;
  /** Original panel slot recorded by a folder focus delta. Undefined when an
   *  older trace has no focus evidence and replay chose a fallback column. */
  replayPanelIndex?: number;
}

export interface ReplayPanelPath {
  path: string;
  panelIndex?: number;
}

/** Return the live panels that should remain beside a replay projection. Empty
 *  live panels are disposable placeholders: once replay has content to mount,
 *  dropping them lets every occupied panel shift into the leftmost free slot. */
export function replayLivePanelIndices(
  panels: readonly ReplayPanelState[],
  hasReplayEntries: boolean,
): number[] {
  const indices: number[] = [];
  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    if (panel.replayOwned) continue;
    if (hasReplayEntries && panel.tabs.length === 0) continue;
    indices.push(i);
  }
  return indices;
}

/** Rebuild replay columns from the folder's recorded occupancy. Traces that
 * share a recorded panel slot remain tabs in that column. Older traces with no
 * focus evidence get their own columns, which is the least surprising fallback
 * when a new file first appears during playback. */
export function createReplayPanels(
  entries: readonly ReplayPanelPath[],
  cap: number,
): ReplayPanelState[] {
  const limit = Math.max(0, Math.floor(cap));
  if (limit < 1) return [];

  const latestByPath = new Map<string, ReplayPanelPath>();
  for (const entry of entries) {
    if (!entry.path) continue;
    latestByPath.delete(entry.path);
    latestByPath.set(entry.path, entry);
  }

  const recorded = new Map<number, string[]>();
  const unplaced: string[] = [];
  for (const { path, panelIndex } of latestByPath.values()) {
    if (Number.isInteger(panelIndex) && (panelIndex ?? -1) >= 0) {
      const slot = panelIndex as number;
      const tabs = recorded.get(slot);
      if (tabs) tabs.push(path);
      else recorded.set(slot, [path]);
    } else {
      unplaced.push(path);
    }
  }

  const panels: ReplayPanelState[] = [...recorded.entries()]
    .sort(([a], [b]) => a - b)
    .map(([replayPanelIndex, tabs]) => ({
      tabs,
      active: tabs[0] ?? "",
      replayOwned: true,
      replayPanelIndex,
    }));
  for (const path of unplaced) {
    panels.push({ tabs: [path], active: path, replayOwned: true });
  }
  if (panels.length <= limit) return panels;
  const kept = panels.slice(0, limit);
  const overflowTabs = panels.slice(limit).flatMap((panel) => panel.tabs);
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = {
    ...last,
    tabs: [...last.tabs, ...overflowTabs],
  };
  return kept;
}

/** Remove only replay-owned panels from the current layout. Live panels are
 *  returned exactly as they exist now, so closes/resizes performed while replay
 *  was running survive teardown instead of being overwritten by an old snapshot. */
export function removeReplayPanels<T extends ReplayPanelState>(
  panels: readonly T[],
  activePanel: number,
): { panels: T[]; keptIndices: number[]; activePanel: number } {
  const keptIndices: number[] = [];
  const keptPanels: T[] = [];
  for (let i = 0; i < panels.length; i++) {
    if (panels[i].replayOwned) continue;
    keptIndices.push(i);
    keptPanels.push(panels[i]);
  }

  if (keptPanels.length === 0) {
    return { panels: [], keptIndices, activePanel: 0 };
  }

  const exact = keptIndices.indexOf(activePanel);
  if (exact >= 0) {
    return { panels: keptPanels, keptIndices, activePanel: exact };
  }

  // The active panel was replay-owned. Prefer the nearest live panel to its
  // left, otherwise the first live panel to its right (which shifts to 0).
  const liveBefore = keptIndices.filter((i) => i < activePanel).length;
  return {
    panels: keptPanels,
    keptIndices,
    activePanel: Math.max(0, Math.min(keptPanels.length - 1, liveBefore - 1)),
  };
}
