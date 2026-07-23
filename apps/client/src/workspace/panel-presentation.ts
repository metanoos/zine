import type { ReplaySpeed } from "../replay/replay-speed.js";
import { isStageViewState } from "../collaboration/stage-crypto.js";
import type {
  WorkingPresentation,
  ReplayPresentation,
  StageFoldRange,
  StagePanelView,
  StagePreviewAnchor,
  StageScrollAnchor,
  StageReplayTrace,
  StageViewState,
} from "../collaboration/stage-types.js";
import type { EditorSelectionState } from "@zine/protocol";
import type { StageWorkspaceState } from "./stage-workspace.js";

export class PanelPresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PanelPresentationError";
  }
}

export interface BeginPanelReplayInput {
  replayId: string;
  traces: readonly StageReplayTrace[];
  speed: ReplaySpeed;
}

export interface RestoredWorkingPanelView {
  selection: EditorSelectionState | null;
  scrollAnchor: StageScrollAnchor | null;
  folds: readonly StageFoldRange[];
  previewAnchor: StagePreviewAnchor | null;
}

export interface PrivatePanelReplayResult<TEditorState> {
  workspace: StageWorkspaceState<TEditorState>;
  replayId: string;
}

function cloneWorkingPresentation(
  presentation: WorkingPresentation,
): WorkingPresentation {
  return {
    kind: "working",
    resource: { ...presentation.resource },
    mode: presentation.mode,
  };
}

function clonePanel(panel: StagePanelView): StagePanelView {
  const presentation = panel.presentation.kind === "working"
    ? cloneWorkingPresentation(panel.presentation)
    : {
        kind: "replay" as const,
        replayId: panel.presentation.replayId,
        traces: panel.presentation.traces.map((trace) => ({ ...trace })),
        playhead: { ...panel.presentation.playhead },
        returnTo: cloneWorkingPresentation(panel.presentation.returnTo),
      };
  return {
    panelId: panel.panelId,
    presentation,
    selection: panel.selection === null
      ? null
      : {
          ranges: panel.selection.ranges.map((range) => ({ ...range })),
          main: panel.selection.main,
        },
    scrollAnchor: panel.scrollAnchor === null
      ? null
      : { ...panel.scrollAnchor },
    folds: panel.folds.map((fold) => ({ ...fold })),
    previewAnchor: panel.previewAnchor === null
      ? null
      : { ...panel.previewAnchor },
  };
}

function updatePanel(
  view: StageViewState,
  panelId: string,
  update: (panel: StagePanelView) => StagePanelView,
): StageViewState {
  let found = false;
  const panels = view.panels.map((panel) => {
    const clone = clonePanel(panel);
    if (clone.panelId !== panelId) return clone;
    found = true;
    return update(clone);
  });
  if (!found) {
    throw new PanelPresentationError(`unknown Stage panel ${panelId}`);
  }
  const next: StageViewState = {
    version: view.version,
    revision: view.revision + 1,
    panels: panels.length === 1
      ? [panels[0]!]
      : [panels[0]!, panels[1]!],
    activePanelId: view.activePanelId,
    arrangement: view.arrangement === null
      ? null
      : { ...view.arrangement },
  };
  if (!isStageViewState(next)) {
    throw new PanelPresentationError("panel presentation update is invalid");
  }
  return next;
}

function replayPanel(
  panel: StagePanelView,
  operation: string,
): ReplayPresentation {
  if (panel.presentation.kind !== "replay") {
    throw new PanelPresentationError(
      `cannot ${operation} outside a Replay presentation`,
    );
  }
  return panel.presentation;
}

/**
 * Replace one working Stage panel with Replay in place. The panel id, slot,
 * arrangement, and every other panel remain unchanged.
 */
export function beginPanelReplay(
  view: StageViewState,
  panelId: string,
  input: BeginPanelReplayInput,
): StageViewState {
  return updatePanel(view, panelId, (panel) => {
    if (panel.presentation.kind !== "working") {
      throw new PanelPresentationError("panel is already presenting Replay");
    }
    return {
      ...panel,
      presentation: {
        kind: "replay",
        replayId: input.replayId,
        traces: input.traces.map((trace) => ({ ...trace })),
        playhead: {
          status: "paused",
          at: 0,
          speed: input.speed,
        },
        returnTo: cloneWorkingPresentation(panel.presentation),
      },
    };
  });
}

/** Update playback state for exactly one Replay panel. */
export function updatePanelReplayPlayhead(
  view: StageViewState,
  panelId: string,
  playhead: ReplayPresentation["playhead"],
): StageViewState {
  return updatePanel(view, panelId, (panel) => {
    const presentation = replayPanel(panel, "change its playhead");
    return {
      ...panel,
      presentation: {
        ...presentation,
        traces: presentation.traces.map((trace) => ({ ...trace })),
        playhead: { ...playhead },
        returnTo: cloneWorkingPresentation(presentation.returnTo),
      },
    };
  });
}

