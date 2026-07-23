import assert from "node:assert/strict";
import test from "node:test";

import type {
  StagePanelView,
  StageViewState,
} from "../collaboration/stage-types.js";
import {
  beginPrivateStagePanelReplay,
  beginPanelReplay,
  PanelPresentationError,
  replacePanelReplayTraces,
  replacePrivateStagePanelTraces,
  returnPrivateStagePanelToWorking,
  returnPanelToWorking,
  updatePrivateStagePanelPlayhead,
  updatePanelReplayPlayhead,
} from "./panel-presentation.js";
import {
  createStageWorkspace,
  followStage,
} from "./stage-workspace.js";

function panel(panelId: string, entryId: string): StagePanelView {
  return {
    panelId,
    presentation: {
      kind: "working",
      resource: { entryId, kind: "file" },
      mode: "markdown",
    },
    selection: { ranges: [{ anchor: 4, head: 7 }], main: 0 },
    scrollAnchor: { position: 4, offset: 12 },
    folds: [{ from: 10, to: 20 }],
    previewAnchor: { key: "heading", offset: 8 },
  };
}

function view(): StageViewState {
  return {
    version: 1,
    revision: 4,
    panels: [panel("left", "entry-a"), panel("right", "entry-b")],
    activePanelId: "left",
    arrangement: { direction: "row", primaryRatio: 0.6 },
  };
}

test("Replay replaces exactly one panel in place and preserves the working return target", () => {
  const initial = view();
  const replay = beginPanelReplay(initial, "left", {
    replayId: "replay-a",
    traces: [{ entryId: "entry-a", traceId: "trace-a" }],
    speed: 4,
  });

  assert.equal(initial.panels[0].presentation.kind, "working");
  assert.equal(replay.revision, 5);
  assert.equal(replay.panels[0].panelId, "left");
  assert.deepEqual(replay.arrangement, initial.arrangement);
  assert.deepEqual(replay.panels[1], initial.panels[1]);
  assert.deepEqual(replay.panels[0].presentation, {
    kind: "replay",
    replayId: "replay-a",
    traces: [{ entryId: "entry-a", traceId: "trace-a" }],
    playhead: { status: "paused", at: 0, speed: 4 },
    returnTo: {
      kind: "working",
      resource: { entryId: "entry-a", kind: "file" },
      mode: "markdown",
    },
  });
});

test("Replay playhead updates stay scoped to their panel", () => {
  const replay = beginPanelReplay(view(), "right", {
    replayId: "replay-b",
    traces: [{ entryId: "entry-b", traceId: "trace-b" }],
    speed: 2,
  });
  const playing = updatePanelReplayPlayhead(replay, "right", {
    status: "playing",
    at: 17,
    speed: 8,
  });

  assert.equal(playing.revision, 6);
  assert.deepEqual(playing.panels[0], replay.panels[0]);
  const right = playing.panels[1]!;
  assert.deepEqual(
    right.presentation.kind === "replay"
      ? right.presentation.playhead
      : null,
    { status: "playing", at: 17, speed: 8 },
  );
});

test("changing traces pauses, rebuilds, and resets without touching another panel", () => {
  const replay = updatePanelReplayPlayhead(
    beginPanelReplay(view(), "left", {
      replayId: "replay-a",
      traces: [{ entryId: "entry-a", traceId: "trace-a" }],
      speed: 4,
    }),
    "left",
    { status: "playing", at: 50, speed: 8 },
  );
  const rebuilt = replacePanelReplayTraces(
    replay,
    "left",
    "replay-c",
    [
      { entryId: "entry-a", traceId: "trace-a" },
      { entryId: "entry-b", traceId: "trace-b" },
    ],
  );

  assert.deepEqual(rebuilt.panels[1], replay.panels[1]);
  assert.deepEqual(rebuilt.panels[0].presentation, {
    kind: "replay",
    replayId: "replay-c",
    traces: [
      { entryId: "entry-a", traceId: "trace-a" },
      { entryId: "entry-b", traceId: "trace-b" },
    ],
    playhead: { status: "paused", at: 0, speed: 8 },
    returnTo: {
      kind: "working",
      resource: { entryId: "entry-a", kind: "file" },
      mode: "markdown",
    },
  });
});

