import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTraceContextV1,
  type TraceContextSelectionSuccessV1,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import {
  hashDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
} from "./desktop-operation-envelope.js";
import {
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import {
  DesktopOperationRuntimeV1,
  DesktopOperationTransportFailureV1,
  createApprovedDesktopExtendEnvelopeV1,
  desktopCredentialFreeTransportConfigSha256V1,
  type DesktopArtifactApplierV1,
  type DesktopOperationKeyV1,
  type DesktopOperationRepositoryV1,
  type DesktopOperationRuntimeDependenciesV1,
  type DesktopOperationRuntimeIdsV1,
  type DesktopOperationTransportV1,
} from "./desktop-operation-runtime.js";
import { completePrepared } from "./llm.js";
import type { ProviderConfig } from "./models-store.js";
import type { PreparedOperation } from "./prepared-operation.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";

const BASE_TIME = 10_000;
const HASH = (value: string) => contentFingerprint(value);

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "provider-runtime-0001",
    label: "Runtime test",
    protocol: "openai",
    baseUrl: "https://provider.invalid/v1",
    modelId: "model-runtime-1",
    credentialRef: "model:provider:runtime-test:api-key",
    credentialConfigured: true,
    reasoningEffort: "medium",
    verbosity: "low",
    personality: "pragmatic",
    temperature: 1,
    maxTokens: 2_048,
    instructions: "Be exact.",
    preset: "test-preset",
    ...overrides,
  };
}

interface TargetFixture {
  text: string;
  path: string;
  folderId: string;
  traceId: string;
  headId: string;
  contentHash: string;
}

function target(suffix = "one"): TargetFixture {
  const text = `draft ${suffix}`;
  return {
    text,
    path: `draft-${suffix}.md`,
    folderId: HASH(`folder-${suffix}`),
    traceId: HASH(`trace-${suffix}`),
    headId: HASH(`head-${suffix}`),
    contentHash: HASH(text),
  };
}

async function selectionFor(targetFixture: TargetFixture): Promise<TraceContextSelectionSuccessV1> {
  const result = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: targetFixture.traceId,
        headId: targetFixture.headId,
        contentHash: targetFixture.contentHash,
        currentText: targetFixture.text,
        chosenPath: targetFixture.path,
      },
      range: {
        fromUtf16: 0,
        toUtf16: targetFixture.text.length,
      },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  });
  assert.equal(result.ok, true);
  return result as TraceContextSelectionSuccessV1;
}

async function preparedFor(
  targetFixture = target(),
  providerFixture = provider(),
  messageTransform: (rendered: string) => string = (rendered) => `Before\n${rendered}\nAfter`,
): Promise<PreparedOperation> {
  const selection = await selectionFor(targetFixture);
  return Object.freeze({
    version: 1,
    requestId: `request-${targetFixture.path}`,
    operation: "extend",
    operationInputs: Object.freeze({
      seed: targetFixture.text,
      hasSelection: false,
      rangeFrom: targetFixture.text.length,
      rangeTo: targetFixture.text.length,
      sourceFrom: 0,
      sourceTo: targetFixture.text.length,
    }),
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: HASH(`context-${targetFixture.path}`),
    traceAuthoring: null,
    traceContextSelection: selection,
    messages: Object.freeze([
      { role: "system" as const, content: "Continue the document." },
      { role: "user" as const, content: messageTransform(selection.renderedContext) },
    ]),
    providerId: providerFixture.id,
    providerFingerprint: providerProfileFingerprint(providerFixture),
    targetRevision: {
      folderId: targetFixture.folderId,
      path: targetFixture.path,
      traceId: targetFixture.traceId,
      headId: targetFixture.headId,
      contentHash: targetFixture.contentHash,
    },
    provenance: Object.freeze({
      modelVoicePubkey: "a".repeat(64),
      lensId: "default" as const,
      voicePromptHash: HASH("voice"),
      dependencyFingerprint: HASH(`dependency-${targetFixture.path}`),
    }),
    budget: Object.freeze({
      maxBytes: 32_768,
      totalBytes: 2_048,
      estimatedTokens: 512,
      contextBytes: selection.manifest.budget.usedRenderedBytes,
      promptLayerBytes: 1_024,
    }),
    preparedRequestHash: HASH(`upstream-${targetFixture.path}`),
    createdAt: BASE_TIME,
  });
}

class MemoryRepository implements DesktopOperationRepositoryV1 {
  readonly records = new Map<string, DesktopOperationEnvelopeV1>();
  readonly events: string[] = [];

  async create(envelope: DesktopOperationEnvelopeV1): Promise<"created" | "exists"> {
    const id = mapKey(keyFor(envelope));
    if (this.records.has(id)) return "exists";
    this.records.set(id, envelope);
    this.events.push(`create:${envelope.lifecycle.status}:${envelope.attempt.attemptId}`);
    return "created";
  }

  async replace(
    key: DesktopOperationKeyV1,
    expectedEnvelopeSha256: string,
    envelope: DesktopOperationEnvelopeV1,
  ): Promise<"replaced" | "conflict" | "missing"> {
    const id = mapKey(key);
    const current = this.records.get(id);
    if (!current) return "missing";
    if (hashDesktopOperationEnvelopeV1(current) !== expectedEnvelopeSha256) return "conflict";
    this.records.set(id, envelope);
    this.events.push(`replace:${envelope.lifecycle.status}:${envelope.attempt.attemptId}`);
    return "replaced";
  }

  async load(key: DesktopOperationKeyV1): Promise<DesktopOperationEnvelopeV1 | null> {
    return this.records.get(mapKey(key)) ?? null;
  }

  async list(): Promise<readonly DesktopOperationEnvelopeV1[]> {
    return [...this.records.values()];
  }

