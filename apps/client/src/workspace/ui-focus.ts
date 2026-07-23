/**
 * One semantic subject and one visible tab locus.
 *
 * Focus is deliberately not directory selection. The directory may hold an
 * arbitrary operation set for drag, context-menu, or batch work while this
 * value continues to route author gestures, MODEL work, and replay.
 *
 *     directory/tab activation
 *               |
 *               v
 *       UiFocus(trace + locus)
 *          /        |       \
 *       author    MODEL    replay
 *
 * Replay projections never rewrite the locus. A projected child must first
 * exit replay and activate a live tab before it can become focus.
 */

export type FocusRef =
  | { kind: "file"; path: string; nodeId?: string }
  | { kind: "folder"; path: string; nodeId?: string }
  | { kind: "coin"; path?: string; nodeId?: string; phrase?: string };

export type UiFocus = FocusRef & {
  /** Exact live panel containing the focus locus. */
  panelIndex: number;
  /** Exact tab token, including folder:// tokens when applicable. A folder
   * row can borrow the current live tab (or an empty panel) without opening. */
  tabPath: string;
};

/** Attach a semantic trace to the one live tab that visibly owns focus. */
export function locateFocus(
  trace: FocusRef,
  panelIndex: number,
  tabPath: string,
): UiFocus {
  return {
    ...trace,
    panelIndex: Math.max(0, Math.trunc(panelIndex)),
    tabPath,
  };
}

/** Refresh an advancing trace head without changing its visible focus locus. */
export function refreshFocusNode(
  focus: UiFocus,
  nodeId: string | undefined,
): UiFocus {
  if (focus.nodeId === nodeId) return focus;
  return { ...focus, nodeId };
}

/** Rebase path identity after a rename or move while preserving focus. */
export function rebaseUiFocus(
  focus: UiFocus | null,
  rebasePath: (path: string) => string,
  rebaseTab: (tabPath: string) => string = rebasePath,
): UiFocus | null {
  if (!focus) return null;
  const path = focus.path === undefined ? undefined : rebasePath(focus.path);
  const tabPath = rebaseTab(focus.tabPath);
  if (path === focus.path && tabPath === focus.tabPath) return focus;
  return {
    ...focus,
    ...(path === undefined ? {} : { path }),
    tabPath,
  };
}

/** Directory gold follows a path-backed focus; node-only Coins have no row. */
export function focusDirectoryPath(focus: UiFocus | null): string | null {
  return focus?.path ?? null;
}

/** Whether a visible tab represents the same semantic subject as the focus.
 * The tab locus alone is insufficient: selecting a directory row deliberately
 * borrows the current live tab without turning that tab into the folder. */
export function focusMatchesTrace(
  focus: UiFocus | null,
  trace: FocusRef | null,
): boolean {
  if (!focus || !trace || focus.kind !== trace.kind) return false;
  if (focus.path !== undefined || trace.path !== undefined) {
    return focus.path === trace.path;
  }
  return focus.nodeId !== undefined && focus.nodeId === trace.nodeId;
}

/** Replay follows exactly one focused subject, never a directory operation set. */
export function focusReplayTarget(
  focus: UiFocus | null,
): { kind: "file" | "folder"; path: string } | null {
  if (!focus) return null;
  if (focus.kind === "folder") return { kind: "folder", path: focus.path };
  if (!focus.path) return null;
  // Path-backed Coins are immutable file traces in Mint.
  return { kind: "file", path: focus.path };
}

/** Avoid React state churn when a panel reconciliation yields the same focus. */
export function sameUiFocus(a: UiFocus | null, b: UiFocus | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.kind === b.kind &&
    a.path === b.path &&
    a.nodeId === b.nodeId &&
    (a.kind === "coin" ? a.phrase : undefined) ===
      (b.kind === "coin" ? b.phrase : undefined) &&
    a.panelIndex === b.panelIndex &&
    a.tabPath === b.tabPath
  );
}
