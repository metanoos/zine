import assert from "node:assert/strict";
import test from "node:test";

import type {
  WorkingPresentation,
  PanelPresentation,
  StagePanelView,
  StageSessionSnapshot,
  StageViewState,
} from "../collaboration/stage-types.js";
import {
  applyStageSnapshot,
  clearSuspendedStageEditorState,
  createStageWorkspace,
  followStage,
  handleStageWorkspaceInteraction,
  projectStageCluster,
  rejoinStage,
  replayReturnTo,
  suspendedStageEditorState,
  suspendStageEditorState,
  type StagePanelInteraction,
  type StageResourceResolver,
  type StageWorkspaceLayout,
} from "./stage-workspace.js";

const resolveResource: StageResourceResolver = (resource) => (
  resource.kind === "folder"
    ? `folder://path-for-${resource.entryId}`
    : `path-for-${resource.entryId}.md`
);

function workingPresentation(
  entryId: string,
  kind: "file" | "folder" = "file",
): WorkingPresentation {
  return {
    kind: "working",
    resource: { entryId, kind },
    mode: kind === "folder" ? "preview" : "markdown",
  };
}

function stagePanel(
  panelId: string,
  presentation: PanelPresentation,
  position = 0,
): StagePanelView {
  return {
    panelId,
    presentation,
    selection: presentation.kind === "working" && presentation.resource.kind === "file"
      ? { ranges: [{ anchor: position, head: position }], main: 0 }
      : null,
    scrollAnchor: { position, offset: 12 },
    folds: [{ from: position, to: position + 4 }],
    previewAnchor: { key: `heading-${position}`, offset: 8 },
  };
}

function stageView(
  revision: number,
  panels: readonly [StagePanelView] | readonly [StagePanelView, StagePanelView],
  activePanelId = panels[0].panelId,
): StageViewState {
  return {
    version: 1,
    revision,
    panels,
    activePanelId,
    arrangement: panels.length === 2
      ? { direction: "row", primaryRatio: 0.6 }
      : null,
  };
}

function snapshot(
  view: StageViewState,
  options: {
    status?: StageSessionSnapshot["status"];
    updatedAt?: number;
    stageId?: string;
  } = {},
): StageSessionSnapshot {
  return {
    version: 1,
    stageId: options.stageId ?? "stage-1",
    collaborationId: "working-1",
    ownerPubkey: "owner",
    controllerPubkey: options.status === "vacant" ? null : "controller",
    status: options.status ?? "active",
    view,
    pendingControlTransfer: null,
    controllerDisconnectedAt: options.status === "vacant" ? 10 : null,
    updatedAt: options.updatedAt ?? view.revision,
  };
}

const privateLayout = (): StageWorkspaceLayout => ({
  panels: [
    {
      panelId: "private-panel",
      tabs: ["private.md"],
      active: "private.md",
    },
    {
      panelId: "stage-panel",
      tabs: ["local-only.md"],
      active: "local-only.md",
    },
  ],
  activePanelId: "private-panel",
});

test("joining an active Stage follows only its explicit stable-ID panel cluster", () => {
  const layout = privateLayout();
  const shared = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-a"), 2),
    stagePanel("guest-panel", workingPresentation("folder-b", "folder"), 5),
  ], "guest-panel");

  const workspace = followStage(
    createStageWorkspace<never>(layout),
    snapshot(shared),
  );
  const projection = projectStageCluster(workspace, resolveResource);

  assert.equal(workspace.stage?.local.mode, "following");
  assert.equal(workspace.layout, layout);
  assert.deepEqual(workspace.layout, privateLayout());
  assert.deepEqual(projection, {
    panels: [
      {
        panelId: "stage-panel",
        tabs: ["path-for-entry-a.md"],
        active: "path-for-entry-a.md",
        view: shared.panels[0],
      },
      {
        panelId: "guest-panel",
        tabs: ["folder://path-for-folder-b"],
        active: "folder://path-for-folder-b",
        view: shared.panels[1],
      },
    ],
    activePanelId: "guest-panel",
    arrangement: { direction: "row", primaryRatio: 0.6 },
    revision: 1,
  });
});

