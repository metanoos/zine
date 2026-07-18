import { contentFingerprint } from "./context-snapshot.js";
import {
  createDesktopOperationEnvelopeV1,
  hashCanonicalV1,
  hashDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
  type DesktopPreparedRequestV1,
  type OperationFaultCodeV1,
} from "./desktop-operation-envelope.js";
import {
  createDesktopOperationRetryV1,
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import type { CompleteOptions, CompletePreparedRequest } from "./llm.js";
import type { ProviderConfig } from "./models-store.js";
import type { PreparedOperation } from "./prepared-operation.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";

export interface DesktopOperationKeyV1 {
  operationId: string;
  attemptId: string;
}

/**
 * Vault-native implementations own cloning, validation, encryption, and
 * transactionality. `replace` is an optimistic compare-and-set over the exact
 * previously observed envelope identity, not merely its timestamp.
 */
export interface DesktopOperationRepositoryV1 {
  create(envelope: DesktopOperationEnvelopeV1): Promise<"created" | "exists">;
  replace(
    key: DesktopOperationKeyV1,
    expectedEnvelopeSha256: string,
    envelope: DesktopOperationEnvelopeV1,
  ): Promise<"replaced" | "conflict" | "missing">;
  load(key: DesktopOperationKeyV1): Promise<DesktopOperationEnvelopeV1 | null>;
  list(): Promise<readonly DesktopOperationEnvelopeV1[]>;
  delete(
    key: DesktopOperationKeyV1,
    expectedEnvelopeSha256: string,
  ): Promise<"deleted" | "conflict" | "missing">;
}

export type DesktopOperationIdKindV1 =
  | "operation"
  | "attempt"
  | "transition"
  | "artifact-intent"
  | "artifact-receipt"
  | "diagnostic";

export interface DesktopOperationRuntimeIdsV1 {
  next(kind: DesktopOperationIdKindV1): string;
}

export interface DesktopOperationRuntimeClockV1 {
  nowMs(): number;
}

/** The exact transport input is fully reconstructible after a crash. */
export type CompletePreparedCompatibleRequestV1 = CompletePreparedRequest;

export type DesktopOperationTransportV1 = (
  prepared: CompletePreparedCompatibleRequestV1,
  provider: ProviderConfig,
  options: CompleteOptions,
) => Promise<string>;

export type DesktopArtifactApplyResultV1 =
  | { status: "applied" | "already-applied"; resultingContentHash: string }
  | { status: "stale" };

export interface DesktopArtifactApplyInputV1 {
  envelope: DesktopOperationEnvelopeV1;
  intent: NonNullable<DesktopOperationEnvelopeV1["artifactIntent"]>;
  responseText: string;
}

/**
 * Implementations MUST atomically bind `intent.intentId` to the durable target
 * mutation. Replaying the same intent after a crash or from another runtime
 * must return `already-applied`, never apply the response twice or misclassify
 * that exact prior application as a stale unrelated edit.
 */
export type DesktopArtifactApplierV1 = (
  input: DesktopArtifactApplyInputV1,
) => Promise<DesktopArtifactApplyResultV1>;

export interface DesktopCurrentTargetRevisionV1 {
  folderId: string;
  path: string;
  traceId: string;
  headId: string;
  contentHash: string;
  /** False when the editor no longer points at this exact live file locus. */
  focused: boolean;
}

export type DesktopOperationPresenterV1 = (
  envelope: DesktopOperationEnvelopeV1,
  reason: "response-recorded" | "recovery" | "stale-target",
) => void | Promise<void>;

export interface DesktopOperationRuntimeDependenciesV1 {
  repository: DesktopOperationRepositoryV1;
  clock: DesktopOperationRuntimeClockV1;
  ids: DesktopOperationRuntimeIdsV1;
  resolveProvider(providerId: string): ProviderConfig | null | Promise<ProviderConfig | null>;
  readCurrentTarget(
    captured: DesktopPreparedRequestV1["targetRevision"],
  ): DesktopCurrentTargetRevisionV1 | null | Promise<DesktopCurrentTargetRevisionV1 | null>;
  completePrepared: DesktopOperationTransportV1;
  applyArtifact: DesktopArtifactApplierV1;
  presentResult?: DesktopOperationPresenterV1;
}

export interface PersistApprovedDesktopExtendInputV1 {
  /** The exact immutable request that the Inspector approved. */
  prepared: PreparedOperation;
  /** The provider card captured at that same approval boundary. */
  provider: ProviderConfig;
  maxOutputTokens: number;
  operationId?: string;
  attemptId?: string;
  createdAtMs?: number;
  retainForMs?: number;
}

export interface DesktopOperationCommandV1 {
  transitionId?: string;
  atMs?: number;
}

export interface RetryDesktopOperationCommandV1 {
  attemptId?: string;
  createdAtMs?: number;
  retainForMs?: number;
  possibleDuplicateAcknowledged?: true;
}

export type DesktopOperationAcceptResultV1 =
  | { status: "applied" | "already-applied"; envelope: DesktopOperationEnvelopeV1 }
  | { status: "stale"; envelope: DesktopOperationEnvelopeV1 };

export interface DesktopOperationRecoveryResultV1 {
  deleted: readonly DesktopOperationKeyV1[];
  recovered: readonly DesktopOperationKeyV1[];
  failures: readonly { key: DesktopOperationKeyV1; error: unknown }[];
}

export type DesktopOperationTransportFailureCertaintyV1 =
  | "provider-completed-without-result"
  | "unknown";

/**
 * Transport adapters use this closed error instead of asking the coordinator
 * to infer dispatch certainty from provider prose or generic exception text.
 */
export class DesktopOperationTransportFailureV1 extends Error {
  readonly code: Extract<
    OperationFaultCodeV1,
    "PROVIDER_REJECTED" | "PROVIDER_UNAVAILABLE" | "PROVIDER_RESPONSE_INVALID"
  >;
  readonly certainty: DesktopOperationTransportFailureCertaintyV1;

  constructor(input: {
    code: DesktopOperationTransportFailureV1["code"];
    certainty: DesktopOperationTransportFailureCertaintyV1;
  }) {
    super(`Desktop provider transport failed with ${input.code}`);
    this.name = "DesktopOperationTransportFailureV1";
    this.code = input.code;
    this.certainty = input.certainty;
  }
}

export class DesktopOperationRuntimeError extends Error {
  constructor(message: string) {
    super(`Desktop operation runtime: ${message}`);
    this.name = "DesktopOperationRuntimeError";
  }
}

/**
 * Hash only transport/output-affecting public configuration. Credential
 * references, credential-presence flags, labels, and preset bookkeeping are
 * intentionally absent.
 */
export function desktopCredentialFreeTransportConfigSha256V1(
  provider: ProviderConfig,
): string {
  return hashCanonicalV1("zine.desktop-operation.transport-config.v1", {
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    reasoningEffort: provider.reasoningEffort ?? null,
    verbosity: provider.verbosity ?? null,
    personality: provider.personality ?? null,
    temperature: provider.temperature ?? null,
    maxTokens: provider.maxTokens ?? null,
    instructions: provider.instructions ?? "",
  });
}

/**
 * Freeze one approved exact-context Extend request into the private envelope.
 * Approval itself remains owned by `PreparedOperationApproval`; this boundary
 * verifies that no request/provider/selector bytes were substituted afterward.
 */
export function createApprovedDesktopExtendEnvelopeV1(
  input: Required<Pick<PersistApprovedDesktopExtendInputV1,
    "prepared" | "provider" | "maxOutputTokens" | "operationId" | "attemptId" | "createdAtMs"
  >> & Pick<PersistApprovedDesktopExtendInputV1, "retainForMs">,
): DesktopOperationEnvelopeV1 {
  const { prepared, provider } = input;
  if (prepared.operation !== "extend") fail("durable Phase 2 execution supports Extend only");
  const selected = prepared.traceContextSelection;
  if (!selected) fail("approved Extend request has no exact trace-context selection");
  if (provider.id !== prepared.providerId) fail("provider id changed after request approval");
  if (providerProfileFingerprint(provider) !== prepared.providerFingerprint) {
    fail("provider configuration changed after request approval");
  }
  const placement = locateUniqueUserContext(prepared, selected.renderedContext);
  return createDesktopOperationEnvelopeV1({
    operationId: input.operationId,
    attemptId: input.attemptId,
    prepared,
    provider: {
      protocol: provider.protocol,
      modelId: provider.modelId,
      transportConfigSha256: desktopCredentialFreeTransportConfigSha256V1(provider),
    },
    selectedContext: {
      manifest: selected.manifest,
      manifestSha256: selected.manifestSha256,
      renderedContext: selected.renderedContext,
      placement,
    },
    maxOutputTokens: input.maxOutputTokens,
    createdAtMs: input.createdAtMs,
    ...(input.retainForMs === undefined ? {} : { retainForMs: input.retainForMs }),
  });
}

export class DesktopOperationRuntimeV1 {
  private readonly operationQueue = new KeyedSerialQueue();
  private readonly targetQueue = new KeyedSerialQueue();

  constructor(private readonly dependencies: DesktopOperationRuntimeDependenciesV1) {}

  async persistApprovedExtend(
    input: PersistApprovedDesktopExtendInputV1,
  ): Promise<DesktopOperationEnvelopeV1> {
    const envelope = createApprovedDesktopExtendEnvelopeV1({
      ...input,
      operationId: input.operationId ?? this.dependencies.ids.next("operation"),
      attemptId: input.attemptId ?? this.dependencies.ids.next("attempt"),
      createdAtMs: input.createdAtMs ?? this.now(),
    });
    if (this.now() >= envelope.retention.deleteByMs) {
      fail("cannot persist an operation envelope after its privacy deadline");
    }
    const key = keyFor(envelope);
    return this.operationQueue.run(operationQueueKey(key), async () => {
      const result = await this.dependencies.repository.create(envelope);
      if (result === "created") {
        await this.assertLive(envelope);
        return envelope;
      }
      const existing = await this.dependencies.repository.load(key);
      if (
        existing
        && hashDesktopOperationEnvelopeV1(existing) === hashDesktopOperationEnvelopeV1(envelope)
      ) {
        await this.assertLive(existing);
        return existing;
      }
      fail(`operation attempt ${key.operationId}/${key.attemptId} already exists with different bytes`);
    });
  }

  async load(key: DesktopOperationKeyV1): Promise<DesktopOperationEnvelopeV1 | null> {
    return this.dependencies.repository.load(key);
  }

  async approve(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.withOperation(key, async () => {
      const current = await this.requireEnvelope(key);
      return (await this.commit(current, this.transition("approve", current, command))).envelope;
    });
  }

  async dispatch(
    key: DesktopOperationKeyV1,
    input: DesktopOperationCommandV1 & { signal?: AbortSignal } = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.withOperation(key, async () => {
      let current = await this.requireEnvelope(key);
      if (current.lifecycle.status === "approved") {
        current = (await this.commit(
          current,
          this.transition("record-dispatch-intent", current, input),
        )).envelope;
      }
      if (current.lifecycle.status !== "dispatch-intent") {
        fail(`dispatch is illegal from ${current.lifecycle.status}`);
      }
      return this.resumeDispatchHandshake(current, input.signal);
    });
  }

  async accept(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationAcceptResultV1> {
    return this.withOperation(key, async () => {
      const current = await this.requireEnvelope(key);
      return this.targetQueue.run(targetQueueKey(current), () => (
        this.acceptWithTargetLock(key, command)
      ));
    });
  }

  async reject(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.simpleTransition(key, "reject-result", command);
  }

  async abandon(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.simpleTransition(key, "abandon", command);
  }

  async cancel(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.withOperation(key, async () => {
      const current = await this.requireEnvelope(key);
      const type = current.lifecycle.status === "provider-io"
        ? "mark-dispatch-unknown"
        : "cancel";
      return (await this.commit(current, this.transition(type, current, command))).envelope;
    });
  }

  async retry(
    key: DesktopOperationKeyV1,
    command: RetryDesktopOperationCommandV1 = {},
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.withOperation(key, async () => {
      const prior = await this.requireEnvelope(key);
      const ambiguous = prior.lifecycle.retryPolicy === "operator-confirmation-required";
      if (!ambiguous && command.possibleDuplicateAcknowledged === true) {
        fail("duplicate-risk acknowledgement is allowed only for an ambiguous attempt");
      }
      const next = createDesktopOperationRetryV1(prior, {
        attemptId: command.attemptId ?? this.dependencies.ids.next("attempt"),
        createdAtMs: command.createdAtMs ?? this.atOrAfter(prior),
        ...(command.retainForMs === undefined ? {} : { retainForMs: command.retainForMs }),
        ...(command.possibleDuplicateAcknowledged === undefined
          ? {}
          : { possibleDuplicateAcknowledged: command.possibleDuplicateAcknowledged }),
      });
      const result = await this.dependencies.repository.create(next);
      if (result === "created") return next;
      const existing = await this.dependencies.repository.load(keyFor(next));
      if (
        existing
        && hashDesktopOperationEnvelopeV1(existing) === hashDesktopOperationEnvelopeV1(next)
      ) return existing;
      fail(`retry attempt ${next.attempt.attemptId} already exists with different bytes`);
    });
  }

  /**
   * Recovery is deliberately two-phase. Every expired record in the initial
   * snapshot is deleted and awaited before any provider, review, or apply work.
   */
  async recover(): Promise<DesktopOperationRecoveryResultV1> {
    const snapshot = [...await this.dependencies.repository.list()];
    const deleted: DesktopOperationKeyV1[] = [];
    const deletedKeys = new Set<string>();
    for (const envelope of snapshot) {
      const key = keyFor(envelope);
      await this.withOperation(key, async () => {
        const current = await this.dependencies.repository.load(key);
        if (current && await this.deleteIfExpired(current)) {
          recordDeletedKey(key, deleted, deletedKeys);
        }
      });
    }

    const recovered: DesktopOperationKeyV1[] = [];
    const failures: Array<{ key: DesktopOperationKeyV1; error: unknown }> = [];
    for (const candidate of snapshot) {
      const key = keyFor(candidate);
      if (deletedKeys.has(operationQueueKey(key))) continue;
      try {
        await this.withOperation(key, async () => {
          const current = await this.dependencies.repository.load(key);
          if (!current) return;
          if (await this.deleteIfExpired(current)) {
            recordDeletedKey(key, deleted, deletedKeys);
            return;
          }
          await this.recoverEnvelope(current);
          recovered.push(key);
        });
      } catch (error) {
        failures.push({ key, error });
      }
    }
    return Object.freeze({
      deleted: freezeKeys(deleted),
      recovered: freezeKeys(recovered),
      failures: Object.freeze(failures.map((entry) => Object.freeze({ ...entry }))),
    });
  }

  private async simpleTransition<T extends "reject-result" | "abandon">(
    key: DesktopOperationKeyV1,
    type: T,
    command: DesktopOperationCommandV1,
  ): Promise<DesktopOperationEnvelopeV1> {
    return this.withOperation(key, async () => {
      const current = await this.requireEnvelope(key);
      return (await this.commit(current, this.transition(type, current, command))).envelope;
    });
  }

  private async resumeDispatchHandshake(
    current: DesktopOperationEnvelopeV1,
    signal?: AbortSignal,
  ): Promise<DesktopOperationEnvelopeV1> {
    if (signal?.aborted) {
      return (await this.commit(current, this.transition("cancel", current))).envelope;
    }
    const provider = await this.dependencies.resolveProvider(current.prepared.provider.providerId);
    if (!provider) {
      return this.recordKnownNotDispatchedFailure(current, "PROVIDER_UNAVAILABLE");
    }
    if (!providerMatchesEnvelope(provider, current)) {
      return this.recordKnownNotDispatchedFailure(current, "APPROVAL_INVALID");
    }
    const marked = await this.commit(
      current,
      this.transition("record-provider-io-may-have-started", current),
    );
    if (marked.replayed) return marked.envelope;
    await this.assertLive(marked.envelope);
    return this.invokeTransport(marked.envelope, provider, signal);
  }

  private async invokeTransport(
    current: DesktopOperationEnvelopeV1,
    provider: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<DesktopOperationEnvelopeV1> {
    let responseText: string;
    try {
      responseText = await this.dependencies.completePrepared(
        transportRequestFor(current.prepared),
        provider,
        { maxTokens: current.prepared.maxOutputTokens, signal },
      );
    } catch (error) {
      if (
        error instanceof DesktopOperationTransportFailureV1
        && error.certainty === "provider-completed-without-result"
      ) {
        return this.recordCompletedWithoutResultFailure(current, error.code);
      }
      return (await this.commit(
        current,
        this.transition("mark-dispatch-unknown", current, {}, {
          diagnosticRef: this.diagnosticRef(),
        }),
      )).envelope;
    }
    // Persistence/presentation failures after a completed provider response
    // are local failures, not evidence that provider dispatch is ambiguous.
    // Let them escape so recovery sees the durable provider-io marker and
    // conservatively resolves it instead of silently fabricating a fault.
    const recorded = await this.commit(
      current,
      this.transition("record-response", current, {}, { responseText }),
    );
    await this.present(recorded.envelope, "response-recorded");
    return recorded.envelope;
  }

  private async recordKnownNotDispatchedFailure(
    current: DesktopOperationEnvelopeV1,
    code: "PROVIDER_UNAVAILABLE" | "APPROVAL_INVALID",
  ): Promise<DesktopOperationEnvelopeV1> {
    return (await this.commit(current, this.transition("record-failure", current, {}, {
      certainty: "known-not-dispatched",
      fault: {
        version: 1,
        code,
        stage: code === "APPROVAL_INVALID" ? "approve" : "dispatch",
        observedAtMs: this.atOrAfter(current),
        diagnosticRef: this.diagnosticRef(),
      },
    }))).envelope;
  }

  private async recordCompletedWithoutResultFailure(
    current: DesktopOperationEnvelopeV1,
    code: DesktopOperationTransportFailureV1["code"],
  ): Promise<DesktopOperationEnvelopeV1> {
    return (await this.commit(current, this.transition("record-failure", current, {}, {
      certainty: "provider-completed-without-result",
      fault: {
        version: 1,
        code,
        stage: code === "PROVIDER_RESPONSE_INVALID" ? "response" : "dispatch",
        observedAtMs: this.atOrAfter(current),
        diagnosticRef: this.diagnosticRef(),
      },
    }))).envelope;
  }

  /** Caller holds the target queue from recheck through the apply boundary. */
  private async acceptWithTargetLock(
    key: DesktopOperationKeyV1,
    command: DesktopOperationCommandV1,
  ): Promise<DesktopOperationAcceptResultV1> {
    let current = await this.requireEnvelope(key);
    if (current.lifecycle.status === "response-completed") {
      const observed = await this.dependencies.readCurrentTarget(current.prepared.targetRevision);
      await this.assertLive(current);
      if (!sameTargetRevision(current.prepared.targetRevision, observed)) {
        const stale = await this.commit(
          current,
          this.transition("mark-target-stale", current, command, {
            diagnosticRef: this.diagnosticRef(),
          }),
        );
        await this.present(stale.envelope, "stale-target");
        return { status: "stale", envelope: stale.envelope };
      }
      const transition = this.transition("accept-result", current, command, {
        artifactIntentId: this.dependencies.ids.next("artifact-intent"),
      });
      current = (await this.commit(current, transition)).envelope;
    }
    if (current.lifecycle.status !== "accepted" || !current.artifactIntent) {
      fail(`accept is illegal from ${current.lifecycle.status}`);
    }
    if (current.artifactReceipt) {
      return { status: "already-applied", envelope: current };
    }
    return this.applyAcceptedIntentWithTargetLock(current);
  }

  private async applyAcceptedIntent(
    current: DesktopOperationEnvelopeV1,
  ): Promise<DesktopOperationAcceptResultV1> {
    return this.targetQueue.run(targetQueueKey(current), () => (
      this.applyAcceptedIntentWithTargetLock(current)
    ));
  }

  private async applyAcceptedIntentWithTargetLock(
    observed: DesktopOperationEnvelopeV1,
  ): Promise<DesktopOperationAcceptResultV1> {
    const current = await this.requireEnvelope(keyFor(observed));
    if (current.lifecycle.status === "stale") {
      return { status: "stale", envelope: current };
    }
    if (current.lifecycle.status !== "accepted" || !current.artifactIntent || !current.response) {
      fail(`artifact application is illegal from ${current.lifecycle.status}`);
    }
    if (current.artifactReceipt) {
      return { status: "already-applied", envelope: current };
    }
    const intent = current.artifactIntent;
    const response = current.response;
    await this.assertLive(current);
    const result = await this.dependencies.applyArtifact({
      envelope: current,
      intent,
      responseText: response.text,
    });
    if (result.status === "stale") {
      const latest = await this.requireEnvelope(keyFor(current));
      if (latest.artifactReceipt) {
        return { status: "already-applied", envelope: latest };
      }
      if (latest.lifecycle.status === "stale") {
        return { status: "stale", envelope: latest };
      }
      const stale = await this.commit(
        latest,
        this.transition("mark-target-stale", latest, {}, {
          diagnosticRef: this.diagnosticRef(),
        }),
      );
      await this.present(stale.envelope, "stale-target");
      return { status: "stale", envelope: stale.envelope };
    }
    const receipt = await this.recordArtifactReceiptConvergently(
      current,
      result.resultingContentHash,
    );
    return {
      status: receipt.converged ? "already-applied" : result.status,
      envelope: receipt.envelope,
    };
  }

  private async recordArtifactReceiptConvergently(
    observed: DesktopOperationEnvelopeV1,
    resultingContentHash: string,
  ): Promise<{ envelope: DesktopOperationEnvelopeV1; converged: boolean }> {
    let current = observed;
    const transition = this.transition("record-artifact-applied", current, {}, {
      receiptId: this.dependencies.ids.next("artifact-receipt"),
      resultingContentHash,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.assertLive(current);
      if (current.artifactReceipt) {
        if (current.artifactReceipt.resultingContentHash !== resultingContentHash) {
          fail("concurrent artifact receipt recorded a different resulting content hash");
        }
        return { envelope: current, converged: true };
      }
      if (current.lifecycle.status !== "accepted" || !current.artifactIntent) {
        fail(`artifact receipt is illegal from ${current.lifecycle.status}`);
      }
      const reduction = reduceDesktopOperationV1(current, transition);
      await this.assertLive(current);
      const result = await this.dependencies.repository.replace(
        keyFor(current),
        hashDesktopOperationEnvelopeV1(current),
        reduction.envelope,
      );
      if (result === "replaced") {
        await this.assertLive(reduction.envelope);
        return { envelope: reduction.envelope, converged: false };
      }
      if (result === "missing") fail("operation envelope disappeared while recording artifact receipt");
      const reloaded = await this.dependencies.repository.load(keyFor(current));
      if (!reloaded) fail("operation envelope disappeared after an artifact receipt conflict");
      current = reloaded;
    }
    fail("artifact receipt exceeded the optimistic-CAS retry limit");
  }

  private async recoverEnvelope(current: DesktopOperationEnvelopeV1): Promise<void> {
    switch (current.lifecycle.status) {
      case "dispatch-intent":
        await this.resumeDispatchHandshake(current);
        return;
      case "provider-io":
        await this.commit(current, this.transition("mark-dispatch-unknown", current, {}, {
          diagnosticRef: this.diagnosticRef(),
        }));
        return;
      case "response-completed":
        await this.present(current, "recovery");
        return;
      case "accepted":
        if (!current.artifactReceipt) await this.applyAcceptedIntent(current);
        return;
      case "stale":
        await this.present(current, "recovery");
        return;
      case "prepared":
      case "approved":
      case "failed":
      case "cancelled":
      case "unknown":
      case "rejected":
      case "abandoned":
        return;
    }
  }

  private async commit(
    observed: DesktopOperationEnvelopeV1,
    transition: DesktopOperationTransitionV1,
  ): Promise<{ envelope: DesktopOperationEnvelopeV1; replayed: boolean }> {
    let current = observed;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await this.assertLive(current);
      const reduction = reduceDesktopOperationV1(current, transition);
      if (reduction.replayed) return { envelope: current, replayed: true };
      await this.assertLive(current);
      const result = await this.dependencies.repository.replace(
        keyFor(current),
        hashDesktopOperationEnvelopeV1(current),
        reduction.envelope,
      );
      if (result === "replaced") {
        await this.assertLive(reduction.envelope);
        return { envelope: reduction.envelope, replayed: false };
      }
      if (result === "missing") fail("operation envelope disappeared during transition");
      const reloaded = await this.dependencies.repository.load(keyFor(current));
      if (!reloaded) fail("operation envelope disappeared after a replace conflict");
      current = reloaded;
    }
    fail("operation transition exceeded the optimistic-CAS retry limit");
  }

  private transition<T extends DesktopOperationTransitionV1["type"]>(
    type: T,
    current: DesktopOperationEnvelopeV1,
    command: DesktopOperationCommandV1 = {},
    extras: Omit<
      Extract<DesktopOperationTransitionV1, { type: T }>,
      "version" | "type" | "transitionId" | "atMs"
    > = {} as never,
  ): Extract<DesktopOperationTransitionV1, { type: T }> {
    return {
      version: 1,
      type,
      transitionId: command.transitionId ?? this.newTransitionId(current),
      atMs: command.atMs ?? this.atOrAfter(current),
      ...extras,
    } as Extract<DesktopOperationTransitionV1, { type: T }>;
  }

  private async requireEnvelope(key: DesktopOperationKeyV1): Promise<DesktopOperationEnvelopeV1> {
    const envelope = await this.dependencies.repository.load(key);
    if (!envelope) fail(`operation attempt ${key.operationId}/${key.attemptId} does not exist`);
    await this.assertLive(envelope);
    return envelope;
  }

  private async present(
    envelope: DesktopOperationEnvelopeV1,
    reason: Parameters<DesktopOperationPresenterV1>[1],
  ): Promise<void> {
    await this.assertLive(envelope);
    await this.dependencies.presentResult?.(envelope, reason);
  }

  private async assertLive(envelope: DesktopOperationEnvelopeV1): Promise<void> {
    if (await this.deleteIfExpired(envelope)) {
      fail("operation envelope reached its privacy deadline and was deleted");
    }
  }

  private async deleteIfExpired(envelope: DesktopOperationEnvelopeV1): Promise<boolean> {
    let current = envelope;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      if (this.now() < current.retention.deleteByMs) return false;
      const result = await this.dependencies.repository.delete(
        keyFor(current),
        hashDesktopOperationEnvelopeV1(current),
      );
      if (result === "deleted" || result === "missing") return true;
      const reloaded = await this.dependencies.repository.load(keyFor(current));
      if (!reloaded) return true;
      current = reloaded;
    }
    fail("expired envelope deletion exceeded the optimistic-CAS retry limit");
  }

  private withOperation<T>(key: DesktopOperationKeyV1, task: () => Promise<T>): Promise<T> {
    return this.operationQueue.run(operationQueueKey(key), task);
  }

  private now(): number {
    const value = this.dependencies.clock.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) fail("clock returned an invalid timestamp");
    return value;
  }

  private atOrAfter(current: DesktopOperationEnvelopeV1): number {
    return Math.max(this.now(), current.updatedAtMs);
  }

  private diagnosticRef(): string {
    return `diag:${contentFingerprint(`desktop-operation-diagnostic\0${this.dependencies.ids.next("diagnostic")}`)}`;
  }

  private newTransitionId(current: DesktopOperationEnvelopeV1): string {
    const used = new Set(current.appliedTransitions.map(({ transitionId }) => transitionId));
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const candidate = this.dependencies.ids.next("transition");
      if (!used.has(candidate)) return candidate;
    }
    fail("id source repeatedly returned an already-used transition id");
  }
}

