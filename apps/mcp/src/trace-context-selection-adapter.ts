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
  traceProcessFromEvent,
  verifyFileTraceChain,
  type ProtocolEvent,
  type TraceConformanceStep,
  type TraceConformanceVerdict,
  type TraceEventVerifier,
} from "@zine/protocol";
import {
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
} from "../../../packages/trace-context/src/index.js";

export interface McpTraceContextOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

export interface McpTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: McpTraceContextOperationMetadataV1;
  /** Fetched genesis-to-head events. They are cloned and frozen at entry. */
  chain: readonly ProtocolEvent[];
  /** Trusted cryptographic verifier injected by the owning MCP runtime. */
  verifyEvent: TraceEventVerifier;
  limits?: TraceContextSelectionLimitsV1;
}

interface CapturedAdapterInput {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: McpTraceContextOperationMetadataV1;
  chain: readonly ProtocolEvent[];
  verifyEvent: TraceEventVerifier;
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
  if (captured.operation.range) {
    requireOperationRange(captured.operation.range, read.currentText);
  }
  const candidates = captured.policy === "text-only-v1"
    ? []
    : verification.verdict.status === "full"
    ? projectTraceProcessCandidatesV1(
        fullProcessProjection(read, captured.chain, verification.verdict),
      )
    : [statusCandidate(
        read,
        captured.chain,
        verification.verdict,
        verification.verdict.status === "snapshot-only" ? "snapshot-only" : "invalid",
      )];
  requireDistinctCandidates(candidates);

  const output: TraceContextSelectionInputV1 = {
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
  return deepFreeze(output);
}

function captureInput(input: McpTraceContextSelectionAdapterInputV1): CapturedAdapterInput {
  const chain = input.chain.map((event) => cloneEvent(event));
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
  const head = chain[headIndex]!;
  const step = verdict.steps[headIndex];
  if (!step || step.stepIndex !== headIndex || step.nodeId !== read.headId) {
    fail("non-FULL verdict does not bind the captured head Step");
  }
  const process = traceProcessFromEvent(head, previousSnapshotBefore(chain, headIndex));
  requireMatchingProcess(step, process);
  const summary = summarizeTraceProcess(process);
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
  const ref = `trace-process-v1:${read.traceId}:${read.headId}:summary`;
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
      nodeId: read.headId,
      processStatus,
      chainDistance: 0,
      transactionIndex: 0,
    },
    reasons: ["prepared-head-process"],
    fact,
  };
}

function fullProcessProjection(
  read: DerivedRead,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
): TraceContextProcessProjectionInputV1 {
  if (verdict.status !== "full") fail("FULL process projection requires a FULL verified verdict");
  if (read.traceId !== chain[0]?.id || read.headId !== chain[chain.length - 1]?.id) {
    fail("verified read does not bind the captured trace and head");
  }
  let previousSnapshot = "";
  const steps = chain.map((event, stepIndex) => {
    const step = verdict.steps[stepIndex];
    if (!step
      || step.stepIndex !== stepIndex
      || step.nodeId !== event.id
      || step.status !== "full") {
      fail("FULL verdict Step does not bind the captured chain");
    }
    const process = traceProcessFromEvent(event, previousSnapshot);
    requireMatchingProcess(step, process);
    if (process.status !== "complete") {
      fail("FULL verdict does not carry a complete verified process Step");
    }
    previousSnapshot = signedSnapshot(event);
    return {
      version: 1 as const,
      nodeId: event.id,
      chainDistance: chain.length - stepIndex - 1,
      transactions: process.transactions.map((transaction) => ({
        version: 1 as const,
        sourceTransactionId: transaction.tx,
        capturedAtMs: transaction.at,
        ...(transaction.intent ? { intent: transaction.intent } : {}),
        changes: transaction.changes.map((change) => ({
          version: 1 as const,
          operation: change.op === "ins"
            ? "insert" as const
            : change.op === "del" ? "delete" as const : "replace" as const,
          range: { fromUtf16: change.from, toUtf16: change.to },
          insertedText: change.inserted,
          deletedText: change.deleted,
          voiceId: change.voice,
        })),
      })),
    };
  });
  return { version: 1, traceId: read.traceId, headId: read.headId, steps };
}

function requireMatchingProcess(
  step: TraceConformanceStep,
  process: ReturnType<typeof traceProcessFromEvent>,
): void {
  if (JSON.stringify(step.process) !== JSON.stringify(process)) {
    fail("verified verdict process does not bind the captured signed chain");
  }
}

function previousSnapshotBefore(chain: readonly ProtocolEvent[], endIndex: number): string {
  let previousSnapshot = "";
  for (let index = 0; index < endIndex; index += 1) {
    const event = chain[index]!;
    try {
      const payload = JSON.parse(event.content) as { snapshot?: unknown };
      if (typeof payload.snapshot === "string") previousSnapshot = payload.snapshot;
    } catch {
      // Match the protocol verifier: malformed ancestry does not replace the
      // last available snapshot and the global verdict remains non-FULL.
    }
  }
  return previousSnapshot;
}

function signedSnapshot(event: ProtocolEvent): string {
  let payload: { snapshot?: unknown };
  try {
    payload = JSON.parse(event.content) as typeof payload;
  } catch {
    fail("verified process Step payload is not valid JSON");
  }
  if (typeof payload.snapshot !== "string") fail("verified process Step has no signed snapshot");
  return payload.snapshot;
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

function requireOperationRange(range: Utf16Range, currentText: string): void {
  if (!Number.isSafeInteger(range.fromUtf16)
    || !Number.isSafeInteger(range.toUtf16)
    || range.fromUtf16 < 0
    || range.toUtf16 < range.fromUtf16
    || range.toUtf16 > currentText.length) {
    fail(`operation range must be within the verified head snapshot [0, ${currentText.length}]`);
  }
  if (!isUtf16Boundary(currentText, range.fromUtf16)
    || !isUtf16Boundary(currentText, range.toUtf16)) {
    fail("operation range must not split a UTF-16 surrogate pair in the verified head snapshot");
  }
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function copyRange(range: Utf16Range): Utf16Range {
  return { fromUtf16: range.fromUtf16, toUtf16: range.toUtf16 };
}

function fail(message: string): never {
  throw new Error(`MCP trace-context adapter: ${message}`);
}
