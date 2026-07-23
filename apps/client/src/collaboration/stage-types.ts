import type { EditorSelectionState } from "@zine/protocol";

import type { ReplaySpeed } from "../replay/replay-speed.js";

export const STAGE_VERSION = 1;
export const STAGE_CONTROLLER_GRACE_MS = 10_000;

export type StagePanelMode = "preview" | "markdown" | "diff";

/** A Stage resource uses the Collaboration's stable entry identity, never a path. */
export interface StageResource {
  entryId: string;
  kind: "file" | "folder";
}

export interface WorkingPresentation {
  kind: "working";
  resource: StageResource;
  mode: StagePanelMode;
}

export interface StageReplayTrace {
  /** Entry whose readable Collaboration scope authorizes this trace. */
  entryId: string;
  /** Immutable trace identity selected for playback. */
  traceId: string;
}

export interface ReplayPlayhead {
  status: "paused" | "playing";
  at: number;
  speed: ReplaySpeed;
}

export interface ReplayPresentation {
  kind: "replay";
  replayId: string;
  traces: readonly StageReplayTrace[];
  playhead: ReplayPlayhead;
  /**
   * Shared, view-only destination for Return to Work. The local CodeMirror
   * document, selection, scroll pixels, and undo manager remain in a private
   * suspension owned by each participant's workspace adapter.
   */
  returnTo: WorkingPresentation;
}

export type PanelPresentation = WorkingPresentation | ReplayPresentation;

export interface StageScrollAnchor {
  /** UTF-16 document position, or the closest meaningful resource position. */
  position: number;
  /** Pixel offset from the top of the panel after positioning the anchor. */
  offset: number;
}

export interface StageFoldRange {
  from: number;
  to: number;
}

export interface StagePreviewAnchor {
  /** Stable DOM/Markdown heading key when available. */
  key: string;
  /** Pixel offset beneath the resolved preview anchor. */
  offset: number;
}

export interface StagePanelView {
  panelId: string;
  presentation: PanelPresentation;
  selection: EditorSelectionState | null;
  scrollAnchor: StageScrollAnchor | null;
  folds: readonly StageFoldRange[];
  previewAnchor: StagePreviewAnchor | null;
}

export interface StagePanelArrangement {
  direction: "row" | "column";
  /** Share of the first panel, strictly between zero and one. */
  primaryRatio: number;
}

/**
 * The complete shared presentation cluster. Anything absent here is private:
 * other panels, tabs, theme, window geometry, hover, clipboard, and IME state.
 */
export interface StageViewState {
  version: typeof STAGE_VERSION;
  revision: number;
  panels: readonly [StagePanelView] | readonly [StagePanelView, StagePanelView];
  activePanelId: string;
  arrangement: StagePanelArrangement | null;
}

export interface StageControlTransfer {
  transferId: string;
  fromPubkey: string;
  toPubkey: string;
  requestedAt: number;
}

export type StageStatus = "active" | "vacant" | "ended";

export interface StageSessionSnapshot {
  version: typeof STAGE_VERSION;
  stageId: string;
  collaborationId: string;
  ownerPubkey: string;
  controllerPubkey: string | null;
  status: StageStatus;
  view: StageViewState;
  pendingControlTransfer: StageControlTransfer | null;
  controllerDisconnectedAt: number | null;
  updatedAt: number;
}

export type StageFollowMode = "following" | "detached";

export interface StageLocalAttachment {
  mode: StageFollowMode;
  /** Full snapshot last projected into this participant's Stage cluster. */
  projected: StageViewState;
}
