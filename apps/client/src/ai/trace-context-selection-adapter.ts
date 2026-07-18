import {
  summarizeTraceProcess,
  verifyFileTraceChain,
  type ProtocolEvent,
  type TraceConformanceIssue,
  type TraceConformanceStatus,
  type TraceConformanceStep,
  type TraceConformanceVerdict,
  type TraceEventVerifier,
  type TraceProcessChange,
  type TraceProcessTransaction,
} from "@zine/protocol";
import {
  isUtf16Boundary,
  type EvidenceCandidateV1,
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

/**
 * Coordinates for one mechanical fact. The fact body, node identity, trace
 * identity, and process status are always derived from the stable verified
 * chain inside the adapter.
 */
export type DesktopProcessFactRequestV1 =
  | {
      version: 1;
      kind: "step-summary";
      chainDistance: number;
    }
  | {
      version: 1;
      kind: "transaction";
      chainDistance: number;
      transactionIndex: number;
    }
  | {
      version: 1;
      kind: "change";
      chainDistance: number;
      transactionIndex: number;
      changeIndex: number;
    };

export interface DesktopTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: DesktopTraceContextOperationMetadataV1;
  /** Exact fetched genesis-to-head order. Cloned before verification starts. */
  chain: readonly ProtocolEvent[];
  /** Trusted cryptographic verifier injected by the native desktop boundary. */
  verifyEvent: TraceEventVerifier;
  processFacts: readonly DesktopProcessFactRequestV1[];
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
  const processFacts = cloneProcessFactRequests(input.processFacts);
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
  const candidates = policy === "text-only-v1"
    ? []
    : processFacts.map((request) => processCandidate(target, verdict.steps, request));
  requireDistinctCandidates(candidates);

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

function cloneProcessFactRequests(
  requests: readonly DesktopProcessFactRequestV1[],
): DesktopProcessFactRequestV1[] {
  if (!Array.isArray(requests)) fail("process fact requests must be an array");
  return requests.map((request) => {
    if (request.kind === "step-summary") {
      return { version: request.version, kind: request.kind, chainDistance: request.chainDistance };
    }
    if (request.kind === "transaction") {
      return {
        version: request.version,
        kind: request.kind,
        chainDistance: request.chainDistance,
        transactionIndex: request.transactionIndex,
      };
    }
    if (request.kind === "change") {
      return {
        version: request.version,
        kind: request.kind,
        chainDistance: request.chainDistance,
        transactionIndex: request.transactionIndex,
        changeIndex: request.changeIndex,
      };
    }
    fail("process fact request kind is unsupported");
  });
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
  if (issues.some((issue) => issue.stepIndex === headIndex && issue.code === "invalid-event")) {
    fail("signed file-chain head has an invalid id or signature");
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
  if (
    issues.some((issue) =>
      issue.stepIndex === headIndex
      && (issue.code === "snapshot-hash-mismatch" || issue.code === "missing-content-hash"))
  ) {
    fail("signed file-chain head snapshot does not match its content hash");
  }
  return {
    traceId: chain[0]!.id,
    headId: head.id,
    contentHash: payload.contentHash,
    currentText: payload.snapshot,
    chosenPath,
  };
}

function processCandidate(
  target: VerifiedTargetProjection,
  steps: readonly TraceConformanceStep[],
  request: DesktopProcessFactRequestV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  requireVersion(request.version, "process fact request");
  if (!Number.isSafeInteger(request.chainDistance) || request.chainDistance < 0) {
    fail("process fact chain distance must be a non-negative safe integer");
  }
  const stepIndex = steps.length - 1 - request.chainDistance;
  const step = steps[stepIndex];
  if (!step || step.stepIndex !== stepIndex) {
    fail("process fact distance does not bind a verified chain Step");
  }

  const fact = authoritativeFact(step, request);
  const transactionIndex = fact.kind === "step-summary" ? 0 : fact.transactionIndex;
  const suffix = factSuffix(fact, request.kind === "change" ? request.changeIndex : undefined);
  const ref = `desktop-trace:${target.traceId}:${step.nodeId}:${suffix}`;
  return {
    version: 1,
    id: ref,
    dedupeKey: ref,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref,
      traceId: target.traceId,
      headId: target.headId,
      nodeId: step.nodeId,
      processStatus: selectorProcessStatus(step.status),
      chainDistance: request.chainDistance,
      transactionIndex,
      ...(fact.kind === "change" ? { range: copyRange(fact.range) } : {}),
    },
    reasons: [request.chainDistance === 0 ? "prepared-head-process" : "recent-target-process"],
    fact,
  };
}

function authoritativeFact(
  step: TraceConformanceStep,
  request: DesktopProcessFactRequestV1,
): TraceProcessFactV1 {
  switch (request.kind) {
    case "step-summary": {
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
    case "transaction":
      return transactionFact(requireTransaction(step, request.transactionIndex), request.transactionIndex);
    case "change": {
      const transaction = requireTransaction(step, request.transactionIndex);
      if (!Number.isSafeInteger(request.changeIndex) || request.changeIndex < 0) {
        fail("change facts require a non-negative safe change index");
      }
      const change = transaction.changes[request.changeIndex];
      if (!change) fail("change index does not bind the verified transaction");
      return changeFact(change, request.transactionIndex);
    }
  }
}

function requireTransaction(
  step: TraceConformanceStep,
  transactionIndex: number,
): TraceProcessTransaction {
  if (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0) {
    fail("transaction index must be a non-negative safe integer");
  }
  if (step.process.status !== "complete") {
    fail("transaction facts require a complete verified Step process");
  }
  const transaction = step.process.transactions[transactionIndex];
  if (!transaction) fail("transaction index does not bind the verified Step process");
  return transaction;
}

function transactionFact(
  transaction: TraceProcessTransaction,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "transaction" }> {
  const voiceIds = [...new Set(transaction.changes.map((change) => change.voice))].sort();
  return {
    kind: "transaction",
    transactionIndex,
    capturedAtMs: transaction.at,
    ...(transaction.intent ? { intent: transaction.intent } : {}),
    changeCount: transaction.changes.length,
    voiceIds,
  };
}

function changeFact(
  change: TraceProcessChange,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "change" }> {
  const insertedCodePointCount = [...change.inserted].length;
  const deletedCodePointCount = [...change.deleted].length;
  if (insertedCodePointCount === 0 && deletedCodePointCount === 0) {
    fail("a no-op range has no selector change-fact shape");
  }
  return {
    kind: "change",
    transactionIndex,
    operation: change.op === "ins" ? "insert" : change.op === "del" ? "delete" : "replace",
    range: { fromUtf16: change.from, toUtf16: change.to },
    insertedCodePointCount,
    deletedCodePointCount,
    voiceId: change.voice,
  };
}

function selectorProcessStatus(status: TraceConformanceStatus): TraceProcessStatusV1 {
  if (status === "full") return "full-trace";
  return status;
}

function factSuffix(fact: TraceProcessFactV1, changeIndex: number | undefined): string {
  if (fact.kind === "step-summary") return "summary";
  if (fact.kind === "transaction") return `transaction:${fact.transactionIndex}`;
  return `transaction:${fact.transactionIndex}:change:${changeIndex}`;
}

function requireDistinctCandidates(candidates: readonly EvidenceCandidateV1[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) fail(`duplicate process fact request ${candidate.id}`);
    ids.add(candidate.id);
  }
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