test("followers atomically replace the complete Stage cluster on shared updates", () => {
  const first = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-a")),
    stagePanel("guest-panel", workingPresentation("entry-b")),
  ]);
  const next = stageView(2, [
    stagePanel("replacement-panel", workingPresentation("entry-c"), 9),
  ]);
  const initial = followStage(
    createStageWorkspace<never>(privateLayout()),
    snapshot(first),
  );

  const updated = applyStageSnapshot(initial, snapshot(next), resolveResource);

  assert.equal(updated.layout, initial.layout);
  assert.deepEqual(
    projectStageCluster(updated, resolveResource)?.panels.map((panel) => panel.panelId),
    ["replacement-panel"],
  );
  assert.equal(projectStageCluster(updated, resolveResource)?.revision, 2);
  assert.equal(projectStageCluster(updated, resolveResource)?.arrangement, null);
});

test("duplicate and stale snapshots cannot regress or prematurely end Stage", () => {
  const currentView = stageView(4, [
    stagePanel("stage-panel", workingPresentation("entry-current")),
  ]);
  const followed = followStage(
    createStageWorkspace<never>(privateLayout()),
    snapshot(currentView, { updatedAt: 40 }),
  );
  const staleTerminal = snapshot(stageView(3, [
    stagePanel("stage-panel", workingPresentation("entry-old")),
  ]), { status: "ended", updatedAt: 50 });
  const duplicate = snapshot(stageView(4, [
    stagePanel("stage-panel", workingPresentation("entry-duplicate")),
  ]), { updatedAt: 60 });

  assert.equal(
    applyStageSnapshot(followed, staleTerminal, resolveResource),
    followed,
  );
  assert.equal(
    applyStageSnapshot(followed, duplicate, resolveResource),
    followed,
  );
  assert.equal(
    projectStageCluster(followed, resolveResource)?.panels[0].active,
    "path-for-entry-current.md",
  );
});

test("all direct followed-Stage interactions detach before local manipulation", () => {
  const shared = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-a")),
  ]);
  const interactions: readonly StagePanelInteraction[] = [
    "navigate",
    "scroll",
    "select",
    "type",
  ];

  for (const kind of interactions) {
    const followed = followStage(
      createStageWorkspace<never>(privateLayout()),
      snapshot(shared),
    );
    const detached = handleStageWorkspaceInteraction(followed, {
      surface: "stage",
      panelId: "stage-panel",
      kind,
    });
    assert.equal(detached.stage?.local.mode, "detached", kind);
  }
});

test("private-panel activity never detaches, even when its ID also appears on Stage", () => {
  const followed = followStage(
    createStageWorkspace<never>(privateLayout()),
    snapshot(stageView(1, [
      stagePanel("stage-panel", workingPresentation("entry-a")),
    ])),
  );

  const unchanged = handleStageWorkspaceInteraction(followed, {
    surface: "private",
    panelId: "stage-panel",
    kind: "type",
  });
  const unrelated = handleStageWorkspaceInteraction(followed, {
    surface: "stage",
    panelId: "private-panel",
    kind: "navigate",
  });

  assert.equal(unchanged, followed);
  assert.equal(unrelated, followed);
  assert.equal(followed.stage?.local.mode, "following");
});

test("detached participants freeze locally, then rejoin the complete latest state", () => {
  const first = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-a")),
  ]);
  const next = stageView(2, [
    stagePanel("stage-panel", workingPresentation("entry-b"), 11),
    stagePanel("new-panel", workingPresentation("entry-c"), 15),
  ], "new-panel");
  const followed = followStage(
    createStageWorkspace<never>(privateLayout()),
    snapshot(first),
  );
  const detached = handleStageWorkspaceInteraction(followed, {
    surface: "stage",
    panelId: "stage-panel",
    kind: "scroll",
  });

  const received = applyStageSnapshot(detached, snapshot(next), resolveResource);

  assert.equal(received.stage?.snapshot.view.revision, 2);
  assert.equal(received.stage?.local.projected.revision, 1);
  assert.deepEqual(
    projectStageCluster(received, resolveResource)?.panels.map((panel) => panel.active),
    ["path-for-entry-a.md"],
  );

  const rejoined = rejoinStage(received);
  assert.equal(rejoined.stage?.local.mode, "following");
  assert.equal(rejoined.stage?.local.projected, next);
  assert.deepEqual(
    projectStageCluster(rejoined, resolveResource)?.panels.map((panel) => panel.active),
    ["path-for-entry-b.md", "path-for-entry-c.md"],
  );
});