  async delete(
    key: DesktopOperationKeyV1,
    expectedEnvelopeSha256: string,
  ): Promise<"deleted" | "conflict" | "missing"> {
    const id = mapKey(key);
    const current = this.records.get(id);
    if (!current) return "missing";
    if (hashDesktopOperationEnvelopeV1(current) !== expectedEnvelopeSha256) return "conflict";
    this.records.delete(id);
    this.events.push(`delete:${key.attemptId}`);
    return "deleted";
  }
}

class SequenceIds implements DesktopOperationRuntimeIdsV1 {
  private sequence = 0;

  next(kind: Parameters<DesktopOperationRuntimeIdsV1["next"]>[0]): string {
    this.sequence += 1;
    return `${kind}-${String(this.sequence).padStart(8, "0")}`;
  }
}

class PrefixedIds implements DesktopOperationRuntimeIdsV1 {
  private sequence = 0;

  constructor(private readonly prefix: string) {}

  next(kind: Parameters<DesktopOperationRuntimeIdsV1["next"]>[0]): string {
    this.sequence += 1;
    return `${this.prefix}-${kind}-${String(this.sequence).padStart(8, "0")}`;
  }
}

class MutableClock {
  value = BASE_TIME;

  nowMs(): number {
    return this.value;
  }
}

function runtimeDependencies(input: {
  repository?: MemoryRepository;
  clock?: MutableClock;
  provider?: ProviderConfig;
  readCurrentTarget?: DesktopOperationRuntimeDependenciesV1["readCurrentTarget"];
  completePrepared?: DesktopOperationRuntimeDependenciesV1["completePrepared"];
  applyArtifact?: DesktopArtifactApplierV1;
  presentResult?: DesktopOperationRuntimeDependenciesV1["presentResult"];
  ids?: DesktopOperationRuntimeIdsV1;
} = {}): DesktopOperationRuntimeDependenciesV1 & {
  repository: MemoryRepository;
  clock: MutableClock;
} {
  const repository = input.repository ?? new MemoryRepository();
  const clock = input.clock ?? new MutableClock();
  const providerFixture = input.provider ?? provider();
  return {
    repository,
    clock,
    ids: input.ids ?? new SequenceIds(),
    resolveProvider: (providerId) => providerId === providerFixture.id ? providerFixture : null,
    readCurrentTarget: input.readCurrentTarget
      ?? ((captured) => ({ ...captured, focused: true })),
    completePrepared: input.completePrepared ?? (async () => "continued prose"),
    applyArtifact: input.applyArtifact ?? (async ({ responseText }) => ({
      status: "applied",
      resultingContentHash: HASH(responseText),
    })),
    ...(input.presentResult ? { presentResult: input.presentResult } : {}),
  };
}

async function persist(
  runtime: DesktopOperationRuntimeV1,
  targetFixture = target(),
  providerFixture = provider(),
  overrides: Partial<Parameters<DesktopOperationRuntimeV1["persistApprovedExtend"]>[0]> = {},
): Promise<DesktopOperationEnvelopeV1> {
  return runtime.persistApprovedExtend({
    prepared: await preparedFor(targetFixture, providerFixture),
    provider: providerFixture,
    maxOutputTokens: 1_024,
    ...overrides,
  });
}

async function responseReady(
  runtime: DesktopOperationRuntimeV1,
  targetFixture = target(),
  providerFixture = provider(),
  overrides: Partial<Parameters<DesktopOperationRuntimeV1["persistApprovedExtend"]>[0]> = {},
): Promise<DesktopOperationEnvelopeV1> {
  let envelope = await persist(runtime, targetFixture, providerFixture, overrides);
  const key = keyFor(envelope);
  envelope = await runtime.approve(key);
  return runtime.dispatch(key);
}

async function replaceWithTransition(
  repository: MemoryRepository,
  current: DesktopOperationEnvelopeV1,
  transition: DesktopOperationTransitionV1,
): Promise<DesktopOperationEnvelopeV1> {
  const next = reduceDesktopOperationV1(current, transition).envelope;
  assert.equal(
    await repository.replace(keyFor(current), hashDesktopOperationEnvelopeV1(current), next),
    "replaced",
  );
  return next;
}

function transition<T extends DesktopOperationTransitionV1["type"]>(
  type: T,
  current: DesktopOperationEnvelopeV1,
  extras: Omit<
    Extract<DesktopOperationTransitionV1, { type: T }>,
    "version" | "type" | "transitionId" | "atMs"
  > = {} as never,
): Extract<DesktopOperationTransitionV1, { type: T }> {
  return {
    version: 1,
    type,
    transitionId: `manual-${type}-${current.appliedTransitions.length}`,
    atMs: current.updatedAtMs + 1,
    ...extras,
  } as Extract<DesktopOperationTransitionV1, { type: T }>;
}

test("the real approved-request transport satisfies the reconstructible runtime boundary", () => {
  const transport: DesktopOperationTransportV1 = completePrepared;
  assert.equal(transport, completePrepared);
});

