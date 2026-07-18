import assert from "node:assert/strict";
import test from "node:test";

import {
  selectTraceContextV1,
  type TraceContextSelectionSuccessV1,
} from "@zine/trace-context";

import { contentFingerprint, createContextSnapshot } from "./context-snapshot.js";
import {
  DESKTOP_OPERATION_MAX_RESPONSE_BYTES,
  DesktopOperationEnvelopeError,
  canonicalJsonV1,
  createDesktopOperationEnvelopeV1,
  hashCanonicalV1,
  hashDesktopOperationEnvelopeV1,
  hashTextV1,
  parseDesktopOperationEnvelopeV1,
  serializeDesktopOperationEnvelopeV1,
  type DesktopOperationEnvelopeV1,
  type OperationFaultV1,
} from "./desktop-operation-envelope.js";
import {
  DesktopOperationTransitionError,
  createDesktopOperationRetryV1,
  projectDesktopOperationRecoveryV1,
  reduceDesktopOperationV1,
  type DesktopOperationTransitionV1,
} from "./desktop-operation-lifecycle.js";
import {
  computePreparedOperationRequestHashV1,
  prepareOperation,
  type PreparedOperation,
} from "./prepared-operation.js";
import type { ProviderConfig } from "./models-store.js";
import { compileTraceAuthoringOperation } from "./trace-authoring-adapter.js";

const TARGET_TEXT = "draft";
const BASE_TIME = 1_000;
const HASH = (label: string) => contentFingerprint(label);
const FOLDER_ID = HASH("folder-1");
const TRACE_ID = HASH("trace-1");
const HEAD_ID = HASH("head-1");
const CONTENT_HASH = HASH(TARGET_TEXT);
let selectionPromise: Promise<TraceContextSelectionSuccessV1> | null = null;
let evidenceSelectionPromise: Promise<TraceContextSelectionSuccessV1> | null = null;

async function selection(): Promise<TraceContextSelectionSuccessV1> {
  selectionPromise ??= selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID,
        headId: HEAD_ID,
        contentHash: CONTENT_HASH,
        currentText: TARGET_TEXT,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: TARGET_TEXT.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  }).then((result) => {
    assert.equal(result.ok, true);
    return result as TraceContextSelectionSuccessV1;
  });
  const result = await selectionPromise;
  assert.equal(result.ok, true);
  return result;
}

async function evidenceSelection(): Promise<TraceContextSelectionSuccessV1> {
  evidenceSelectionPromise ??= selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID,
        headId: HEAD_ID,
        contentHash: CONTENT_HASH,
        currentText: TARGET_TEXT,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: TARGET_TEXT.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [
      {
        version: 1,
        id: "instruction-evidence",
        dedupeKey: "instruction-evidence",
        kind: "operation-instruction",
        claimClass: "explicit",
        source: { kind: "operation", ref: "operation:extend" },
        reasons: ["explicit-operation-intent"],
        text: "Continue from the selected source.",
      },
      {
        version: 1,
        id: "citation-evidence",
        dedupeKey: "citation-evidence",
        kind: "citation",
        claimClass: "explicit",
        source: {
          kind: "citation", ref: "citation:1", nodeId: HASH("citation-node"),
          approvedOrder: 0, processStatus: "full-trace",
        },
        reasons: ["approved-direct-citation"],
        text: "Quoted source.",
      },
    ],
  }).then((result) => {
    if (!result.ok) assert.fail(result.error.message);
    return result;
  });
  return evidenceSelectionPromise;
}

function prepared(renderedContext: string): PreparedOperation {
  const operationInputs = Object.freeze({
    seed: TARGET_TEXT,
    hasSelection: false,
    rangeFrom: TARGET_TEXT.length,
    rangeTo: TARGET_TEXT.length,
    sourceFrom: 0,
    sourceTo: TARGET_TEXT.length,
  });
  const messages = Object.freeze([
    { role: "system" as const, content: "Continue the document." },
    { role: "user" as const, content: renderedContext },
  ]);
  const targetRevision = {
    folderId: FOLDER_ID,
    path: "draft.md",
    traceId: TRACE_ID,
    headId: HEAD_ID,
    contentHash: CONTENT_HASH,
  };
  const dependencyFingerprint = HASH("dependency");
  const requestId = "request-0001";
  const createdAt = BASE_TIME;
  const traceAuthoring = compileTraceAuthoringOperation({
    operation: "extend",
    operationInputs,
    targetText: TARGET_TEXT,
    renderedContextBlock: renderedContext,
    actingAuthorId: "",
    authoritySpans: [],
    sourceRevision: {
      traceId: TRACE_ID,
      headId: HEAD_ID,
      path: "draft.md",
      contentHash: CONTENT_HASH,
    },
  }).authoring!;
  const preparedRequestHash = computePreparedOperationRequestHashV1({
    requestId,
    operation: "extend",
    operationInputs,
    messages,
    traceAuthoring,
    providerFingerprint: HASH("provider"),
    targetRevision,
    dependencyFingerprint,
    createdAt,
  });
  return Object.freeze({
    version: 1,
    requestId,
    operation: "extend",
    operationInputs,
    contextSnapshot: {} as PreparedOperation["contextSnapshot"],
    contextFingerprint: HASH("context"),
    traceAuthoring,
    messages,
    providerId: "provider-0001",
    providerFingerprint: HASH("provider"),
    targetRevision,
    provenance: Object.freeze({
      modelVoicePubkey: "a".repeat(64),
      lensId: "default" as const,
      voicePromptHash: HASH("voice"),
      dependencyFingerprint,
    }),
    budget: Object.freeze({
      maxBytes: 32_768,
      totalBytes: 2_048,
      estimatedTokens: 512,
      contextBytes: 1_024,
      promptLayerBytes: 1_024,
    }),
    preparedRequestHash,
    createdAt,
  });
}

function withRecomputedPreparedRequestHash(
  value: PreparedOperation,
): PreparedOperation {
  return {
    ...value,
    preparedRequestHash: computePreparedOperationRequestHashV1({
      requestId: value.requestId,
      operation: value.operation,
      operationInputs: value.operationInputs,
      messages: value.messages,
      traceAuthoring: value.traceAuthoring,
      providerFingerprint: value.providerFingerprint,
      targetRevision: value.targetRevision,
      dependencyFingerprint: value.provenance.dependencyFingerprint,
      createdAt: value.createdAt,
    }),
  };
}

async function envelope(suffix = "0001"): Promise<DesktopOperationEnvelopeV1> {
  const selected = await selection();
  return createDesktopOperationEnvelopeV1({
    operationId: `operation-${suffix}`,
    attemptId: `attempt-${suffix}`,
    prepared: prepared(selected.renderedContext),
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("redacted-transport-config"),
    },
    selectedContext: withPlacement(selected),
    maxOutputTokens: 1_024,
    createdAtMs: BASE_TIME,
    retainForMs: 60_000,
  });
}

function withPlacement(selected: TraceContextSelectionSuccessV1) {
  return {
    ...selected,
    placement: {
      messageIndex: 1,
      fromUtf16: 0,
      toUtf16: selected.renderedContext.length,
    },
  };
}

