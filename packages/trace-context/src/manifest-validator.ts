import {
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  type EvidenceCandidateKindV1,
  type EvidenceInclusionReasonV1,
  type EvidencePriorityClassV1,
  type SelectedEvidenceSourceV1,
  type SelectedEvidenceV1,
  type SelectedTraceContextManifestV1,
  type TraceContextPolicyV1,
  type TraceProcessFactV1,
} from "./selection-types.js";
import type { Utf16Range } from "./types.js";
import { isUtf16Boundary } from "./ranges.js";
import { validateSelectorManifestSemanticsV1 } from "./selector.js";

const encoder = new TextEncoder();
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VOICE_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

const POLICIES = new Set<TraceContextPolicyV1>(["text-only-v1", "selected-trace-v1"]);
const KINDS = new Set<EvidenceCandidateKindV1>([
  "operation-instruction", "protected-range", "correction", "explicit-preference",
  "process-fact", "citation",
]);
const REASONS = new Set<EvidenceInclusionReasonV1>([
  "explicit-operation-intent", "protected-current-range", "explicit-correction",
  "explicit-scoped-preference", "prepared-head-process", "recent-target-process",
  "approved-direct-citation", "compatibility-history", "caller-selected",
]);
const PRIORITIES = new Set<EvidencePriorityClassV1>([
  "operation-instruction", "protected-range", "correction", "explicit-preference",
  "prepared-head-process", "prior-process", "direct-citation",
]);

export class SelectedTraceContextManifestValidationError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "SelectedTraceContextManifestValidationError";
  }
}

/**
 * Strict runtime validation for the complete package-local manifest contract.
 * It accepts only selector-emittable V1 fields and relationships; consumers
 * remain responsible for checking the manifest hash and private rendered bytes.
 */