test("factory binds the approved selector, unique user-message placement, and credential-free provider config", async () => {
  const providerFixture = provider();
  const prepared = await preparedFor(target(), providerFixture);
  const envelope = createApprovedDesktopExtendEnvelopeV1({
    prepared,
    provider: providerFixture,
    maxOutputTokens: 1_024,
    operationId: "operation-factory-0001",
    attemptId: "attempt-factory-0001",
    createdAtMs: BASE_TIME,
  });
  const rendered = prepared.traceContextSelection!.renderedContext;
  assert.equal(
    envelope.prepared.messages[envelope.selectedContext.placement.messageIndex]!.content.slice(
      envelope.selectedContext.placement.fromUtf16,
      envelope.selectedContext.placement.toUtf16,
    ),
    rendered,
  );
  assert.equal(envelope.selectedContext.manifestSha256, prepared.traceContextSelection!.manifestSha256);
  assert.equal(
    envelope.prepared.provider.transportConfigSha256,
    desktopCredentialFreeTransportConfigSha256V1(providerFixture),
  );
  assert.equal(
    desktopCredentialFreeTransportConfigSha256V1(providerFixture),
    desktopCredentialFreeTransportConfigSha256V1({
      ...providerFixture,
      credentialRef: "different-secret-slot",
      credentialConfigured: false,
      label: "Renamed",
      preset: "other-preset",
    }),
  );
  assert.throws(
    () => createApprovedDesktopExtendEnvelopeV1({
      prepared,
      provider: { ...providerFixture, modelId: "changed-after-approval" },
      maxOutputTokens: 1_024,
      operationId: "operation-factory-changed",
      attemptId: "attempt-factory-changed",
      createdAtMs: BASE_TIME,
    }),
    /provider configuration changed after request approval/,
  );

  const duplicate = await preparedFor(
    target(),
    providerFixture,
    (context) => `${context}\n${context}`,
  );
  assert.throws(
    () => createApprovedDesktopExtendEnvelopeV1({
      prepared: duplicate,
      provider: providerFixture,
      maxOutputTokens: 1_024,
      operationId: "operation-factory-0002",
      attemptId: "attempt-factory-0002",
      createdAtMs: BASE_TIME,
    }),
    /occur exactly once.*found 2/,
  );
  assert.throws(
    () => createApprovedDesktopExtendEnvelopeV1({
      prepared: { ...prepared, traceContextSelection: undefined },
      provider: providerFixture,
      maxOutputTokens: 1_024,
      operationId: "operation-factory-0003",
      attemptId: "attempt-factory-0003",
      createdAtMs: BASE_TIME,
    }),
    /no exact trace-context selection/,
  );
});

test("happy path persists every boundary before provider and artifact side effects", async () => {
  const events: string[] = [];
  const dependencies = runtimeDependencies({
    completePrepared: async (prepared, cfg, options) => {
      events.push("transport");
      assert.equal(prepared.providerId, cfg.id);
      assert.equal(options.maxTokens, 1_024);
      return "continued prose";
    },
    applyArtifact: async ({ envelope, intent, responseText }) => {
      events.push("apply");
      assert.equal(envelope.lifecycle.status, "accepted");
      assert.equal(intent.responseSha256, envelope.response!.responseSha256);
      assert.equal(responseText, "continued prose");
      return { status: "applied", resultingContentHash: HASH("applied-content") };
    },
    presentResult: () => { events.push("present"); },
  });
  const originalReplace = dependencies.repository.replace.bind(dependencies.repository);
  dependencies.repository.replace = async (...args) => {
    const result = await originalReplace(...args);
    if (result === "replaced") events.push(`persist:${args[2].lifecycle.status}`);
    return result;
  };
  const runtime = new DesktopOperationRuntimeV1(dependencies);
  let envelope = await persist(runtime);
  const key = keyFor(envelope);
  envelope = await runtime.approve(key);
  envelope = await runtime.dispatch(key);
  assert.equal(envelope.lifecycle.status, "response-completed");
  const accepted = await runtime.accept(key);
  assert.equal(accepted.status, "applied");
  assert.equal(accepted.envelope.lifecycle.status, "accepted");
  assert.ok(accepted.envelope.artifactReceipt);
  assert.deepEqual(events, [
    "persist:approved",
    "persist:dispatch-intent",
    "persist:provider-io",
    "transport",
    "persist:response-completed",
    "present",
    "persist:accepted",
    "apply",
    "persist:accepted",
  ]);
});

