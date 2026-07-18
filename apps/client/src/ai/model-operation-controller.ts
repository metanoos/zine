import { contentFingerprint, type ContextSnapshot } from "./context-snapshot.js";
import {
  executePreparedOperation,
  type CurrentModelTarget,
  type ExecutePreparedOperationInput,
  type ModelExecutionResult,
  type RecoverableModelResult,
} from "./model-operation-executor.js";
import type { ProviderConfig } from "./models-store.js";
import type { OpLensId } from "./op-lenses.js";
import type { OpInputs, OpKind } from "./op-prompts.js";
import {
  PREPARED_OPERATION_VERSION,
  PROMPT_LAYER_VERSIONS,
  PreparedOperationApproval,
  prepareOperation,
  type PreparedOperation,
  type PrepareOperationInput,
} from "./prepared-operation.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";
import {
  SnapshotCoordinator,
  snapshotDependencyKey,
  type SnapshotDependencies,
} from "./snapshot-coordinator.js";
import type { AuthoritySpanV1 } from "@zine/trace-context";
import {
  desktopTraceContextBoundaryFingerprintV1,
  prepareDesktopTraceContextOperationV1,
  type DesktopTraceContextPreparationBoundaryV1,
} from "./desktop-trace-context-preparation.js";

export interface ModelOperationFocusSnapshot {
  kind: string;
  path: string;
  nodeId: string | null;
  panelIndex: number;
  tabPath: string;
}

export interface ModelOperationTargetSnapshot {
  path: string;
  traceId: string | null;
  headId: string | null;
  contentHash: string;
  authoritySpans: readonly AuthoritySpanV1[];
}

/** Live authoring state captured by App at one preparation boundary. */
export interface ModelOperationCapture {
  workspaceId: string | null;
  activePath: string;
  focus: ModelOperationFocusSnapshot | null;
  target: ModelOperationTargetSnapshot | null;
  mount: unknown;
  shields: readonly string[];
  voicePrompt: string;
  dirtyTarget: boolean;
  actingAuthorId: string;
  gatherContext: (signal: AbortSignal) => Promise<ContextSnapshot>;
}

export interface ModelOperationControllerDependencies {
  capture: (panelIndex: number, modelVoicePubkey: string) => ModelOperationCapture;
  readCurrentTarget: (prepared: PreparedOperation) => CurrentModelTarget | null;
}

export interface PrepareModelOperationInput {
  panelIndex: number;
  operation: OpKind;
  operationInputs: OpInputs;
  provider: ProviderConfig;
  modelVoicePubkey: string;
  lensId: OpLensId;
  signal?: AbortSignal;
  /** Optional exact signed-chain selector boundary for Extend/Settle dogfood. */
  traceContext?: DesktopTraceContextPreparationBoundaryV1;
}

export interface ExecuteApprovedModelOperationInput extends PrepareModelOperationInput {
  maxTokens: number;
  beforeExecute?: (prepared: PreparedOperation) => void | Promise<void>;
  apply: ExecutePreparedOperationInput["apply"];
  onStale?: (recovery: RecoverableModelResult) => void | Promise<void>;
  complete?: ExecutePreparedOperationInput["complete"];
}

export interface ApprovedModelExecution {
  /** The exact immutable object previously approved in Inspector. */
  prepared: PreparedOperation;
  result: ModelExecutionResult;
}

/**
 * Owns the prepared-operation lifecycle shared by token estimate, Inspector,
 * approval, and transport. App supplies live state and atomic UI apply
 * callbacks, but cannot rebuild or substitute the approved wire object.
 */
export class ModelOperationController {
  private readonly snapshots = new SnapshotCoordinator();
  private readonly approval = new PreparedOperationApproval();
  private preparationKey: string | null = null;
  private readonly preparationControllers = new Set<AbortController>();

  constructor(private readonly dependencies: ModelOperationControllerDependencies) {}

