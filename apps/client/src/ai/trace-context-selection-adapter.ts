import {
  summarizeTraceProcess,
  type TraceConformanceStep,
  type TraceConformanceVerdict,
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
  Utf16Range,
} from "@zine/trace-context";

/**
 * Snapshot projection emitted only after the desktop reader has verified the
 * exact trace ending at `headId`. This adapter intentionally does not fetch or
 * verify the chain itself; live ContextSnapshot wiring is a later phase.
 */
export interface DesktopVerifiedSnapshotProjectionV1 {
  version: 1;
  traceId: string;
  headId: string;
  contentHash: string;
  currentText: string;
  chosenPath: string;
  /** Authoritative result returned by the shared protocol verifier. */
  verdict: TraceConformanceVerdict;
}

export interface DesktopTraceContextOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

/**
 * Exact binding to one fact in a FULL verified Step. Transaction and change
 * indexes are zero-based ordinals in the verified process, not KEdit tx ids.
 * Step summaries use transactionIndex zero and omit changeIndex.
 */
export interface DesktopBoundProcessFactV1 {
  version: 1;
  traceId: string;
  headId: string;
  nodeId: string;
  chainDistance: number;
  transactionIndex: number;
  changeIndex?: number;
  fact: TraceProcessFactV1;
}

export interface DesktopTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: DesktopTraceContextOperationMetadataV1;
  snapshot: DesktopVerifiedSnapshotProjectionV1;
  processFacts: readonly DesktopBoundProcessFactV1[];
  limits?: TraceContextSelectionLimitsV1;
}

export class DesktopTraceContextSelectionAdapterError extends Error {
  constructor(message: string) {
    super(`Desktop trace-context adapter: ${message}`);
    this.name = "DesktopTraceContextSelectionAdapterError";
  }
}

/**
 * Purely maps one already-validated desktop snapshot and its verified process
 * entries into selector input. It performs no I/O, signing, storage, model
 * calls, inference, or PreparedOperation/App wiring.
 */
export function adaptDesktopTraceContextSelectionV1(
  input: DesktopTraceContextSelectionAdapterInputV1,
): TraceContextSelectionInputV1 {
  requireVersion(input.version, "input");
  requirePolicy(input.policy);
  requireOperation(input.operation);
  requireSnapshot(input.snapshot);
  const steps = requireFullVerdict(input.snapshot);

  const candidates = input.processFacts.map((binding) =>
    processCandidate(input.snapshot, steps, binding));
  requireDistinctCandidates(candidates);

  return {
    version: 1,
    policy: input.policy,
    operation: {
      version: 1,
      operation: input.operation.operation,
      target: {
        traceId: input.snapshot.traceId,
        headId: input.snapshot.headId,
        contentHash: input.snapshot.contentHash,
        currentText: input.snapshot.currentText,
        chosenPath: input.snapshot.chosenPath,
      },
      ...(input.operation.range ? { range: copyRange(input.operation.range) } : {}),
      maxContextBytes: input.operation.maxContextBytes,
      preparedRequestMaxBytes: input.operation.preparedRequestMaxBytes,
      reservedPromptBytes: input.operation.reservedPromptBytes,
    },
    candidates,
    ...(input.limits ? { limits: { ...input.limits } } : {}),
  };
}

function requireFullVerdict(snapshot: DesktopVerifiedSnapshotProjectionV1): readonly TraceConformanceStep[] {
  const { verdict } = snapshot;
  if (verdict.status !== "full") {
    fail(`authoritative verdict must be full, received ${verdict.status}`);
  }
  if (verdict.issues.length !== 0) {
    fail("a full authoritative verdict cannot carry conformance issues");
  }
  if (verdict.steps.length === 0) fail("authoritative verdict has no verified Steps");

  const nodeIds = new Set<string>();
  for (let index = 0; index < verdict.steps.length; index += 1) {
    const step = verdict.steps[index]!;
    if (
      step.stepIndex !== index
      || step.status !== "full"
      || step.process.status !== "complete"
    ) {
      fail(`authoritative verdict step ${index} is not a contiguous FULL process Step`);
    }
    if (nodeIds.has(step.nodeId)) fail(`authoritative verdict repeats node ${step.nodeId}`);
    nodeIds.add(step.nodeId);
  }
  if (verdict.steps[0]!.nodeId !== snapshot.traceId) {
    fail("snapshot trace id does not bind the verified genesis Step");
  }
  if (verdict.steps[verdict.steps.length - 1]!.nodeId !== snapshot.headId) {
    fail("snapshot head id does not bind the final verified Step");
  }
  return verdict.steps;
}

function processCandidate(
  snapshot: DesktopVerifiedSnapshotProjectionV1,
  steps: readonly TraceConformanceStep[],
  binding: DesktopBoundProcessFactV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  requireVersion(binding.version, "process fact binding");
  if (binding.traceId !== snapshot.traceId || binding.headId !== snapshot.headId) {
    fail("process fact does not bind the exact snapshot trace and head");
  }
  if (!Number.isSafeInteger(binding.chainDistance) || binding.chainDistance < 0) {
    fail("process fact chain distance must be a non-negative safe integer");
  }
  const stepIndex = steps.length - 1 - binding.chainDistance;
  const step = steps[stepIndex];
  if (!step || step.nodeId !== binding.nodeId) {
    fail("process fact node and distance do not bind a verified Step");
  }
  if (step.status !== "full" || step.process.status !== "complete") {
    fail("process fact does not bind a FULL verified process Step");
  }

  const authoritative = authoritativeFact(step, binding);
  requireExactClosedFact(binding.fact, authoritative);
  const suffix = factSuffix(binding.fact, binding.changeIndex);
  const ref = `desktop-trace:${snapshot.traceId}:${binding.nodeId}:${suffix}`;
  return {
    version: 1,
    id: ref,
    dedupeKey: ref,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref,
      traceId: snapshot.traceId,
      headId: snapshot.headId,
      nodeId: binding.nodeId,
      processStatus: "full-trace",
      chainDistance: binding.chainDistance,
      transactionIndex: binding.transactionIndex,
      ...(binding.fact.kind === "change" ? { range: copyRange(binding.fact.range) } : {}),
    },
    reasons: [binding.chainDistance === 0 ? "prepared-head-process" : "recent-target-process"],
    fact: authoritative,
  };
}