/**
 * Changing trace membership is intentionally discontinuous: playback pauses
 * and restarts at zero so peers never interpret one playhead against two trace
 * sets.
 */
export function replacePanelReplayTraces(
  view: StageViewState,
  panelId: string,
  replayId: string,
  traces: readonly StageReplayTrace[],
): StageViewState {
  return updatePanel(view, panelId, (panel) => {
    const presentation = replayPanel(panel, "replace its traces");
    return {
      ...panel,
      presentation: {
        ...presentation,
        replayId,
        traces: traces.map((trace) => ({ ...trace })),
        playhead: {
          ...presentation.playhead,
          status: "paused",
          at: 0,
        },
        returnTo: cloneWorkingPresentation(presentation.returnTo),
      },
    };
  });
}

/**
 * Return one panel to its working resource. The caller supplies the controller's
 * restored view fields; the opaque suspended CodeMirror state itself remains
 * participant-private and never enters this shared value.
 */
export function returnPanelToWorking(
  view: StageViewState,
  panelId: string,
  restored: RestoredWorkingPanelView,
): StageViewState {
  return updatePanel(view, panelId, (panel) => {
    const presentation = replayPanel(panel, "return it to Work");
    return {
      panelId: panel.panelId,
      presentation: cloneWorkingPresentation(presentation.returnTo),
      selection: restored.selection === null
        ? null
        : {
            ranges: restored.selection.ranges.map((range) => ({ ...range })),
            main: restored.selection.main,
          },
      scrollAnchor: restored.scrollAnchor === null
        ? null
        : { ...restored.scrollAnchor },
      folds: restored.folds.map((fold) => ({ ...fold })),
      previewAnchor: restored.previewAnchor === null
        ? null
        : { ...restored.previewAnchor },
    };
  });
}

function updatePrivateStageView<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  update: (view: StageViewState) => StageViewState,
): StageWorkspaceState<TEditorState> {
  if (!workspace.stage || workspace.stage.snapshot.status === "ended") {
    throw new PanelPresentationError("private Stage playback requires an open Stage");
  }
  return {
    ...workspace,
    stage: {
      ...workspace.stage,
      local: {
        mode: "detached",
        projected: update(workspace.stage.local.projected),
      },
    },
  };
}

/**
 * A non-controlling participant starts Replay against only their local Stage
 * projection. Detachment and editor suspension happen in the same immutable
 * transition; the authoritative Stage snapshot is left byte-for-byte intact.
 */
export function beginPrivateStagePanelReplay<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  input: BeginPanelReplayInput,
  suspendedEditorState: TEditorState,
): PrivatePanelReplayResult<TEditorState> {
  const updated = updatePrivateStageView(
    workspace,
    (view) => beginPanelReplay(view, panelId, input),
  );
  return {
    replayId: input.replayId,
    workspace: {
      ...updated,
      editorState: updated.editorState.with(
        panelId,
        input.replayId,
        suspendedEditorState,
      ),
    },
  };
}

export function updatePrivateStagePanelPlayhead<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  playhead: ReplayPresentation["playhead"],
): StageWorkspaceState<TEditorState> {
  return updatePrivateStageView(
    workspace,
    (view) => updatePanelReplayPlayhead(view, panelId, playhead),
  );
}

export function replacePrivateStagePanelTraces<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  replayId: string,
  traces: readonly StageReplayTrace[],
): StageWorkspaceState<TEditorState> {
  const panel = workspace.stage?.local.projected.panels.find(
    (candidate) => candidate.panelId === panelId,
  );
  if (!panel || panel.presentation.kind !== "replay") {
    throw new PanelPresentationError("panel is not privately presenting Replay");
  }
  const priorReplayId = panel.presentation.replayId;
  const suspended = workspace.editorState.get(panelId, priorReplayId);
  const updated = updatePrivateStageView(
    workspace,
    (view) => replacePanelReplayTraces(view, panelId, replayId, traces),
  );
  if (priorReplayId === replayId || suspended === undefined) return updated;
  return {
    ...updated,
    editorState: updated.editorState
      .without(panelId, priorReplayId)
      .with(panelId, replayId, suspended),
  };
}

/**
 * Return a detached private Replay to Work and release its matching opaque
 * suspension. The latest shared Stage remains available for an explicit
 * rejoin; returning to Work does not silently reattach the participant.
 */
export function returnPrivateStagePanelToWorking<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  restored: RestoredWorkingPanelView,
): StageWorkspaceState<TEditorState> {
  const panel = workspace.stage?.local.projected.panels.find(
    (candidate) => candidate.panelId === panelId,
  );
  if (!panel || panel.presentation.kind !== "replay") {
    throw new PanelPresentationError("panel is not privately presenting Replay");
  }
  const replayId = panel.presentation.replayId;
  const updated = updatePrivateStageView(
    workspace,
    (view) => returnPanelToWorking(view, panelId, restored),
  );
  return {
    ...updated,
    editorState: updated.editorState.without(panelId, replayId),
  };
}