function locateUniqueUserContext(
  prepared: PreparedOperation,
  renderedContext: string,
): { messageIndex: number; fromUtf16: number; toUtf16: number } {
  if (renderedContext.length === 0) fail("selected rendered context must be non-empty for exact placement");
  const matches: Array<{
    messageIndex: number;
    role: PreparedOperation["messages"][number]["role"];
    fromUtf16: number;
    toUtf16: number;
  }> = [];
  for (const [messageIndex, message] of prepared.messages.entries()) {
    let fromUtf16 = message.content.indexOf(renderedContext);
    while (fromUtf16 >= 0) {
      matches.push({
        messageIndex,
        role: message.role,
        fromUtf16,
        toUtf16: fromUtf16 + renderedContext.length,
      });
      if (matches.length > 1) break;
      fromUtf16 = message.content.indexOf(renderedContext, fromUtf16 + 1);
    }
    if (matches.length > 1) break;
  }
  if (matches.length !== 1) {
    fail(`selected rendered context must occur exactly once in the prepared messages; found ${matches.length}`);
  }
  const [{ messageIndex, role, fromUtf16, toUtf16 }] = matches;
  if (role !== "user") fail("selected rendered context must occur in a user message");
  return { messageIndex, fromUtf16, toUtf16 };
}

function providerMatchesEnvelope(
  provider: ProviderConfig,
  envelope: DesktopOperationEnvelopeV1,
): boolean {
  return provider.id === envelope.prepared.provider.providerId
    && provider.protocol === envelope.prepared.provider.protocol
    && provider.modelId === envelope.prepared.provider.modelId
    && providerProfileFingerprint(provider) === envelope.prepared.provider.providerFingerprint
    && desktopCredentialFreeTransportConfigSha256V1(provider)
      === envelope.prepared.provider.transportConfigSha256;
}