test("reconstruction handles every durable crash window without replaying provider I/O", async () => {
  const repository = new MemoryRepository();
  const setup = runtimeDependencies({ repository });
  const setupRuntime = new DesktopOperationRuntimeV1(setup);

  const preparedEnvelope = await persist(setupRuntime, target("prepared"), provider(), {
    operationId: "operation-crash-prepared",
    attemptId: "attempt-crash-prepared",
  });
  const approvedEnvelope = await setupRuntime.approve(keyFor(await persist(
    setupRuntime,
    target("approved"),
    provider(),
    { operationId: "operation-crash-approved", attemptId: "attempt-crash-approved" },
  )));
  let dispatchIntent = await setupRuntime.approve(keyFor(await persist(
    setupRuntime,
    target("intent"),
    provider(),
    { operationId: "operation-crash-intent", attemptId: "attempt-crash-intent" },
  )));
  dispatchIntent = await replaceWithTransition(
    repository,
    dispatchIntent,
    transition("record-dispatch-intent", dispatchIntent),
  );
  let providerIo = await setupRuntime.approve(keyFor(await persist(
    setupRuntime,
    target("provider-io"),
    provider(),
    { operationId: "operation-crash-provider", attemptId: "attempt-crash-provider" },
  )));
  providerIo = await replaceWithTransition(
    repository,
    providerIo,
    transition("record-dispatch-intent", providerIo),
  );
  providerIo = await replaceWithTransition(
    repository,
    providerIo,
    transition("record-provider-io-may-have-started", providerIo),
  );
  // Give each recovery state a distinct durable attempt.
  const responseBase = await setupRuntime.approve(keyFor(await persist(
    setupRuntime,
    target("response"),
    provider(),
    { operationId: "operation-crash-response", attemptId: "attempt-crash-response" },
  )));
  let responseIntent = await replaceWithTransition(
    repository,
    responseBase,
    transition("record-dispatch-intent", responseBase),
  );
  responseIntent = await replaceWithTransition(
    repository,
    responseIntent,
    transition("record-provider-io-may-have-started", responseIntent),
  );
  const recordedResponse = await replaceWithTransition(
    repository,
    responseIntent,
    transition("record-response", responseIntent, { responseText: "recorded result" }),
  );
  let accepted = await replaceWithTransition(
    repository,
    recordedResponse,
    transition("accept-result", recordedResponse, { artifactIntentId: "intent-crash-accepted" }),
  );
  // Keep response-completed and accepted as distinct records.
  const acceptedBase = accepted;
  const responseCopy = await responseReady(
    setupRuntime,
    target("response-only"),
    provider(),
    { operationId: "operation-crash-response-only", attemptId: "attempt-crash-response-only" },
  );
  assert.equal(responseCopy.lifecycle.status, "response-completed");

  let transportCalls = 0;
  const presentations: string[] = [];
  let applyCalls = 0;
  const recoveredRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    completePrepared: async () => {
      transportCalls += 1;
      return "resumed result";
    },
    presentResult: (envelope) => { presentations.push(envelope.attempt.attemptId); },
    applyArtifact: async () => {
      applyCalls += 1;
      return { status: "applied", resultingContentHash: HASH("recovered-apply") };
    },
  }));
  const recovery = await recoveredRuntime.recover();
  assert.equal(
    recovery.failures.length,
    0,
    recovery.failures.map(({ key, error }) => `${key.attemptId}: ${String(error)}`).join("\n"),
  );
  assert.equal((await recoveredRuntime.load(keyFor(preparedEnvelope)))!.lifecycle.status, "prepared");
  assert.equal((await recoveredRuntime.load(keyFor(approvedEnvelope)))!.lifecycle.status, "approved");
  assert.equal((await recoveredRuntime.load(keyFor(dispatchIntent)))!.lifecycle.status, "response-completed");
  assert.equal((await recoveredRuntime.load(keyFor(providerIo)))!.lifecycle.status, "unknown");
  assert.equal((await recoveredRuntime.load(keyFor(acceptedBase)))!.artifactReceipt !== null, true);
  assert.equal(transportCalls, 1, "only the pre-I/O dispatch handshake may resume");
  assert.equal(applyCalls, 1);
  assert.ok(presentations.includes(responseCopy.attempt.attemptId));
});

test("typed completed failures remain typed while abort and generic transport ambiguity become unknown", async () => {
  async function dispatchWith(
    completePrepared: DesktopOperationRuntimeDependenciesV1["completePrepared"],
    suffix: string,
    signal?: AbortSignal,
  ) {
    const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({ completePrepared }));
    const approved = await runtime.approve(keyFor(await persist(
      runtime,
      target(suffix),
      provider(),
      { operationId: `operation-${suffix}-0001`, attemptId: `attempt-${suffix}-0001` },
    )));
    return runtime.dispatch(keyFor(approved), { signal });
  }

  const rejected = await dispatchWith(async () => {
    throw new DesktopOperationTransportFailureV1({
      code: "PROVIDER_REJECTED",
      certainty: "provider-completed-without-result",
    });
  }, "typed-failure");
  assert.equal(rejected.lifecycle.status, "failed");
  assert.equal(rejected.lifecycle.executionCertainty, "provider-completed-without-result");
  assert.equal(rejected.fault!.code, "PROVIDER_REJECTED");

  const generic = await dispatchWith(async () => {
    throw new Error("provider-specific prose that must not be parsed");
  }, "generic-failure");
  assert.equal(generic.lifecycle.status, "unknown");
  assert.equal(generic.fault!.code, "DISPATCH_OUTCOME_UNKNOWN");
  assert.doesNotMatch(JSON.stringify(generic.fault), /provider-specific prose/);

  const controller = new AbortController();
  let entered!: () => void;
  const didEnter = new Promise<void>((resolve) => { entered = resolve; });
  const abortPromise = dispatchWith(async (_prepared, _provider, options) => {
    entered();
    await new Promise<void>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
    return "unreachable";
  }, "abort-ambiguous", controller.signal);
  await didEnter;
  controller.abort();
  const aborted = await abortPromise;
  assert.equal(aborted.lifecycle.status, "unknown");

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  let preAbortTransportCalls = 0;
  const cancelled = await dispatchWith(async () => {
    preAbortTransportCalls += 1;
    return "unreachable";
  }, "abort-before-io", alreadyAborted.signal);
  assert.equal(cancelled.lifecycle.status, "cancelled");
  assert.equal(preAbortTransportCalls, 0);
});

test("changed provider configuration fails before the durable provider-I/O boundary", async () => {
  const approvedProvider = provider();
  const changedProvider = { ...approvedProvider, baseUrl: "https://changed.invalid/v1" };
  const repository = new MemoryRepository();
  const setupRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    provider: approvedProvider,
  }));
  const approved = await setupRuntime.approve(keyFor(await persist(
    setupRuntime,
    target("provider-change"),
    approvedProvider,
  )));
  let transportCalls = 0;
  const dispatchRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    provider: changedProvider,
    completePrepared: async () => {
      transportCalls += 1;
      return "must not dispatch";
    },
  }));
  const failed = await dispatchRuntime.dispatch(keyFor(approved));
  assert.equal(failed.lifecycle.status, "failed");
  assert.equal(failed.lifecycle.executionCertainty, "known-not-dispatched");
  assert.equal(failed.fault!.code, "APPROVAL_INVALID");
  assert.equal(transportCalls, 0);
  assert.equal(
    failed.appliedTransitions.some(({ transitionType }) => (
      transitionType === "record-provider-io-may-have-started"
    )),
    false,
  );
});