function fault(
  code: OperationFaultV1["code"] = "PROVIDER_UNAVAILABLE",
  observedAtMs = BASE_TIME + 10,
): OperationFaultV1 {
  return {
    version: 1,
    code,
    stage: "dispatch",
    observedAtMs,
    diagnosticRef: `diag:${"d".repeat(64)}`,
  };
}

function transition<T extends DesktopOperationTransitionV1["type"]>(
  type: T,
  atMs: number,
  extras: Omit<Extract<DesktopOperationTransitionV1, { type: T }>, "version" | "type" | "transitionId" | "atMs">,
): Extract<DesktopOperationTransitionV1, { type: T }> {
  return {
    version: 1,
    type,
    transitionId: `transition-${type}-${atMs}`,
    atMs,
    ...extras,
  } as Extract<DesktopOperationTransitionV1, { type: T }>;
}

function apply(
  current: DesktopOperationEnvelopeV1,
  action: DesktopOperationTransitionV1,
): DesktopOperationEnvelopeV1 {
  return reduceDesktopOperationV1(current, action).envelope;
}

async function atStatus(
  status: DesktopOperationEnvelopeV1["lifecycle"]["status"],
): Promise<DesktopOperationEnvelopeV1> {
  let current = await envelope(status.replace(/[^a-z]/g, "0").padEnd(8, "0"));
  let at = BASE_TIME + 1;
  const run = (action: DesktopOperationTransitionV1) => {
    current = apply(current, action);
    at += 1;
  };
  if (status === "prepared") return current;
  if (status === "cancelled") {
    run(transition("cancel", at, {}));
    return current;
  }
  if (status === "abandoned") {
    run(transition("abandon", at, {}));
    return current;
  }
  run(transition("approve", at, {}));
  if (status === "approved") return current;
  run(transition("record-dispatch-intent", at, {}));
  if (status === "dispatch-intent") return current;
  if (status === "failed") {
    run(transition("record-failure", at, {
      certainty: "known-not-dispatched",
      fault: fault("PROVIDER_UNAVAILABLE", at),
    }));
    return current;
  }
  run(transition("record-provider-io-may-have-started", at, {}));
  if (status === "provider-io") return current;
  if (status === "unknown") {
    run(transition("mark-dispatch-unknown", at, {}));
    return current;
  }
  run(transition("record-response", at, { responseText: "continued prose" }));
  if (status === "response-completed") return current;
  if (status === "stale") {
    run(transition("mark-target-stale", at, {}));
    return current;
  }
  if (status === "rejected") {
    run(transition("reject-result", at, {}));
    return current;
  }
  run(transition("accept-result", at, { artifactIntentId: "artifact-intent-0001" }));
  assert.equal(status, "accepted");
  return current;
}

test("creates a frozen private envelope bound to exact request and selected-context bytes", async () => {
  const subject = await envelope();
  assert.equal(subject.lifecycle.status, "prepared");
  assert.equal(subject.prepared.operation, "extend");
  assert.equal(subject.selectedContext.manifest.operation.target.headId, HEAD_ID);
  assert.equal(subject.selectedContext.renderedContext, subject.prepared.messages[1]!.content);
  assert.equal(Object.isFrozen(subject), true);
  assert.equal(Object.isFrozen(subject.selectedContext.manifest), true);
  assert.match(subject.prepared.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(subject.prepared.modelVoicePubkey, "a".repeat(64));
  assert.equal(subject.prepared.traceAuthoring.operation, "extend");
  assert.match(hashDesktopOperationEnvelopeV1(subject), /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(subject), /credential|api.?key|bearer/i);
  assert.equal(subject.retention.classification, "vault-local-private");
  assert.equal(subject.retention.deleteByMs, BASE_TIME + 60_000);
});

test("canonical bytes are deterministic, I-JSON safe, and round-trip with integrity checks", async () => {
  const subject = await envelope();
  const serialized = serializeDesktopOperationEnvelopeV1(subject);
  const parsed = parseDesktopOperationEnvelopeV1(serialized);
  assert.deepEqual(parsed, subject);
  assert.equal(serializeDesktopOperationEnvelopeV1(parsed), serialized);
  assert.equal(canonicalJsonV1({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.throws(() => canonicalJsonV1({ bad: Number.NaN }), DesktopOperationEnvelopeError);
  assert.throws(() => canonicalJsonV1({ bad: 1.5 }), /safe I-JSON integer/);
  assert.throws(() => canonicalJsonV1({ bad: undefined }), /undefined/);
  assert.throws(() => canonicalJsonV1({ bad: "\ud800" }), /unpaired high surrogate/);
  assert.throws(() => hashTextV1("domain\0suffix", "value"), /domain separator/);

  const corrupted = JSON.parse(serialized) as {
    prepared: { messages: Array<{ role: string; content: string }> };
  };
  corrupted.prepared.messages[1]!.content = "tampered";
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(corrupted)),
    /prepared request hash does not match/,
  );

  const changedModelVoice = JSON.parse(serialized) as {
    prepared: { modelVoicePubkey: string };
  };
  changedModelVoice.prepared.modelVoicePubkey = "b".repeat(64);
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(changedModelVoice)),
    /prepared request hash does not match/,
  );

  const malformedInputs = JSON.parse(serialized) as {
    prepared: { operationInputs: Record<string, unknown>; requestSha256: string };
  };
  malformedInputs.prepared.operationInputs.seed = 17;
  const requestWithoutHash = { ...malformedInputs.prepared };
  delete (requestWithoutHash as Partial<typeof requestWithoutHash>).requestSha256;
  malformedInputs.prepared.requestSha256 = hashCanonicalV1(
    "zine.desktop-operation.request.v1",
    requestWithoutHash,
  );
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(malformedInputs)),
    /operationInputs.seed must be a string/,
  );

  const splitPlacement = JSON.parse(serialized) as {
    prepared: {
      messages: Array<{ role: string; content: string }>;
      requestSha256: string;
    };
    selectedContext: {
      renderedContext: string;
      placement: { messageIndex: number; fromUtf16: number; toUtf16: number };
    };
  };
  const originalMessage = splitPlacement.prepared.messages[1]!.content;
  splitPlacement.prepared.messages[1]!.content = `😀${originalMessage}`;
  splitPlacement.selectedContext.placement = {
    messageIndex: 1,
    fromUtf16: 1,
    toUtf16: 2 + originalMessage.length,
  };
  const splitRequestWithoutHash = { ...splitPlacement.prepared };
  delete (splitRequestWithoutHash as Partial<typeof splitRequestWithoutHash>).requestSha256;
  splitPlacement.prepared.requestSha256 = hashCanonicalV1(
    "zine.desktop-operation.request.v1",
    splitRequestWithoutHash,
  );
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(splitPlacement)),
    /placement range splits a Unicode scalar value/,
  );

  for (const [name, mutate] of [
    ["missing field", (manifest: Record<string, any>) => { delete manifest.input; }],
    ["unknown field", (manifest: Record<string, any>) => { manifest.unreviewed = true; }],
  ] as const) {
    const malformed = JSON.parse(serialized) as Record<string, any>;
    mutate(malformed.selectedContext.manifest);
    malformed.selectedContext.manifestSha256 = hashCanonicalV1(
      "zine.trace-context.package-manifest.v1",
      malformed.selectedContext.manifest,
    );
    assert.throws(
      () => parseDesktopOperationEnvelopeV1(JSON.stringify(malformed)),
      /selected context manifest is invalid/,
      name,
    );
  }
});

