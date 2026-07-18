/**
 * Pure MCP boundary for the package-local trace-context selector.
 *
 * This adapter consumes only an already fetched and authoritatively verified
 * file chain. It does not fetch, verify signatures, sign, store, call a model,
 * or infer prose claims. Callers remain responsible for obtaining the chain
 * and its `verifyFileTraceChain` verdict before entering this boundary.
 */
import {
  summarizeTraceProcess,
  type ProtocolEvent,
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
} from "../../../packages/trace-context/src/index.js";

export interface McpVerifiedFileReadProjectionV1 {
  version: 1;
  traceId: string;
  headId: string;
  contentHash: string;
  currentText: string;
  chosenPath: string;
}

export interface McpTraceContextOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

/**
 * Binding supplied beside one already closed selector fact. Transaction and
 * change indexes are zero-based ordinals in the verified Step process, not the
 * caller-authored KEdit `tx` value. Step summaries use transaction index zero.
 */
export interface McpBoundProcessFactV1 {
  version: 1;
  traceId: string;
  headId: string;
  nodeId: string;
  chainDistance: number;
  transactionIndex: number;
  changeIndex?: number;
  fact: TraceProcessFactV1;
}

export interface McpTraceContextSelectionAdapterInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: McpTraceContextOperationMetadataV1;
  read: McpVerifiedFileReadProjectionV1;
  /** Exact fetched genesis-to-head order used to produce `verdict`. */
  chain: readonly ProtocolEvent[];
  /** Authoritative result returned by the shared protocol verifier. */
  verdict: TraceConformanceVerdict;
  processFacts: readonly McpBoundProcessFactV1[];
  limits?: TraceContextSelectionLimitsV1;
}

/**
 * Map a verified MCP file read and mechanically closed process facts into the
 * selector's exact V1 input. Trust-bearing mismatches throw before selection.
 */
export function adaptVerifiedMcpFileForTraceContextSelectionV1(
  input: McpTraceContextSelectionAdapterInputV1,
): TraceContextSelectionInputV1 {
  requireVersion(input.version, "input");
  requireVersion(input.operation.version, "operation");
  requireVersion(input.read.version, "read projection");
  const head = requireVerifiedChainBinding(input);
  requireReadBinding(input.read, input.chain, head);

  const candidates = input.processFacts.map((binding) =>
    processCandidate(input.read, input.chain, input.verdict, binding));
  requireDistinctCandidates(candidates);

  return {
    version: 1,
    policy: input.policy,
    operation: {
      version: 1,
      operation: input.operation.operation,
      target: {
        traceId: input.read.traceId,
        headId: input.read.headId,
        contentHash: input.read.contentHash,
        currentText: input.read.currentText,
        chosenPath: input.read.chosenPath,
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

function requireVerifiedChainBinding(
  input: McpTraceContextSelectionAdapterInputV1,
): ProtocolEvent {
  if (input.chain.length === 0) fail("verified file chain is empty");
  if (input.verdict.status !== "full") {
    fail(`authoritative verdict must be full, received ${input.verdict.status}`);
  }
  if (input.verdict.issues.length !== 0) {
    fail("a full authoritative verdict cannot carry conformance issues");
  }
  if (input.verdict.steps.length !== input.chain.length) {
    fail("authoritative verdict steps do not cover the exact supplied chain");
  }
  for (let index = 0; index < input.chain.length; index += 1) {
    const event = input.chain[index]!;
    const step = input.verdict.steps[index];
    if (
      !step
      || step.stepIndex !== index
      || step.nodeId !== event.id
      || step.status !== "full"
      || step.process.status !== "complete"
    ) {
      fail(`authoritative verdict step ${index} does not bind the supplied chain`);
    }
  }
  return input.chain[input.chain.length - 1]!;
}

function requireReadBinding(
  read: McpVerifiedFileReadProjectionV1,
  chain: readonly ProtocolEvent[],
  head: ProtocolEvent,
): void {
  if (read.traceId !== chain[0]!.id) {
    fail("read trace id does not bind the verified genesis");
  }
  if (read.headId !== head.id) {
    fail("read head id does not bind the verified nucleus");
  }
  const paths = head.tags.filter((tag) => tag[0] === "F");
  if (paths.length !== 1 || paths[0]?.[1] !== read.chosenPath) {
    fail("read path does not bind the verified nucleus path");
  }
  let payload: { snapshot?: unknown; contentHash?: unknown };
  try {
    payload = JSON.parse(head.content) as typeof payload;
  } catch {
    fail("verified nucleus payload is not valid JSON");
  }
  if (payload.snapshot !== read.currentText) {
    fail("current text does not bind the verified nucleus snapshot");
  }
  if (payload.contentHash !== read.contentHash) {
    fail("content hash does not bind the verified nucleus payload");
  }
}

function processCandidate(
  read: McpVerifiedFileReadProjectionV1,
  chain: readonly ProtocolEvent[],
  verdict: TraceConformanceVerdict,
  binding: McpBoundProcessFactV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  requireVersion(binding.version, "process fact binding");
  if (binding.traceId !== read.traceId || binding.headId !== read.headId) {
    fail("process fact does not bind the exact target trace and head");
  }
  if (!Number.isSafeInteger(binding.chainDistance) || binding.chainDistance < 0) {
    fail("process fact chain distance must be a non-negative safe integer");
  }
  const stepIndex = chain.length - 1 - binding.chainDistance;
  const event = chain[stepIndex];
  const step = verdict.steps[stepIndex];
  if (!event || !step || event.id !== binding.nodeId || step.nodeId !== binding.nodeId) {
    fail("process fact node and distance do not bind the verified chain");
  }
  if (step.status !== "full" || step.process.status !== "complete") {
    fail("process fact does not bind a Full Trace process Step");
  }

  const authoritative = authoritativeFact(step, binding);
  requireExactClosedFact(binding.fact, authoritative);
  const suffix = factSuffix(binding.fact, binding.changeIndex);
  const ref = `mcp-trace:${read.traceId}:${binding.nodeId}:${suffix}`;
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
  binding: McpBoundProcessFactV1,
): TraceProcessFactV1 {
  if (step.process.status !== "complete") {
    fail("process fact is not backed by a complete verified process");
  }
  switch (binding.fact.kind) {
    case "step-summary": {
      if (binding.transactionIndex !== 0 || binding.changeIndex !== undefined) {
        fail("Step summaries must use the zero summary binding without a change index");
      }
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
    case "transaction": {
      if (binding.changeIndex !== undefined) {
        fail("transaction facts cannot carry a change index");
      }
      const transaction = requireTransaction(step, binding.transactionIndex);
      return transactionFact(transaction, binding.transactionIndex);
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
  const insertedCodePointCount = codePointCount(change.inserted);
  const deletedCodePointCount = codePointCount(change.deleted);
  if (insertedCodePointCount === 0 && deletedCodePointCount === 0) {
    fail("a no-op range has no selector change-fact shape; bind its Step summary or transaction");
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
    fail("closed process fact does not exactly match its verified process binding");
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