test("provider-io and unknown recovery never silently redispatch", async () => {
  const repository = new MemoryRepository();
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({ repository }));
  let current = await runtime.approve(keyFor(await persist(runtime, target("no-redispatch"), provider())));
  current = await replaceWithTransition(
    repository,
    current,
    transition("record-dispatch-intent", current),
  );
  current = await replaceWithTransition(
    repository,
    current,
    transition("record-provider-io-may-have-started", current),
  );
  let calls = 0;
  const recovering = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    completePrepared: async () => {
      calls += 1;
      return "must not happen";
    },
  }));
  await recovering.recover();
  assert.equal((await recovering.load(keyFor(current)))!.lifecycle.status, "unknown");
  await recovering.recover();
  assert.equal(calls, 0);
});

test("apply-before-receipt crash is recovered through an idempotent artifact applier", async () => {
  const repository = new MemoryRepository();
  let applied = false;
  let calls = 0;
  const applyArtifact: DesktopArtifactApplierV1 = async ({ responseText }) => {
    calls += 1;
    if (!applied) {
      applied = true;
      throw new Error("simulated process death after atomic apply");
    }
    return { status: "already-applied", resultingContentHash: HASH(responseText) };
  };
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({ repository, applyArtifact }));
  const ready = await responseReady(runtime, target("apply-crash"));
  await assert.rejects(() => runtime.accept(keyFor(ready)), /simulated process death/);
  const afterCrash = await runtime.load(keyFor(ready));
  assert.equal(afterCrash!.lifecycle.status, "accepted");
  assert.equal(afterCrash!.artifactReceipt, null);

  const reconstructed = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    applyArtifact,
  }));
  const recovery = await reconstructed.recover();
  assert.equal(recovery.failures.length, 0);
  const recovered = await reconstructed.load(keyFor(ready));
  assert.ok(recovered!.artifactReceipt);
  assert.equal(calls, 2);
});

test("two runtimes converge on one idempotent application and one durable receipt", async () => {
  const repository = new MemoryRepository();
  const setup = new DesktopOperationRuntimeV1(runtimeDependencies({ repository }));
  const ready = await responseReady(setup, target("cross-runtime-receipt"));
  const accepted = await replaceWithTransition(
    repository,
    ready,
    transition("accept-result", ready, { artifactIntentId: "intent-cross-runtime-receipt" }),
  );
  let calls = 0;
  let mutations = 0;
  let bothEntered!: () => void;
  const didBothEnter = new Promise<void>((resolve) => { bothEntered = resolve; });
  let releaseBoth!: () => void;
  const holdBoth = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const appliedIntents = new Map<string, string>();
  const applyArtifact: DesktopArtifactApplierV1 = async ({ intent, responseText }) => {
    calls += 1;
    const priorHash = appliedIntents.get(intent.intentId);
    const resultingContentHash = priorHash ?? HASH(responseText);
    if (!priorHash) {
      mutations += 1;
      appliedIntents.set(intent.intentId, resultingContentHash);
    }
    if (calls === 2) bothEntered();
    await holdBoth;
    return {
      status: priorHash ? "already-applied" : "applied",
      resultingContentHash,
    };
  };
  const first = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    applyArtifact,
    ids: new PrefixedIds("runtime-a"),
  }));
  const second = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    applyArtifact,
    ids: new PrefixedIds("runtime-b"),
  }));

  const applying = Promise.all([
    first.accept(keyFor(accepted)),
    second.accept(keyFor(accepted)),
  ]);
  await didBothEnter;
  releaseBoth();
  const results = await applying;

  assert.equal(calls, 2, "both runtime processes may enter the idempotent adapter");
  assert.equal(mutations, 1, "the durable intent marker permits only one target mutation");
  assert.ok(results.every(({ envelope }) => envelope.artifactReceipt));
  assert.ok(results.some(({ status }) => status === "already-applied"));
  const stored = await first.load(keyFor(accepted));
  assert.ok(stored!.artifactReceipt);
  assert.equal(stored!.artifactReceipt!.resultingContentHash, HASH(accepted.response!.text));
});

test("accept rechecks the target before persisting intent and records review-stage staleness", async () => {
  const repository = new MemoryRepository();
  let applyCalls = 0;
  const presentations: Array<{ status: string; reason: string }> = [];
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    readCurrentTarget: (captured) => ({
      ...captured,
      contentHash: HASH("changed-before-accept"),
      focused: true,
    }),
    applyArtifact: async () => {
      applyCalls += 1;
      return { status: "applied", resultingContentHash: HASH("must-not-apply") };
    },
    presentResult: (envelope, reason) => {
      presentations.push({ status: envelope.lifecycle.status, reason });
    },
  }));
  const ready = await responseReady(runtime, target("stale-before-accept"));

  const result = await runtime.accept(keyFor(ready));

  assert.equal(result.status, "stale");
  assert.equal(result.envelope.lifecycle.status, "stale");
  assert.equal(result.envelope.fault!.code, "TARGET_STALE");
  assert.equal(result.envelope.fault!.stage, "review");
  assert.equal(result.envelope.artifactIntent, null);
  assert.equal(applyCalls, 0);
  assert.deepEqual(presentations.at(-1), { status: "stale", reason: "stale-target" });
});

test("same-target acceptance serializes recheck through apply so the loser is review-stale", async () => {
  const repository = new MemoryRepository();
  const sharedTarget = target("serialized-accept-window");
  let liveContentHash = sharedTarget.contentHash;
  let applyCalls = 0;
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    readCurrentTarget: (captured) => ({
      ...captured,
      contentHash: liveContentHash,
      focused: true,
    }),
    applyArtifact: async ({ responseText }) => {
      applyCalls += 1;
      liveContentHash = HASH(responseText);
      return { status: "applied", resultingContentHash: liveContentHash };
    },
  }));
  const first = await responseReady(runtime, sharedTarget, provider(), {
    operationId: "operation-serialized-accept-a",
    attemptId: "attempt-serialized-accept-a",
  });
  const second = await responseReady(runtime, sharedTarget, provider(), {
    operationId: "operation-serialized-accept-b",
    attemptId: "attempt-serialized-accept-b",
  });

  const results = await Promise.all([
    runtime.accept(keyFor(first)),
    runtime.accept(keyFor(second)),
  ]);

  assert.deepEqual(results.map(({ status }) => status).sort(), ["applied", "stale"]);
  const stale = results.find(({ status }) => status === "stale")!.envelope;
  assert.equal(stale.fault!.stage, "review");
  assert.equal(stale.artifactIntent, null);
  assert.equal(applyCalls, 1);
});