test("creation and parsing reject rehashed manifests with reordered selected evidence", async () => {
  const selected = await evidenceSelection();
  const valid = createDesktopOperationEnvelopeV1({
    operationId: "operation-evidence-order",
    attemptId: "attempt-evidence-order",
    prepared: prepared(selected.renderedContext),
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("redacted-transport-config"),
    },
    selectedContext: withPlacement(selected),
    maxOutputTokens: 1_024,
    createdAtMs: BASE_TIME,
    retainForMs: 60_000,
  });
  const reorderedManifest = structuredClone(selected.manifest) as unknown as Record<string, any>;
  reorderedManifest.selected.reverse();
  const reorderedSegments = JSON.parse(selected.renderedContext) as unknown[];
  [reorderedSegments[1], reorderedSegments[2]] = [reorderedSegments[2], reorderedSegments[1]];
  const reorderedRenderedContext = canonicalJsonV1(reorderedSegments);
  reorderedManifest.hashes.renderedContextSha256 = hashTextV1(
    "zine.trace-context.rendered-selection.v1",
    reorderedRenderedContext,
  );
  const reorderedManifestSha256 = hashCanonicalV1(
    "zine.trace-context.package-manifest.v1",
    reorderedManifest,
  );
  assert.throws(() => createDesktopOperationEnvelopeV1({
    operationId: "operation-reordered-create",
    attemptId: "attempt-reordered-create",
    prepared: prepared(reorderedRenderedContext),
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("redacted-transport-config"),
    },
    selectedContext: {
      manifest: reorderedManifest as never,
      manifestSha256: reorderedManifestSha256,
      renderedContext: reorderedRenderedContext,
      placement: {
        messageIndex: 1,
        fromUtf16: 0,
        toUtf16: reorderedRenderedContext.length,
      },
    },
    maxOutputTokens: 1_024,
    createdAtMs: BASE_TIME,
  }), /deterministic selector order/);

  const reparsed = JSON.parse(serializeDesktopOperationEnvelopeV1(valid)) as Record<string, any>;
  reparsed.selectedContext.manifest = reorderedManifest;
  reparsed.selectedContext.manifestSha256 = reorderedManifestSha256;
  reparsed.selectedContext.renderedContext = reorderedRenderedContext;
  reparsed.selectedContext.renderedContextSha256 = hashTextV1(
    "zine.trace-context.rendered-selection.v1",
    reorderedRenderedContext,
  );
  reparsed.selectedContext.placement.toUtf16 = reorderedRenderedContext.length;
  reparsed.prepared.messages[1].content = reorderedRenderedContext;
  const requestWithoutHash = { ...reparsed.prepared };
  delete requestWithoutHash.requestSha256;
  reparsed.prepared.requestSha256 = hashCanonicalV1(
    "zine.desktop-operation.request.v1",
    requestWithoutHash,
  );
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(reparsed)),
    /deterministic selector order/,
  );
});

test("creation rejects mismatched context identity, non-Extend operations, split Unicode, and unbounded retention", async () => {
  const selected = await selection();
  const base = {
    operationId: "operation-invalid",
    attemptId: "attempt-invalid",
    prepared: prepared(selected.renderedContext),
    provider: {
      protocol: "openai" as const,
      modelId: "model-1",
      transportConfigSha256: HASH("config"),
    },
    selectedContext: withPlacement(selected),
    maxOutputTokens: 100,
    createdAtMs: BASE_TIME,
  };
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    selectedContext: { ...withPlacement(selected), renderedContext: `${selected.renderedContext}x` },
  }), /rendered-context identity|rendered context must be selector-owned JSON/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    selectedContext: {
      ...withPlacement(selected),
      placement: { messageIndex: 1, fromUtf16: 1, toUtf16: selected.renderedContext.length },
    },
  }), /does not identify the exact rendered context/);
  const duplicatePrepared = withRecomputedPreparedRequestHash({
    ...base.prepared,
    messages: [
      base.prepared.messages[0]!,
      { role: "user" as const, content: `${selected.renderedContext}\n${selected.renderedContext}` },
    ],
  });
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: duplicatePrepared,
    selectedContext: withPlacement(selected),
  }), /must occur exactly once/);
  for (const role of ["system", "assistant"] as const) {
    assert.throws(() => createDesktopOperationEnvelopeV1({
      ...base,
      prepared: withRecomputedPreparedRequestHash({
        ...base.prepared,
        messages: [
          { role, content: selected.renderedContext },
          { role: "user", content: "ordinary seed" },
        ],
      }),
      selectedContext: {
        ...withPlacement(selected),
        placement: { messageIndex: 0, fromUtf16: 0, toUtf16: selected.renderedContext.length },
      },
    }), /must identify a user message/);
  }
  const wrongRangeManifest = JSON.parse(JSON.stringify(selected.manifest)) as typeof selected.manifest;
  (wrongRangeManifest.operation as { range: { fromUtf16: number; toUtf16: number } }).range = {
    fromUtf16: 0,
    toUtf16: 0,
  };
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    selectedContext: {
      ...withPlacement(selected),
      manifest: wrongRangeManifest,
      manifestSha256: hashCanonicalV1(
        "zine.trace-context.package-manifest.v1",
        wrongRangeManifest,
      ),
    },
  }), /selected operation range does not match/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: { ...base.prepared, operation: "settle" },
  }), /supports Extend only/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: { ...base.prepared, version: 2 } as never,
  }), /prepared operation version is unsupported/);
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    retainForMs: 31 * 24 * 60 * 60 * 1_000,
  }), /retainForMs/);

  const badPrepared = {
    ...base.prepared,
    operationInputs: { ...base.prepared.operationInputs, rangeFrom: 1, rangeTo: 1 },
  };
  const selectedEmoji = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID, headId: HEAD_ID, contentHash: HASH("😀"),
        currentText: "😀", chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: 0 },
      maxContextBytes: 1_024,
      preparedRequestMaxBytes: 2_048,
      reservedPromptBytes: 100,
    },
    candidates: [],
  });
  assert.equal(selectedEmoji.ok, true);
  const emojiSelection = selectedEmoji as TraceContextSelectionSuccessV1;
  const splitEmojiManifest = JSON.parse(JSON.stringify(emojiSelection.manifest)) as typeof emojiSelection.manifest;
  (splitEmojiManifest.operation as { range: { fromUtf16: number; toUtf16: number } }).range = {
    fromUtf16: 1,
    toUtf16: 1,
  };
  const emojiPrepared = withRecomputedPreparedRequestHash({
    ...badPrepared,
    operationInputs: {
      ...badPrepared.operationInputs,
      seed: "😀",
      rangeFrom: 1,
      rangeTo: 1,
      sourceFrom: 0,
      sourceTo: 2,
    },
    messages: [
      badPrepared.messages[0]!,
      { role: "user" as const, content: emojiSelection.renderedContext },
    ],
    targetRevision: { ...badPrepared.targetRevision, contentHash: HASH("😀") },
  });
  assert.throws(() => createDesktopOperationEnvelopeV1({
    ...base,
    prepared: emojiPrepared,
    selectedContext: {
      ...withPlacement(emojiSelection),
      manifest: splitEmojiManifest,
      manifestSha256: hashCanonicalV1(
        "zine.trace-context.package-manifest.v1",
        splitEmojiManifest,
      ),
    },
  }), /splits a Unicode scalar/);
});

