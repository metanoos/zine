export interface DeletablePanel {
  tabs: string[];
  active: string;
}

export interface DeleteTabTarget {
  path: string;
  isFolder: boolean;
}

/** Remove tabs covered by a delete gesture while preserving unrelated tabs. */
export function closeDeletedTabs<T extends DeletablePanel>(
  panels: T[],
  targets: readonly DeleteTabTarget[],
  tabPath: (tab: string) => string,
): T[] {
  const isDeleted = (tab: string): boolean => {
    const path = tabPath(tab);
    return targets.some(
      (target) =>
        path === target.path ||
        (target.isFolder && path.startsWith(target.path + "/")),
    );
  };

  let changed = false;
  const next = panels.map((panel) => {
    if (!panel.tabs.some(isDeleted)) return panel;
    changed = true;

    const tabs = panel.tabs.filter((tab) => !isDeleted(tab));
    if (!isDeleted(panel.active)) return { ...panel, tabs };

    const activeIndex = panel.tabs.indexOf(panel.active);
    const active =
      panel.tabs.slice(activeIndex + 1).find((tab) => !isDeleted(tab)) ??
      panel.tabs.slice(0, activeIndex).reverse().find((tab) => !isDeleted(tab)) ??
      "";
    return { ...panel, tabs, active };
  });

  return changed ? next : panels;
}
