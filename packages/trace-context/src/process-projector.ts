import type {
  EvidenceCandidateV1,
  TraceProcessFactV1,
} from "./selection-types.js";
import { TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1 } from "./selection-types.js";
import type { Utf16Range } from "./types.js";

const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;
const VOICE_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;
const NON_PUBKEY_ACTOR_PREFIX = "editor-transaction-actor-utf16-v1:";

export interface TraceContextProcessProjectionChangeV1 {
  version: 1;
  operation: "insert" | "delete" | "replace";
  range: Utf16Range;
  insertedText: string;
  deletedText: string;
  voiceId: string;
}

export interface TraceContextProcessProjectionTransactionV1 {
  version: 1;
  /** Signed source transaction sequence; output identity uses the array ordinal. */
  sourceTransactionId: number;
  capturedAtMs: number;
  /** EditorTransaction actor preserved even when the transaction changes only selection. */
  actor: string;
  intent?: "undo" | "redo";
  changes: readonly TraceContextProcessProjectionChangeV1[];
}

export interface TraceContextProcessProjectionStepV1 {
  version: 1;
  nodeId: string;
  chainDistance: number;
  transactions: readonly TraceContextProcessProjectionTransactionV1[];
}

/**
 * Surface-neutral process view constructed only after authoritative chain and
 * process verification. This package does not verify signatures or provenance.
 */
export interface TraceContextProcessProjectionInputV1 {
  version: 1;
  traceId: string;
  headId: string;
  steps: readonly TraceContextProcessProjectionStepV1[];
}

export interface TraceContextProcessProjectionOptionsV1 {
  signal?: AbortSignal;
  maxCandidates?: number;
  maxInputBytes?: number;
  maxCandidateInputBytes?: number;
}

/**
 * Deterministically enumerate closed process candidates for every supplied
 * verified Step. Identity is press-neutral and transaction/change indexes are
 * zero-based process-array ordinals, never signed EditorTransaction transaction ids.
 */
export function projectTraceProcessCandidatesV1(
  input: TraceContextProcessProjectionInputV1,
): readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] {
  validateInput(input);
  return projectSynchronously(input);
}

/**
 * Adapter-facing projection with bounded materialization and cooperative
 * cancellation. The synchronous projector remains available for small pure
 * callers; chain adapters must use this variant before invoking the selector.
 */
export async function projectTraceProcessCandidatesV1Async(
  input: TraceContextProcessProjectionInputV1,
  options: TraceContextProcessProjectionOptionsV1 = {},
): Promise<readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[]> {
  validateProjectionOptions(options);
  if (options.signal?.aborted) fail("projection was cancelled");
  await yieldToHost();
  if (options.signal?.aborted) fail("projection was cancelled");
  validateInput(input);

  const candidates: Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] = [];
  const bounds = projectionBounds(options);
  const orderedSteps = [...input.steps].sort((left, right) =>
    left.chainDistance - right.chainDistance || compareUtf8(left.nodeId, right.nodeId));
  let workIndex = 0;
  const append = boundedAppender(candidates, bounds);

  for (const step of orderedSteps) {
    if (options.signal && workIndex % 256 === 0) {
      await yieldToHost();
      if (options.signal.aborted) fail("projection was cancelled");
    }
    workIndex += 1;
    append(candidate(input, step, 0, "summary", summaryFact(step)));
    for (let transactionIndex = 0; transactionIndex < step.transactions.length; transactionIndex += 1) {
      const transaction = step.transactions[transactionIndex]!;
      if (options.signal && workIndex % 256 === 0) {
        await yieldToHost();
        if (options.signal.aborted) fail("projection was cancelled");
      }
      workIndex += 1;
      append(candidate(
        input,
        step,
        transactionIndex,
        `transaction:${transactionIndex}`,
        transactionFact(transaction, transactionIndex),
      ));
      for (let changeIndex = 0; changeIndex < transaction.changes.length; changeIndex += 1) {
        const change = transaction.changes[changeIndex]!;
        if (change.insertedText.length === 0 && change.deletedText.length === 0) continue;
        append(candidate(
          input,
          step,
          transactionIndex,
          `transaction:${transactionIndex}:change:${changeIndex}`,
          changeFact(change, transactionIndex),
        ));
      }
    }
  }
  return deepFreeze(candidates);
}