function authoritativeFact(
  step: TraceConformanceStep,
  binding: DesktopBoundProcessFactV1,
): TraceProcessFactV1 {
  if (step.process.status !== "complete") fail("verified Step process is not complete");
  switch (binding.fact.kind) {
    case "step-summary": {
      if (binding.transactionIndex !== 0 || binding.changeIndex !== undefined) {
        fail("Step summaries require transaction index zero and no change index");
      }
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
    case "transaction": {
      if (binding.changeIndex !== undefined) fail("transaction facts cannot carry a change index");
      return transactionFact(requireTransaction(step, binding.transactionIndex), binding.transactionIndex);
    }
    case "change": {
      const transaction = requireTransaction(step, binding.transactionIndex);
      if (!Number.isSafeInteger(binding.changeIndex) || (binding.changeIndex ?? -1) < 0) {
        fail("change facts require a non-negative safe change index");
      }
      const change = transaction.changes[binding.changeIndex!];
      if (!change) fail("change index does not bind the verified transaction");
      return changeFact(change, binding.transactionIndex);
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
  if (step.process.status !== "complete") fail("verified Step process is not complete");
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

function requireExactClosedFact(actual: TraceProcessFactV1, expected: TraceProcessFactV1): void {
  const actualKeys = Object.keys(actual).sort().join("\0");
  const expectedKeys = Object.keys(expected).sort().join("\0");
  const rangeKeysMatch = actual.kind !== "change" || expected.kind !== "change"
    || Object.keys(actual.range).sort().join("\0") === Object.keys(expected.range).sort().join("\0");
  if (
    actualKeys !== expectedKeys
    || !rangeKeysMatch
    || closedFactIdentity(actual) !== closedFactIdentity(expected)
  ) {
    fail("closed process fact does not exactly match its verified Step binding");
  }
}

function closedFactIdentity(fact: TraceProcessFactV1): string {
  switch (fact.kind) {
    case "step-summary":
      return JSON.stringify({
        kind: fact.kind,
        transactionCount: fact.transactionCount,
        rangeCount: fact.rangeCount,
        insertedCodePointCount: fact.insertedCodePointCount,
        deletedCodePointCount: fact.deletedCodePointCount,
        firstCapturedAtMs: fact.firstCapturedAtMs,
        lastCapturedAtMs: fact.lastCapturedAtMs,
        spanMs: fact.spanMs,
        longestGapMs: fact.longestGapMs,
        undoCount: fact.undoCount,
        redoCount: fact.redoCount,
      });
    case "transaction":
      return JSON.stringify({
        kind: fact.kind,
        transactionIndex: fact.transactionIndex,
        capturedAtMs: fact.capturedAtMs,
        intent: fact.intent,
        changeCount: fact.changeCount,
        voiceIds: fact.voiceIds,
      });
    case "change":
      return JSON.stringify({
        kind: fact.kind,
        transactionIndex: fact.transactionIndex,
        operation: fact.operation,
        range: fact.range,
        insertedCodePointCount: fact.insertedCodePointCount,
        deletedCodePointCount: fact.deletedCodePointCount,
        voiceId: fact.voiceId,
      });
  }
}

function factSuffix(fact: TraceProcessFactV1, changeIndex: number | undefined): string {
  if (fact.kind === "step-summary") return "summary";
  if (fact.kind === "transaction") return `transaction:${fact.transactionIndex}`;
  return `transaction:${fact.transactionIndex}:change:${changeIndex}`;
}

function requireDistinctCandidates(candidates: readonly EvidenceCandidateV1[]): void {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    if (ids.has(candidate.id)) fail(`duplicate process fact binding ${candidate.id}`);
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
  if (operation.range) requireRange(operation.range, "operation range");
  requirePositiveInteger(operation.maxContextBytes, "maxContextBytes");
  requirePositiveInteger(operation.preparedRequestMaxBytes, "preparedRequestMaxBytes");
  if (!Number.isSafeInteger(operation.reservedPromptBytes) || operation.reservedPromptBytes < 0) {
    fail("reservedPromptBytes must be a non-negative safe integer");
  }
  if (operation.reservedPromptBytes >= operation.preparedRequestMaxBytes) {
    fail("reservedPromptBytes must be less than preparedRequestMaxBytes");
  }
}

function requireSnapshot(snapshot: DesktopVerifiedSnapshotProjectionV1): void {
  requireVersion(snapshot.version, "snapshot");
  for (const [name, value] of [
    ["traceId", snapshot.traceId],
    ["headId", snapshot.headId],
    ["contentHash", snapshot.contentHash],
    ["chosenPath", snapshot.chosenPath],
  ] as const) {
    if (value.length === 0) fail(`snapshot ${name} must be non-empty`);
  }
  if (typeof snapshot.currentText !== "string") fail("snapshot currentText must be a string");
}

function requireRange(range: Utf16Range, subject: string): void {
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

function fail(message: string): never {
  throw new DesktopTraceContextSelectionAdapterError(message);
}