test("a stale compare-and-set becomes a durable reviewable state and never reapplies on recovery", async () => {
  const repository = new MemoryRepository();
  let applyCalls = 0;
  const presentations: Array<{ status: string; reason: string }> = [];
  const dependencies = runtimeDependencies({
    repository,
    applyArtifact: async () => {
      applyCalls += 1;
      return { status: "stale" };
    },
    presentResult: (envelope, reason) => {
      presentations.push({ status: envelope.lifecycle.status, reason });
    },
  });
  const runtime = new DesktopOperationRuntimeV1(dependencies);
  const ready = await responseReady(runtime, target("stale-cas"));
  const accepted = await runtime.accept(keyFor(ready));
  assert.equal(accepted.status, "stale");
  assert.equal(accepted.envelope.lifecycle.status, "stale");
  assert.equal(accepted.envelope.fault!.code, "TARGET_STALE");
  assert.equal(accepted.envelope.fault!.stage, "apply");
  assert.equal(accepted.envelope.artifactIntent, null);
  assert.equal(accepted.envelope.artifactReceipt, null);
  await assert.rejects(() => runtime.accept(keyFor(ready)), /accept is illegal from stale/);

  const reconstructed = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    applyArtifact: dependencies.applyArtifact,
    presentResult: dependencies.presentResult,
  }));
  const recovery = await reconstructed.recover();
  assert.equal(recovery.failures.length, 0);
  assert.equal(applyCalls, 1, "stale recovery must not retry the artifact mutation");
  assert.deepEqual(presentations.at(-1), { status: "stale", reason: "recovery" });
  const retry = await reconstructed.retry(keyFor(ready), {
    attemptId: "attempt-stale-safe-retry",
  });
  assert.equal(retry.attempt.retryOfAttemptId, ready.attempt.attemptId);
  assert.equal(retry.attempt.possibleDuplicateAcknowledgedAtMs, null);
});

test("linked retry requires acknowledgement only when the prior dispatch is ambiguous", async () => {
  const repository = new MemoryRepository();
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    completePrepared: async () => { throw new Error("ambiguous"); },
  }));
  const unknown = await responseOrFailure(runtime, "ambiguous-retry");
  assert.equal(unknown.lifecycle.status, "unknown");
  await assert.rejects(
    () => runtime.retry(keyFor(unknown), { attemptId: "attempt-retry-no-ack" }),
    /explicit operator confirmation/,
  );
  const retry = await runtime.retry(keyFor(unknown), {
    attemptId: "attempt-retry-with-ack",
    possibleDuplicateAcknowledged: true,
  });
  assert.equal(retry.operationId, unknown.operationId);
  assert.equal(retry.attempt.retryOfAttemptId, unknown.attempt.attemptId);
  assert.equal(retry.attempt.possibleDuplicateAcknowledgedAtMs, retry.attempt.createdAtMs);
  const abandoned = await runtime.abandon(keyFor(unknown));
  assert.equal(abandoned.lifecycle.status, "abandoned");
  assert.equal(abandoned.lifecycle.executionCertainty, "may-have-dispatched");
  assert.equal(abandoned.fault!.code, "DISPATCH_OUTCOME_UNKNOWN");
  await assert.rejects(
    () => runtime.retry(keyFor(abandoned), { attemptId: "attempt-after-abandon" }),
    /abandoned is not retryable/,
  );

  const safeRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({ repository }));
  const prepared = await persist(
    safeRuntime,
    target("safe-retry"),
    provider(),
    { operationId: "operation-safe-retry", attemptId: "attempt-safe-retry" },
  );
  const cancelled = await safeRuntime.cancel(keyFor(prepared));
  await assert.rejects(
    () => safeRuntime.retry(keyFor(cancelled), {
      attemptId: "attempt-safe-retry-ack",
      possibleDuplicateAcknowledged: true,
    }),
    /allowed only for an ambiguous attempt/,
  );
  const safeRetry = await safeRuntime.retry(keyFor(cancelled), {
    attemptId: "attempt-safe-retry-new",
  });
  assert.equal(safeRetry.attempt.possibleDuplicateAcknowledgedAtMs, null);

  const rejectedReady = await responseReady(
    safeRuntime,
    target("rejected-retry"),
    provider(),
    { operationId: "operation-rejected-retry", attemptId: "attempt-rejected-retry" },
  );
  const rejected = await safeRuntime.reject(keyFor(rejectedReady));
  assert.equal(rejected.lifecycle.retryPolicy, "safe-new-attempt");
  const rejectedRetry = await safeRuntime.retry(keyFor(rejected), {
    attemptId: "attempt-rejected-retry-new",
  });
  assert.equal(rejectedRetry.attempt.retryOfAttemptId, rejected.attempt.attemptId);
  assert.equal(rejectedRetry.attempt.possibleDuplicateAcknowledgedAtMs, null);
});

