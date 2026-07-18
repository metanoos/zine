import type {
  EvidenceCandidateV1,
  TraceProcessFactV1,
} from "./selection-types.js";
import type { Utf16Range } from "./types.js";

const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;

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
  /** Signed source KEdit transaction id; output identity uses the array ordinal. */
  sourceTransactionId: number;
  capturedAtMs: number;
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

/**
 * Deterministically enumerate closed process candidates for every supplied
 * verified Step. Identity is press-neutral and transaction/change indexes are
 * zero-based process-array ordinals, never signed KEdit transaction ids.
 */
export function projectTraceProcessCandidatesV1(
  input: TraceContextProcessProjectionInputV1,
): readonly Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] {
  validateInput(input);
  const candidates: Extract<EvidenceCandidateV1, { kind: "process-fact" }>[] = [];
  const orderedSteps = [...input.steps].sort((left, right) =>
    left.chainDistance - right.chainDistance || compareUtf8(left.nodeId, right.nodeId));

  for (const step of orderedSteps) {
    candidates.push(candidate(input, step, 0, "summary", summaryFact(step)));
    step.transactions.forEach((transaction, transactionIndex) => {
      candidates.push(candidate(
        input,
        step,
        transactionIndex,
        `transaction:${transactionIndex}`,
        transactionFact(transaction, transactionIndex),
      ));
      transaction.changes.forEach((change, changeIndex) => {
        if (change.insertedText.length === 0 && change.deletedText.length === 0) return;
        candidates.push(candidate(
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
  for (let index = 1; index < times.length; index += 1) {
    longestGapMs = Math.max(longestGapMs, times[index]! - times[index - 1]!);
  }
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
    ...(first === undefined ? {} : { firstCapturedAtMs: first }),
    ...(last === undefined ? {} : { lastCapturedAtMs: last }),
    spanMs: first === undefined || last === undefined ? 0 : last - first,
    longestGapMs,
    undoCount: step.transactions.filter((transaction) => transaction.intent === "undo").length,
    redoCount: step.transactions.filter((transaction) => transaction.intent === "redo").length,
  };
}

function transactionFact(
  transaction: TraceContextProcessProjectionTransactionV1,
  transactionIndex: number,
): Extract<TraceProcessFactV1, { kind: "transaction" }> {
  return {
    kind: "transaction",
    transactionIndex,
    capturedAtMs: transaction.capturedAtMs,
    ...(transaction.intent ? { intent: transaction.intent } : {}),
    changeCount: transaction.changes.length,
    voiceIds: [...new Set(transaction.changes.map((change) => change.voiceId))].sort(compareUtf8),
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
    voiceId: change.voiceId,
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
      requireNonNegativeInteger(transaction.sourceTransactionId, "source transaction id");
      if (transaction.sourceTransactionId <= previousSourceTransactionId) {
        fail("source transaction ids must be strictly increasing");
      }
      previousSourceTransactionId = transaction.sourceTransactionId;
      requireNonNegativeInteger(transaction.capturedAtMs, "transaction captured time");
      if (transaction.intent !== undefined
        && transaction.intent !== "undo"
        && transaction.intent !== "redo") {
        fail("transaction intent must be undo or redo");
      }
      if (!Array.isArray(transaction.changes) || transaction.changes.length === 0) {
        fail("transactions must contain at least one verified change");
      }
      for (const change of transaction.changes) validateChange(change);
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
  requireNodeId(change.voiceId, "change voice id");
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

function requireString(value: string, subject: string): void {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    fail(`${subject} must be a valid UTF-16 string`);
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
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
