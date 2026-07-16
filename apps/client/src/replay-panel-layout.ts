export interface ReplayPanelState {
  tabs: string[];
  active: string;
  /** Ephemeral panel created only for animated replay playback. */
  replayOwned?: boolean;
}

/** Build at most `cap` replay-owned panels without emitting empty placeholders.
 *  Paths beyond the cap share the last panel as tabs. */
export function createReplayPanels(
  paths: readonly string[],
  cap: number,
): ReplayPanelState[] {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  const panelCount = Math.min(uniquePaths.length, Math.max(0, Math.floor(cap)));
  if (panelCount === 0) return [];

  const panels: ReplayPanelState[] = [];
  for (let i = 0; i < panelCount; i++) {
    const tabs = i === panelCount - 1 ? uniquePaths.slice(i) : [uniquePaths[i]];
    panels.push({ tabs, active: tabs[0], replayOwned: true });
  }
  return panels;
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
