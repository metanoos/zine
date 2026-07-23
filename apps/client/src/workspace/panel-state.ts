/** One live or replay-owned column in the workspace panel layout. */
export interface PanelState {
  tabs: string[];
  active: string;
  /** Session-owned read-only replay panel, never persisted. */
  replayOwned?: boolean;
  /** Historical panel slot from a replay focus delta. */
  replayPanelIndex?: number;
}
