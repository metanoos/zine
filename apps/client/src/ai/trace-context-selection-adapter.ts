import {
  summarizeTraceProcess,
  verifyFileTraceChain,
  type ProtocolEvent,
  type TraceConformanceIssue,
  type TraceConformanceStatus,
  type TraceConformanceStep,
  type TraceConformanceVerdict,
  type TraceEventVerifier,
} from "@zine/protocol";
import {
  isUtf16Boundary,
  projectTraceProcessCandidatesV1,
  projectTraceProcessCandidatesV1Async,
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  validateTraceContextAbortSignalV1,
  validateTraceContextAdapterMetadataV1,
  validateTraceContextAdapterProcessBoundsV1,
  type EvidenceCandidateV1,
  type TraceContextAdapterOperationMetadataV1,
  type TraceContextProcessProjectionInputV1,
  type TraceContextPolicyV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionLimitsV1,
  type TraceProcessFactV1,
  type TraceProcessStatusV1,
  type Utf16Range,
} from "@zine/trace-context";

export type DesktopTraceContextOperationMetadataV1 = TraceContextAdapterOperationMetadataV1;

export interface DesktopTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: DesktopTraceContextOperationMetadataV1;
  /** Exact fetched genesis-to-head order. Cloned before verification starts. */
  chain: readonly ProtocolEvent[];
  /** Trusted cryptographic verifier injected by the native desktop boundary. */
  verifyEvent: TraceEventVerifier;
  limits?: TraceContextSelectionLimitsV1;
  signal?: AbortSignal;
}

export class DesktopTraceContextSelectionAdapterError extends Error {
  constructor(message: string) {
    super(`Desktop trace-context adapter: ${message}`);
    this.name = "DesktopTraceContextSelectionAdapterError";
  }
}

interface VerifiedTargetProjection {
  traceId: string;
  headId: string;
  contentHash: string;
  currentText: string;
  chosenPath: string;
}

/**
 * Clone, verify, and map one signed file chain into selector input. The clone
 * is captured before the verifier's first asynchronous digest so caller-side
 * mutation cannot change the verified projection mid-call.
 */
export async function adaptDesktopTraceContextSelectionV1(
  input: DesktopTraceContextSelectionAdapterInputV1,
): Promise<TraceContextSelectionInputV1> {
  let metadata: ReturnType<typeof validateTraceContextAdapterMetadataV1>;
  let signal: AbortSignal | undefined;
  try {
    metadata = validateTraceContextAdapterMetadataV1(input);
    signal = validateTraceContextAbortSignalV1(
      (input as unknown as Record<string, unknown>).signal,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : "input metadata is malformed");
  }
  const record = input as unknown as Record<string, unknown>;
  if (typeof record.verifyEvent !== "function") fail("verifyEvent must be a trusted function");
  if (signal?.aborted) fail("operation was cancelled");
  const policy = metadata.policy;
  const operation = metadata.operation;
  const limits = metadata.limits;
  const verifyEvent = record.verifyEvent as TraceEventVerifier;
  const chain = cloneChain(record.chain as readonly ProtocolEvent[]);
  try {
    validateTraceContextAdapterProcessBoundsV1(
      chain.map((event) => event.content),
      policy === "selected-trace-v1"
        ? limits?.maxCandidates ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates
        : undefined,
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : "file chain exceeds process bounds");
  }

  let verdict: TraceConformanceVerdict;
  try {
    verdict = await verifyFileTraceChain(chain, verifyEvent);
  } catch {
    fail("trusted file-chain verification failed");
  }
  if (signal?.aborted) fail("operation was cancelled");
  const target = requireVerifiedTarget(chain, verdict.issues);
  requireOperationRange(operation.range, target.currentText);

  // Text-only projection excludes process candidates before their validation,
  // byte accounting, hashing, or rendering. Preserve that exact boundary here.
  // Selected-trace always carries a non-FULL global verdict to the selector,
  // so completeness cannot disappear.
  let candidates: readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[];
  try {
    candidates = policy === "text-only-v1"
      ? []
      : await projectVerifiedProcessCandidates(target, chain, verdict, limits, signal);
  } catch (error) {
    if (error instanceof DesktopTraceContextSelectionAdapterError) throw error;
    fail(error instanceof Error ? `process projection failed: ${error.message}` : "process projection failed");
  }

  return deepFreeze({
    version: 1,
    policy,
    operation: {
      version: 1,
      operation: operation.operation,
      target,
      ...(operation.range ? { range: copyRange(operation.range) } : {}),
      maxContextBytes: operation.maxContextBytes,
      preparedRequestMaxBytes: operation.preparedRequestMaxBytes,
      reservedPromptBytes: operation.reservedPromptBytes,
    },
    candidates,
    ...(limits ? { limits: { ...limits } } : {}),
  });
}