test("recovery deletes every expired envelope before any surviving side effect", async () => {
  const repository = new MemoryRepository();
  const clock = new MutableClock();
  const setup = new DesktopOperationRuntimeV1(runtimeDependencies({ repository, clock }));
  let expired = await persist(setup, target("expired"), provider(), {
    operationId: "operation-expired-0001",
    attemptId: "attempt-expired-0001",
    retainForMs: 5,
  });
  expired = await setup.approve(keyFor(expired));
  expired = await replaceWithTransition(
    repository,
    expired,
    transition("record-dispatch-intent", expired),
  );
  const live = await responseReady(setup, target("live"), provider(), {
    operationId: "operation-live-0001",
    attemptId: "attempt-live-0001",
    retainForMs: 100,
  });
  repository.events.length = 0;
  clock.value = BASE_TIME + 10;
  const events = repository.events;
  let transportCalls = 0;
  const recovering = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository,
    clock,
    completePrepared: async () => {
      transportCalls += 1;
      events.push("transport");
      return "must not dispatch expired";
    },
    presentResult: () => { events.push("present"); },
  }));
  const result = await recovering.recover();
  assert.equal(await recovering.load(keyFor(expired)), null);
  assert.ok(await recovering.load(keyFor(live)));
  assert.equal(transportCalls, 0);
  assert.deepEqual(result.deleted, [keyFor(expired)]);
  assert.equal(events[0], `delete:${expired.attempt.attemptId}`);
  assert.ok(events.indexOf("present") > events.indexOf(`delete:${expired.attempt.attemptId}`));
});

test("privacy deadlines delete and block direct dispatch and acceptance", async () => {
  const dispatchRepository = new MemoryRepository();
  const dispatchClock = new MutableClock();
  let transportCalls = 0;
  const dispatchRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository: dispatchRepository,
    clock: dispatchClock,
    completePrepared: async () => {
      transportCalls += 1;
      return "must not dispatch";
    },
  }));
  let approved = await persist(dispatchRuntime, target("expired-direct-dispatch"), provider(), {
    operationId: "operation-expired-direct-dispatch",
    attemptId: "attempt-expired-direct-dispatch",
    retainForMs: 5,
  });
  approved = await dispatchRuntime.approve(keyFor(approved));
  dispatchClock.value = BASE_TIME + 5;
  await assert.rejects(
    () => dispatchRuntime.dispatch(keyFor(approved)),
    /privacy deadline.*deleted/,
  );
  assert.equal(transportCalls, 0);
  assert.equal(await dispatchRuntime.load(keyFor(approved)), null);

  const acceptRepository = new MemoryRepository();
  const acceptClock = new MutableClock();
  let applyCalls = 0;
  const acceptRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository: acceptRepository,
    clock: acceptClock,
    applyArtifact: async () => {
      applyCalls += 1;
      return { status: "applied", resultingContentHash: HASH("must-not-apply") };
    },
  }));
  const ready = await responseReady(acceptRuntime, target("expired-direct-accept"), provider(), {
    operationId: "operation-expired-direct-accept",
    attemptId: "attempt-expired-direct-accept",
    retainForMs: 5,
  });
  acceptClock.value = BASE_TIME + 5;
  await assert.rejects(
    () => acceptRuntime.accept(keyFor(ready)),
    /privacy deadline.*deleted/,
  );
  assert.equal(applyCalls, 0);
  assert.equal(await acceptRuntime.load(keyFor(ready)), null);
});

test("recovery refreshes the deadline immediately before a resumed side effect", async () => {
  const repository = new MemoryRepository();
  const setup = new DesktopOperationRuntimeV1(runtimeDependencies({ repository }));
  let pending = await persist(setup, target("expires-during-recovery"), provider(), {
    operationId: "operation-expires-during-recovery",
    attemptId: "attempt-expires-during-recovery",
    retainForMs: 5,
  });
  pending = await setup.approve(keyFor(pending));
  pending = await replaceWithTransition(
    repository,
    pending,
    transition("record-dispatch-intent", pending),
  );
  let clockReads = 0;
  const advancingClock = {
    nowMs: () => {
      clockReads += 1;
      return clockReads === 1 ? BASE_TIME + 4 : BASE_TIME + 5;
    },
  };
  let transportCalls = 0;
  const recovering = new DesktopOperationRuntimeV1({
    ...runtimeDependencies({ repository }),
    clock: advancingClock,
    completePrepared: async () => {
      transportCalls += 1;
      return "must not resume";
    },
  });

  const result = await recovering.recover();

  assert.equal(transportCalls, 0);
  assert.equal(await recovering.load(keyFor(pending)), null);
  assert.deepEqual(result.deleted, [keyFor(pending)]);
});

test("expiry deletion uses envelope CAS and never deletes a newer record at the same key", async () => {
  const repository = new MemoryRepository();
  const clock = new MutableClock();
  const setup = new DesktopOperationRuntimeV1(runtimeDependencies({ repository, clock }));
  const expired = await persist(setup, target("expiry-delete-cas"), provider(), {
    operationId: "operation-expiry-delete-cas",
    attemptId: "attempt-expiry-delete-cas",
    retainForMs: 5,
  });
  const providerFixture = provider();
  const replacement = createApprovedDesktopExtendEnvelopeV1({
    prepared: await preparedFor(target("expiry-delete-cas"), providerFixture),
    provider: providerFixture,
    maxOutputTokens: 1_024,
    operationId: expired.operationId,
    attemptId: expired.attempt.attemptId,
    createdAtMs: BASE_TIME + 4,
    retainForMs: 100,
  });
  const originalDelete = repository.delete.bind(repository);
  let injected = false;
  repository.delete = async (key, expectedHash) => {
    if (!injected) {
      injected = true;
      repository.records.set(mapKey(key), replacement);
    }
    return originalDelete(key, expectedHash);
  };
  clock.value = BASE_TIME + 5;
  const recovering = new DesktopOperationRuntimeV1(runtimeDependencies({ repository, clock }));

  const result = await recovering.recover();

  assert.deepEqual(result.deleted, []);
  assert.equal(
    hashDesktopOperationEnvelopeV1((await recovering.load(keyFor(expired)))!),
    hashDesktopOperationEnvelopeV1(replacement),
  );
});