test("real preparation and selector bind an Extend source selection separately from its apply point", async () => {
  const body = "Opening paragraph. Selected 🧠 seed";
  const sourceFrom = body.indexOf("Selected");
  const sourceTo = body.length;
  const applyAt = body.length;
  const selected = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID,
        headId: HEAD_ID,
        contentHash: HASH(body),
        currentText: body,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: sourceFrom, toUtf16: sourceTo },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  });
  if (!selected.ok) assert.fail(selected.error.message);
  assert.equal(selected.ok, true);
  const contextSnapshot = createContextSnapshot({
    target: {
      kind: "file",
      folderId: FOLDER_ID,
      path: "draft.md",
      traceId: TRACE_ID,
      headId: HEAD_ID,
      body,
    },
    mount: { kind: "file", path: "draft.md" },
    shields: [],
    inputs: [{
      path: "draft.md", traceId: TRACE_ID, headId: HEAD_ID, body,
      citations: [], deltaLog: [], unstepped: false,
    }],
    renderedBlock: selected.renderedContext,
    createdAt: BASE_TIME,
  });
  const provider: ProviderConfig = {
    id: "provider-real-prepare",
    label: "Provider",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    modelId: "model-1",
    credentialRef: "model:provider:real:api-key",
    credentialConfigured: true,
  };
  const prepared = prepareOperation({
    operation: "extend",
    operationInputs: {
      seed: body.slice(sourceFrom, sourceTo),
      hasSelection: true,
      rangeFrom: applyAt,
      rangeTo: applyAt,
      sourceFrom,
      sourceTo,
    },
    contextSnapshot,
    provider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    requestId: "request-cross-lane",
    createdAt: BASE_TIME,
  });
  const messageIndex = prepared.messages.findIndex((message) => message.content.includes(selected.renderedContext));
  const fromUtf16 = prepared.messages[messageIndex]!.content.indexOf(selected.renderedContext);
  let subject = createDesktopOperationEnvelopeV1({
    operationId: "operation-cross-lane",
    attemptId: "attempt-cross-lane",
    prepared,
    provider: {
      protocol: "openai",
      modelId: "model-1",
      transportConfigSha256: HASH("cross-lane-config"),
    },
    selectedContext: {
      ...selected,
      placement: {
        messageIndex,
        fromUtf16,
        toUtf16: fromUtf16 + selected.renderedContext.length,
      },
    },
    maxOutputTokens: 100,
    createdAtMs: BASE_TIME,
  });
  assert.deepEqual(subject.selectedContext.manifest.operation.range, { fromUtf16: sourceFrom, toUtf16: sourceTo });
  subject = apply(subject, transition("approve", BASE_TIME + 1, {}));
  subject = apply(subject, transition("record-dispatch-intent", BASE_TIME + 2, {}));
  subject = apply(subject, transition("record-provider-io-may-have-started", BASE_TIME + 3, {}));
  subject = apply(subject, transition("record-response", BASE_TIME + 4, { responseText: "Continuation" }));
  subject = apply(subject, transition("accept-result", BASE_TIME + 5, {
    artifactIntentId: "artifact-cross-lane",
  }));
  assert.deepEqual(subject.artifactIntent?.applyRange, { fromUtf16: applyAt, toUtf16: applyAt });
});

test("the complete live path emits one dispatch, review, and accepted-only artifact intent", async () => {
  let current = await envelope();
  current = apply(current, transition("approve", 1_001, {}));
  current = apply(current, transition("record-dispatch-intent", 1_002, {}));
  const ioAction = transition("record-provider-io-may-have-started", 1_003, {});
  const io = reduceDesktopOperationV1(current, ioAction);
  current = io.envelope;
  assert.deepEqual(io.effects.map((effect) => effect.kind), ["dispatch-provider-request"]);
  assert.equal(Object.isFrozen(io.effects[0]), true);
  assert.equal(io.mustPersistBeforeEffects, true);
  assert.deepEqual(
    current.appliedTransitions.map((entry) => entry.transitionType),
    ["approve", "record-dispatch-intent", "record-provider-io-may-have-started"],
  );
  const replay = reduceDesktopOperationV1(current, ioAction);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.effects, [], "idempotent replay cannot redispatch");

  const completed = reduceDesktopOperationV1(
    current,
    transition("record-response", 1_004, { responseText: "continued prose" }),
  );
  current = completed.envelope;
  assert.deepEqual(completed.effects.map((effect) => effect.kind), ["present-result-for-review"]);
  assert.equal(current.artifactIntent, null, "completion alone never creates an artifact intent");

  const accepted = reduceDesktopOperationV1(
    current,
    transition("accept-result", 1_005, { artifactIntentId: "artifact-intent-0001" }),
  );
  current = accepted.envelope;
  assert.equal(current.lifecycle.status, "accepted");
  assert.equal(current.artifactIntent?.responseSha256, current.response?.responseSha256);
  assert.deepEqual(accepted.effects.map((effect) => effect.kind), ["apply-artifact-intent"]);
  assert.equal("step" in (current.artifactIntent ?? {}), false, "contract does not create a signed Step");

  current = apply(current, transition("record-artifact-applied", 1_006, {
    receiptId: "artifact-receipt-0001",
    resultingContentHash: HASH("resulting content"),
  }));
  assert.equal(current.artifactReceipt?.receiptId, "artifact-receipt-0001");
  assert.throws(() => reduceDesktopOperationV1(current, transition("record-artifact-applied", 1_007, {
    receiptId: "artifact-receipt-0002",
    resultingContentHash: HASH("different content"),
  })), /already recorded/);
});

test("rejecting a response never creates an artifact intent", async () => {
  let current = await atStatus("response-completed");
  current = apply(current, transition("reject-result", current.updatedAtMs + 1, {}));
  assert.equal(current.lifecycle.status, "rejected");
  assert.equal(current.artifactIntent, null);
  assert.equal(current.artifactReceipt, null);
  assert.equal(current.lifecycle.retryPolicy, "safe-new-attempt");
});

