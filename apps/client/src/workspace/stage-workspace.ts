import type {
  WorkingPresentation,
  StageLocalAttachment,
  StagePanelView,
  StageResource,
  StageSessionSnapshot,
  StageViewState,
} from "../collaboration/stage-types.js";
import type { PanelState } from "./panel-state.js";

export interface IdentifiedPanelState extends PanelState {
  /** Stable local identity. Paths remain mutable tab labels only. */
  panelId: string;
}

export interface StageWorkspaceLayout {
  panels: readonly IdentifiedPanelState[];
  activePanelId: string | null;
}

export interface WorkspaceStageAttachment {
  /** Latest complete shared snapshot, including updates received while detached. */
  snapshot: StageSessionSnapshot;
  /** Participant-private follow mode and the view currently projected locally. */
  local: StageLocalAttachment;
}

/**
 * Opaque CodeMirror state suspended for an in-place Working -> Replay transition.
 *
 * The values remain in a private field and `toJSON` deliberately omits the
 * sidecar. Shared Stage snapshots therefore cannot accidentally acquire local
 * document text, selection pixels, or undo-manager state.
 */
export class PrivateStageEditorState<T> {
  readonly #byReplay: ReadonlyMap<string, T>;

  private constructor(byReplay: ReadonlyMap<string, T>) {
    this.#byReplay = byReplay;
  }

  static empty<T>(): PrivateStageEditorState<T> {
    return new PrivateStageEditorState<T>(new Map());
  }

  get(panelId: string, replayId: string): T | undefined {
    return this.#byReplay.get(editorStateKey(panelId, replayId));
  }

  has(panelId: string, replayId: string): boolean {
    return this.#byReplay.has(editorStateKey(panelId, replayId));
  }

  with(panelId: string, replayId: string, state: T): PrivateStageEditorState<T> {
    const next = new Map(this.#byReplay);
    next.set(editorStateKey(panelId, replayId), state);
    return new PrivateStageEditorState(next);
  }

  without(panelId: string, replayId: string): PrivateStageEditorState<T> {
    const key = editorStateKey(panelId, replayId);
    if (!this.#byReplay.has(key)) return this;
    const next = new Map(this.#byReplay);
    next.delete(key);
    return new PrivateStageEditorState(next);
  }

  toJSON(): undefined {
    return undefined;
  }
}

function editorStateKey(panelId: string, replayId: string): string {
  return `${panelId.length}:${panelId}${replayId}`;
}

export interface StageWorkspaceState<TEditorState = unknown> {
  /** The participant's ordinary layout. Stage never mutates it while attached. */
  layout: StageWorkspaceLayout;
  stage: WorkspaceStageAttachment | null;
  /** Participant-private runtime state; never part of a Stage snapshot. */
  editorState: PrivateStageEditorState<TEditorState>;
}

export type StageResourceResolver = (resource: StageResource) => string;

export interface ProjectedStagePanel extends PanelState {
  panelId: string;
  view: StagePanelView;
}

export interface ProjectedStageCluster {
  panels: readonly [ProjectedStagePanel] | readonly [
    ProjectedStagePanel,
    ProjectedStagePanel,
  ];
  activePanelId: string;
  arrangement: StageViewState["arrangement"];
  revision: number;
}

export type StagePanelInteraction =
  | "navigate"
  | "scroll"
  | "select"
  | "type";

export interface StageWorkspaceInteraction {
  /**
   * The surface is explicit because a staged panel can have the same stable ID
   * as the private panel it was started from.
   */
  surface: "stage" | "private";
  panelId: string;
  kind: StagePanelInteraction;
}

function presentationResource(view: StagePanelView): StageResource {
  return view.presentation.kind === "working"
    ? view.presentation.resource
    : view.presentation.returnTo.resource;
}

function resolvePanel(
  view: StagePanelView,
  resolveResource: StageResourceResolver,
): ProjectedStagePanel {
  const tab = resolveResource(presentationResource(view));
  if (!tab) {
    throw new Error("The staged resource is not available in this workspace");
  }
  return {
    panelId: view.panelId,
    tabs: [tab],
    active: tab,
    view,
  };
}

function projectView(
  view: StageViewState,
  resolveResource: StageResourceResolver,
): ProjectedStageCluster {
  const first = resolvePanel(view.panels[0], resolveResource);
  const panels: ProjectedStageCluster["panels"] = view.panels.length === 1
    ? [first]
    : [first, resolvePanel(view.panels[1], resolveResource)];
  return {
    panels,
    activePanelId: view.activePanelId,
    arrangement: view.arrangement,
    revision: view.revision,
  };
}

function hasStagedPanel(
  attachment: WorkspaceStageAttachment,
  panelId: string,
): boolean {
  return attachment.local.projected.panels.some((panel) => panel.panelId === panelId);
}

function mergeStageViewIntoLayout(
  layout: StageWorkspaceLayout,
  view: StageViewState,
  resolveResource: StageResourceResolver,
): StageWorkspaceLayout {
  const projected = projectView(view, resolveResource);
  const panels = [...layout.panels];

  for (const staged of projected.panels) {
    const existingIndex = panels.findIndex((panel) => panel.panelId === staged.panelId);
    if (existingIndex < 0) {
      panels.push({
        panelId: staged.panelId,
        tabs: [...staged.tabs],
        active: staged.active,
      });
      continue;
    }

    const existing = panels[existingIndex];
    const merged: IdentifiedPanelState = {
      ...existing,
      tabs: existing.tabs.includes(staged.active)
        ? [...existing.tabs]
        : [...existing.tabs, staged.active],
      active: staged.active,
    };
    // A completed Stage panel is ordinary private workspace state. Existing
    // replay ownership flags must not make a later replay teardown remove it.
    delete merged.replayOwned;
    delete merged.replayPanelIndex;
    panels[existingIndex] = merged;
  }

  return {
    panels,
    activePanelId: projected.activePanelId,
  };
}

export function createStageWorkspace<TEditorState>(
  layout: StageWorkspaceLayout,
): StageWorkspaceState<TEditorState> {
  return {
    layout,
    stage: null,
    editorState: PrivateStageEditorState.empty<TEditorState>(),
  };
}

/**
 * Attach to a current Stage. Active Stage joins call this automatically.
 * Vacant Stages are also attachable so their last view can remain visibly
 * frozen during controller recovery.
 */
export function followStage<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  snapshot: StageSessionSnapshot,
): StageWorkspaceState<TEditorState> {
  if (snapshot.status === "ended") return workspace;
  return {
    ...workspace,
    stage: {
      snapshot,
      local: {
        mode: "following",
        projected: snapshot.view,
      },
    },
  };
}

/**
 * Apply a complete Stage snapshot. Followers project it atomically; detached
 * participants retain their local cluster while still learning the latest
 * shared state for a future rejoin.
 */
export function applyStageSnapshot<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  snapshot: StageSessionSnapshot,
  resolveResource: StageResourceResolver,
): StageWorkspaceState<TEditorState> {
  const attachment = workspace.stage;
  if (!attachment) {
    return snapshot.status === "ended"
      ? workspace
      : followStage(workspace, snapshot);
  }
  if (attachment.snapshot.stageId !== snapshot.stageId) {
    throw new Error("Cannot attach one workspace to two Stages");
  }
  // The Stage protocol advances the view revision for every accepted command,
  // including lifecycle-only changes. Duplicates and out-of-order delivery can
  // therefore be ignored without hiding a legitimate status transition.
  if (snapshot.view.revision <= attachment.snapshot.view.revision) {
    return workspace;
  }

  if (snapshot.status === "ended") {
    const finalView = attachment.local.mode === "following"
      ? snapshot.view
      : attachment.local.projected;
    return {
      ...workspace,
      layout: mergeStageViewIntoLayout(workspace.layout, finalView, resolveResource),
      stage: null,
    };
  }

  return {
    ...workspace,
    stage: {
      snapshot,
      local: attachment.local.mode === "following"
        ? {
            mode: "following",
            projected: snapshot.view,
          }
        : attachment.local,
    },
  };
}

/**
 * Direct manipulation of a followed Stage panel detaches before the caller
 * applies the navigation, scroll, selection, or edit. Private-panel activity
 * has no effect on Stage following.
 */
export function handleStageWorkspaceInteraction<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  interaction: StageWorkspaceInteraction,
): StageWorkspaceState<TEditorState> {
  const attachment = workspace.stage;
  if (
    !attachment
    || attachment.local.mode === "detached"
    || interaction.surface === "private"
    || !hasStagedPanel(attachment, interaction.panelId)
  ) {
    return workspace;
  }

  return {
    ...workspace,
    stage: {
      ...attachment,
      local: {
        ...attachment.local,
        mode: "detached",
      },
    },
  };
}