function projectSynchronously(
  input: TraceContextProcessProjectionInputV1,
): readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] {
  const candidates: Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] = [];
  const append = boundedAppender(candidates, projectionBounds({}));
  const orderedSteps = [...input.steps].sort((left, right) =>
    left.chainDistance - right.chainDistance || compareUtf8(left.nodeId, right.nodeId));

  for (const step of orderedSteps) {
    append(candidate(input, step, 0, "summary", summaryFact(step)));
    step.transactions.forEach((transaction, transactionIndex) => {
      append(candidate(
        input,
        step,
        transactionIndex,
        `transaction:${transactionIndex}`,
        transactionFact(transaction, transactionIndex),
      ));
      transaction.changes.forEach((change, changeIndex) => {
        if (change.insertedText.length === 0 && change.deletedText.length === 0) return;
        append(candidate(
          input,
          step,
          transactionIndex,
          `transaction:${transactionIndex}:change:${changeIndex}`,
          changeFact(change, transactionIndex),
        ));
      });
    });
  }
  return deepFreeze(candidates);
}

function boundedAppender(
  candidates: Extract<EvidenceCandidateV1, { kind: "process-fact" }>[],
  bounds: Required<
    Pick<TraceContextProcessProjectionOptionsV1, "maxCandidates" | "maxInputBytes" | "maxCandidateInputBytes">
  >,
): (value: Extract<EvidenceCandidateV1, { kind: "process-fact" }>) => void {
  let materializedBytes = 2;
  return (value) => {
    const candidateBytes = utf8Bytes(JSON.stringify(value));
    if (candidateBytes > bounds.maxCandidateInputBytes) {
      fail(`candidate ${value.id} exceeds the input byte ceiling`);
    }
    const nextCount = candidates.length + 1;
    if (nextCount > bounds.maxCandidates) fail("projected candidate count exceeds the selector ceiling");
    materializedBytes += candidateBytes + (nextCount > 1 ? 1 : 0);
    if (materializedBytes > bounds.maxInputBytes) {
      fail("projected candidates exceed the selector input byte ceiling");
    }
    candidates.push(value);
  };
}

function projectionBounds(options: TraceContextProcessProjectionOptionsV1): Required<
  Pick<TraceContextProcessProjectionOptionsV1, "maxCandidates" | "maxInputBytes" | "maxCandidateInputBytes">
> {
  return {
    maxCandidates: options.maxCandidates ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates,
    maxInputBytes: options.maxInputBytes ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes,
    maxCandidateInputBytes: options.maxCandidateInputBytes
      ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes,
  };
}

function validateProjectionOptions(options: TraceContextProcessProjectionOptionsV1): void {
  const bounds = projectionBounds(options);
  for (const [subject, value, hardLimit] of [
    ["maxCandidates", bounds.maxCandidates, TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates],
    ["maxInputBytes", bounds.maxInputBytes, TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes],
    [
      "maxCandidateInputBytes",
      bounds.maxCandidateInputBytes,
      TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes,
    ],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > hardLimit) {
      fail(`${subject} must be a positive safe integer no greater than ${hardLimit}`);
    }
  }
}