test("target staleness is durable before review or after acceptance and never reapplies", async () => {
  const completed = await atStatus("response-completed");
  const reviewStaleReduction = reduceDesktopOperationV1(
    completed,
    transition("mark-target-stale", completed.updatedAtMs + 1, {}),
  );
  const reviewStale = reviewStaleReduction.envelope;
  assert.deepEqual(reviewStaleReduction.effects, []);
  assert.equal(reviewStale.lifecycle.status, "stale");
  assert.equal(reviewStale.lifecycle.executionCertainty, "response-recorded");
  assert.equal(reviewStale.lifecycle.retryPolicy, "safe-new-attempt");
  assert.strictEqual(reviewStale.response?.text, completed.response?.text);
  assert.equal(reviewStale.fault?.code, "TARGET_STALE");
  assert.equal(reviewStale.fault?.stage, "review");
  assert.equal(reviewStale.artifactIntent, null);
  assert.equal(reviewStale.artifactReceipt, null);
  const reviewRecovery = projectDesktopOperationRecoveryV1(reviewStale, reviewStale.updatedAtMs + 1);
  assert.deepEqual(reviewRecovery.automaticEffects, []);
  assert.equal(reviewRecovery.operatorAction, "review-stale-result");
  assert.throws(() => createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-stale-missing-fresh",
    createdAtMs: reviewStale.updatedAtMs + 1,
  }), /requires a fresh prepared operation and selected context/);

  const focusOnlySelected = await selection();
  const cosmeticallyRelabeled = Object.freeze({
    ...prepared(focusOnlySelected.renderedContext),
    requestId: "request-after-focus-stale",
    createdAt: reviewStale.updatedAtMs + 1,
  });
  assert.equal(
    cosmeticallyRelabeled.preparedRequestHash,
    reviewStale.prepared.upstreamPreparedRequestHash,
  );
  assert.throws(() => createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-cosmetic-stale-retry",
    createdAtMs: reviewStale.updatedAtMs + 1,
    freshPreparation: {
      prepared: cosmeticallyRelabeled,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: withPlacement(focusOnlySelected),
      maxOutputTokens: 1_024,
    },
  }), /new prepared request identity/);
  const relabeledWithRandomHash = Object.freeze({
    ...cosmeticallyRelabeled,
    preparedRequestHash: HASH("cosmetic-random-prepared-request"),
  });
  assert.notEqual(
    relabeledWithRandomHash.preparedRequestHash,
    reviewStale.prepared.upstreamPreparedRequestHash,
  );
  assert.throws(() => createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-random-hash-stale-retry",
    createdAtMs: reviewStale.updatedAtMs + 1,
    freshPreparation: {
      prepared: relabeledWithRandomHash,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: withPlacement(focusOnlySelected),
      maxOutputTokens: 1_024,
    },
  }), /prepared preparedRequestHash does not match its exact bytes/);

  const focusOnlySnapshot = createContextSnapshot({
    target: {
      kind: "file",
      folderId: FOLDER_ID,
      path: "draft.md",
      traceId: TRACE_ID,
      headId: HEAD_ID,
      body: TARGET_TEXT,
    },
    mount: { kind: "file", path: "draft.md" },
    shields: [],
    inputs: [{
      path: "draft.md",
      traceId: TRACE_ID,
      headId: HEAD_ID,
      body: TARGET_TEXT,
      citations: [],
      deltaLog: [],
      unstepped: false,
    }],
    renderedBlock: focusOnlySelected.renderedContext,
    createdAt: reviewStale.updatedAtMs + 1,
  });
  const focusOnlyProvider: ProviderConfig = {
    id: "provider-focus-only-retry",
    label: "Provider",
    protocol: "openai",
    baseUrl: "https://example.test/v1",
    modelId: "model-1",
    credentialRef: "model:provider:focus-only:api-key",
    credentialConfigured: true,
  };
  const focusOnlyPrepared = prepareOperation({
    operation: "extend",
    operationInputs: {
      seed: TARGET_TEXT,
      hasSelection: false,
      rangeFrom: TARGET_TEXT.length,
      rangeTo: TARGET_TEXT.length,
      sourceFrom: 0,
      sourceTo: TARGET_TEXT.length,
    },
    contextSnapshot: focusOnlySnapshot,
    provider: focusOnlyProvider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    requestId: "request-after-focus-stale",
    createdAt: reviewStale.updatedAtMs + 1,
  });
  const focusOnlyMessageIndex = focusOnlyPrepared.messages.findIndex(
    (message) => message.content.includes(focusOnlySelected.renderedContext),
  );
  assert.notEqual(focusOnlyMessageIndex, -1);
  const focusOnlyFromUtf16 = focusOnlyPrepared.messages[focusOnlyMessageIndex]!.content.indexOf(
    focusOnlySelected.renderedContext,
  );
  assert.notEqual(
    focusOnlyPrepared.preparedRequestHash,
    reviewStale.prepared.upstreamPreparedRequestHash,
  );
  const focusOnlyRetry = createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-focus-stale-retry",
    createdAtMs: reviewStale.updatedAtMs + 1,
    freshPreparation: {
      prepared: focusOnlyPrepared,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: {
        ...focusOnlySelected,
        placement: {
          messageIndex: focusOnlyMessageIndex,
          fromUtf16: focusOnlyFromUtf16,
          toUtf16: focusOnlyFromUtf16 + focusOnlySelected.renderedContext.length,
        },
      },
      maxOutputTokens: 1_024,
    },
  });
  assert.deepEqual(focusOnlyRetry.prepared.targetRevision, reviewStale.prepared.targetRevision);
  assert.equal(focusOnlyRetry.prepared.requestId, "request-after-focus-stale");
  assert.equal(
    focusOnlyRetry.prepared.upstreamPreparedRequestHash,
    focusOnlyPrepared.preparedRequestHash,
  );
  const differentTargetPreparation = withRecomputedPreparedRequestHash({
    ...focusOnlyPrepared,
    requestId: "request-different-target-stale",
    targetRevision: { ...focusOnlyPrepared.targetRevision, path: "different.md" },
  });
  assert.throws(() => createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-different-target-stale",
    createdAtMs: reviewStale.updatedAtMs + 1,
    freshPreparation: {
      prepared: differentTargetPreparation,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: withPlacement(focusOnlySelected),
      maxOutputTokens: 1_024,
    },
  }), /same stable folder, path, and trace target/);

  const freshText = "draft changed after response";
  const freshHeadId = HASH("head-after-stale");
  const freshSelectionResult = await selectTraceContextV1({
    version: 1,
    policy: "text-only-v1",
    operation: {
      version: 1,
      operation: "extend",
      target: {
        traceId: TRACE_ID,
        headId: freshHeadId,
        contentHash: HASH(freshText),
        currentText: freshText,
        chosenPath: "draft.md",
      },
      range: { fromUtf16: 0, toUtf16: freshText.length },
      maxContextBytes: 16_384,
      preparedRequestMaxBytes: 32_768,
      reservedPromptBytes: 1_024,
    },
    candidates: [],
  });
  if (!freshSelectionResult.ok) assert.fail(freshSelectionResult.error.message);
  const freshSnapshot = createContextSnapshot({
    target: {
      kind: "file",
      folderId: FOLDER_ID,
      path: "draft.md",
      traceId: TRACE_ID,
      headId: freshHeadId,
      body: freshText,
    },
    mount: { kind: "file", path: "draft.md" },
    shields: [],
    inputs: [{
      path: "draft.md",
      traceId: TRACE_ID,
      headId: freshHeadId,
      body: freshText,
      citations: [],
      deltaLog: [],
      unstepped: false,
    }],
    renderedBlock: freshSelectionResult.renderedContext,
    createdAt: reviewStale.updatedAtMs + 1,
  });
  const freshProvider: ProviderConfig = {
    ...focusOnlyProvider,
    id: "provider-content-stale-retry",
    credentialRef: "model:provider:content-stale:api-key",
  };
  const freshPrepared = prepareOperation({
    operation: "extend",
    requestId: "request-after-stale",
    operationInputs: {
      seed: freshText,
      hasSelection: false,
      rangeFrom: freshText.length,
      rangeTo: freshText.length,
      sourceFrom: 0,
      sourceTo: freshText.length,
    },
    contextSnapshot: freshSnapshot,
    provider: freshProvider,
    modelVoicePubkey: "a".repeat(64),
    lensId: "default",
    dirtyTarget: false,
    createdAt: reviewStale.updatedAtMs + 1,
  });
  const freshMessageIndex = freshPrepared.messages.findIndex(
    (message) => message.content.includes(freshSelectionResult.renderedContext),
  );
  assert.notEqual(freshMessageIndex, -1);
  const freshFromUtf16 = freshPrepared.messages[freshMessageIndex]!.content.indexOf(
    freshSelectionResult.renderedContext,
  );
  const retry = createDesktopOperationRetryV1(reviewStale, {
    attemptId: "attempt-stale-retry",
    createdAtMs: reviewStale.updatedAtMs + 1,
    freshPreparation: {
      prepared: freshPrepared,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: {
        ...freshSelectionResult,
        placement: {
          messageIndex: freshMessageIndex,
          fromUtf16: freshFromUtf16,
          toUtf16: freshFromUtf16 + freshSelectionResult.renderedContext.length,
        },
      },
      maxOutputTokens: 1_024,
    },
  });
  assert.equal(retry.operationId, reviewStale.operationId);
  assert.equal(retry.attempt.retryOfAttemptId, reviewStale.attempt.attemptId);
  assert.equal(retry.attempt.possibleDuplicateAcknowledgedAtMs, null);
  assert.equal(retry.prepared.requestId, "request-after-stale");
  assert.equal(retry.prepared.targetRevision.headId, freshHeadId);
  assert.equal(retry.selectedContext.manifest.operation.target.currentText, freshText);
  assert.deepEqual(retry.appliedTransitions, []);
  const retryApproved = apply(
    retry,
    transition("approve", retry.updatedAtMs + 1, {}),
  );
  assert.equal(
    reviewStale.appliedTransitions.some(
      (priorTransition) => priorTransition.transitionId === retryApproved.appliedTransitions[0]?.transitionId,
    ),
    false,
  );

  const rejected = await atStatus("rejected");
  assert.throws(() => createDesktopOperationRetryV1(rejected, {
    attemptId: "attempt-rejected-fresh",
    createdAtMs: rejected.updatedAtMs + 1,
    freshPreparation: {
      prepared: focusOnlyPrepared,
      provider: {
        protocol: "openai",
        modelId: "model-1",
        transportConfigSha256: HASH("redacted-transport-config"),
      },
      selectedContext: withPlacement(focusOnlySelected),
      maxOutputTokens: 1_024,
    },
  }), /valid only for a stale retry/);

  const accepted = await atStatus("accepted");
  const applyStaleReduction = reduceDesktopOperationV1(
    accepted,
    transition("mark-target-stale", accepted.updatedAtMs + 1, {}),
  );
  const applyStale = applyStaleReduction.envelope;
  assert.deepEqual(applyStaleReduction.effects, []);
  assert.equal(applyStale.fault?.stage, "apply");
  assert.equal(applyStale.artifactIntent, null);
  assert.equal(applyStale.artifactReceipt, null);
  assert.doesNotThrow(() => parseDesktopOperationEnvelopeV1(
    serializeDesktopOperationEnvelopeV1(applyStale),
  ));

  const applied = apply(accepted, transition("record-artifact-applied", accepted.updatedAtMs + 1, {
    receiptId: "artifact-receipt-stale",
    resultingContentHash: HASH("already applied"),
  }));
  assert.throws(
    () => reduceDesktopOperationV1(
      applied,
      transition("mark-target-stale", applied.updatedAtMs + 1, {}),
    ),
    /applied artifact cannot later be marked target-stale/,
  );

  const discarded = apply(
    applyStale,
    transition("reject-result", applyStale.updatedAtMs + 1, {}),
  );
  assert.equal(discarded.lifecycle.status, "rejected");
  assert.equal(discarded.fault, null);
  assert.strictEqual(discarded.response?.text, applyStale.response?.text);
});