test("stable transition ids replay idempotently and reject different bytes", async () => {
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies());
  const prepared = await persist(runtime, target("transition-replay"));
  const key = keyFor(prepared);
  const command = { transitionId: "transition-stable-0001", atMs: BASE_TIME + 1 };
  const approved = await runtime.approve(key, command);
  const replayed = await runtime.approve(key, command);
  assert.equal(hashDesktopOperationEnvelopeV1(replayed), hashDesktopOperationEnvelopeV1(approved));
  await assert.rejects(
    () => runtime.approve(key, { ...command, atMs: BASE_TIME + 2 }),
    /reused with different bytes/,
  );
});

test("an optimistic-CAS conflict converges when another writer stored the same transition", async () => {
  const repository = new MemoryRepository();
  const runtime = new DesktopOperationRuntimeV1(runtimeDependencies({ repository }));
  const prepared = await persist(runtime, target("cas-replay"));
  const key = keyFor(prepared);
  const command = { transitionId: "transition-cas-replay", atMs: BASE_TIME + 1 };
  const originalReplace = repository.replace.bind(repository);
  let injected = false;
  repository.replace = async (replaceKey, expectedHash, next) => {
    if (!injected) {
      injected = true;
      const current = await repository.load(replaceKey);
      assert.ok(current);
      const concurrent = reduceDesktopOperationV1(current, {
        version: 1,
        type: "approve",
        ...command,
      }).envelope;
      assert.equal(
        await originalReplace(replaceKey, expectedHash, concurrent),
        "replaced",
      );
      return "conflict";
    }
    return originalReplace(replaceKey, expectedHash, next);
  };
  const approved = await runtime.approve(key, command);
  assert.equal(approved.lifecycle.status, "approved");
  assert.equal(approved.appliedTransitions.length, 1);
  assert.equal(approved.appliedTransitions[0]!.transitionId, command.transitionId);
});

test("artifact mutations serialize per target while distinct targets proceed concurrently", async () => {
  const sameRepository = new MemoryRepository();
  let sameCalls = 0;
  let firstEntered!: () => void;
  const firstDidEnter = new Promise<void>((resolve) => { firstEntered = resolve; });
  let releaseFirst!: () => void;
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const sameRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository: sameRepository,
    applyArtifact: async ({ responseText }) => {
      sameCalls += 1;
      if (sameCalls === 1) {
        firstEntered();
        await holdFirst;
      }
      return { status: "applied", resultingContentHash: HASH(responseText) };
    },
  }));
  const sharedTarget = target("shared-target");
  const sameA = await responseReady(sameRuntime, sharedTarget, provider(), {
    operationId: "operation-shared-a",
    attemptId: "attempt-shared-a",
  });
  const sameB = await responseReady(sameRuntime, sharedTarget, provider(), {
    operationId: "operation-shared-b",
    attemptId: "attempt-shared-b",
  });
  const acceptingA = sameRuntime.accept(keyFor(sameA));
  const acceptingB = sameRuntime.accept(keyFor(sameB));
  await firstDidEnter;
  await Promise.resolve();
  assert.equal(sameCalls, 1, "the second same-target apply must wait");
  releaseFirst();
  await Promise.all([acceptingA, acceptingB]);
  assert.equal(sameCalls, 2);

  const distinctRepository = new MemoryRepository();
  let distinctCalls = 0;
  let bothEntered!: () => void;
  const bothDidEnter = new Promise<void>((resolve) => { bothEntered = resolve; });
  let releaseBoth!: () => void;
  const holdBoth = new Promise<void>((resolve) => { releaseBoth = resolve; });
  const distinctRuntime = new DesktopOperationRuntimeV1(runtimeDependencies({
    repository: distinctRepository,
    applyArtifact: async ({ responseText }) => {
      distinctCalls += 1;
      if (distinctCalls === 2) bothEntered();
      await holdBoth;
      return { status: "applied", resultingContentHash: HASH(responseText) };
    },
  }));
  const differentA = await responseReady(distinctRuntime, target("different-a"), provider(), {
    operationId: "operation-different-a",
    attemptId: "attempt-different-a",
  });
  const differentB = await responseReady(distinctRuntime, target("different-b"), provider(), {
    operationId: "operation-different-b",
    attemptId: "attempt-different-b",
  });
  const acceptingDifferentA = distinctRuntime.accept(keyFor(differentA));
  const acceptingDifferentB = distinctRuntime.accept(keyFor(differentB));
  await bothDidEnter;
  assert.equal(distinctCalls, 2, "different targets should enter apply concurrently");
  releaseBoth();
  await Promise.all([acceptingDifferentA, acceptingDifferentB]);
});

async function responseOrFailure(
  runtime: DesktopOperationRuntimeV1,
  suffix: string,
): Promise<DesktopOperationEnvelopeV1> {
  let envelope = await persist(runtime, target(suffix), provider(), {
    operationId: `operation-${suffix}-0001`,
    attemptId: `attempt-${suffix}-0001`,
  });
  envelope = await runtime.approve(keyFor(envelope));
  return runtime.dispatch(keyFor(envelope));
}

function keyFor(envelope: DesktopOperationEnvelopeV1): DesktopOperationKeyV1 {
  return {
    operationId: envelope.operationId,
    attemptId: envelope.attempt.attemptId,
  };
}

function mapKey(key: DesktopOperationKeyV1): string {
  return `${key.operationId}\0${key.attemptId}`;
}
