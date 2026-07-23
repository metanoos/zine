import { test } from "node:test";
import assert from "node:assert/strict";

import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  isStageViewState,
  verifyStageCommand,
} from "./stage-crypto.js";
import {
  canParticipantViewStage,
  cloneStageViewState,
  StageSession,
} from "./stage-session.js";
import {
  STAGE_CONTROLLER_GRACE_MS,
  STAGE_VERSION,
  type StagePanelView,
  type StageViewState,
} from "./stage-types.js";
import { CollaborationReplica } from "./collaboration.js";
import {
  COLLABORATION_VERSION,
  type CollaborationCapability,
  type CollaborationSeedEntry,
  type CollaborationDefinition,
} from "./collaboration-types.js";

function identity() {
  const pair = schnorr.keygen();
  return {
    secretKey: pair.secretKey,
    pubkey: bytesToHex(pair.publicKey),
  };
}

const owner = identity();
const presenter = identity();
const presenterVoice = identity();
const recipient = identity();
const narrowViewer = identity();
const noControl = identity();
const noJoin = identity();

const entries: CollaborationSeedEntry[] = [
  { id: "root", kind: "folder", parentId: null, name: "" },
  { id: "docs", kind: "folder", parentId: "root", name: "docs" },
  {
    id: "a",
    kind: "file",
    parentId: "docs",
    name: "a.md",
    text: "A",
  },
  {
    id: "b",
    kind: "file",
    parentId: "docs",
    name: "b.md",
    text: "B",
  },
  {
    id: "outside",
    kind: "file",
    parentId: "root",
    name: "outside.md",
    text: "outside",
  },
];

function collaborationCapability(
  id: string,
  subjectPubkey: string,
  actions: CollaborationCapability["actions"],
  actorPubkeys?: readonly string[],
): CollaborationCapability {
  return {
    id,
    subjectPubkey,
    resource: { kind: "collaboration" },
    actions,
    ...(actorPubkeys ? { actorPubkeys } : {}),
  };
}

function entryCapability(
  id: string,
  subjectPubkey: string,
  entryId: string,
  actions: CollaborationCapability["actions"],
): CollaborationCapability {
  return {
    id,
    subjectPubkey,
    resource: {
      kind: "entry",
      entryId,
      includeDescendants: false,
    },
    actions,
  };
}

function definition(
  capabilities: readonly CollaborationCapability[],
): CollaborationDefinition {
  return {
    version: COLLABORATION_VERSION,
    collaborationId: `stage-working-${Math.random()}`,
    ownerPubkey: owner.pubkey,
    mount: {
      mount: { kind: "folder", path: "docs" },
      shields: [],
    },
    capabilities,
  };
}

function fullCapabilities(): CollaborationCapability[] {
  return [
    collaborationCapability(
      "presenter",
      presenter.pubkey,
      [
        "collaboration.join",
        "file.read",
        "stage.view",
        "stage.start",
        "stage.control",
        "stage.end",
      ],
      // Voices apply only to attributed editing actions, never Stage authority.
      [presenterVoice.pubkey],
    ),
    collaborationCapability(
      "recipient",
      recipient.pubkey,
      [
        "collaboration.join",
        "file.read",
        "stage.view",
        "stage.control",
        "stage.end",
      ],
    ),
    entryCapability(
      "narrow-a",
      narrowViewer.pubkey,
      "a",
      ["collaboration.join", "file.read", "stage.view"],
    ),
    collaborationCapability(
      "no-control",
      noControl.pubkey,
      ["collaboration.join", "file.read", "stage.view"],
    ),
  ];
}

function replicas(capabilities = fullCapabilities()) {
  const host = CollaborationReplica.createHost({
    definition: definition(capabilities),
    participantPubkey: owner.pubkey,
    entries,
  });
  const replica = (participantPubkey: string) =>
    CollaborationReplica.fromBootstrap(
      participantPubkey,
      host.bootstrapFor(participantPubkey, owner.secretKey),
    );
  return { host, replica };
}

function panel(
  panelId: string,
  entryId: string,
  options: { revision?: never } = {},
): StagePanelView {
  void options;
  return {
    panelId,
    presentation: {
      kind: "working",
      resource: { entryId, kind: "file" },
      mode: "markdown",
    },
    selection: {
      ranges: [{ anchor: 0, head: 0 }],
      main: 0,
    },
    scrollAnchor: { position: 0, offset: 0 },
    folds: [],
    previewAnchor: null,
  };
}

function onePanelView(
  entryId = "a",
  revision = 0,
): StageViewState {
  return {
    version: STAGE_VERSION,
    revision,
    panels: [panel("stage-panel-a", entryId)],
    activePanelId: "stage-panel-a",
    arrangement: null,
  };
}