function candidate(
  input: TraceContextProcessProjectionInputV1,
  step: TraceContextProcessProjectionStepV1,
  transactionIndex: number,
  suffix: string,
  fact: TraceProcessFactV1,
): Extract<EvidenceCandidateV1, { kind: "process-fact" }> {
  const ref = `trace-process-v1:${input.traceId}:${step.nodeId}:${suffix}`;
  return {
    version: 1,
    id: ref,
    dedupeKey: ref,
    kind: "process-fact",
    claimClass: "mechanical",
    source: {
      kind: "trace",
      ref,
      traceId: input.traceId,
      headId: input.headId,
      nodeId: step.nodeId,
      processStatus: "full-trace",
      chainDistance: step.chainDistance,
      transactionIndex,
      ...(fact.kind === "change" ? { range: copyRange(fact.range) } : {}),
    },
    reasons: [step.chainDistance === 0 ? "prepared-head-process" : "recent-target-process"],
    fact,
  };
}

function summaryFact(
  step: TraceContextProcessProjectionStepV1,
): Extract<TraceProcessFactV1, { kind: "step-summary" }> {
  const changes = step.transactions.flatMap((transaction) => transaction.changes);
  const times = step.transactions.map((transaction) => transaction.capturedAtMs)
    .sort((left, right) => left - right);
  const first = times[0];
  const last = times.length === 0 ? undefined : times[times.length - 1];
  let longestGapMs = 0;
  let timingOutsideSummaryDomain = false;
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!;
    if (!Number.isFinite(gap)) timingOutsideSummaryDomain = true;
    else longestGapMs = Math.max(longestGapMs, gap);
  }
  const spanMs = first === undefined || last === undefined ? 0 : last - first;
  if (!Number.isFinite(spanMs)) timingOutsideSummaryDomain = true;
  return {
    kind: "step-summary",
    transactionCount: step.transactions.length,
    rangeCount: changes.length,
    insertedCodePointCount: changes.reduce(
      (total, change) => total + codePointCount(change.insertedText),
      0,
    ),
    deletedCodePointCount: changes.reduce(
      (total, change) => total + codePointCount(change.deletedText),
      0,
    ),
    ...(!timingOutsideSummaryDomain && first !== undefined ? { firstCapturedAtMs: first } : {}),
    ...(!timingOutsideSummaryDomain && last !== undefined ? { lastCapturedAtMs: last } : {}),
    spanMs: timingOutsideSummaryDomain ? 0 : spanMs,
    longestGapMs: timingOutsideSummaryDomain ? 0 : longestGapMs,
    ...(timingOutsideSummaryDomain ? { timingStatus: "outside-summary-domain" as const } : {}),
    undoCount: step.transactions.filter((transaction) => transaction.intent === "undo").length,
    redoCount: step.transactions.filter((transaction) => transaction.intent === "redo").length,
  };
}

function transactionFact(
  transaction: TraceContextProcessProjectionTransactionV1,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "transaction" }> {
  const actor = selectorVoiceId(transaction.actor);
  return {
    kind: "transaction",
    transactionIndex,
    capturedAtMs: transaction.capturedAtMs,
    ...(transaction.intent ? { intent: transaction.intent } : {}),
    changeCount: transaction.changes.length,
    voiceIds: [actor],
  };
}

function changeFact(
  change: TraceContextProcessProjectionChangeV1,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "change" }> {
  return {
    kind: "change",
    transactionIndex,
    operation: change.operation,
    range: copyRange(change.range),
    insertedCodePointCount: codePointCount(change.insertedText),
    deletedCodePointCount: codePointCount(change.deletedText),
    voiceId: selectorVoiceId(change.voiceId),
  };
}

