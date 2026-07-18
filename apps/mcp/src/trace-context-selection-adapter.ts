/**
 * Pure MCP boundary for the package-local trace-context selector.
 *
 * The adapter snapshots an already-fetched chain, verifies that immutable
 * snapshot with an injected trusted event verifier, and derives both the
 * current target and every process fact from the same verification result.
 * It performs no fetches, signing, storage, model calls, or inference.
 */
import {
  summarizeTraceProcess,
  verifyFileTraceChain,
  type ProtocolEvent,
  type TraceConformanceStep,
  type TraceConformanceVerdict,
  type TraceEventVerifier,
  type TraceProcessChange,
  type TraceProcessTransaction,
} from "@zine/protocol";
import type {
  EvidenceCandidateV1,
  TraceContextPolicyV1,
  TraceContextSelectionInputV1,
  TraceContextSelectionLimitsV1,
  TraceContextSelectionOperationV1,
  TraceProcessFactV1,
  TraceProcessStatusV1,
  Utf16Range,
} from "../../../packages/trace-context/src/index.js";

export interface McpTraceContextOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

interface McpProcessFactRequestBaseV1 {
  version: 1;
  nodeId: string;
  chainDistance: number;
}

/** Coordinates only. No caller-authored process fact crosses this boundary. */
export type McpProcessFactRequestV1 =
  | (McpProcessFactRequestBaseV1 & {
      kind: "step-summary";
    })
  | (McpProcessFactRequestBaseV1 & {
      kind: "transaction";
      transactionIndex: number;
    })
  | (McpProcessFactRequestBaseV1 & {
      kind: "change";
      transactionIndex: number;
      changeIndex: number;
    });

export interface McpTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: McpTraceContextOperationMetadataV1;
  /** Fetched genesis-to-head events. They are cloned and frozen at entry. */
  chain: readonly ProtocolEvent[];
  /** Trusted cryptographic verifier injected by the owning MCP runtime. */
  verifyEvent: TraceEventVerifier;
  processFactRequests: readonly McpProcessFactRequestV1[];
  limits?: TraceContextSelectionLimitsV1;
}

interface CapturedAdapterInput {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: McpTraceContextOperationMetadataV1;
  chain: readonly ProtocolEvent[];
  verifyEvent: TraceEventVerifier;
  processFactRequests: readonly McpProcessFactRequestV1[];
  limits?: TraceContextSelectionLimitsV1;
}

interface DerivedRead {
  traceId: string;
  headId: string;
  contentHash: string;
  currentText: string;
  chosenPath: string;
}

interface VerificationResult {
  verdict: TraceConformanceVerdict;
  headSignatureValid: boolean;
}

/**
 * Verify and map one fetched MCP file chain into the shared selector contract.
 * Non-FULL process status is carried to the selector; a signed, hash-valid head
 * remains usable under text-only policy even when history or process is bad.
 */
export async function adaptVerifiedMcpFileForTraceContextSelectionV1(
  input: McpTraceContextSelectionAdapterInputV1,
): Promise<TraceContextSelectionInputV1> {
  const captured = captureInput(input);
  requireVersion(captured.version, "input");
  requireVersion(captured.operation.version, "operation");
  if (captured.chain.length === 0) fail("fetched file chain is empty");

  const verification = await verifyCapturedChain(captured.chain, captured.verifyEvent);
  const read = deriveRead(captured.chain, verification);
  const candidates = verification.verdict.status === "full"
    ? captured.processFactRequests.map((request) =>
        processCandidate(read, captured.chain, verification.verdict, "full-trace", request))
    : [statusCandidate(
        read,
        captured.chain,
        verification.verdict,
        verification.verdict.status === "snapshot-only" ? "snapshot-only" : "invalid",
      )];
  requireDistinctCandidates(candidates);

  return {
    version: 1,
    policy: captured.policy,
    operation: {
      version: 1,
      operation: captured.operation.operation,
      target: {
        traceId: read.traceId,
        headId: read.headId,
        contentHash: read.contentHash,
        currentText: read.currentText,
        chosenPath: read.chosenPath,
      },
      ...(captured.operation.range ? { range: copyRange(captured.operation.range) } : {}),
      maxContextBytes: captured.operation.maxContextBytes,
      preparedRequestMaxBytes: captured.operation.preparedRequestMaxBytes,
      reservedPromptBytes: captured.operation.reservedPromptBytes,
    },
    candidates,
    ...(captured.limits ? { limits: { ...captured.limits } } : {}),
  };
}

