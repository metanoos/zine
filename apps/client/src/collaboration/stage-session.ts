import type { CollaborationPermissionAction } from "./collaboration-types.js";
import type { CollaborationReplica } from "./collaboration.js";
import {
  createStageNonce,
  isStageSessionSnapshot,
  isStageViewState,
  signStageCommand,
  verifyStageCommand,
  type StageCommandBody,
  type StageSignedCommand,
  type StageSignedCommandOf,
} from "./stage-crypto.js";
import {
  STAGE_CONTROLLER_GRACE_MS,
  STAGE_VERSION,
  type WorkingPresentation,
  type StagePanelView,
  type StageSessionSnapshot,
  type StageViewState,
} from "./stage-types.js";

type StageOutgoingListener = (command: StageSignedCommand) => void;
type StageActiveCommand = Exclude<
  StageSignedCommand,
  { kind: "stage.start" }
>;
type StageSnapshotListener = (
  snapshot: StageSessionSnapshot,
  source: "local" | "remote" | "transport",
) => void;

export interface StartStageInput {
  collaboration: CollaborationReplica;
  stageId: string;
  view: StageViewState;
  secretKey: Uint8Array;
  timestamp?: number;
}

export class StageSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageSessionError";
  }
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
  return {
    panelId: panel.panelId,
    presentation: panel.presentation.kind === "working"
      ? cloneWorkingPresentation(panel.presentation)
      : {
          kind: "replay",
          replayId: panel.presentation.replayId,
          traces: panel.presentation.traces.map((trace) => ({ ...trace })),
          playhead: { ...panel.presentation.playhead },
          returnTo: cloneWorkingPresentation(panel.presentation.returnTo),
        },
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

export function cloneStageViewState(view: StageViewState): StageViewState {
  const panels = view.panels.map(clonePanel);
  return {
    version: STAGE_VERSION,
    revision: view.revision,
    panels: panels.length === 1
      ? [panels[0]!]
      : [panels[0]!, panels[1]!],
    activePanelId: view.activePanelId,
    arrangement: view.arrangement === null
      ? null
      : { ...view.arrangement },
  };
}

export function cloneStageSessionSnapshot(
  snapshot: StageSessionSnapshot,
): StageSessionSnapshot {
  return {
    version: STAGE_VERSION,
    stageId: snapshot.stageId,
    collaborationId: snapshot.collaborationId,
    ownerPubkey: snapshot.ownerPubkey,
    controllerPubkey: snapshot.controllerPubkey,
    status: snapshot.status,
    view: cloneStageViewState(snapshot.view),
    pendingControlTransfer: snapshot.pendingControlTransfer === null
      ? null
      : { ...snapshot.pendingControlTransfer },
    controllerDisconnectedAt: snapshot.controllerDisconnectedAt,
    updatedAt: snapshot.updatedAt,
  };
}

function participantExists(
  collaboration: CollaborationReplica,
  participantPubkey: string,
): boolean {
  return (
    participantPubkey === collaboration.definition.ownerPubkey ||
    collaboration.definition.capabilities.some(
      (capability) =>
        capability.subjectPubkey === participantPubkey &&
        capability.actions.includes("collaboration.join"),
    )
  );
}

function entryIdsInView(view: StageViewState): string[] {
  const entryIds = new Set<string>();
  for (const panel of view.panels) {
    const presentation = panel.presentation;
    if (presentation.kind === "working") {
      entryIds.add(presentation.resource.entryId);
      continue;
    }
    entryIds.add(presentation.returnTo.resource.entryId);
    for (const trace of presentation.traces) entryIds.add(trace.entryId);
  }
  return [...entryIds];
}

function resourceKindsInView(
  view: StageViewState,
): Map<string, "file" | "folder"> {
  const kinds = new Map<string, "file" | "folder">();
  for (const panel of view.panels) {
    const presentation = panel.presentation;
    const working = presentation.kind === "working"
      ? presentation
      : presentation.returnTo;
    const previous = kinds.get(working.resource.entryId);
    if (previous !== undefined && previous !== working.resource.kind) {
      throw new StageSessionError(
        `Stage resource ${working.resource.entryId} has conflicting kinds`,
      );
    }
    kinds.set(working.resource.entryId, working.resource.kind);
  }
  return kinds;
}

function actionAllowedForView(
  collaboration: CollaborationReplica,
  participantPubkey: string,
  action: Extract<
    CollaborationPermissionAction,
    "stage.view" | "stage.start" | "stage.control" | "stage.end"
  >,
  view: StageViewState,
): boolean {
  if (collaboration.canPerformAction(action, null, participantPubkey)) return true;
  const entryIds = entryIdsInView(view);
  return (
    entryIds.length > 0 &&
    entryIds.every((entryId) =>
      collaboration.canPerformAction(action, entryId, participantPubkey)
    )
  );
}

function viewResourcesAreValid(
  collaboration: CollaborationReplica,
  view: StageViewState,
): boolean {
  if (!isStageViewState(view)) return false;
  const entries = new Map(
    collaboration.listEntries().map((entry) => [entry.id, entry] as const),
  );
  try {
    for (const [entryId, kind] of resourceKindsInView(view)) {
      if (entries.get(entryId)?.kind !== kind) return false;
    }
  } catch {
    return false;
  }
  return entryIdsInView(view).every((entryId) => entries.has(entryId));
}

/**
 * Whether one authenticated Collaboration participant may project this Stage
 * view. This is deliberately separate from command validity: a narrow-scope
 * follower may detach/refuse projection without making controller replicas
 * diverge on the authoritative Stage snapshot.
 */
export function canParticipantViewStage(
  collaboration: CollaborationReplica,
  view: StageViewState,
  participantPubkey = collaboration.participantPubkey,
): boolean {
  return (
    participantExists(collaboration, participantPubkey) &&
    viewResourcesAreValid(collaboration, view) &&
    actionAllowedForView(
      collaboration,
      participantPubkey,
      "stage.view",
      view,
    ) &&
    entryIdsInView(view).every((entryId) =>
      collaboration.canReadEntry(entryId, participantPubkey)
    )
  );
}

function assertViewResources(
  collaboration: CollaborationReplica,
  view: StageViewState,
): void {
  if (!viewResourcesAreValid(collaboration, view)) {
    throw new StageSessionError(
      "Stage view is malformed or references an entry outside the Collaboration",
    );
  }
}

function assertCanView(
  collaboration: CollaborationReplica,
  participantPubkey: string,
  view: StageViewState,
): void {
  assertViewResources(collaboration, view);
  if (!canParticipantViewStage(collaboration, view, participantPubkey)) {
    throw new StageSessionError(
      `${participantPubkey} cannot view every Stage resource`,
    );
  }
}

function assertAction(
  collaboration: CollaborationReplica,
  participantPubkey: string,
  action: Extract<
    CollaborationPermissionAction,
    "stage.start" | "stage.control" | "stage.end"
  >,
  view: StageViewState,
): void {
  if (!participantExists(collaboration, participantPubkey)) {
    throw new StageSessionError("Stage command signer is not a Collaboration participant");
  }
  if (!actionAllowedForView(collaboration, participantPubkey, action, view)) {
    throw new StageSessionError(
      `${participantPubkey} lacks ${action} permission`,
    );
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new StageSessionError("Stage timestamp must be finite and non-negative");
  }
}

function advancedView(view: StageViewState): StageViewState {
  const next = cloneStageViewState(view);
  return {
    ...next,
    revision: next.revision + 1,
  };
}

export class StageSession {
  readonly collaboration: CollaborationReplica;
  readonly startCommand: StageSignedCommandOf<"stage.start"> | null;

  private current: StageSessionSnapshot;
  private readonly seenCommandIds = new Set<string>();
  private readonly outgoingListeners = new Set<StageOutgoingListener>();
  private readonly snapshotListeners = new Set<StageSnapshotListener>();

  private constructor(
    collaboration: CollaborationReplica,
    snapshot: StageSessionSnapshot,
    startCommand: StageSignedCommandOf<"stage.start"> | null,
  ) {
    this.collaboration = collaboration;
    this.current = cloneStageSessionSnapshot(snapshot);
    this.startCommand = startCommand;
    if (startCommand) this.seenCommandIds.add(startCommand.commandId);
  }

  static start(input: StartStageInput): StageSession {
    if (!isStageViewState(input.view) || input.view.revision !== 0) {
      throw new StageSessionError("a Stage must start at view revision zero");
    }
    if (input.stageId.length === 0) {
      throw new StageSessionError("a Stage requires a stable id");
    }
    const participantPubkey = input.collaboration.participantPubkey;
    assertCanView(input.collaboration, participantPubkey, input.view);
    assertAction(
      input.collaboration,
      participantPubkey,
      "stage.start",
      input.view,
    );
    assertAction(
      input.collaboration,
      participantPubkey,
      "stage.control",
      input.view,
    );
    const timestamp = input.timestamp ?? Date.now();
    assertTimestamp(timestamp);
    const body: Extract<StageCommandBody, { kind: "stage.start" }> = {
      version: STAGE_VERSION,
      stageId: input.stageId,
      collaborationId: input.collaboration.definition.collaborationId,
      nonce: createStageNonce(),
      participantPubkey,
      timestamp,
      expectedRevision: -1,
      kind: "stage.start",
      payload: { view: cloneStageViewState(input.view) },
    };
    const command = signStageCommand(body, input.secretKey);
    return StageSession.fromVerifiedStart(input.collaboration, command);
  }

  static fromStart(
    collaboration: CollaborationReplica,
    value: unknown,
  ): StageSession {
    if (!verifyStageCommand(value) || value.kind !== "stage.start") {
      throw new StageSessionError("rejected an invalid signed Stage start");
    }
    return StageSession.fromVerifiedStart(collaboration, value);
  }

  /**
   * Restore trusted local persistence. A snapshot is current-state storage,
   * not an authenticated wire format; peers synchronize with signed commands.
   */
  static restore(
    collaboration: CollaborationReplica,
    value: unknown,
  ): StageSession {
    if (!isStageSessionSnapshot(value)) {
      throw new StageSessionError("cannot restore a malformed Stage snapshot");
    }
    if (
      value.collaborationId !== collaboration.definition.collaborationId ||
      value.ownerPubkey !== collaboration.definition.ownerPubkey
    ) {
      throw new StageSessionError("Stage snapshot belongs to another Collaboration");
    }
    assertViewResources(collaboration, value.view);
    if (
      value.status === "active" &&
      value.controllerPubkey !== null
    ) {
      assertAction(
        collaboration,
        value.controllerPubkey,
        "stage.control",
        value.view,
      );
      assertCanView(collaboration, value.controllerPubkey, value.view);
    }
    if (
      value.pendingControlTransfer !== null &&
      !actionAllowedForView(
        collaboration,
        value.pendingControlTransfer.toPubkey,
        "stage.control",
        value.view,
      )
    ) {
      throw new StageSessionError("pending Stage Controller lacks stage.control");
    }
    return new StageSession(collaboration, value, null);
  }

  private static fromVerifiedStart(
    collaboration: CollaborationReplica,
    command: StageSignedCommandOf<"stage.start">,
  ): StageSession {
    if (command.collaborationId !== collaboration.definition.collaborationId) {
      throw new StageSessionError("Stage start belongs to another Collaboration");
    }
    assertCanView(collaboration, command.participantPubkey, command.payload.view);
    assertAction(
      collaboration,
      command.participantPubkey,
      "stage.start",
      command.payload.view,
    );
    assertAction(
      collaboration,
      command.participantPubkey,
      "stage.control",
      command.payload.view,
    );
    const snapshot: StageSessionSnapshot = {
      version: STAGE_VERSION,
      stageId: command.stageId,
      collaborationId: command.collaborationId,
      ownerPubkey: collaboration.definition.ownerPubkey,
      controllerPubkey: command.participantPubkey,
      status: "active",
      view: cloneStageViewState(command.payload.view),
      pendingControlTransfer: null,
      controllerDisconnectedAt: null,
      updatedAt: command.timestamp,
    };
    return new StageSession(collaboration, snapshot, command);
  }

  snapshot(): StageSessionSnapshot {
    return cloneStageSessionSnapshot(this.current);
  }

  canView(
    participantPubkey = this.collaboration.participantPubkey,
  ): boolean {
    return canParticipantViewStage(
      this.collaboration,
      this.current.view,
      participantPubkey,
    );
  }

  /**
   * Projection boundary for workspace adapters. Returning null prevents local
   * rendering or retention through this API; it is not transport
   * confidentiality. A provider must avoid delivering plaintext Stage
   * commands to a participant who cannot read their referenced resources
   * (and production read privacy still requires per-file encryption).
   */
  snapshotFor(
    participantPubkey = this.collaboration.participantPubkey,
  ): StageSessionSnapshot | null {
    return this.canView(participantPubkey) ? this.snapshot() : null;
  }

  subscribeOutgoing(listener: StageOutgoingListener): () => void {
    this.outgoingListeners.add(listener);
    return () => this.outgoingListeners.delete(listener);
  }

  subscribeSnapshot(listener: StageSnapshotListener): () => void {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  private publish(
    source: "local" | "remote" | "transport",
  ): void {
    const snapshot = this.snapshot();
    for (const listener of this.snapshotListeners) listener(snapshot, source);
  }

  private submit<Command extends StageActiveCommand>(
    command: Command,
  ): Command {
    this.apply(command, "local");
    for (const listener of this.outgoingListeners) listener(command);
    return command;
  }

  private signAndSubmit(
    kind: StageActiveCommand["kind"],
    payload: StageActiveCommand["payload"],
    secretKey: Uint8Array,
    timestamp: number,
  ): StageActiveCommand {
    assertTimestamp(timestamp);
    const body = {
      version: STAGE_VERSION,
      stageId: this.current.stageId,
      collaborationId: this.current.collaborationId,
      nonce: createStageNonce(),
      participantPubkey: this.collaboration.participantPubkey,
      timestamp,
      expectedRevision: this.current.view.revision,
      kind,
      payload,
    } as Exclude<StageCommandBody, { kind: "stage.start" }>;
    return this.submit(signStageCommand(body, secretKey) as StageActiveCommand);
  }

  updateView(
    view: StageViewState,
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.view.update"> {
    return this.signAndSubmit(
      "stage.view.update",
      { view: cloneStageViewState(view) },
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.view.update">;
  }

  requestControl(
    toPubkey: string,
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.control.request"> {
    return this.signAndSubmit(
      "stage.control.request",
      {
        transferId: createStageNonce(),
        toPubkey,
      },
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.control.request">;
  }

  acceptControl(
    transferId: string,
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.control.accept"> {
    return this.signAndSubmit(
      "stage.control.accept",
      { transferId },
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.control.accept">;
  }

  cancelControl(
    transferId: string,
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.control.cancel"> {
    return this.signAndSubmit(
      "stage.control.cancel",
      { transferId },
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.control.cancel">;
  }

  recoverControl(
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.recover"> {
    return this.signAndSubmit(
      "stage.recover",
      {},
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.recover">;
  }

  end(
    secretKey: Uint8Array,
    timestamp = Date.now(),
  ): StageSignedCommandOf<"stage.end"> {
    return this.signAndSubmit(
      "stage.end",
      {},
      secretKey,
      timestamp,
    ) as StageSignedCommandOf<"stage.end">;
  }

  receive(value: unknown): boolean {
    if (!verifyStageCommand(value)) {
      throw new StageSessionError("rejected an invalid Stage signature");
    }
    if (value.kind === "stage.start") {
      throw new StageSessionError("an existing Stage cannot receive another start");
    }
    if (this.seenCommandIds.has(value.commandId)) return false;
    this.apply(value, "remote");
    return true;
  }

  private assertCurrentCommand(command: StageSignedCommand): void {
    if (
      command.stageId !== this.current.stageId ||
      command.collaborationId !== this.current.collaborationId
    ) {
      throw new StageSessionError("Stage command targets another Stage");
    }
    if (command.expectedRevision !== this.current.view.revision) {
      throw new StageSessionError(
        "rejected a stale or replayed Stage command",
      );
    }
    if (!participantExists(this.collaboration, command.participantPubkey)) {
      throw new StageSessionError(
        "Stage command signer is not a Collaboration participant",
      );
    }
  }

  private assertControlling(command: StageSignedCommand): void {
    if (
      this.current.status !== "active" ||
      this.current.controllerPubkey !== command.participantPubkey
    ) {
      throw new StageSessionError(
        "only the active Stage Controller may perform this command",
      );
    }
    if (this.current.controllerDisconnectedAt !== null) {
      throw new StageSessionError(
        "Stage is frozen while its Controller is disconnected",
      );
    }
    assertAction(
      this.collaboration,
      command.participantPubkey,
      "stage.control",
      this.current.view,
    );
  }

  private apply(
    command: Exclude<StageSignedCommand, { kind: "stage.start" }>,
    source: "local" | "remote",
  ): void {
    this.assertCurrentCommand(command);
    const old = this.current;
    if (
      old.pendingControlTransfer !== null &&
      command.kind !== "stage.control.accept" &&
      command.kind !== "stage.control.cancel" &&
      command.kind !== "stage.end"
    ) {
      throw new StageSessionError(
        "Stage is frozen while its Controller transfer awaits acceptance",
      );
    }
    switch (command.kind) {
      case "stage.view.update": {
        this.assertControlling(command);
        if (command.payload.view.revision !== old.view.revision + 1) {
          throw new StageSessionError(
            "Stage view update must advance exactly one revision",
          );
        }
        assertCanView(
          this.collaboration,
          command.participantPubkey,
          command.payload.view,
        );
        assertAction(
          this.collaboration,
          command.participantPubkey,
          "stage.control",
          command.payload.view,
        );
        this.current = {
          ...old,
          view: cloneStageViewState(command.payload.view),
          updatedAt: command.timestamp,
        };
        break;
      }
      case "stage.control.request": {
        this.assertControlling(command);
        if (
          command.payload.toPubkey === command.participantPubkey ||
          !participantExists(this.collaboration, command.payload.toPubkey)
        ) {
          throw new StageSessionError(
            "Stage Controller transfer requires another Collaboration participant",
          );
        }
        assertAction(
          this.collaboration,
          command.payload.toPubkey,
          "stage.control",
          old.view,
        );
        if (
          !canParticipantViewStage(
            this.collaboration,
            old.view,
            command.payload.toPubkey,
          )
        ) {
          throw new StageSessionError(
            "Stage Controller recipient cannot view the current Stage",
          );
        }
        this.current = {
          ...old,
          view: advancedView(old.view),
          pendingControlTransfer: {
            transferId: command.payload.transferId,
            fromPubkey: command.participantPubkey,
            toPubkey: command.payload.toPubkey,
            requestedAt: command.timestamp,
          },
          updatedAt: command.timestamp,
        };
        break;
      }
      case "stage.control.accept": {
        const transfer = old.pendingControlTransfer;
        if (
          old.status !== "active" ||
          old.controllerDisconnectedAt !== null ||
          transfer === null ||
          transfer.transferId !== command.payload.transferId ||
          transfer.toPubkey !== command.participantPubkey ||
          transfer.fromPubkey !== old.controllerPubkey
        ) {
          throw new StageSessionError(
            "Stage Controller transfer was not requested for this participant",
          );
        }
        assertAction(
          this.collaboration,
          command.participantPubkey,
          "stage.control",
          old.view,
        );
        assertCanView(
          this.collaboration,
          command.participantPubkey,
          old.view,
        );
        this.current = {
          ...old,
          controllerPubkey: command.participantPubkey,
          view: advancedView(old.view),
          pendingControlTransfer: null,
          updatedAt: command.timestamp,
        };
        break;
      }
      case "stage.control.cancel": {
        const transfer = old.pendingControlTransfer;
        if (
          old.status !== "active" ||
          transfer === null ||
          transfer.transferId !== command.payload.transferId ||
          (
            command.participantPubkey !== transfer.fromPubkey &&
            command.participantPubkey !== old.ownerPubkey
          )
        ) {
          throw new StageSessionError(
            "only the requesting Controller or owner may cancel this transfer",
          );
        }
        assertAction(
          this.collaboration,
          command.participantPubkey,
          "stage.control",
          old.view,
        );
        this.current = {
          ...old,
          view: advancedView(old.view),
          pendingControlTransfer: null,
          updatedAt: command.timestamp,
        };
        break;
      }
      case "stage.recover": {
        if (
          command.participantPubkey !== old.ownerPubkey ||
          old.status !== "vacant"
        ) {
          throw new StageSessionError(
            "only the owner may recover a vacant Stage",
          );
        }
        assertAction(
          this.collaboration,
          command.participantPubkey,
          "stage.control",
          old.view,
        );
        assertCanView(
          this.collaboration,
          command.participantPubkey,
          old.view,
        );
        this.current = {
          ...old,
          controllerPubkey: command.participantPubkey,
          status: "active",
          view: advancedView(old.view),
          pendingControlTransfer: null,
          controllerDisconnectedAt: null,
          updatedAt: command.timestamp,
        };
        break;
      }
      case "stage.end": {
        if (
          command.participantPubkey !== old.ownerPubkey &&
          command.participantPubkey !== old.controllerPubkey
        ) {
          throw new StageSessionError(
            "only the owner or Stage Controller may end Stage",
          );
        }
        if (old.status === "ended") {
          throw new StageSessionError("Stage has already ended");
        }
        assertAction(
          this.collaboration,
          command.participantPubkey,
          "stage.end",
          old.view,
        );
        this.current = {
          ...old,
          controllerPubkey: null,
          status: "ended",
          view: advancedView(old.view),
          pendingControlTransfer: null,
          controllerDisconnectedAt: null,
          updatedAt: command.timestamp,
        };
        break;
      }
    }
    this.seenCommandIds.add(command.commandId);
    this.publish(source);
  }

  /**
   * Transport-authenticated presence event. An unexpected network loss cannot
   * be signed by the absent Controller, so disconnect/grace is not a command.
   *
   * A provider may call this only at an ordered delivery fence shared by every
   * Stage replica. It is not safe to derive shared vacancy independently from
   * unordered peer observations; a production mesh needs one logical
   * sequencer/epoch for these transport-only transitions.
   */
  noteControllerDisconnected(
    authenticatedParticipantPubkey: string,
    disconnectedAt = Date.now(),
  ): boolean {
    assertTimestamp(disconnectedAt);
    if (
      this.current.status !== "active" ||
      this.current.controllerPubkey !== authenticatedParticipantPubkey
    ) return false;
    if (this.current.controllerDisconnectedAt !== null) return false;
    this.current = {
      ...this.current,
      view: advancedView(this.current.view),
      pendingControlTransfer: null,
      controllerDisconnectedAt: disconnectedAt,
      updatedAt: disconnectedAt,
    };
    this.publish("transport");
    return true;
  }

  noteControllerReconnected(
    authenticatedParticipantPubkey: string,
    reconnectedAt = Date.now(),
  ): boolean {
    assertTimestamp(reconnectedAt);
    if (
      this.current.status !== "active" ||
      this.current.controllerPubkey !== authenticatedParticipantPubkey ||
      this.current.controllerDisconnectedAt === null
    ) return false;
    if (reconnectedAt < this.current.controllerDisconnectedAt) return false;
    if (
      reconnectedAt - this.current.controllerDisconnectedAt >=
        STAGE_CONTROLLER_GRACE_MS
    ) {
      this.expireControllerGrace(reconnectedAt);
      return false;
    }
    this.current = {
      ...this.current,
      view: advancedView(this.current.view),
      controllerDisconnectedAt: null,
      updatedAt: reconnectedAt,
    };
    this.publish("transport");
    return true;
  }

  expireControllerGrace(now = Date.now()): boolean {
    assertTimestamp(now);
    const disconnectedAt = this.current.controllerDisconnectedAt;
    if (
      this.current.status !== "active" ||
      disconnectedAt === null ||
      now < disconnectedAt ||
      now - disconnectedAt < STAGE_CONTROLLER_GRACE_MS
    ) return false;
    this.current = {
      ...this.current,
      controllerPubkey: null,
      status: "vacant",
      view: advancedView(this.current.view),
      pendingControlTransfer: null,
      controllerDisconnectedAt: null,
      updatedAt: now,
    };
    this.publish("transport");
    return true;
  }
}