function validateInput(input: TraceContextProcessProjectionInputV1): void {
  requireVersion(input.version, "input");
  requireNodeId(input.traceId, "trace id");
  requireNodeId(input.headId, "head id");
  if (!Array.isArray(input.steps) || input.steps.length === 0) fail("steps must be non-empty");
  const distances = new Set<number>();
  const nodes = new Set<string>();
  for (const step of input.steps) {
    requireVersion(step.version, "Step");
    requireNodeId(step.nodeId, "Step node id");
    requireNonNegativeInteger(step.chainDistance, "Step chain distance");
    if (distances.has(step.chainDistance)) fail("Step chain distances must be unique");
    if (nodes.has(step.nodeId)) fail("Step node ids must be unique");
    distances.add(step.chainDistance);
    nodes.add(step.nodeId);
    if ((step.chainDistance === 0) !== (step.nodeId === input.headId)) {
      fail("distance zero must bind exactly the prepared head");
    }
    if (!Array.isArray(step.transactions)) fail("Step transactions must be an array");
    let previousSourceTransactionId = -1;
    for (const transaction of step.transactions) {
      requireVersion(transaction.version, "transaction");
      requireProtocolTransactionId(transaction.sourceTransactionId, "source transaction id");
      if (transaction.sourceTransactionId <= previousSourceTransactionId) {
        fail("source transaction ids must be strictly increasing");
      }
      previousSourceTransactionId = transaction.sourceTransactionId;
      requireFiniteNumber(transaction.capturedAtMs, "transaction captured time");
      requireString(transaction.actor, "transaction actor");
      if (transaction.intent !== undefined
        && transaction.intent !== "undo"
        && transaction.intent !== "redo") {
        fail("transaction intent must be undo or redo");
      }
      if (!Array.isArray(transaction.changes)) fail("transaction changes must be an array");
      for (const change of transaction.changes) {
        validateChange(change);
        if (change.voiceId !== transaction.actor) {
          fail("transaction change voice must match its actor");
        }
      }
    }
  }
}

function validateChange(change: TraceContextProcessProjectionChangeV1): void {
  requireVersion(change.version, "change");
  if (change.operation !== "insert"
    && change.operation !== "delete"
    && change.operation !== "replace") {
    fail("change operation must be insert, delete, or replace");
  }
  requireRange(change.range);
  requireString(change.insertedText, "inserted text");
  requireString(change.deletedText, "deleted text");
  if (typeof change.voiceId !== "string") fail("change voice id must be a string");
  const expectedOperation = change.range.fromUtf16 === change.range.toUtf16
    ? "insert"
    : change.insertedText.length === 0 ? "delete" : "replace";
  if (change.operation !== expectedOperation) fail("change operation does not match its range/text");
  if (change.deletedText.length !== change.range.toUtf16 - change.range.fromUtf16) {
    fail("deleted text UTF-16 length does not match the verified range");
  }
}

function requireRange(range: Utf16Range): void {
  if (!range
    || !Number.isSafeInteger(range.fromUtf16)
    || !Number.isSafeInteger(range.toUtf16)
    || range.fromUtf16 < 0
    || range.toUtf16 < range.fromUtf16) {
    fail("change range must be an ordered non-negative UTF-16 range");
  }
}

function requireVersion(version: number, subject: string): void {
  if (version !== 1) fail(`${subject} version must be 1`);
}

function requireNodeId(value: string, subject: string): void {
  if (typeof value !== "string" || !NODE_ID_PATTERN.test(value)) {
    fail(`${subject} must be a 32-byte lowercase-hex identifier`);
  }
}

function requireNonNegativeInteger(value: number, subject: string): void {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${subject} must be a non-negative safe integer`);
}

function requireProtocolTransactionId(value: number, subject: string): void {
  if (!Number.isInteger(value) || value < 0) fail(`${subject} must be a non-negative integer`);
}

function requireFiniteNumber(value: number, subject: string): void {
  if (!Number.isFinite(value)) fail(`${subject} must be finite`);
}

function selectorVoiceId(value: string): string {
  if (VOICE_PUBKEY_PATTERN.test(value)) return value;
  let encoded = NON_PUBKEY_ACTOR_PREFIX;
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return encoded;
}

function requireString(value: string, subject: string): void {
  if (typeof value !== "string") fail(`${subject} must be a string`);
}

function codePointCount(value: string): number {
  return [...value].length;
}

function copyRange(range: Utf16Range): Utf16Range {
  return { fromUtf16: range.fromUtf16, toUtf16: range.toUtf16 };
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function fail(message: string): never {
  throw new TypeError(`Trace process candidate projector: ${message}`);
}