  async prepare(input: PrepareModelOperationInput): Promise<PreparedOperation> {
    const capture = this.dependencies.capture(input.panelIndex, input.modelVoicePubkey);
    if (!capture.workspaceId) {
      throw new Error("Open a workspace before running an AI operation");
    }
    const focus = capture.focus;
    if (
      !focus ||
      focus.kind !== "file" ||
      !focus.path ||
      focus.path !== capture.activePath ||
      focus.panelIndex !== input.panelIndex ||
      focus.tabPath !== capture.activePath
    ) {
      throw new Error("Focus a live file before running an AI operation");
    }
    const target = capture.target;
    if (!target || target.path !== capture.activePath) {
      throw new Error("The focused AI target is not an editable file");
    }

    const dependencies: SnapshotDependencies = {
      focus: JSON.stringify({
        kind: focus.kind,
        path: focus.path,
        nodeId: focus.nodeId,
        panelIndex: focus.panelIndex,
        tabPath: focus.tabPath,
      }),
      targetRevision: JSON.stringify({
        folderId: capture.workspaceId,
        path: target.path,
        traceId: target.traceId,
        headId: target.headId,
        contentHash: target.contentHash,
      }),
      mount: JSON.stringify(capture.mount) ?? "null",
      shields: [...capture.shields].sort(),
      providerFingerprint: providerProfileFingerprint(input.provider),
      modelVoicePromptHash: contentFingerprint(capture.voicePrompt),
      lensId: input.lensId,
      operation: input.operation,
      operationInputsHash: contentFingerprint(JSON.stringify(input.operationInputs)),
      authoringAuthorityHash: contentFingerprint(JSON.stringify({
        actingAuthorId: capture.actingAuthorId,
        spans: target.authoritySpans,
      })),
      traceContextBoundaryHash: desktopTraceContextBoundaryFingerprintV1(input.traceContext),
      promptLayerVersions: [
        ...PROMPT_LAYER_VERSIONS,
        `prepared-operation:v${PREPARED_OPERATION_VERSION}`,
      ],
    };
    const preparationKey = snapshotDependencyKey(dependencies);
    if (this.preparationKey !== preparationKey) {
      this.abortPreparations("model operation dependencies changed");
      this.preparationKey = preparationKey;
    }
    const preparationController = new AbortController();
    const onAbort = () => preparationController.abort(input.signal?.reason);
    if (input.signal?.aborted) preparationController.abort(input.signal.reason);
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    this.preparationControllers.add(preparationController);

    try {
      throwIfPreparationAborted(preparationController.signal);
      const snapshot = await this.snapshots.request(
        dependencies,
        capture.gatherContext,
        preparationController.signal,
      );
      throwIfPreparationAborted(preparationController.signal);
      if (
        snapshot.target.path !== target.path ||
        snapshot.target.contentHash !== target.contentHash ||
        snapshot.target.traceId !== target.traceId ||
        snapshot.target.headId !== target.headId
      ) {
        throw new Error("The gathered context no longer matches the captured target revision");
      }
      const preparationInput: PrepareOperationInput = {
        operation: input.operation,
        operationInputs: input.operationInputs,
        contextSnapshot: snapshot,
        provider: input.provider,
        modelVoicePubkey: input.modelVoicePubkey,
        voicePrompt: capture.voicePrompt,
        lensId: input.lensId,
        dirtyTarget: capture.dirtyTarget,
        actingAuthorId: capture.actingAuthorId,
        authoritySpans: target.authoritySpans,
      };
      const prepared = input.traceContext
        ? await prepareDesktopTraceContextOperationV1(
            preparationInput,
            input.traceContext,
            preparationController.signal,
          )
        : prepareOperation(preparationInput);
      throwIfPreparationAborted(preparationController.signal);
      return prepared;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      this.preparationControllers.delete(preparationController);
    }
  }

  approve(prepared: PreparedOperation): void {
    this.approval.approve(prepared);
  }

  async executeApproved(
    input: ExecuteApprovedModelOperationInput,
  ): Promise<ApprovedModelExecution> {
    const current = await this.prepare(input);
    const prepared = this.approval.get(current.provenance.dependencyFingerprint);
    if (!prepared || prepared.operation !== input.operation) {
      throw new Error("Inspect and approve this AI request before running it");
    }
    await input.beforeExecute?.(prepared);
    const result = await executePreparedOperation({
      prepared,
      provider: input.provider,
      maxTokens: input.maxTokens,
      signal: input.signal,
      readCurrentTarget: () => this.dependencies.readCurrentTarget(prepared),
      apply: input.apply,
      onStale: input.onStale,
      complete: input.complete,
    });
    return { prepared, result };
  }

  invalidate(): void {
    this.abortPreparations("model operation invalidated");
    this.preparationKey = null;
    this.snapshots.invalidate();
    this.approval.invalidate();
  }

  private abortPreparations(reason: string): void {
    for (const controller of this.preparationControllers) controller.abort(reason);
    this.preparationControllers.clear();
  }
}

function throwIfPreparationAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const error = new Error("Model operation preparation was cancelled");
  error.name = "AbortError";
  throw error;
}