function cloneChain(value: readonly ProtocolEvent[]): ProtocolEvent[] {
  if (!Array.isArray(value) || value.length === 0) fail("signed file chain is empty");
  if (value.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates) {
    fail("signed file chain exceeds the bounded Step ceiling");
  }
  const events = value as readonly ProtocolEvent[];
  return events.map((event, index) => {
    if (
      event === null
      || typeof event !== "object"
      || typeof event.id !== "string"
      || typeof event.pubkey !== "string"
      || !Number.isSafeInteger(event.created_at)
      || !Number.isSafeInteger(event.kind)
      || typeof event.content !== "string"
      || typeof event.sig !== "string"
      || !Array.isArray(event.tags)
      || event.tags.some((tag) => !Array.isArray(tag) || tag.some((part) => typeof part !== "string"))
    ) {
      fail(`signed file chain event ${index} is malformed`);
    }
    return {
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags.map((tag) => [...tag]),
      content: event.content,
      sig: event.sig,
    };
  });
}

function requireVerifiedTarget(
  chain: readonly ProtocolEvent[],
  issues: readonly TraceConformanceIssue[],
): VerifiedTargetProjection {
  const headIndex = chain.length - 1;
  const head = chain[headIndex]!;
  const headIntegrityIssue = issues.find(
    (issue) => issue.kind === "integrity" && issue.stepIndex === headIndex,
  );
  if (headIntegrityIssue) {
    fail(`signed file-chain head is not a valid signed snapshot: ${headIntegrityIssue.code}`);
  }
  if (head.kind !== 4290) fail("signed file-chain head is not a TraceNode");
  const reifications = head.tags.filter((tag) => tag[0] === "z");
  if (reifications.length !== 1 || reifications[0]?.[1] !== "file") {
    fail("signed file-chain head is not exactly one file TraceNode");
  }
  const paths = head.tags.filter((tag) => tag[0] === "F");
  const chosenPath = paths[0]?.[1];
  if (paths.length !== 1 || !chosenPath) fail("signed file-chain head has no exact structural path");

  let payload: { snapshot?: unknown; contentHash?: unknown };
  try {
    const parsed = JSON.parse(head.content) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("signed file-chain head payload is not an object");
    }
    payload = parsed as typeof payload;
  } catch (error) {
    if (error instanceof DesktopTraceContextSelectionAdapterError) throw error;
    fail("signed file-chain head payload is not valid JSON");
  }
  if (typeof payload.snapshot !== "string") fail("signed file-chain head has no text snapshot");
  if (typeof payload.contentHash !== "string" || payload.contentHash.length === 0) {
    fail("signed file-chain head has no content hash");
  }
  return {
    traceId: chain[0]!.id,
    headId: head.id,
    contentHash: payload.contentHash,
    currentText: payload.snapshot,
    chosenPath,
  };
}

async function projectVerifiedProcessCandidates(
  target: VerifiedTargetProjection,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
  limits: TraceContextSelectionLimitsV1 | undefined,
  signal: AbortSignal | undefined,
): Promise<readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[]> {
  const steps = requireBoundVerifiedSteps(chain, verdict.steps);
  if (verdict.status !== "full") {
    return [nonFullStatusCandidate(target, steps[steps.length - 1]!, verdict.status)];
  }
  requireProjectedCandidateBound(
    steps,
    limits?.maxCandidates ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates,
  );
  const projection: TraceContextProcessProjectionInputV1 = {
    version: 1,
    traceId: target.traceId,
    headId: target.headId,
    steps: steps.map((step) => {
      if (step.status !== "full" || step.process.status !== "complete") {
        fail("FULL verdict does not contain only complete FULL process Steps");
      }
      return {
        version: 1,
        nodeId: step.nodeId,
        chainDistance: steps.length - step.stepIndex - 1,
        transactions: step.process.transactions.map((transaction) => ({
          version: 1,
          sourceTransactionId: transaction.sequence,
          capturedAtMs: transaction.timestamp,
          actor: transaction.actor,
          ...(transaction.intent ? { intent: transaction.intent } : {}),
          changes: transaction.changes.map((change) => ({
            version: 1,
            operation: change.op,
            range: { fromUtf16: change.from, toUtf16: change.to },
            insertedText: change.inserted,
            deletedText: change.deleted,
            voiceId: change.actor,
          })),
        })),
      };
    }),
  };
  return projectTraceProcessCandidatesV1Async(projection, {
    ...(signal ? { signal } : {}),
    ...(limits?.maxCandidates !== undefined ? { maxCandidates: limits.maxCandidates } : {}),
    ...(limits?.maxInputBytes !== undefined ? { maxInputBytes: limits.maxInputBytes } : {}),
    ...(limits?.maxCandidateInputBytes !== undefined
      ? { maxCandidateInputBytes: limits.maxCandidateInputBytes }
      : {}),
  });
}