test("legal transitions are idempotent and every omitted graph edge fails closed", async () => {
  const legal: Readonly<Record<DesktopOperationEnvelopeV1["lifecycle"]["status"], readonly DesktopOperationTransitionV1["type"][]>> = {
    prepared: ["approve", "cancel", "abandon"],
    approved: ["record-dispatch-intent", "record-failure", "cancel", "abandon"],
    "dispatch-intent": [
      "record-provider-io-may-have-started", "record-failure", "cancel",
      "mark-dispatch-unknown", "abandon",
    ],
    "provider-io": ["record-response", "record-failure", "mark-dispatch-unknown"],
    "response-completed": ["accept-result", "mark-target-stale", "reject-result"],
    accepted: ["mark-target-stale", "record-artifact-applied"],
    stale: ["reject-result"],
    failed: [],
    cancelled: [],
    unknown: ["abandon"],
    rejected: [],
    abandoned: [],
  };
  const allTypes = [
    "approve", "record-dispatch-intent", "record-provider-io-may-have-started",
    "record-response", "record-failure", "cancel", "mark-dispatch-unknown",
    "accept-result", "mark-target-stale", "reject-result", "abandon", "record-artifact-applied",
  ] as const;

  for (const status of Object.keys(legal) as Array<keyof typeof legal>) {
    const current = await atStatus(status);
    for (const type of allTypes) {
      const action = actionFor(type, current.updatedAtMs + 1, current.lifecycle.executionCertainty);
      if (legal[status].includes(type)) {
        const first = reduceDesktopOperationV1(current, action);
        const second = reduceDesktopOperationV1(first.envelope, action);
        assert.equal(second.replayed, true, `${status} -> ${type} must be idempotent`);
        assert.strictEqual(second.envelope, first.envelope);
        assert.deepEqual(second.effects, []);
      } else {
        assert.throws(
          () => reduceDesktopOperationV1(current, action),
          DesktopOperationTransitionError,
          `${status} -> ${type} must be illegal`,
        );
      }
    }
  }
});

test("a reused transition id with different action bytes is rejected", async () => {
  const current = await envelope();
  const first = transition("approve", 1_001, {});
  const approved = apply(current, first);
  assert.throws(
    () => reduceDesktopOperationV1(approved, { ...first, atMs: 1_002 }),
    /reused with different bytes/,
  );
  assert.throws(
    () => reduceDesktopOperationV1(current, { ...first, version: 2 } as never),
    /transition version is unsupported/,
  );
});