function twoPanelView(revision: number): StageViewState {
  return {
    version: STAGE_VERSION,
    revision,
    panels: [
      panel("stage-panel-a", "a"),
      panel("stage-panel-b", "b"),
    ],
    activePanelId: "stage-panel-b",
    arrangement: {
      direction: "row",
      primaryRatio: 0.4,
    },
  };
}

test("signed controller updates converge and reject tampering and replay", () => {
  const { host, replica } = replicas();
  const presenterLive = replica(presenter.pubkey);
  const recipientLive = replica(recipient.pubkey);
  try {
    const controller = StageSession.start({
      collaboration: presenterLive,
      stageId: "stage-1",
      view: onePanelView(),
      secretKey: presenter.secretKey,
      timestamp: 10,
    });
    assert(controller.startCommand);
    assert.equal(verifyStageCommand(controller.startCommand), true);

    const follower = StageSession.fromStart(
      recipientLive,
      controller.startCommand,
    );
    const command = controller.updateView(
      twoPanelView(1),
      presenter.secretKey,
      11,
    );
    assert.equal(follower.receive(command), true);
    assert.deepEqual(follower.snapshot().view, controller.snapshot().view);
    assert.equal(follower.receive(command), false);

    const tampered = {
      ...command,
      payload: {
        view: {
          ...command.payload.view,
          activePanelId: "stage-panel-a",
        },
      },
    };
    assert.equal(verifyStageCommand(tampered), false);
    assert.throws(
      () => follower.receive(tampered),
      /invalid Stage signature/,
    );
  } finally {
    presenterLive.destroy();
    recipientLive.destroy();
    host.destroy();
  }
});

test("Stage views are closed, one-or-two-panel states inside the mounted scope", () => {
  const { host } = replicas();
  try {
    assert.equal(isStageViewState(onePanelView()), true);
    const duplicatePanels = {
      ...twoPanelView(0),
      panels: [panel("same", "a"), panel("same", "b")],
      activePanelId: "same",
    };
    assert.equal(isStageViewState(duplicatePanels), false);

    assert.throws(
      () => StageSession.start({
        collaboration: host,
        stageId: "outside-stage",
        view: onePanelView("outside"),
        secretKey: owner.secretKey,
      }),
      /outside the Collaboration/,
    );

    const replayWithDuplicateTraces = onePanelView();
    replayWithDuplicateTraces.panels[0].presentation = {
      kind: "replay",
      replayId: "replay-1",
      traces: [
        { entryId: "a", traceId: "trace-1" },
        { entryId: "b", traceId: "trace-1" },
      ],
      playhead: { status: "paused", at: 0, speed: 1 },
      returnTo: {
        kind: "working",
        resource: { entryId: "a", kind: "file" },
        mode: "markdown",
      },
    };
    assert.equal(isStageViewState(replayWithDuplicateTraces), false);
  } finally {
    host.destroy();
  }
});

test("participant identity, not an attributed voice, owns Stage authority", () => {
  const { host, replica } = replicas();
  const presenterLive = replica(presenter.pubkey);
  try {
    const stage = StageSession.start({
      collaboration: presenterLive,
      stageId: "identity-stage",
      view: onePanelView(),
      secretKey: presenter.secretKey,
    });
    assert.equal(stage.snapshot().controllerPubkey, presenter.pubkey);
  } finally {
    presenterLive.destroy();
    host.destroy();
  }
});

test("entry-scoped control cannot steer Stage into another readable entry", () => {
  const capabilities: CollaborationCapability[] = [
    collaborationCapability(
      "presenter-session",
      presenter.pubkey,
      ["collaboration.join", "file.read", "stage.view", "stage.start"],
    ),
    entryCapability(
      "presenter-control-a",
      presenter.pubkey,
      "a",
      ["stage.control"],
    ),
  ];
  const { host, replica } = replicas(capabilities);
  const presenterLive = replica(presenter.pubkey);
  try {
    const stage = StageSession.start({
      collaboration: presenterLive,
      stageId: "scoped-control",
      view: onePanelView("a"),
      secretKey: presenter.secretKey,
    });
    assert.throws(
      () => stage.updateView(
        onePanelView("b", 1),
        presenter.secretKey,
      ),
      /lacks stage.control/,
    );
    const presentation = stage.snapshot().view.panels[0].presentation;
    assert.equal(presentation.kind, "working");
    assert.equal(
      presentation.kind === "working"
        ? presentation.resource.entryId
        : null,
      "a",
    );
  } finally {
    presenterLive.destroy();
    host.destroy();
  }
});