export function validateSelectedTraceContextManifestV1(
  value: unknown,
  renderedContext?: string,
): asserts value is SelectedTraceContextManifestV1 {
  const manifest = record(value, "$", [
    "version", "contract", "policy", "operation", "selected", "exclusionSummary",
    "input", "budget", "completeness", "hashes",
  ]);
  if (manifest.version !== 1) fail("$.version", "must be 1");
  if (manifest.contract !== "package-local-non-normative-v1") {
    fail("$.contract", "is unsupported");
  }
  if (!POLICIES.has(manifest.policy as TraceContextPolicyV1)) fail("$.policy", "is unsupported");
  const policy = manifest.policy as TraceContextPolicyV1;
  const operation = validateOperation(manifest.operation);

  if (!Array.isArray(manifest.selected)) fail("$.selected", "must be an array");
  if (manifest.selected.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates) {
    fail("$.selected", "exceeds the selected-evidence limit");
  }
  const selectedIds = new Set<string>();
  const selectedDedupeKeys = new Set<string>();
  let selectedRenderedBytes = 0;
  for (const [index, item] of manifest.selected.entries()) {
    const selected = validateSelectedEvidence(item, `$.selected[${index}]`, policy, operation);
    if (selectedIds.has(selected.id)) fail(`$.selected[${index}].id`, "must be unique");
    if (selectedDedupeKeys.has(selected.dedupeKey)) {
      fail(`$.selected[${index}].dedupeKey`, "must be unique after duplicate collapse");
    }
    selectedIds.add(selected.id);
    selectedDedupeKeys.add(selected.dedupeKey);
    selectedRenderedBytes += selected.renderedByteCost;
    if (!Number.isSafeInteger(selectedRenderedBytes)) fail("$.selected", "rendered byte sum overflowed");
  }

  const exclusions = record(manifest.exclusionSummary, "$.exclusionSummary", ["countsByReason"], [
    "firstBudgetRejectedRef",
  ]);
  const counts = record(exclusions.countsByReason, "$.exclusionSummary.countsByReason", [
    "budgetExceeded", "duplicateCollapsed",
  ]);
  const budgetExceeded = nonNegative(counts.budgetExceeded, "$.exclusionSummary.countsByReason.budgetExceeded");
  const duplicateCollapsed = nonNegative(
    counts.duplicateCollapsed,
    "$.exclusionSummary.countsByReason.duplicateCollapsed",
  );
  if (budgetExceeded > 0) {
    const first = record(
      exclusions.firstBudgetRejectedRef,
      "$.exclusionSummary.firstBudgetRejectedRef",
      ["candidateId", "dedupeKey"],
    );
    nonEmpty(first.candidateId, "$.exclusionSummary.firstBudgetRejectedRef.candidateId");
    nonEmpty(first.dedupeKey, "$.exclusionSummary.firstBudgetRejectedRef.dedupeKey");
  } else if (exclusions.firstBudgetRejectedRef !== undefined) {
    fail("$.exclusionSummary.firstBudgetRejectedRef", "requires at least one budget exclusion");
  }

  const input = record(manifest.input, "$.input", [
    "projectedInputBytes", "maxInputBytes", "maxCandidateInputBytes",
  ]);
  const projectedInputBytes = nonNegative(input.projectedInputBytes, "$.input.projectedInputBytes");
  const maxInputBytes = positive(input.maxInputBytes, "$.input.maxInputBytes");
  const maxCandidateInputBytes = positive(
    input.maxCandidateInputBytes,
    "$.input.maxCandidateInputBytes",
  );
  if (maxInputBytes > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes) {
    fail("$.input.maxInputBytes", "exceeds the package hard limit");
  }
  if (maxCandidateInputBytes > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes) {
    fail("$.input.maxCandidateInputBytes", "exceeds the package hard limit");
  }
  if (projectedInputBytes > maxInputBytes) fail("$.input.projectedInputBytes", "exceeds maxInputBytes");

  const budget = record(manifest.budget, "$.budget", [
    "contextCeilingBytes", "hardContextCeilingBytes", "preparedRequestMaxBytes",
    "reservedPromptBytes", "preparedRequestAvailableBytes", "effectiveContextBytes",
    "currentTargetTextBytes", "currentTargetRenderedBytes", "usedRenderedBytes",
    "candidateCount", "uniqueCandidateCount", "selectedCount", "truncated",
  ]);
  const contextCeilingBytes = positive(budget.contextCeilingBytes, "$.budget.contextCeilingBytes");
  if (contextCeilingBytes !== operation.maxContextBytes) {
    fail("$.budget.contextCeilingBytes", "does not match operation.maxContextBytes");
  }
  const hardContextCeilingBytes = positive(
    budget.hardContextCeilingBytes,
    "$.budget.hardContextCeilingBytes",
  );
  if (hardContextCeilingBytes !== TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxRenderedContextBytes) {
    fail("$.budget.hardContextCeilingBytes", "does not match the package hard limit");
  }
  const preparedRequestMaxBytes = positive(
    budget.preparedRequestMaxBytes,
    "$.budget.preparedRequestMaxBytes",
  );
  if (preparedRequestMaxBytes !== operation.preparedRequestMaxBytes) {
    fail("$.budget.preparedRequestMaxBytes", "does not match operation.preparedRequestMaxBytes");
  }
  const reservedPromptBytes = nonNegative(budget.reservedPromptBytes, "$.budget.reservedPromptBytes");
  if (reservedPromptBytes !== operation.reservedPromptBytes) {
    fail("$.budget.reservedPromptBytes", "does not match operation.reservedPromptBytes");
  }
  const preparedRequestAvailableBytes = nonNegative(
    budget.preparedRequestAvailableBytes,
    "$.budget.preparedRequestAvailableBytes",
  );
  if (preparedRequestAvailableBytes !== Math.max(0, preparedRequestMaxBytes - reservedPromptBytes)) {
    fail("$.budget.preparedRequestAvailableBytes", "does not match the request remainder");
  }
  const effectiveContextBytes = nonNegative(budget.effectiveContextBytes, "$.budget.effectiveContextBytes");
  if (
    effectiveContextBytes
    !== Math.min(contextCeilingBytes, hardContextCeilingBytes, preparedRequestAvailableBytes)
  ) {
    fail("$.budget.effectiveContextBytes", "does not match the effective ceiling");
  }
  const currentTargetTextBytes = nonNegative(
    budget.currentTargetTextBytes,
    "$.budget.currentTargetTextBytes",
  );
  if (currentTargetTextBytes !== encoder.encode(operation.target.currentText).length) {
    fail("$.budget.currentTargetTextBytes", "does not match the target UTF-8 bytes");
  }
  const currentTargetRenderedBytes = nonNegative(
    budget.currentTargetRenderedBytes,
    "$.budget.currentTargetRenderedBytes",
  );
  const usedRenderedBytes = nonNegative(budget.usedRenderedBytes, "$.budget.usedRenderedBytes");
  if (usedRenderedBytes !== 2 + currentTargetRenderedBytes + selectedRenderedBytes) {
    fail("$.budget.usedRenderedBytes", "does not match the selected rendered-byte accounting");
  }
  if (usedRenderedBytes > effectiveContextBytes) fail("$.budget.usedRenderedBytes", "exceeds the effective ceiling");
  const candidateCount = nonNegative(budget.candidateCount, "$.budget.candidateCount");
  const uniqueCandidateCount = nonNegative(
    budget.uniqueCandidateCount,
    "$.budget.uniqueCandidateCount",
  );
  const selectedCount = nonNegative(budget.selectedCount, "$.budget.selectedCount");
  if (candidateCount > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates) {
    fail("$.budget.candidateCount", "exceeds the package candidate limit");
  }
  if (uniqueCandidateCount !== candidateCount - duplicateCollapsed) {
    fail("$.budget.uniqueCandidateCount", "does not match duplicate collapse accounting");
  }
  if (selectedCount !== manifest.selected.length) fail("$.budget.selectedCount", "does not match selected[]");
  if (selectedCount !== uniqueCandidateCount - budgetExceeded) {
    fail("$.budget.selectedCount", "does not match budget exclusion accounting");
  }
  if (typeof budget.truncated !== "boolean") fail("$.budget.truncated", "must be boolean");
  if (budget.truncated !== (budgetExceeded > 0)) fail("$.budget.truncated", "does not match exclusions");

  const completeness = record(manifest.completeness, "$.completeness", [
    "selectionComplete", "examinedCandidateCount",
  ]);
  if (completeness.selectionComplete !== true) fail("$.completeness.selectionComplete", "must be true");
  const examined = nonNegative(
    completeness.examinedCandidateCount,
    "$.completeness.examinedCandidateCount",
  );
  if (examined !== candidateCount) fail("$.completeness.examinedCandidateCount", "must equal candidateCount");

  const hashes = record(manifest.hashes, "$.hashes", [
    "frozenInputsSha256", "renderedContextSha256",
  ]);
  hash(hashes.frozenInputsSha256, "$.hashes.frozenInputsSha256");
  hash(hashes.renderedContextSha256, "$.hashes.renderedContextSha256");
  if (encoder.encode(JSON.stringify(manifest)).length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxManifestBytes) {
    fail("$", "exceeds the package manifest byte limit");
  }
  try {
    validateSelectorManifestSemanticsV1(
      manifest as unknown as SelectedTraceContextManifestV1,
      renderedContext,
    );
  } catch (error) {
    fail("$", error instanceof Error ? error.message : String(error));
  }
}