function requireProjectedCandidateBound(
  steps: readonly TraceConformanceStep[],
  maxCandidates: number,
): void {
  let count = 0;
  for (const step of steps) {
    count += 1;
    if (step.process.status === "complete") {
      for (const transaction of step.process.transactions) {
        count += 1 + transaction.changes.filter(
          (change) => change.inserted.length > 0 || change.deleted.length > 0,
        ).length;
        if (count > maxCandidates) fail("projected candidate count exceeds the selector ceiling");
      }
    }
    if (count > maxCandidates) fail("projected candidate count exceeds the selector ceiling");
  }
}

function requireBoundVerifiedSteps(
  chain: readonly ProtocolEvent[],
  steps: readonly TraceConformanceStep[],
): readonly TraceConformanceStep[] {
  if (steps.length !== chain.length) fail("verification did not cover the captured chain");
  for (let stepIndex = 0; stepIndex < chain.length; stepIndex += 1) {
    const event = chain[stepIndex]!;
    const step = steps[stepIndex];
    if (!step || step.stepIndex !== stepIndex || step.nodeId !== event.id) {
      fail("verified process Steps do not bind the captured chain");
    }
  }
  return steps;
}

function nonFullStatusCandidate(
  target: VerifiedTargetProjection,
  headStep: TraceConformanceStep,
  status: Exclude<TraceConformanceStatus, "full">,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  const canonical = projectTraceProcessCandidatesV1({
    version: 1,
    traceId: target.traceId,
    headId: target.headId,
    steps: [{
      version: 1,
      nodeId: target.headId,
      chainDistance: 0,
      transactions: [],
    }],
  })[0];
  if (!canonical || canonical.fact.kind !== "step-summary") {
    fail("shared projector did not produce the canonical head summary");
  }
  return {
    ...canonical,
    source: {
      ...canonical.source,
      traceId: target.traceId,
      headId: target.headId,
      nodeId: headStep.nodeId,
      processStatus: selectorProcessStatus(status),
    },
    fact: summaryFact(headStep),
  };
}

function summaryFact(
  step: TraceConformanceStep,
): Extract<TraceProcessFactV1, { kind: "step-summary" }> {
  const summary = summarizeTraceProcess(step.process);
  return {
    kind: "step-summary",
    transactionCount: summary.transactions,
    rangeCount: summary.ranges,
    insertedCodePointCount: summary.inserted,
    deletedCodePointCount: summary.deleted,
    ...(summary.firstAt === null ? {} : { firstCapturedAtMs: summary.firstAt }),
    ...(summary.lastAt === null ? {} : { lastCapturedAtMs: summary.lastAt }),
    spanMs: summary.spanMs,
    longestGapMs: summary.longestGapMs,
    undoCount: summary.undo,
    redoCount: summary.redo,
  };
}

function selectorProcessStatus(status: TraceConformanceStatus): TraceProcessStatusV1 {
  if (status === "full") return "full-trace";
  return status;
}

function requireOperationRange(range: Utf16Range | undefined, currentText: string): void {
  if (!range) return;
  if (
    range.toUtf16 > currentText.length
    || !isUtf16Boundary(currentText, range.fromUtf16)
    || !isUtf16Boundary(currentText, range.toUtf16)
  ) {
    fail("operation range must be within the signed current text on UTF-16 code-point boundaries");
  }
}

function copyRange(range: Utf16Range): Utf16Range {
  return { fromUtf16: range.fromUtf16, toUtf16: range.toUtf16 };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(message: string): never {
  throw new DesktopTraceContextSelectionAdapterError(message);
}