function captureInput(input: McpTraceContextSelectionAdapterInputV1): CapturedAdapterInput {
  const chain = input.chain.map((event) => cloneEvent(event));
  const processFactRequests = input.processFactRequests.map((request) => cloneRequest(request));
  const captured: CapturedAdapterInput = {
    version: input.version,
    policy: input.policy,
    operation: {
      version: input.operation.version,
      operation: input.operation.operation,
      ...(input.operation.range ? { range: copyRange(input.operation.range) } : {}),
      maxContextBytes: input.operation.maxContextBytes,
      preparedRequestMaxBytes: input.operation.preparedRequestMaxBytes,
      reservedPromptBytes: input.operation.reservedPromptBytes,
    },
    chain,
    verifyEvent: input.verifyEvent,
    processFactRequests,
    ...(input.limits ? { limits: { ...input.limits } } : {}),
  };
  return deepFreeze(captured);
}

function cloneEvent(event: ProtocolEvent): ProtocolEvent {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  };
}

function cloneRequest(request: McpProcessFactRequestV1): McpProcessFactRequestV1 {
  switch (request.kind) {
    case "step-summary":
      return {
        version: request.version,
        kind: request.kind,
        nodeId: request.nodeId,
        chainDistance: request.chainDistance,
      };
    case "transaction":
      return {
        version: request.version,
        kind: request.kind,
        nodeId: request.nodeId,
        chainDistance: request.chainDistance,
        transactionIndex: request.transactionIndex,
      };
    case "change":
      return {
        version: request.version,
        kind: request.kind,
        nodeId: request.nodeId,
        chainDistance: request.chainDistance,
        transactionIndex: request.transactionIndex,
        changeIndex: request.changeIndex,
      };
  }
}

async function verifyCapturedChain(
  chain: readonly ProtocolEvent[],
  verifyEvent: TraceEventVerifier,
): Promise<VerificationResult> {
  const verificationByEvent = new Map<string, boolean>();
  const recordingVerifier: TraceEventVerifier = (event) => {
    const identity = eventIdentity(event);
    const verified = verifyEvent(event);
    verificationByEvent.set(identity, verified);
    return verified;
  };
  const verdict = await verifyFileTraceChain(chain, recordingVerifier, {
    expectedNucleusId: chain[chain.length - 1]!.id,
    expectedTraceId: chain[0]!.id,
  });
  const head = chain[chain.length - 1]!;
  return {
    verdict,
    headSignatureValid: verificationByEvent.get(eventIdentity(head)) === true,
  };
}

function deriveRead(
  chain: readonly ProtocolEvent[],
  verification: VerificationResult,
): DerivedRead {
  const headIndex = chain.length - 1;
  const head = chain[headIndex]!;
  if (!verification.headSignatureValid) {
    fail("fetched head did not pass the injected trusted event verifier");
  }
  const headIntegrityIssue = verification.verdict.issues.find(
    (issue) => issue.kind === "integrity" && issue.stepIndex === headIndex,
  );
  if (headIntegrityIssue) {
    fail(`fetched head is not a valid signed snapshot: ${headIntegrityIssue.code}`);
  }
  if (verification.verdict.steps.length !== chain.length) {
    fail("internal verification did not cover the captured chain");
  }

  const pathTags = head.tags.filter((tag) => tag[0] === "F");
  if (pathTags.length !== 1 || !pathTags[0]?.[1]) {
    fail("verified head does not carry exactly one structural path");
  }
  let payload: { snapshot?: unknown; contentHash?: unknown };
  try {
    payload = JSON.parse(head.content) as typeof payload;
  } catch {
    fail("verified head payload is not valid JSON");
  }
  if (typeof payload.snapshot !== "string" || typeof payload.contentHash !== "string") {
    fail("verified head does not carry an exact text snapshot and content hash");
  }
  return {
    traceId: chain[0]!.id,
    headId: head.id,
    contentHash: payload.contentHash,
    currentText: payload.snapshot,
    chosenPath: pathTags[0][1]!,
  };
}

function statusCandidate(
  read: DerivedRead,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
  processStatus: Exclude<TraceProcessStatusV1, "full-trace">,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  const headIndex = chain.length - 1;
  const step = verdict.steps[headIndex];
  if (!step || step.nodeId !== read.headId) {
    fail("non-FULL verdict does not bind the captured head Step");
  }
  const summary = summarizeTraceProcess(step.process);
  const fact: Extract<TraceProcessFactV1, { kind: "step-summary" }> = {
    kind: "step-summary",
    transactionCount: summary.transactions,
    rangeCount: summary.ranges,
    insertedCodePointCount: summary.inserted,
    deletedCodePointCount: summary.deleted,
    ...(summary.firstAt !== null ? { firstCapturedAtMs: summary.firstAt } : {}),
    ...(summary.lastAt !== null ? { lastCapturedAtMs: summary.lastAt } : {}),
    spanMs: summary.spanMs,
    longestGapMs: summary.longestGapMs,
    undoCount: summary.undo,
    redoCount: summary.redo,
  };
  return candidate(read, read.headId, 0, 0, undefined, processStatus, fact);
}