test("Stage Controller transfer changes no authority until recipient accepts", () => {
  const { host, replica } = replicas();
  const recipientLive = replica(recipient.pubkey);
  const noControlLive = replica(noControl.pubkey);
  try {
    const ownerStage = StageSession.start({
      collaboration: host,
      stageId: "transfer-stage",
      view: onePanelView(),
      secretKey: owner.secretKey,
      timestamp: 20,
    });
    assert(ownerStage.startCommand);
    const recipientStage = StageSession.fromStart(
      recipientLive,
      ownerStage.startCommand,
    );
    const noControlStage = StageSession.fromStart(
      noControlLive,
      ownerStage.startCommand,
    );

    assert.throws(
      () => ownerStage.requestControl(
        noControl.pubkey,
        owner.secretKey,
        21,
      ),
      /lacks stage.control/,
    );

    const request = ownerStage.requestControl(
      recipient.pubkey,
      owner.secretKey,
      22,
    );
    assert.equal(recipientStage.receive(request), true);
    assert.equal(ownerStage.snapshot().controllerPubkey, owner.pubkey);
    assert.throws(
      () => recipientStage.updateView(
        onePanelView("a", 2),
        recipient.secretKey,
        23,
      ),
      /frozen while its Controller transfer awaits acceptance/,
    );

    const acceptance = recipientStage.acceptControl(
      request.payload.transferId,
      recipient.secretKey,
      24,
    );
    assert.equal(ownerStage.receive(acceptance), true);
    assert.equal(ownerStage.snapshot().controllerPubkey, recipient.pubkey);
    assert.equal(ownerStage.snapshot().pendingControlTransfer, null);
    assert.equal(noControlStage.snapshot().controllerPubkey, owner.pubkey);
  } finally {
    recipientLive.destroy();
    noControlLive.destroy();
    host.destroy();
  }
});

test("Stage Controller transfer rejects a capable identity that cannot join", () => {
  const { host } = replicas([
    ...fullCapabilities(),
    collaborationCapability(
      "unjoined-controller",
      noJoin.pubkey,
      ["file.read", "stage.view", "stage.control"],
    ),
  ]);
  try {
    const stage = StageSession.start({
      collaboration: host,
      stageId: "stage-unjoined-transfer",
      view: onePanelView(),
      secretKey: owner.secretKey,
    });
    assert.throws(
      () => stage.requestControl(noJoin.pubkey, owner.secretKey),
      /another Collaboration participant/,
    );
  } finally {
    host.destroy();
  }
});

test("a pending Controller transfer freezes edits until its requester cancels", () => {
  const { host, replica } = replicas();
  const recipientLive = replica(recipient.pubkey);
  try {
    const controller = StageSession.start({
      collaboration: host,
      stageId: "stage-transfer-race",
      view: onePanelView(),
      secretKey: owner.secretKey,
      timestamp: 1,
    });
    assert(controller.startCommand);
    const recipientStage = StageSession.fromStart(
      recipientLive,
      controller.startCommand,
    );

    const request = controller.requestControl(
      recipient.pubkey,
      owner.secretKey,
      2,
    );
    recipientStage.receive(request);

    assert.throws(
      () => controller.updateView(
        onePanelView("b", 2),
        owner.secretKey,
        3,
      ),
      /frozen while its Controller transfer awaits acceptance/,
    );

    const canceled = controller.cancelControl(
      request.payload.transferId,
      owner.secretKey,
      3,
    );
    assert.equal(recipientStage.receive(canceled), true);
    assert.equal(controller.snapshot().pendingControlTransfer, null);
    const update = controller.updateView(
      onePanelView("b", 3),
      owner.secretKey,
      4,
    );
    assert.equal(recipientStage.receive(update), true);
    assert.deepEqual(controller.snapshot(), recipientStage.snapshot());
  } finally {
    recipientLive.destroy();
    host.destroy();
  }
});

test("the owner can end a Stage while a Controller transfer is pending", () => {
  const { host, replica } = replicas();
  const recipientLive = replica(recipient.pubkey);
  try {
    const ownerStage = StageSession.start({
      collaboration: host,
      stageId: "stage-transfer-end",
      view: onePanelView(),
      secretKey: owner.secretKey,
      timestamp: 1,
    });
    assert(ownerStage.startCommand);
    const recipientStage = StageSession.fromStart(
      recipientLive,
      ownerStage.startCommand,
    );
    const request = ownerStage.requestControl(
      recipient.pubkey,
      owner.secretKey,
      2,
    );
    recipientStage.receive(request);

    const ended = ownerStage.end(owner.secretKey, 3);
    assert.equal(recipientStage.receive(ended), true);
    assert.equal(ownerStage.snapshot().status, "ended");
    assert.equal(ownerStage.snapshot().pendingControlTransfer, null);
    assert.deepEqual(ownerStage.snapshot(), recipientStage.snapshot());
  } finally {
    recipientLive.destroy();
    host.destroy();
  }
});