test("ending Stage converts final staged panels into ordinary private panels", () => {
  const initialView = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-a")),
  ]);
  const finalView = stageView(2, [
    stagePanel("stage-panel", workingPresentation("entry-final")),
    stagePanel("new-panel", workingPresentation("folder-final", "folder")),
  ], "new-panel");
  const layout = privateLayout();
  layout.panels[1].replayOwned = true;
  layout.panels[1].replayPanelIndex = 3;
  const followed = followStage(
    createStageWorkspace<never>(layout),
    snapshot(initialView),
  );

  const ended = applyStageSnapshot(
    followed,
    snapshot(finalView, { status: "ended", updatedAt: 20 }),
    resolveResource,
  );

  assert.equal(ended.stage, null);
  assert.equal(ended.layout.activePanelId, "new-panel");
  assert.deepEqual(ended.layout.panels, [
    {
      panelId: "private-panel",
      tabs: ["private.md"],
      active: "private.md",
    },
    {
      panelId: "stage-panel",
      tabs: ["local-only.md", "path-for-entry-final.md"],
      active: "path-for-entry-final.md",
    },
    {
      panelId: "new-panel",
      tabs: ["folder://path-for-folder-final"],
      active: "folder://path-for-folder-final",
    },
  ]);
});

test("Stage end preserves a detached participant's chosen local projection", () => {
  const initialView = stageView(1, [
    stagePanel("stage-panel", workingPresentation("entry-local")),
  ]);
  const remoteFinalView = stageView(2, [
    stagePanel("stage-panel", workingPresentation("entry-remote")),
  ]);
  const followed = followStage(
    createStageWorkspace<never>(privateLayout()),
    snapshot(initialView),
  );
  const detached = handleStageWorkspaceInteraction(followed, {
    surface: "stage",
    panelId: "stage-panel",
    kind: "navigate",
  });

  const ended = applyStageSnapshot(
    detached,
    snapshot(remoteFinalView, { status: "ended" }),
    resolveResource,
  );

  assert.equal(
    ended.layout.panels.find((panel) => panel.panelId === "stage-panel")?.active,
    "path-for-entry-local.md",
  );
});

test("opaque editor suspensions survive working-replay-working without entering shared state", () => {
  const returnTo = workingPresentation("entry-a");
  const workingView = stageView(1, [
    stagePanel("stage-panel", returnTo),
  ]);
  const replayView = stageView(2, [
    stagePanel("stage-panel", {
      kind: "replay",
      replayId: "replay-a",
      traces: [{ entryId: "entry-a", traceId: "trace-a" }],
      playhead: { status: "playing", at: 40, speed: 4 },
      returnTo,
    }),
  ]);
  const opaqueEditorState = {
    unsteppedText: "private draft",
    selection: { anchor: 4, head: 9 },
    scrollPixels: 120,
    undoManager: { privateToken: "undo-secret" },
  };
  let workspace = followStage(
    createStageWorkspace<typeof opaqueEditorState>(privateLayout()),
    snapshot(workingView),
  );

  workspace = suspendStageEditorState(
    workspace,
    "stage-panel",
    "replay-a",
    opaqueEditorState,
  );
  workspace = applyStageSnapshot(workspace, snapshot(replayView), resolveResource);

  assert.equal(
    suspendedStageEditorState(workspace, "stage-panel", "replay-a"),
    opaqueEditorState,
  );
  assert.equal(
    replayReturnTo(workspace.stage?.local.projected.panels[0] as StagePanelView),
    returnTo,
  );
  assert.doesNotMatch(JSON.stringify(workspace), /private draft|undo-secret/);

  workspace = applyStageSnapshot(workspace, snapshot(stageView(3, [
    stagePanel("stage-panel", returnTo),
  ])), resolveResource);
  assert.equal(
    suspendedStageEditorState(workspace, "stage-panel", "replay-a"),
    opaqueEditorState,
  );

  workspace = clearSuspendedStageEditorState(
    workspace,
    "stage-panel",
    "replay-a",
  );
  assert.equal(
    suspendedStageEditorState(workspace, "stage-panel", "replay-a"),
    undefined,
  );
});

test("editor suspensions are isolated by both stable panel and replay identity", () => {
  let workspace = followStage(
    createStageWorkspace<string>(privateLayout()),
    snapshot(stageView(1, [
      stagePanel("stage-panel", workingPresentation("entry-a")),
    ])),
  );
  workspace = suspendStageEditorState(workspace, "stage-panel", "replay-a", "state-a");
  workspace = suspendStageEditorState(workspace, "stage-panel", "replay-b", "state-b");

  assert.equal(
    suspendedStageEditorState(workspace, "stage-panel", "replay-a"),
    "state-a",
  );
  assert.equal(
    suspendedStageEditorState(workspace, "stage-panel", "replay-b"),
    "state-b",
  );
});