test("Return to Work restores caller-owned view fields without sharing editor state", () => {
  const replay = beginPanelReplay(view(), "left", {
    replayId: "replay-a",
    traces: [{ entryId: "entry-a", traceId: "trace-a" }],
    speed: 4,
  });
  const working = returnPanelToWorking(replay, "left", {
    selection: { ranges: [{ anchor: 30, head: 31 }], main: 0 },
    scrollAnchor: { position: 30, offset: 2 },
    folds: [],
    previewAnchor: null,
  });

  assert.deepEqual(working.panels[0], {
    panelId: "left",
    presentation: {
      kind: "working",
      resource: { entryId: "entry-a", kind: "file" },
      mode: "markdown",
    },
    selection: { ranges: [{ anchor: 30, head: 31 }], main: 0 },
    scrollAnchor: { position: 30, offset: 2 },
    folds: [],
    previewAnchor: null,
  });
  assert.equal(JSON.stringify(working).includes("undo"), false);
});

test("invalid panel transitions are rejected at the presentation boundary", () => {
  assert.throws(
    () => beginPanelReplay(view(), "missing", {
      replayId: "replay-a",
      traces: [{ entryId: "entry-a", traceId: "trace-a" }],
      speed: 4,
    }),
    PanelPresentationError,
  );
  assert.throws(
    () => updatePanelReplayPlayhead(view(), "left", {
      status: "playing",
      at: 0,
      speed: 4,
    }),
    /outside a Replay presentation/,
  );
  assert.throws(
    () => beginPanelReplay(view(), "left", {
      replayId: "replay-a",
      traces: [],
      speed: 4,
    }),
    /invalid/,
  );
});

test("follower Play detaches and changes only the private projection", () => {
  const shared = view();
  const snapshot = {
    version: 1 as const,
    stageId: "stage-1",
    collaborationId: "working-1",
    ownerPubkey: "owner",
    controllerPubkey: "controller",
    status: "active" as const,
    view: shared,
    pendingControlTransfer: null,
    controllerDisconnectedAt: null,
    updatedAt: 4,
  };
  const attached = followStage(
    createStageWorkspace<{ undoDepth: number }>({
      panels: [{ panelId: "private", tabs: ["private.md"], active: "private.md" }],
      activePanelId: "private",
    }),
    snapshot,
  );

  const started = beginPrivateStagePanelReplay(
    attached,
    "left",
    {
      replayId: "private-replay",
      traces: [{ entryId: "entry-a", traceId: "trace-a" }],
      speed: 4,
    },
    { undoDepth: 3 },
  ).workspace;
  const playing = updatePrivateStagePanelPlayhead(
    started,
    "left",
    { status: "playing", at: 9, speed: 2 },
  );
  const rebuilt = replacePrivateStagePanelTraces(
    playing,
    "left",
    "rebuilt-replay",
    [{ entryId: "entry-a", traceId: "trace-c" }],
  );

  assert.equal(rebuilt.stage?.local.mode, "detached");
  assert.equal(rebuilt.stage?.snapshot, snapshot);
  assert.equal(rebuilt.stage?.snapshot.view.panels[0].presentation.kind, "working");
  assert.deepEqual(
    rebuilt.stage?.local.projected.panels[0].presentation,
    {
      kind: "replay",
      replayId: "rebuilt-replay",
      traces: [{ entryId: "entry-a", traceId: "trace-c" }],
      playhead: { status: "paused", at: 0, speed: 2 },
      returnTo: {
        kind: "working",
        resource: { entryId: "entry-a", kind: "file" },
        mode: "markdown",
      },
    },
  );
  assert.deepEqual(
    rebuilt.editorState.get("left", "rebuilt-replay"),
    { undoDepth: 3 },
  );
  assert.equal(
    rebuilt.editorState.get("left", "private-replay"),
    undefined,
  );

  const returned = returnPrivateStagePanelToWorking(
    rebuilt,
    "left",
    {
      selection: { ranges: [{ anchor: 7, head: 7 }], main: 0 },
      scrollAnchor: { position: 7, offset: 1 },
      folds: [],
      previewAnchor: null,
    },
  );
  assert.equal(returned.stage?.local.mode, "detached");
  assert.equal(returned.stage?.local.projected.panels[0].presentation.kind, "working");
  assert.equal(
    returned.editorState.get("left", "rebuilt-replay"),
    undefined,
  );
});