test("disconnect grace freezes Stage, then leaves it vacant for owner recovery", () => {
  const { host } = replicas();
  try {
    const stage = StageSession.start({
      collaboration: host,
      stageId: "grace-stage",
      view: onePanelView(),
      secretKey: owner.secretKey,
      timestamp: 100,
    });
    assert.equal(stage.noteControllerDisconnected(owner.pubkey, 200), true);
    assert.throws(
      () => stage.updateView(
        onePanelView("a", 2),
        owner.secretKey,
        201,
      ),
      /frozen/,
    );
    assert.equal(
      stage.expireControllerGrace(200 + STAGE_CONTROLLER_GRACE_MS - 1),
      false,
    );
    assert.equal(
      stage.expireControllerGrace(200 + STAGE_CONTROLLER_GRACE_MS),
      true,
    );
    assert.equal(stage.snapshot().status, "vacant");
    assert.equal(stage.snapshot().controllerPubkey, null);

    const finalPanelId = stage.snapshot().view.panels[0].panelId;
    stage.recoverControl(
      owner.secretKey,
      200 + STAGE_CONTROLLER_GRACE_MS + 1,
    );
    assert.equal(stage.snapshot().status, "active");
    assert.equal(stage.snapshot().controllerPubkey, owner.pubkey);
    assert.equal(stage.snapshot().view.panels[0].panelId, finalPanelId);
  } finally {
    host.destroy();
  }
});

test("owner can end a vacant Stage and its final panel state is retained", () => {
  const { host } = replicas();
  try {
    const stage = StageSession.start({
      collaboration: host,
      stageId: "end-stage",
      view: onePanelView(),
      secretKey: owner.secretKey,
      timestamp: 300,
    });
    stage.noteControllerDisconnected(owner.pubkey, 301);
    stage.expireControllerGrace(301 + STAGE_CONTROLLER_GRACE_MS);
    const finalView = cloneStageViewState(stage.snapshot().view);
    stage.end(
      owner.secretKey,
      301 + STAGE_CONTROLLER_GRACE_MS + 1,
    );
    assert.equal(stage.snapshot().status, "ended");
    assert.equal(stage.snapshot().controllerPubkey, null);
    assert.deepEqual(
      stage.snapshot().view.panels,
      finalView.panels,
    );
  } finally {
    host.destroy();
  }
});

test("narrow followers accept authoritative state but refuse unreadable projection", () => {
  const { host, replica } = replicas();
  const presenterLive = replica(presenter.pubkey);
  const narrowLive = replica(narrowViewer.pubkey);
  try {
    const controller = StageSession.start({
      collaboration: presenterLive,
      stageId: "narrow-stage",
      view: onePanelView("a"),
      secretKey: presenter.secretKey,
    });
    assert(controller.startCommand);
    const follower = StageSession.fromStart(
      narrowLive,
      controller.startCommand,
    );
    assert.equal(follower.canView(), true);
    assert(follower.snapshotFor());

    const command = controller.updateView(
      onePanelView("b", 1),
      presenter.secretKey,
    );
    assert.equal(follower.receive(command), true);
    assert.equal(follower.snapshot().view.revision, 1);
    assert.equal(follower.canView(), false);
    assert.equal(follower.snapshotFor(), null);
    assert.equal(
      canParticipantViewStage(
        narrowLive,
        follower.snapshot().view,
      ),
      false,
    );
  } finally {
    presenterLive.destroy();
    narrowLive.destroy();
    host.destroy();
  }
});

test("snapshot restoration persists current state without a command history", () => {
  const { host } = replicas();
  try {
    const stage = StageSession.start({
      collaboration: host,
      stageId: "persist-stage",
      view: onePanelView(),
      secretKey: owner.secretKey,
    });
    stage.updateView(twoPanelView(1), owner.secretKey);
    const snapshot = stage.snapshot();
    assert.equal("commands" in snapshot, false);
    assert.equal("history" in snapshot, false);

    const restored = StageSession.restore(host, snapshot);
    const first = restored.snapshot();
    first.view.panels[0].folds = [{ from: 0, to: 1 }];
    assert.deepEqual(restored.snapshot(), snapshot);
    assert.equal(restored.startCommand, null);
  } finally {
    host.destroy();
  }
});