function processCandidate(
  read: DerivedRead,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
  processStatus: "full-trace",
  request: McpProcessFactRequestV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  requireVersion(request.version, "process fact request");
  if (!Number.isSafeInteger(request.chainDistance) || request.chainDistance < 0) {
    fail("process fact chain distance must be a non-negative safe integer");
  }
  const stepIndex = chain.length - 1 - request.chainDistance;
  const event = chain[stepIndex];
  const step = verdict.steps[stepIndex];
  if (!event || !step || event.id !== request.nodeId || step.nodeId !== request.nodeId) {
    fail("process fact node and distance do not bind the internally verified chain");
  }
  if (step.status !== "full" || step.process.status !== "complete") {
    fail("requested fact does not bind a FULL internally verified process Step");
  }

  switch (request.kind) {
    case "step-summary":
      return candidate(
        read,
        request.nodeId,
        request.chainDistance,
        0,
        undefined,
        processStatus,
        summaryFact(step),
      );
    case "transaction":
      return candidate(
        read,
        request.nodeId,
        request.chainDistance,
        request.transactionIndex,
        undefined,
        processStatus,
        transactionFact(
          requireTransaction(step, request.transactionIndex),
          request.transactionIndex,
        ),
      );
    case "change": {
      const transaction = requireTransaction(step, request.transactionIndex);
      if (!Number.isSafeInteger(request.changeIndex) || request.changeIndex < 0) {
        fail("change facts require a non-negative safe change index");
      }
      const change = transaction.changes[request.changeIndex];
      if (!change) fail("change index does not bind the verified transaction");
      return candidate(
        read,
        request.nodeId,
        request.chainDistance,
        request.transactionIndex,
        request.changeIndex,
        processStatus,
        changeFact(change, request.transactionIndex),
      );
    }
  }
}

function candidate(
  read: DerivedRead,
  nodeId: string,
  chainDistance: number,
  transactionIndex: number,
  changeIndex: number | undefined,
  processStatus: TraceProcessStatusV1,
  fact: TraceProcessFactV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  const ref = `mcp-trace:${read.traceId}:${nodeId}:${factSuffix(fact, changeIndex)}`;
  return {
    version: 1,
    id: ref,
    dedupeKey: ref,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref,
      traceId: read.traceId,
      headId: read.headId,
      nodeId,
      processStatus,
      chainDistance,
      transactionIndex,
      ...(fact.kind === "change" ? { range: copyRange(fact.range) } : {}),
    },
    reasons: [chainDistance === 0 ? "prepared-head-process" : "recent-target-process"],
    fact,
  };
}

function summaryFact(step: TraceConformanceStep): Extract<TraceProcessFactV1, { kind: "step-summary" }> {
  const summary = summarizeTraceProcess(step.process);
  return {
    kind: "step-summary",
    transactionCount: summary.transactions,
    rangeCount: summary.ranges,
    insertedCodePointCount: summary.inserted,
    deletedCodePointCount: summary.deleted,
    ...(summary.firstAt !== null ? { firstCapturedAtMs: summary.firstAt } : {}),
    ...(summary.lastAt !== null ? { lastCapturedAtMs: summary.lastAt } : {}),
    spanMs: summary.spanMs,
    longestGapMs: summary.longestGapMs,
    undoCount: summary.undo,
    redoCount: summary.redo,
  };
}

function requireTransaction(
  step: TraceConformanceStep,
  transactionIndex: number,
): TraceProcessTransaction {
  if (!Number.isSafeInteger(transactionIndex) || transactionIndex < 0) {
    fail("transaction index must be a non-negative safe integer");
  }
  const transaction = step.process.transactions[transactionIndex];
  if (!transaction) fail("transaction index does not bind the verified Step process");
  return transaction;
}

function transactionFact(
  transaction: TraceProcessTransaction,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "transaction" }> {
  return {
    kind: "transaction",
    transactionIndex,
    capturedAtMs: transaction.at,
    ...(transaction.intent ? { intent: transaction.intent } : {}),
    changeCount: transaction.changes.length,
    voiceIds: [...new Set(transaction.changes.map((change) => change.voice))].sort(),
  };
}

function changeFact(
  change: TraceProcessChange,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "change" }> {
  const insertedCodePointCount = codePointCount(change.inserted);
  const deletedCodePointCount = codePointCount(change.deleted);
  if (insertedCodePointCount === 0 && deletedCodePointCount === 0) {
    fail("a no-op range has no selector change-fact shape; request its Step summary or transaction");
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

function eventIdentity(event: ProtocolEvent): string {
  return JSON.stringify([
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
    event.sig,
  ]);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function requireVersion(version: number, subject: string): void {
  if (version !== 1) fail(`${subject} version must be 1`);
}

function copyRange(range: Utf16Range): Utf16Range {
  return { fromUtf16: range.fromUtf16, toUtf16: range.toUtf16 };
}

function codePointCount(value: string): number {
  return [...value].length;
}

function fail(message: string): never {
  throw new Error(`MCP trace-context adapter: ${message}`);
}
