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
  type EvidenceCandidateV1,
  type TraceContextProcessProjectionInputV1,
  type TraceContextPolicyV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionLimitsV1,
  type TraceContextSelectionOperationV1,
  type TraceProcessFactV1,
  type TraceProcessStatusV1,
  type Utf16Range,
} from "@zine/trace-context";

export interface DesktopTraceContextOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

export interface DesktopTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: DesktopTraceContextOperationMetadataV1;
  /** Exact fetched genesis-to-head order. Cloned before verification starts. */
  chain: readonly ProtocolEvent[];
  /** Trusted cryptographic verifier injected by the native desktop boundary. */
  verifyEvent: TraceEventVerifier;
  limits?: TraceContextSelectionLimitsV1;
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
  requireVersion(input.version, "input");
  requirePolicy(input.policy);
  requireOperation(input.operation);
  if (typeof input.verifyEvent !== "function") fail("verifyEvent must be a trusted function");
  const policy = input.policy;
  const operation = cloneOperation(input.operation);
  const limits = input.limits ? { ...input.limits } : undefined;
  const verifyEvent = input.verifyEvent;
  const chain = cloneChain(input.chain);

  let verdict: TraceConformanceVerdict;
  try {
    verdict = await verifyFileTraceChain(chain, verifyEvent);
  } catch {
    fail("trusted file-chain verification failed");
  }
  const target = requireVerifiedTarget(chain, verdict.issues);
  requireOperationRange(operation.range, target.currentText);

  // Text-only projection excludes process candidates before their validation,
  // byte accounting, hashing, or rendering. Preserve that exact boundary here.
  // Selected-trace always carries a non-FULL global verdict to the selector,
  // so completeness cannot disappear.
  const candidates = policy === "text-only-v1"
    ? []
    : projectVerifiedProcessCandidates(target, chain, verdict);

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
    ...(limits ? { limits } : {}),
  });
}

function cloneOperation(
  operation: DesktopTraceContextOperationMetadataV1,
): DesktopTraceContextOperationMetadataV1 {
  return {
    version: operation.version,
    operation: operation.operation,
    ...(operation.range ? { range: copyRange(operation.range) } : {}),
    maxContextBytes: operation.maxContextBytes,
    preparedRequestMaxBytes: operation.preparedRequestMaxBytes,
    reservedPromptBytes: operation.reservedPromptBytes,
  };
}

function cloneChain(value: readonly ProtocolEvent[]): ProtocolEvent[] {
  if (!Array.isArray(value) || value.length === 0) fail("signed file chain is empty");
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

function projectVerifiedProcessCandidates(
  target: VerifiedTargetProjection,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
): readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] {
  const steps = requireBoundVerifiedSteps(chain, verdict.steps);
  if (verdict.status !== "full") {
    return [nonFullStatusCandidate(target, steps[steps.length - 1]!, verdict.status)];
  }
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
          sourceTransactionId: transaction.tx,
          capturedAtMs: transaction.at,
          ...(transaction.intent ? { intent: transaction.intent } : {}),
          changes: transaction.changes.map((change) => ({
            version: 1,
            operation: change.op === "ins"
              ? "insert"
              : change.op === "del" ? "delete" : "replace",
            range: { fromUtf16: change.from, toUtf16: change.to },
            insertedText: change.inserted,
            deletedText: change.deleted,
            voiceId: change.voice,
          })),
        })),
      };
    }),
  };
  return projectTraceProcessCandidatesV1(projection);
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

function requirePolicy(policy: TraceContextPolicyV1): void {
  if (policy !== "text-only-v1" && policy !== "selected-trace-v1") {
    fail("policy must be text-only-v1 or selected-trace-v1");
  }
}

function requireOperation(operation: DesktopTraceContextOperationMetadataV1): void {
  requireVersion(operation.version, "operation");
  if (operation.operation !== "extend" && operation.operation !== "settle") {
    fail("operation must be Extend or Settle");
  }
  if (operation.operation === "settle" && operation.range === undefined) {
    fail("Settle requires an exact UTF-16 range");
  }
  if (operation.range) requireOrderedRange(operation.range, "operation range");
  requirePositiveInteger(operation.maxContextBytes, "maxContextBytes");
  requirePositiveInteger(operation.preparedRequestMaxBytes, "preparedRequestMaxBytes");
  if (!Number.isSafeInteger(operation.reservedPromptBytes) || operation.reservedPromptBytes < 0) {
    fail("reservedPromptBytes must be a non-negative safe integer");
  }
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

function requireOrderedRange(range: Utf16Range, subject: string): void {
  if (
    !Number.isSafeInteger(range.fromUtf16)
    || !Number.isSafeInteger(range.toUtf16)
    || range.fromUtf16 < 0
    || range.toUtf16 < range.fromUtf16
  ) {
    fail(`${subject} must be an ordered non-negative UTF-16 range`);
  }
}

function requirePositiveInteger(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${subject} must be a positive safe integer`);
}

function requireVersion(version: number, subject: string): void {
  if (version !== 1) fail(`${subject} version must be 1`);
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