test("serialized receipts must form one legal monotonic chain to the recorded lifecycle", async () => {
  let current = await envelope("receipt0");
  current = apply(current, transition("approve", 1_001, {}));
  current = apply(current, transition("record-dispatch-intent", 1_002, {}));
  const serialized = serializeDesktopOperationEnvelopeV1(current);

  const nonContiguous = JSON.parse(serialized) as DesktopOperationEnvelopeV1;
  (nonContiguous.appliedTransitions[0] as { fromStatus: string }).fromStatus = "approved";
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(nonContiguous)),
    /does not continue from prepared/,
  );

  const nonMonotonic = JSON.parse(serialized) as DesktopOperationEnvelopeV1;
  (nonMonotonic.appliedTransitions[1] as { appliedAtMs: number }).appliedAtMs = 1_000;
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(nonMonotonic)),
    /transition times must be monotonic/,
  );

  const wrongFinal = JSON.parse(serialized) as DesktopOperationEnvelopeV1;
  (wrongFinal.lifecycle as { status: string }).status = "approved";
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(wrongFinal)),
    /chain does not reach the lifecycle status/,
  );

  const wrongUpdatedAt = JSON.parse(serialized) as DesktopOperationEnvelopeV1;
  (wrongUpdatedAt as { updatedAtMs: number }).updatedAtMs += 1;
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(wrongUpdatedAt)),
    /updatedAtMs does not match/,
  );

  const applyStale = apply(
    await atStatus("accepted"),
    transition("mark-target-stale", BASE_TIME + 20, {}),
  );
  const wrongStaleStage = JSON.parse(
    serializeDesktopOperationEnvelopeV1(applyStale),
  ) as DesktopOperationEnvelopeV1;
  (wrongStaleStage.fault as OperationFaultV1).stage = "review";
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(wrongStaleStage)),
    /TARGET_STALE stage must be apply/,
  );

  const applied = apply(
    await atStatus("accepted"),
    transition("record-artifact-applied", BASE_TIME + 20, {
      receiptId: "artifact-receipt-forged-stale",
      resultingContentHash: HASH("applied before forged stale"),
    }),
  );
  const staleAfterApplied = JSON.parse(
    serializeDesktopOperationEnvelopeV1(applied),
  ) as DesktopOperationEnvelopeV1;
  const staleAtMs = staleAfterApplied.updatedAtMs + 1;
  (staleAfterApplied.appliedTransitions as Array<DesktopOperationEnvelopeV1["appliedTransitions"][number]>).push({
    transitionId: "transition-forged-target-stale",
    transitionType: "mark-target-stale",
    fromStatus: "accepted",
    toStatus: "stale",
    actionSha256: HASH("forged stale transition"),
    appliedAtMs: staleAtMs,
  });
  staleAfterApplied.lifecycle = {
    status: "stale",
    executionCertainty: "response-recorded",
    retryPolicy: "safe-new-attempt",
  };
  staleAfterApplied.fault = {
    version: 1,
    code: "TARGET_STALE",
    stage: "apply",
    observedAtMs: staleAtMs,
  };
  staleAfterApplied.artifactIntent = null;
  staleAfterApplied.artifactReceipt = null;
  staleAfterApplied.updatedAtMs = staleAtMs;
  assert.throws(
    () => parseDesktopOperationEnvelopeV1(JSON.stringify(staleAfterApplied)),
    /applied artifact cannot later be marked target-stale/,
  );

  const acceptedWithReceipt = apply(
    await atStatus("accepted"),
    transition("record-artifact-applied", BASE_TIME + 30, {
      receiptId: "artifact-receipt-bound",
      resultingContentHash: HASH("receipt-bound-result"),
    }),
  );
  const receiptSerialized = serializeDesktopOperationEnvelopeV1(acceptedWithReceipt);
  for (const [name, mutate, expected] of [
    ["receipt id", (value: Record<string, any>) => {
      value.artifactReceipt.receiptId = "artifact-receipt-mutated";
    }, /exact transition action/],
    ["receipt time", (value: Record<string, any>) => {
      value.artifactReceipt.recordedAtMs += 1;
    }, /receipt time does not match/],
    ["result hash", (value: Record<string, any>) => {
      value.artifactReceipt.resultingContentHash = HASH("mutated-result");
    }, /exact transition action/],
  ] as const) {
    const malformed = JSON.parse(receiptSerialized) as Record<string, any>;
    mutate(malformed);
    assert.throws(
      () => parseDesktopOperationEnvelopeV1(JSON.stringify(malformed)),
      expected,
      name,
    );
  }
});

test("post-marker ambiguity becomes unknown and recovery never automatically redispatches", async () => {
  const io = await atStatus("provider-io");
  const recovery = projectDesktopOperationRecoveryV1(io, io.updatedAtMs + 1);
  assert.equal(recovery.mayAutomaticallyDispatch, false);
  assert.deepEqual(recovery.automaticEffects.map((effect) => effect.kind), ["record-attempt-unknown"]);
  assert.equal(
    recovery.automaticEffects.some((effect) => effect.kind === "dispatch-provider-request"),
    false,
  );

  const unknown = apply(io, transition("mark-dispatch-unknown", io.updatedAtMs + 1, {}));
  assert.equal(unknown.lifecycle.status, "unknown");
  assert.equal(unknown.lifecycle.executionCertainty, "may-have-dispatched");
  assert.equal(unknown.lifecycle.retryPolicy, "operator-confirmation-required");
  assert.throws(
    () => reduceDesktopOperationV1(io, transition("cancel", io.updatedAtMs + 1, {})),
    /cancel is illegal from provider-io/,
  );

  const abandoned = apply(
    unknown,
    transition("abandon", unknown.updatedAtMs + 1, {}),
  );
  assert.equal(abandoned.lifecycle.status, "abandoned");
  assert.equal(abandoned.lifecycle.executionCertainty, "may-have-dispatched");
  assert.equal(abandoned.lifecycle.retryPolicy, "not-eligible");
  assert.strictEqual(abandoned.fault?.code, "DISPATCH_OUTCOME_UNKNOWN");
  const abandonedRecovery = projectDesktopOperationRecoveryV1(
    abandoned,
    abandoned.updatedAtMs + 1,
  );
  assert.deepEqual(abandonedRecovery.automaticEffects, []);
  assert.equal(abandonedRecovery.operatorAction, "none");
  assert.doesNotThrow(() => parseDesktopOperationEnvelopeV1(
    serializeDesktopOperationEnvelopeV1(abandoned),
  ));
  assert.throws(() => createDesktopOperationRetryV1(abandoned, {
    attemptId: "attempt-after-abandonment",
    createdAtMs: abandoned.updatedAtMs + 1,
  }), /not retryable/);
});

test("recovered dispatch intent fails closed to unknown without provider dispatch", async () => {
  const intent = await atStatus("dispatch-intent");
  const recovery = projectDesktopOperationRecoveryV1(intent, intent.updatedAtMs + 1);
  assert.deepEqual(recovery.automaticEffects.map((effect) => effect.kind), ["record-attempt-unknown"]);
  assert.equal(
    recovery.automaticEffects.some((effect) => effect.kind === "dispatch-provider-request"),
    false,
  );
  assert.equal(intent.lifecycle.executionCertainty, "known-not-dispatched");
  assert.equal(recovery.mayAutomaticallyDispatch, false);

  const unknown = apply(
    intent,
    transition("mark-dispatch-unknown", intent.updatedAtMs + 1, {}),
  );
  assert.equal(unknown.lifecycle.status, "unknown");
  assert.equal(unknown.lifecycle.executionCertainty, "may-have-dispatched");
  assert.equal(unknown.lifecycle.retryPolicy, "operator-confirmation-required");
  const projectedUnknown = projectDesktopOperationRecoveryV1(unknown, unknown.updatedAtMs + 1);
  assert.deepEqual(projectedUnknown.automaticEffects, []);
  assert.equal(projectedUnknown.operatorAction, "confirm-possible-duplicate-or-stop");
});