interface ValidOperation {
  operation: "extend" | "settle";
  target: {
    traceId: string;
    headId: string;
    contentHash: string;
    currentText: string;
    chosenPath?: string;
  };
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

function validateOperation(value: unknown): ValidOperation {
  const operation = record(value, "$.operation", [
    "version", "operation", "target", "maxContextBytes", "preparedRequestMaxBytes",
    "reservedPromptBytes",
  ], ["range"]);
  if (operation.version !== 1) fail("$.operation.version", "must be 1");
  if (operation.operation !== "extend" && operation.operation !== "settle") {
    fail("$.operation.operation", "is unsupported");
  }
  const target = record(operation.target, "$.operation.target", [
    "traceId", "headId", "contentHash", "currentText",
  ], ["chosenPath"]);
  const validatedTarget = {
    traceId: nonEmpty(target.traceId, "$.operation.target.traceId"),
    headId: nonEmpty(target.headId, "$.operation.target.headId"),
    contentHash: nonEmpty(target.contentHash, "$.operation.target.contentHash"),
    currentText: text(target.currentText, "$.operation.target.currentText"),
    ...(target.chosenPath === undefined
      ? {}
      : { chosenPath: nonEmpty(target.chosenPath, "$.operation.target.chosenPath") }),
  };
  const range = operation.range === undefined
    ? undefined
    : validateRange(operation.range, "$.operation.range", validatedTarget.currentText);
  if (operation.operation === "settle" && !range) fail("$.operation.range", "is required for Settle");
  const maxContextBytes = positive(operation.maxContextBytes, "$.operation.maxContextBytes");
  const preparedRequestMaxBytes = positive(
    operation.preparedRequestMaxBytes,
    "$.operation.preparedRequestMaxBytes",
  );
  const reservedPromptBytes = nonNegative(
    operation.reservedPromptBytes,
    "$.operation.reservedPromptBytes",
  );
  return {
    operation: operation.operation,
    target: validatedTarget,
    ...(range ? { range } : {}),
    maxContextBytes,
    preparedRequestMaxBytes,
    reservedPromptBytes,
  };
}

function validateSelectedEvidence(
  value: unknown,
  path: string,
  policy: TraceContextPolicyV1,
  operation: ValidOperation,
): SelectedEvidenceV1 {
  const selected = record(value, path, [
    "version", "id", "dedupeKey", "kind", "claimClass", "authority", "source",
    "reasons", "priorityClass", "renderedByteCost",
  ], ["fact"]);
  if (selected.version !== 1) fail(`${path}.version`, "must be 1");
  if (!KINDS.has(selected.kind as EvidenceCandidateKindV1)) fail(`${path}.kind`, "is unsupported");
  const kind = selected.kind as EvidenceCandidateKindV1;
  const id = nonEmpty(selected.id, `${path}.id`);
  const dedupeKey = nonEmpty(selected.dedupeKey, `${path}.dedupeKey`);
  const mechanical = kind === "process-fact";
  if (selected.claimClass !== (mechanical ? "mechanical" : "explicit")) {
    fail(`${path}.claimClass`, `must be ${mechanical ? "mechanical" : "explicit"}`);
  }
  if (selected.authority !== (kind === "operation-instruction" ? "instruction" : "quoted-data")) {
    fail(`${path}.authority`, "does not match the evidence kind");
  }
  if (!Array.isArray(selected.reasons) || selected.reasons.length === 0) {
    fail(`${path}.reasons`, "must be a non-empty array");
  }
  const reasons = selected.reasons.map((reason, index) => {
    if (!REASONS.has(reason as EvidenceInclusionReasonV1)) fail(`${path}.reasons[${index}]`, "is unsupported");
    return reason as EvidenceInclusionReasonV1;
  });
  if (new Set(reasons).size !== reasons.length) fail(`${path}.reasons`, "must be unique");
  if (!PRIORITIES.has(selected.priorityClass as EvidencePriorityClassV1)) {
    fail(`${path}.priorityClass`, "is unsupported");
  }
  const source = validateSource(selected.source, `${path}.source`, kind, policy, operation);
  const expectedPriority = kind === "process-fact"
    ? ((source as Extract<SelectedEvidenceSourceV1, { kind: "trace" }>).chainDistance === 0
      ? "prepared-head-process" : "prior-process")
    : kind === "citation" ? "direct-citation" : kind;
  if (selected.priorityClass !== expectedPriority) fail(`${path}.priorityClass`, "does not match the source");
  const renderedByteCost = positive(selected.renderedByteCost, `${path}.renderedByteCost`);
  let fact: TraceProcessFactV1 | undefined;
  if (mechanical) fact = validateProcessFact(selected.fact, `${path}.fact`);
  else if (selected.fact !== undefined) fail(`${path}.fact`, "is only valid for process facts");
  return {
    version: 1,
    id,
    dedupeKey,
    kind,
    claimClass: selected.claimClass as SelectedEvidenceV1["claimClass"],
    authority: selected.authority as SelectedEvidenceV1["authority"],
    source,
    reasons,
    priorityClass: selected.priorityClass as EvidencePriorityClassV1,
    renderedByteCost,
    ...(fact ? { fact } : {}),
  };
}

function validateSource(
  value: unknown,
  path: string,
  kind: EvidenceCandidateKindV1,
  policy: TraceContextPolicyV1,
  operation: ValidOperation,
): SelectedEvidenceSourceV1 {
  const source = recordOpen(value, path);
  const expected: Record<EvidenceCandidateKindV1, SelectedEvidenceSourceV1["kind"]> = {
    "operation-instruction": "operation", "protected-range": "target", correction: "local",
    "explicit-preference": "local", "process-fact": "trace", citation: "citation",
  };
  if (source.kind !== expected[kind]) fail(`${path}.kind`, `must be ${expected[kind]}`);
  const ref = nonEmpty(source.ref, `${path}.ref`);
  switch (source.kind) {
    case "operation":
      exact(source, path, ["kind", "ref"]);
      return { kind: "operation", ref };
    case "target": {
      const traceFree = policy === "text-only-v1";
      exact(source, path, traceFree ? ["kind", "ref", "range"] : ["kind", "ref", "traceId", "headId", "range"]);
      const range = validateRange(source.range, `${path}.range`, operation.target.currentText);
      if (!traceFree) {
        const traceId = nonEmpty(source.traceId, `${path}.traceId`);
        const headId = nonEmpty(source.headId, `${path}.headId`);
        if (traceId !== operation.target.traceId || headId !== operation.target.headId) {
          fail(path, "does not match the operation target");
        }
        return { kind: "target", ref, traceId, headId, range };
      }
      return { kind: "target", ref, range };
    }
    case "local":
      if (policy === "text-only-v1") fail(`${path}.kind`, "is unavailable to text-only selection");
      exact(source, path, ["kind", "ref"]);
      return { kind: "local", ref };
    case "trace": {
      if (policy === "text-only-v1") fail(`${path}.kind`, "is unavailable to text-only selection");
      exact(source, path, [
        "kind", "ref", "traceId", "headId", "nodeId", "processStatus", "chainDistance",
        "transactionIndex",
      ], ["range"]);
      const traceId = nonEmpty(source.traceId, `${path}.traceId`);
      const headId = nonEmpty(source.headId, `${path}.headId`);
      const nodeId = nonEmpty(source.nodeId, `${path}.nodeId`);
      if (source.processStatus !== "full-trace") fail(`${path}.processStatus`, "must be full-trace in a successful manifest");
      const chainDistance = nonNegative(source.chainDistance, `${path}.chainDistance`);
      const transactionIndex = nonNegative(source.transactionIndex, `${path}.transactionIndex`);
      if (traceId !== operation.target.traceId || headId !== operation.target.headId) {
        fail(path, "does not match the operation target chain");
      }
      if (chainDistance === 0 && nodeId !== operation.target.headId) {
        fail(`${path}.nodeId`, "must name the prepared head at distance zero");
      }
      return {
        kind: "trace", ref, traceId, headId, nodeId, processStatus: "full-trace",
        chainDistance, transactionIndex,
        ...(source.range === undefined ? {} : { range: validateRange(source.range, `${path}.range`) }),
      };
    }
    case "citation": {
      const traceFree = policy === "text-only-v1";
      exact(source, path, traceFree
        ? ["kind", "ref", "approvedOrder"]
        : ["kind", "ref", "nodeId", "approvedOrder"],
      traceFree ? [] : ["processStatus", "traceId", "range"]);
      const approvedOrder = nonNegative(source.approvedOrder, `${path}.approvedOrder`);
      if (traceFree) return { kind: "citation", ref, approvedOrder };
      const nodeId = nonEmpty(source.nodeId, `${path}.nodeId`);
      const processStatus = source.processStatus;
      if (
        processStatus !== undefined
        && processStatus !== "full-trace"
        && processStatus !== "snapshot-only"
        && processStatus !== "invalid"
      ) fail(`${path}.processStatus`, "is unsupported");
      return {
        kind: "citation", ref, nodeId, approvedOrder,
        ...(processStatus === undefined ? {} : { processStatus }),
        ...(source.traceId === undefined ? {} : { traceId: nonEmpty(source.traceId, `${path}.traceId`) }),
        ...(source.range === undefined ? {} : { range: validateRange(source.range, `${path}.range`) }),
      };
    }
    default:
      fail(`${path}.kind`, "is unsupported");
  }
}

function validateProcessFact(value: unknown, path: string): TraceProcessFactV1 {
  const fact = recordOpen(value, path);
  switch (fact.kind) {
    case "step-summary": {
      exact(fact, path, [
        "kind", "transactionCount", "rangeCount", "insertedCodePointCount",
        "deletedCodePointCount", "spanMs", "longestGapMs", "undoCount", "redoCount",
      ], ["firstCapturedAtMs", "lastCapturedAtMs"]);
      const transactionCount = nonNegative(fact.transactionCount, `${path}.transactionCount`);
      const rangeCount = nonNegative(fact.rangeCount, `${path}.rangeCount`);
      const insertedCodePointCount = nonNegative(fact.insertedCodePointCount, `${path}.insertedCodePointCount`);
      const deletedCodePointCount = nonNegative(fact.deletedCodePointCount, `${path}.deletedCodePointCount`);
      const spanMs = nonNegative(fact.spanMs, `${path}.spanMs`);
      const longestGapMs = nonNegative(fact.longestGapMs, `${path}.longestGapMs`);
      const undoCount = nonNegative(fact.undoCount, `${path}.undoCount`);
      const redoCount = nonNegative(fact.redoCount, `${path}.redoCount`);
      const hasFirst = fact.firstCapturedAtMs !== undefined;
      if (hasFirst !== (fact.lastCapturedAtMs !== undefined)) fail(path, "capture times must be paired");
      const firstCapturedAtMs = hasFirst ? nonNegative(fact.firstCapturedAtMs, `${path}.firstCapturedAtMs`) : undefined;
      const lastCapturedAtMs = hasFirst ? nonNegative(fact.lastCapturedAtMs, `${path}.lastCapturedAtMs`) : undefined;
      if (hasFirst && (lastCapturedAtMs! < firstCapturedAtMs! || spanMs !== lastCapturedAtMs! - firstCapturedAtMs!)) {
        fail(path, "capture times and span are inconsistent");
      }
      if (!hasFirst && spanMs !== 0) fail(`${path}.spanMs`, "must be zero without capture times");
      if (longestGapMs > spanMs || undoCount + redoCount > transactionCount) fail(path, "summary counts are inconsistent");
      return {
        kind: "step-summary", transactionCount, rangeCount, insertedCodePointCount,
        deletedCodePointCount,
        ...(firstCapturedAtMs === undefined ? {} : { firstCapturedAtMs }),
        ...(lastCapturedAtMs === undefined ? {} : { lastCapturedAtMs }),
        spanMs, longestGapMs, undoCount, redoCount,
      };
    }
    case "transaction": {
      exact(fact, path, [
        "kind", "transactionIndex", "capturedAtMs", "changeCount", "voiceIds",
      ], ["intent"]);
      const transactionIndex = nonNegative(fact.transactionIndex, `${path}.transactionIndex`);
      const capturedAtMs = nonNegative(fact.capturedAtMs, `${path}.capturedAtMs`);
      if (fact.intent !== undefined && fact.intent !== "undo" && fact.intent !== "redo") {
        fail(`${path}.intent`, "must be undo or redo");
      }
      const changeCount = positive(fact.changeCount, `${path}.changeCount`);
      if (
        !Array.isArray(fact.voiceIds)
        || fact.voiceIds.length === 0
        || fact.voiceIds.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxFactVoiceIds
      ) fail(`${path}.voiceIds`, "must be a bounded non-empty array");
      const voiceIds = fact.voiceIds.map((voice, index) => voiceId(voice, `${path}.voiceIds[${index}]`));
      if (new Set(voiceIds).size !== voiceIds.length) fail(`${path}.voiceIds`, "must be unique");
      return { kind: "transaction", transactionIndex, capturedAtMs, ...(fact.intent ? { intent: fact.intent } : {}), changeCount, voiceIds };
    }
    case "change": {
      exact(fact, path, [
        "kind", "transactionIndex", "operation", "range", "insertedCodePointCount",
        "deletedCodePointCount", "voiceId",
      ]);
      if (fact.operation !== "insert" && fact.operation !== "delete" && fact.operation !== "replace") {
        fail(`${path}.operation`, "is unsupported");
      }
      return {
        kind: "change",
        transactionIndex: nonNegative(fact.transactionIndex, `${path}.transactionIndex`),
        operation: fact.operation,
        range: validateRange(fact.range, `${path}.range`),
        insertedCodePointCount: nonNegative(fact.insertedCodePointCount, `${path}.insertedCodePointCount`),
        deletedCodePointCount: nonNegative(fact.deletedCodePointCount, `${path}.deletedCodePointCount`),
        voiceId: voiceId(fact.voiceId, `${path}.voiceId`),
      };
    }
    default:
      fail(`${path}.kind`, "is unsupported");
  }
}

function validateRange(value: unknown, path: string, textValue?: string): Utf16Range {
  const range = record(value, path, ["fromUtf16", "toUtf16"]);
  const fromUtf16 = nonNegative(range.fromUtf16, `${path}.fromUtf16`);
  const toUtf16 = nonNegative(range.toUtf16, `${path}.toUtf16`);
  if (toUtf16 < fromUtf16) fail(path, "must be ordered");
  if (textValue !== undefined) {
    if (toUtf16 > textValue.length) fail(path, "is outside the target text");
    if (!isUtf16Boundary(textValue, fromUtf16) || !isUtf16Boundary(textValue, toUtf16)) {
      fail(path, "splits a Unicode scalar value");
    }
  }
  return { fromUtf16, toUtf16 };
}

function record(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  const result = recordOpen(value, path);
  exact(result, path, required, optional);
  return result;
}

function recordOpen(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, "is required");
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, "is not part of the V1 contract");
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, "must be a string");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) fail(path, "contains an unpaired high surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail(path, "contains an unpaired low surrogate");
  }
  return value;
}

function nonEmpty(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.length === 0) fail(path, "must be non-empty");
  return result;
}

function nonNegative(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, "must be a non-negative safe integer");
  return value as number;
}

function positive(value: unknown, path: string): number {
  const result = nonNegative(value, path);
  if (result === 0) fail(path, "must be positive");
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!SHA256_PATTERN.test(result)) fail(path, "must be lowercase SHA-256 hex");
  return result;
}

function voiceId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!VOICE_PUBKEY_PATTERN.test(result)) fail(path, "must be a lowercase Nostr pubkey");
  return result;
}

function fail(path: string, message: string): never {
  throw new SelectedTraceContextManifestValidationError(path, message);
}