function transportRequestFor(
  request: DesktopPreparedRequestV1,
): CompletePreparedCompatibleRequestV1 {
  return Object.freeze({
    messages: request.messages,
    providerId: request.provider.providerId,
    providerFingerprint: request.provider.providerFingerprint,
  });
}

function keyFor(envelope: DesktopOperationEnvelopeV1): DesktopOperationKeyV1 {
  return Object.freeze({
    operationId: envelope.operationId,
    attemptId: envelope.attempt.attemptId,
  });
}

function operationQueueKey(key: DesktopOperationKeyV1): string {
  return `${key.operationId}\0${key.attemptId}`;
}

function targetQueueKey(envelope: DesktopOperationEnvelopeV1): string {
  const target = envelope.prepared.targetRevision;
  // The mutable editor locus is vault/folder + path. A fork can change trace
  // identity without changing that locus, so trace/head ids must not split the
  // serialization queue.
  return `${target.folderId}\0${target.path}`;
}

function sameTargetRevision(
  captured: DesktopPreparedRequestV1["targetRevision"],
  current: DesktopCurrentTargetRevisionV1 | null,
): boolean {
  return Boolean(
    current?.focused
    && current.folderId === captured.folderId
    && current.path === captured.path
    && current.traceId === captured.traceId
    && current.headId === captured.headId
    && current.contentHash === captured.contentHash,
  );
}

function recordDeletedKey(
  key: DesktopOperationKeyV1,
  deleted: DesktopOperationKeyV1[],
  deletedKeys: Set<string>,
): void {
  const id = operationQueueKey(key);
  if (deletedKeys.has(id)) return;
  deletedKeys.add(id);
  deleted.push(key);
}

function freezeKeys(keys: readonly DesktopOperationKeyV1[]): readonly DesktopOperationKeyV1[] {
  return Object.freeze(keys.map((key) => Object.freeze({ ...key })));
}

class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.tails.set(key, tail);
    await prior.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

function fail(message: string): never {
  throw new DesktopOperationRuntimeError(message);
}