/** Snap an explicitly detached participant to the complete current Stage view. */
export function rejoinStage<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
): StageWorkspaceState<TEditorState> {
  if (!workspace.stage || workspace.stage.snapshot.status === "ended") {
    return workspace;
  }
  return {
    ...workspace,
    stage: {
      ...workspace.stage,
      local: {
        mode: "following",
        projected: workspace.stage.snapshot.view,
      },
    },
  };
}

export function projectStageCluster<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  resolveResource: StageResourceResolver,
): ProjectedStageCluster | null {
  return workspace.stage
    ? projectView(workspace.stage.local.projected, resolveResource)
    : null;
}

export function suspendStageEditorState<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  replayId: string,
  editorState: TEditorState,
): StageWorkspaceState<TEditorState> {
  if (!workspace.stage || !hasStagedPanel(workspace.stage, panelId)) {
    throw new Error("Cannot suspend editor state for a panel outside Stage");
  }
  return {
    ...workspace,
    editorState: workspace.editorState.with(panelId, replayId, editorState),
  };
}

export function suspendedStageEditorState<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  replayId: string,
): TEditorState | undefined {
  return workspace.editorState.get(panelId, replayId);
}

export function clearSuspendedStageEditorState<TEditorState>(
  workspace: StageWorkspaceState<TEditorState>,
  panelId: string,
  replayId: string,
): StageWorkspaceState<TEditorState> {
  return {
    ...workspace,
    editorState: workspace.editorState.without(panelId, replayId),
  };
}

/**
 * Convenience for constructing the shared Return-to-Work destination without
 * ever placing the participant's opaque suspended CodeMirror state in it.
 */
export function replayReturnTo(
  panel: StagePanelView,
): WorkingPresentation | null {
  return panel.presentation.kind === "replay"
    ? panel.presentation.returnTo
    : null;
}