test("recovery re-presents completed responses and replays only pending local artifact intents", async () => {
  const completed = await atStatus("response-completed");
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(completed, completed.updatedAtMs + 1).automaticEffects
      .map((effect) => effect.kind),
    ["present-result-for-review"],
  );
  let accepted = await atStatus("accepted");
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(accepted, accepted.updatedAtMs + 1).automaticEffects
      .map((effect) => effect.kind),
    ["apply-artifact-intent"],
  );
  accepted = apply(accepted, transition("record-artifact-applied", accepted.updatedAtMs + 1, {
    receiptId: "artifact-receipt-0002",
    resultingContentHash: HASH("applied"),
  }));
  assert.deepEqual(
    projectDesktopOperationRecoveryV1(accepted, accepted.updatedAtMs + 1).automaticEffects,
    [],
  );
});

test("retries keep operation identity, create a linked attempt, and require ambiguity acknowledgement", async () => {
  const cancelled = await atStatus("cancelled");
  const safeRetry = createDesktopOperationRetryV1(cancelled, {
    attemptId: "attempt-retry-0001",
    createdAtMs: cancelled.updatedAtMs + 1,
  });
  assert.equal(safeRetry.operationId, cancelled.operationId);
  assert.equal(safeRetry.attempt.retryOfAttemptId, cancelled.attempt.attemptId);
  assert.equal(safeRetry.attempt.attemptId, "attempt-retry-0001");
  assert.equal(safeRetry.attempt.possibleDuplicateAcknowledgedAtMs, null);
  assert.equal(safeRetry.prepared.requestSha256, cancelled.prepared.requestSha256);
  assert.equal(safeRetry.lifecycle.status, "prepared");
  assert.throws(() => createDesktopOperationRetryV1(cancelled, {
    attemptId: "attempt-retry-safe-ack",
    createdAtMs: cancelled.updatedAtMs + 1,
    possibleDuplicateAcknowledged: true,
  }), /must not acknowledge a possible duplicate/);
  assert.throws(() => createDesktopOperationRetryV1(cancelled, {
    attemptId: cancelled.attempt.attemptId,
    createdAtMs: cancelled.updatedAtMs + 1,
  }), /new attempt id/);

  const unknown = await atStatus("unknown");
  assert.throws(() => createDesktopOperationRetryV1(unknown, {
    attemptId: "attempt-retry-0002",
    createdAtMs: unknown.updatedAtMs + 1,
  }), /explicit operator confirmation/);
  const confirmed = createDesktopOperationRetryV1(unknown, {
    attemptId: "attempt-retry-0002",
    createdAtMs: unknown.updatedAtMs + 1,
    possibleDuplicateAcknowledged: true,
  });
  assert.equal(confirmed.attempt.possibleDuplicateAcknowledgedAtMs, unknown.updatedAtMs + 1);
  const rejected = await atStatus("rejected");
  const rejectedRetry = createDesktopOperationRetryV1(rejected, {
    attemptId: "attempt-retry-rejected",
    createdAtMs: rejected.updatedAtMs + 1,
  });
  assert.equal(rejectedRetry.attempt.retryOfAttemptId, rejected.attempt.attemptId);
  assert.equal(rejectedRetry.attempt.possibleDuplicateAcknowledgedAtMs, null);
  assert.equal(rejectedRetry.response, null);
  const accepted = await atStatus("accepted");
  assert.throws(() => createDesktopOperationRetryV1(accepted, {
    attemptId: "attempt-retry-0003",
    createdAtMs: 2_000,
  }), /not retryable/);
});

test("faults are structured and reject unredacted exception fields", async () => {
  const approved = await atStatus("approved");
  const rawFault = {
    ...fault("PROVIDER_UNAVAILABLE", approved.updatedAtMs + 1),
    message: "Authorization: Bearer secret-token",
  } as OperationFaultV1;
  assert.throws(() => reduceDesktopOperationV1(approved, transition("record-failure", approved.updatedAtMs + 1, {
    certainty: "known-not-dispatched",
    fault: rawFault,
  })), /could contain unredacted diagnostics/);

  const failed = apply(approved, transition("record-failure", approved.updatedAtMs + 1, {
    certainty: "known-not-dispatched",
    fault: fault("PROVIDER_UNAVAILABLE", approved.updatedAtMs + 1),
  }));
  assert.equal(failed.lifecycle.status, "failed");
  assert.equal(failed.lifecycle.retryPolicy, "safe-new-attempt");
  assert.equal("message" in failed.fault!, false);
  assert.throws(() => reduceDesktopOperationV1(approved, transition("record-failure", approved.updatedAtMs + 1, {
    certainty: "known-not-dispatched",
    fault: { ...fault(), diagnosticRef: "sk-proj-secret-material" },
  })), /opaque diag-prefixed local identifier/);
});

test("response and retention limits fail before persistence and signal bounded deletion", async () => {
  const io = await atStatus("provider-io");
  assert.throws(() => reduceDesktopOperationV1(io, transition("record-response", io.updatedAtMs + 1, {
    responseText: "x".repeat(DESKTOP_OPERATION_MAX_RESPONSE_BYTES + 1),
  })), /response exceeds/);
  for (const status of ["dispatch-intent", "provider-io", "response-completed", "accepted"] as const) {
    const expiring = await atStatus(status);
    const due = projectDesktopOperationRecoveryV1(expiring, expiring.retention.deleteByMs);
    assert.equal(due.privateEnvelopeDeletionDue, true);
    assert.equal(expiring.retention.deadlineBehavior, "delete-entire-private-envelope");
    assert.deepEqual(due.automaticEffects.map((effect) => effect.kind), ["delete-expired-private-envelope"]);
    assert.equal(due.operatorAction, "none");
    assert.equal("keepHashes" in due.automaticEffects[0]!, false);
  }
});

function actionFor(
  type: DesktopOperationTransitionV1["type"],
  atMs: number,
  certainty: DesktopOperationEnvelopeV1["lifecycle"]["executionCertainty"],
): DesktopOperationTransitionV1 {
  switch (type) {
    case "approve": return transition(type, atMs, {});
    case "record-dispatch-intent": return transition(type, atMs, {});
    case "record-provider-io-may-have-started": return transition(type, atMs, {});
    case "record-response": return transition(type, atMs, { responseText: "result" });
    case "record-failure": return transition(type, atMs, {
      certainty: certainty === "may-have-dispatched"
        ? "provider-completed-without-result"
        : "known-not-dispatched",
      fault: fault("PROVIDER_UNAVAILABLE", atMs),
    });
    case "cancel": return transition(type, atMs, {});
    case "mark-dispatch-unknown": return transition(type, atMs, {});
    case "accept-result": return transition(type, atMs, { artifactIntentId: `artifact-intent-${atMs}` });
    case "mark-target-stale": return transition(type, atMs, {});
    case "reject-result": return transition(type, atMs, {});
    case "abandon": return transition(type, atMs, {});
    case "record-artifact-applied": return transition(type, atMs, {
      receiptId: `artifact-receipt-${atMs}`,
      resultingContentHash: HASH(`result-${atMs}`),
    });
  }
}
