import type { Utf16Range } from "./types.js";
import {
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  type EvidenceCandidateKindV1,
  type EvidenceClaimClassV1,
  type EvidenceDecisionReasonV1,
  type EvidenceExclusionCountsV1,
  type EvidenceInclusionReasonV1,
  type EvidencePriorityClassV1,
  type EvidenceSelectionDecisionV1,
  type SelectedEvidenceSourceV1,
  type SelectedEvidenceV1,
  type SelectedTraceContextManifestV1,
  type TraceContextInputValueTypeV1,
  type TraceContextPolicyV1,
  type TraceContextSelectionErrorV1,
  type TraceContextSelectionFailureV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionOperationV1,
  type TraceContextSelectionOptionsV1,
  type TraceContextSelectionResultV1,
  type TraceProcessFactV1,
} from "./selection-types.js";

const encoder = new TextEncoder();
const CANCELLATION_YIELD_INTERVAL = 256;

const POLICIES: readonly TraceContextPolicyV1[] = ["text-only-v1", "selected-trace-v1"];

const CANDIDATE_KINDS: readonly EvidenceCandidateKindV1[] = [
  "operation-instruction",
  "protected-range",
  "correction",
  "explicit-preference",
  "process-fact",
  "citation",
];

const TEXT_ONLY_KINDS: readonly EvidenceCandidateKindV1[] = [
  "operation-instruction",
  "protected-range",
  "citation",
];

const INCLUSION_REASONS: readonly EvidenceInclusionReasonV1[] = [
  "explicit-operation-intent",
  "protected-current-range",
  "explicit-correction",
  "explicit-scoped-preference",
  "prepared-head-process",
  "recent-target-process",
  "approved-direct-citation",
  "compatibility-history",
  "caller-selected",
];

const PRIORITY_RANK: Readonly<Record<EvidencePriorityClassV1, number>> = {
  "operation-instruction": 0,
  "protected-range": 1,
  correction: 2,
  "explicit-preference": 3,
  "prepared-head-process": 4,
  "prior-process": 5,
  "direct-citation": 6,
};

interface NormalizedCandidate {
  version: 1;
  id: string;
  dedupeKey: string;
  kind: EvidenceCandidateKindV1;
  claimClass: EvidenceClaimClassV1;
  source: SelectedEvidenceSourceV1;
  reasons: readonly EvidenceInclusionReasonV1[];
  text?: string;
  fact?: TraceProcessFactV1;
}

interface NormalizedInput {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: TraceContextSelectionOperationV1;
  candidates: readonly NormalizedCandidate[];
  limits?: TraceContextSelectionInputV1["limits"];
  projectedInputBytes: number;
}

interface CandidateGroup {
  representative: NormalizedCandidate;
  candidates: readonly NormalizedCandidate[];
  reasons: readonly EvidenceInclusionReasonV1[];
  priorityClass: EvidencePriorityClassV1;
}

interface RenderedCandidate {
  segment: string;
  segmentBytes: number;
}

interface GroupDecision {
  group: CandidateGroup;
  reason: EvidenceDecisionReasonV1;
  selected?: SelectedEvidenceV1;
}

/**
 * Deterministically projects, validates, selects, and renders package-local
 * evidence. This is deliberately not the durable/normative manifest runtime.
 * Bounded history is rejected until complete-Step suffix semantics are frozen.
 */
export async function selectTraceContextV1(
  input: unknown,
  options: TraceContextSelectionOptionsV1 = {},
): Promise<TraceContextSelectionResultV1> {
  if (options.signal?.aborted) return cancelled("validate");
  if (options.signal) {
    await yieldToHost();
    if (options.signal.aborted) return cancelled("validate");
  }

  const validation = await validateAndNormalizeInput(input, options.signal);
  if (!validation.ok) return validation;
  const normalized = validation.value;

  const processSafety = validateSelectedProcessEvidence(normalized);
  if (processSafety) return processSafety;

  const grouped = await collapseCandidates(normalized.candidates, options.signal);
  if (!grouped.ok) return grouped;
  if (options.signal?.aborted) return cancelled("select");

  const preparedRequestAvailableBytes = Math.max(
    0,
    normalized.operation.preparedRequestMaxBytes - normalized.operation.reservedPromptBytes,
  );
  const effectiveContextBytes = Math.min(
    normalized.operation.maxContextBytes,
    TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxRenderedContextBytes,
    preparedRequestAvailableBytes,
  );

  const targetSegment = renderCurrentTarget(normalized.operation.target.currentText);
  const currentTargetRenderedBytes = utf8Bytes(targetSegment);
  let usedRenderedBytes = 2 + currentTargetRenderedBytes;
  if (usedRenderedBytes > effectiveContextBytes) {
    return failure({
      version: 1,
      code: "MANDATORY_BUDGET_EXCEEDED",
      stage: "render",
      message: "The exact current target cannot fit the effective rendered-context ceiling",
      available: effectiveContextBytes,
      required: usedRenderedBytes,
    });
  }

  const orderedGroups = [...grouped.groups].sort(compareGroups);
  const excludedCounts = emptyExclusionCounts();
  const decisions: GroupDecision[] = [];
  const selectedDrafts: RenderedCandidate[] = [];
  let firstBudgetRejectedRef: { candidateId: string; dedupeKey: string } | undefined;

  for (let index = 0; index < orderedGroups.length; index += 1) {
    if (options.signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (options.signal.aborted) return cancelled("select");
    }
    const group = orderedGroups[index]!;
    const rendered = renderCandidate(group);
    const renderedByteCost = rendered.segmentBytes + 1; // comma after mandatory target
    const required = usedRenderedBytes + renderedByteCost;
    if (required > effectiveContextBytes) {
      if (isMandatory(group.representative.kind)) {
        return failure({
          version: 1,
          code: "MANDATORY_BUDGET_EXCEEDED",
          stage: "render",
          message: `Mandatory candidate ${group.representative.id} exceeds the rendered context budget`,
          available: effectiveContextBytes,
          required,
          candidateId: group.representative.id,
        });
      }
      decisions.push({ group, reason: "budget-exceeded" });
      excludedCounts.budgetExceeded += 1;
      firstBudgetRejectedRef ??= {
        candidateId: group.representative.id,
        dedupeKey: group.representative.dedupeKey,
      };
      continue;
    }

    usedRenderedBytes = required;
    const selected: SelectedEvidenceV1 = deepFreeze({
      version: 1,
      id: group.representative.id,
      dedupeKey: group.representative.dedupeKey,
      kind: group.representative.kind,
      claimClass: group.representative.claimClass,
      authority: authorityFor(group.representative.kind),
      source: group.representative.source,
      reasons: group.reasons,
      priorityClass: group.priorityClass,
      renderedByteCost,
      ...(group.representative.fact ? { fact: group.representative.fact } : {}),
    });
    selectedDrafts.push(rendered);
    decisions.push({
      group,
      reason: isMandatory(group.representative.kind) ? "mandatory" : "policy-eligible",
      selected,
    });
  }

  if (options.signal?.aborted) return cancelled("render");
  const renderedContext = `[${[targetSegment, ...selectedDrafts.map((draft) => draft.segment)].join(",")}]`;
  if (utf8Bytes(renderedContext) !== usedRenderedBytes) {
    return failure({
      version: 1,
      code: "INTERNAL_INVARIANT",
      stage: "render",
      message: "Rendered-context byte accounting did not match the final output",
    });
  }

  const normalizedForHash = frozenInputProjection(normalized);
  let frozenInputsSha256: string;
  let renderedContextSha256: string;
  try {
    if (options.signal?.aborted) return cancelled("hash");
    frozenInputsSha256 = await sha256Domain(
      "zine.trace-context.selection-input.v1",
      canonicalJson(normalizedForHash),
    );
    if (options.signal?.aborted) return cancelled("hash");
    renderedContextSha256 = await sha256Domain(
      "zine.trace-context.rendered-selection.v1",
      renderedContext,
    );
  } catch {
    return failure({
      version: 1,
      code: "HASH_UNAVAILABLE",
      stage: "hash",
      message: "SHA-256 is unavailable for deterministic selection identity",
    });
  }
  if (options.signal?.aborted) return cancelled("hash");

  excludedCounts.duplicateCollapsed = grouped.duplicateCount;
  const compactDecisions = buildDecisions(decisions);
  const maxInputBytes = normalized.limits?.maxInputBytes
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes;
  const maxCandidateInputBytes = normalized.limits?.maxCandidateInputBytes
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes;
  const manifest: SelectedTraceContextManifestV1 = deepFreeze({
    version: 1,
    contract: "package-local-non-normative-v1",
    policy: normalized.policy,
    operation: normalized.operation,
    selected: decisions.flatMap((decision) => decision.selected ? [decision.selected] : []),
    exclusionSummary: {
      countsByReason: excludedCounts,
      ...(firstBudgetRejectedRef ? { firstBudgetRejectedRef } : {}),
    },
    input: {
      projectedInputBytes: normalized.projectedInputBytes,
      maxInputBytes,
      maxCandidateInputBytes,
    },
    budget: {
      contextCeilingBytes: normalized.operation.maxContextBytes,
      hardContextCeilingBytes: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxRenderedContextBytes,
      preparedRequestMaxBytes: normalized.operation.preparedRequestMaxBytes,
      reservedPromptBytes: normalized.operation.reservedPromptBytes,
      preparedRequestAvailableBytes,
      effectiveContextBytes,
      currentTargetTextBytes: utf8Bytes(normalized.operation.target.currentText),
      currentTargetRenderedBytes,
      usedRenderedBytes,
      candidateCount: normalized.candidates.length,
      uniqueCandidateCount: grouped.groups.length,
      selectedCount: selectedDrafts.length,
      truncated: excludedCounts.budgetExceeded > 0,
    },
    completeness: {
      selectionComplete: true,
      examinedCandidateCount: normalized.candidates.length,
    },
    hashes: { frozenInputsSha256, renderedContextSha256 },
  });

  const manifestBytes = utf8Bytes(canonicalJson(manifest));
  const manifestLimit = normalized.limits?.maxManifestBytes
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxManifestBytes;
  if (manifestBytes > manifestLimit) {
    return failure({
      version: 1,
      code: "MANIFEST_LIMIT_EXCEEDED",
      stage: "render",
      message: `Manifest size ${manifestBytes} exceeds limit ${manifestLimit}`,
      actual: manifestBytes,
      limit: manifestLimit,
    });
  }

  let manifestSha256: string;
  try {
    if (options.signal?.aborted) return cancelled("hash");
    manifestSha256 = await sha256Domain(
      "zine.trace-context.package-manifest.v1",
      canonicalJson(manifest),
    );
  } catch {
    return failure({
      version: 1,
      code: "HASH_UNAVAILABLE",
      stage: "hash",
      message: "SHA-256 is unavailable for deterministic manifest identity",
    });
  }
  if (options.signal?.aborted) return cancelled("hash");

  return deepFreeze({
    version: 1,
    ok: true,
    manifest,
    manifestSha256,
    renderedContext,
    decisions: compactDecisions,
  });
}

async function validateAndNormalizeInput(
  input: unknown,
  signal?: AbortSignal,
): Promise<{ ok: true; value: NormalizedInput } | TraceContextSelectionFailureV1> {
  if (!isRecord(input)) return malformed("$", "Selection input must be an object");
  if (input.version !== 1) {
    return failure({
      version: 1,
      code: "UNSUPPORTED_INPUT_VERSION",
      stage: "validate",
      message: "Selection input version must be 1",
      receivedVersionType: valueType(input.version),
    });
  }
  const topKeys = exactKeys(input, ["version", "policy", "operation", "candidates", "limits"]);
  if (topKeys) return malformed("$", topKeys);
  if (input.policy === "bounded-trace-v1") {
    return failure({
      version: 1,
      code: "UNSUPPORTED_POLICY",
      stage: "validate",
      message: "bounded-trace-v1 is unavailable until complete-Step suffix semantics are implemented",
      receivedPolicy: "bounded-trace-v1",
    });
  }
  if (!isOneOf(input.policy, POLICIES)) return malformed("$.policy", "Unsupported policy");

  if (!Array.isArray(input.candidates)) return malformed("$.candidates", "Candidates must be an array");
  if (input.candidates.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateSlots) {
    return failure({
      version: 1,
      code: "CANDIDATE_LIMIT_EXCEEDED",
      stage: "validate",
      message: "Raw candidate slots exceed the bounded selector scan ceiling",
      actual: input.candidates.length,
      limit: TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateSlots,
    });
  }
  const limitsResult = normalizeLimits(input.limits);
  if (!limitsResult.ok) return limitsResult;
  const maxInputBytes = limitsResult.value?.maxInputBytes
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes;
  const maxCandidateInputBytes = limitsResult.value?.maxCandidateInputBytes
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes;
  const oversizedOperationString = firstOversizedOperationString(input.operation, maxInputBytes);
  if (oversizedOperationString !== null) {
    return failure({
      version: 1,
      code: "INPUT_LIMIT_EXCEEDED",
      stage: "validate",
      message: "An operation string alone exceeds the total input byte ceiling",
      actual: oversizedOperationString,
      limit: maxInputBytes,
    });
  }
  const operationResult = normalizeOperation(input.operation);
  if (!operationResult.ok) return operationResult;

  const projectedValues: { value: unknown; path: string }[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    if (signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal.aborted) return cancelled("validate");
    }
    const value = input.candidates[index];
    if (input.policy === "text-only-v1" && isPolicyExcludedTextOnlyCandidate(value)) continue;
    projectedValues.push({ value, path: `$.candidates[${index}]` });
  }

  const candidateLimit = limitsResult.value?.maxCandidates
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates;
  if (projectedValues.length > candidateLimit) {
    return failure({
      version: 1,
      code: "CANDIDATE_LIMIT_EXCEEDED",
      stage: "validate",
      message: `Projected candidate count ${projectedValues.length} exceeds limit ${candidateLimit}`,
      actual: projectedValues.length,
      limit: candidateLimit,
    });
  }

  const candidates: NormalizedCandidate[] = [];
  const candidateIds = new Set<string>();
  let candidateBytesLowerBound = 0;
  for (let index = 0; index < projectedValues.length; index += 1) {
    if (signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal.aborted) return cancelled("validate");
    }
    const projected = projectedValues[index]!;
    const oversizedCandidateString = firstOversizedCandidateString(
      projected.value,
      maxCandidateInputBytes,
    );
    if (oversizedCandidateString !== null) {
      return failure({
        version: 1,
        code: "CANDIDATE_INPUT_LIMIT_EXCEEDED",
        stage: "validate",
        message: "A candidate string alone exceeds its input byte ceiling",
        candidateId: boundedCandidateId(projected.value, index),
        actual: oversizedCandidateString,
        limit: maxCandidateInputBytes,
      });
    }
    const result = normalizeCandidate(projected.value, projected.path, input.policy);
    if (!result.ok) return result;
    if (candidateIds.has(result.value.id)) {
      return malformed(`${projected.path}.id`, "Candidate ids must be unique after policy projection");
    }
    candidateIds.add(result.value.id);
    const candidateBytes = utf8Bytes(canonicalJson(result.value));
    if (candidateBytes > maxCandidateInputBytes) {
      return failure({
        version: 1,
        code: "CANDIDATE_INPUT_LIMIT_EXCEEDED",
        stage: "validate",
        message: `Candidate ${result.value.id} exceeds its input byte ceiling`,
        candidateId: result.value.id,
        actual: candidateBytes,
        limit: maxCandidateInputBytes,
      });
    }
    candidateBytesLowerBound += candidateBytes;
    if (candidateBytesLowerBound > maxInputBytes) {
      return failure({
        version: 1,
        code: "INPUT_LIMIT_EXCEEDED",
        stage: "validate",
        message: "Projected candidate bytes exceed the total input byte ceiling",
        actual: candidateBytesLowerBound,
        limit: maxInputBytes,
      });
    }
    candidates.push(result.value);
  }
  candidates.sort(compareCandidatesForFrozenInput);

  const frozenProjection: Omit<NormalizedInput, "projectedInputBytes"> = {
    version: 1,
    policy: input.policy,
    operation: operationResult.value,
    candidates,
    ...(limitsResult.value ? { limits: limitsResult.value } : {}),
  };
  const projectedInputBytes = utf8Bytes(canonicalJson(frozenProjection));
  if (projectedInputBytes > maxInputBytes) {
    return failure({
      version: 1,
      code: "INPUT_LIMIT_EXCEEDED",
      stage: "validate",
      message: "Projected selector input exceeds the total input byte ceiling",
      actual: projectedInputBytes,
      limit: maxInputBytes,
    });
  }

  return {
    ok: true,
    value: deepFreeze({ ...frozenProjection, projectedInputBytes }),
  };
}

function normalizeOperation(
  value: unknown,
): { ok: true; value: TraceContextSelectionOperationV1 } | TraceContextSelectionFailureV1 {
  if (!isRecord(value)) return malformed("$.operation", "Operation must be an object");
  const keys = exactKeys(value, [
    "version",
    "operation",
    "target",
    "range",
    "maxContextBytes",
    "preparedRequestMaxBytes",
    "reservedPromptBytes",
  ]);
  if (keys) return malformed("$.operation", keys);
  if (value.version !== 1) return malformed("$.operation.version", "Operation version must be 1");
  if (value.operation !== "extend" && value.operation !== "settle") {
    return malformed("$.operation.operation", "Operation must be extend or settle");
  }
  if (!isRecord(value.target)) return malformed("$.operation.target", "Target must be an object");
  const targetKeys = exactKeys(value.target, [
    "traceId",
    "headId",
    "contentHash",
    "currentText",
    "chosenPath",
  ]);
  if (targetKeys) return malformed("$.operation.target", targetKeys);
  for (const key of ["traceId", "headId", "contentHash"] as const) {
    const stringError = validateString(value.target[key], `$.operation.target.${key}`, false);
    if (stringError) return stringError;
  }
  const currentTextError = validateString(value.target.currentText, "$.operation.target.currentText", true);
  if (currentTextError) return currentTextError;
  if (value.target.chosenPath !== undefined) {
    const stringError = validateString(value.target.chosenPath, "$.operation.target.chosenPath", false);
    if (stringError) return stringError;
  }
  const rangeResult = normalizeRange(value.range, "$.operation.range");
  if (!rangeResult.ok) return rangeResult;
  if (value.operation === "settle" && !rangeResult.value) {
    return malformed("$.operation.range", "Settle requires an exact UTF-16 range");
  }
  for (const key of ["maxContextBytes", "preparedRequestMaxBytes"] as const) {
    if (!isPositiveSafeInteger(value[key])) {
      return malformed(`$.operation.${key}`, `${key} must be a positive safe integer`);
    }
  }
  if (!isNonNegativeSafeInteger(value.reservedPromptBytes)) {
    return malformed(
      "$.operation.reservedPromptBytes",
      "Reserved prompt bytes must be a non-negative safe integer",
    );
  }

  return {
    ok: true,
    value: deepFreeze({
      version: 1,
      operation: value.operation,
      target: {
        traceId: value.target.traceId as string,
        headId: value.target.headId as string,
        contentHash: value.target.contentHash as string,
        currentText: value.target.currentText as string,
        ...(value.target.chosenPath !== undefined
          ? { chosenPath: value.target.chosenPath as string }
          : {}),
      },
      ...(rangeResult.value ? { range: rangeResult.value } : {}),
      maxContextBytes: value.maxContextBytes as number,
      preparedRequestMaxBytes: value.preparedRequestMaxBytes as number,
      reservedPromptBytes: value.reservedPromptBytes,
    }),
  };
}

function normalizeCandidate(
  value: unknown,
  path: string,
  policy: TraceContextPolicyV1,
): { ok: true; value: NormalizedCandidate } | TraceContextSelectionFailureV1 {
  if (!isRecord(value)) return malformed(path, "Candidate must be an object");
  if (!isOneOf(value.kind, CANDIDATE_KINDS)) {
    return malformed(`${path}.kind`, "Unsupported candidate kind");
  }
  if (policy === "text-only-v1" && !isOneOf(value.kind, TEXT_ONLY_KINDS)) {
    return malformed(`${path}.kind`, "Candidate was not removed by text-only projection");
  }
  const process = value.kind === "process-fact";
  const keys = exactKeys(value, [
    "version",
    "id",
    "dedupeKey",
    "kind",
    "claimClass",
    "source",
    "reasons",
    process ? "fact" : "text",
  ]);
  if (keys) return malformed(path, keys);
  if (value.version !== 1) return malformed(`${path}.version`, "Candidate version must be 1");
  for (const key of ["id", "dedupeKey"] as const) {
    const stringError = validateString(value[key], `${path}.${key}`, false);
    if (stringError) return stringError;
  }
  if (!Array.isArray(value.reasons) || value.reasons.length === 0) {
    return malformed(`${path}.reasons`, "At least one explicit inclusion reason is required");
  }
  if (value.reasons.length > INCLUSION_REASONS.length) {
    return malformed(`${path}.reasons`, "Inclusion reasons must not contain duplicates");
  }
  const reasons: EvidenceInclusionReasonV1[] = [];
  for (let index = 0; index < value.reasons.length; index += 1) {
    const reason = value.reasons[index];
    if (!isOneOf(reason, INCLUSION_REASONS)) {
      return malformed(`${path}.reasons[${index}]`, "Unsupported inclusion reason");
    }
    reasons.push(reason);
  }
  if (new Set(reasons).size !== reasons.length) {
    return malformed(`${path}.reasons`, "Inclusion reasons must be unique");
  }

  const sourceResult = normalizeSource(value.source, `${path}.source`, value.kind, policy);
  if (!sourceResult.ok) return sourceResult;
  const claimClass = process ? "mechanical" : "explicit";
  if (value.claimClass !== claimClass) {
    return malformed(`${path}.claimClass`, `${value.kind} candidates must be ${claimClass}`);
  }

  if (process) {
    const factResult = normalizeProcessFact(value.fact, `${path}.fact`);
    if (!factResult.ok) return factResult;
    return {
      ok: true,
      value: deepFreeze({
        version: 1,
        id: value.id as string,
        dedupeKey: value.dedupeKey as string,
        kind: "process-fact",
        claimClass: "mechanical",
        source: sourceResult.value,
        reasons: uniqueSortedStrings(reasons),
        fact: factResult.value,
      }),
    };
  }

  const textError = validateString(value.text, `${path}.text`, true);
  if (textError) return textError;
  return {
    ok: true,
    value: deepFreeze({
      version: 1,
      id: value.id as string,
      dedupeKey: value.dedupeKey as string,
      kind: value.kind,
      claimClass: "explicit",
      source: sourceResult.value,
      reasons: uniqueSortedStrings(reasons),
      text: value.text as string,
    }),
  };
}

function normalizeSource(
  value: unknown,
  path: string,
  candidateKind: EvidenceCandidateKindV1,
  policy: TraceContextPolicyV1,
): { ok: true; value: SelectedEvidenceSourceV1 } | TraceContextSelectionFailureV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return malformed(path, "Evidence source must be a discriminated object");
  }
  const expectedKind: Readonly<Record<EvidenceCandidateKindV1, SelectedEvidenceSourceV1["kind"]>> = {
    "operation-instruction": "operation",
    "protected-range": "target",
    correction: "local",
    "explicit-preference": "local",
    "process-fact": "trace",
    citation: "citation",
  };
  if (value.kind !== expectedKind[candidateKind]) {
    return malformed(`${path}.kind`, `${candidateKind} candidates require a ${expectedKind[candidateKind]} source`);
  }
  const refError = validateString(value.ref, `${path}.ref`, false);
  if (refError) return refError;

  if (policy === "text-only-v1") {
    switch (value.kind) {
      case "operation": {
        const keys = exactKeys(value, ["kind", "ref"]);
        if (keys) return malformed(path, keys);
        return { ok: true, value: deepFreeze({ kind: "operation", ref: value.ref as string }) };
      }
      case "target": {
        const keys = exactKeys(value, ["kind", "ref", "traceId", "headId", "range"]);
        if (keys) return malformed(path, keys);
        const range = normalizeRange(value.range, `${path}.range`);
        if (!range.ok) return range;
        if (!range.value) return malformed(`${path}.range`, "Target evidence requires an exact UTF-16 range");
        return {
          ok: true,
          value: deepFreeze({ kind: "target", ref: value.ref as string, range: range.value }),
        };
      }
      case "citation": {
        const keys = exactKeys(value, [
          "kind",
          "ref",
          "nodeId",
          "approvedOrder",
          "processStatus",
          "traceId",
          "range",
        ]);
        if (keys) return malformed(path, keys);
        if (!isNonNegativeSafeInteger(value.approvedOrder)) {
          return malformed(`${path}.approvedOrder`, "Approved citation order must be a non-negative safe integer");
        }
        return {
          ok: true,
          value: deepFreeze({
            kind: "citation",
            ref: value.ref as string,
            approvedOrder: value.approvedOrder,
          }),
        };
      }
      default:
        return malformed(`${path}.kind`, "Trace-bearing source is unavailable to text-only selection");
    }
  }

  switch (value.kind) {
    case "operation": {
      const keys = exactKeys(value, ["kind", "ref"]);
      if (keys) return malformed(path, keys);
      return { ok: true, value: deepFreeze({ kind: "operation", ref: value.ref as string }) };
    }
    case "target": {
      const keys = exactKeys(value, ["kind", "ref", "traceId", "headId", "range"]);
      if (keys) return malformed(path, keys);
      for (const key of ["traceId", "headId"] as const) {
        const error = validateString(value[key], `${path}.${key}`, false);
        if (error) return error;
      }
      const range = normalizeRange(value.range, `${path}.range`);
      if (!range.ok) return range;
      if (!range.value) return malformed(`${path}.range`, "Target evidence requires an exact UTF-16 range");
      return {
        ok: true,
        value: deepFreeze({
          kind: "target",
          ref: value.ref as string,
          traceId: value.traceId as string,
          headId: value.headId as string,
          range: range.value,
        }),
      };
    }
    case "local": {
      const keys = exactKeys(value, ["kind", "ref"]);
      if (keys) return malformed(path, keys);
      return { ok: true, value: deepFreeze({ kind: "local", ref: value.ref as string }) };
    }
    case "trace": {
      const keys = exactKeys(value, [
        "kind",
        "ref",
        "traceId",
        "headId",
        "nodeId",
        "processStatus",
        "chainDistance",
        "transactionIndex",
        "range",
      ]);
      if (keys) return malformed(path, keys);
      for (const key of ["traceId", "headId", "nodeId"] as const) {
        const error = validateString(value[key], `${path}.${key}`, false);
        if (error) return error;
      }
      if (
        value.processStatus !== "full-trace"
        && value.processStatus !== "snapshot-only"
        && value.processStatus !== "invalid"
      ) {
        return malformed(`${path}.processStatus`, "Unsupported trace process status");
      }
      for (const key of ["chainDistance", "transactionIndex"] as const) {
        if (!isNonNegativeSafeInteger(value[key])) {
          return malformed(`${path}.${key}`, `${key} must be a non-negative safe integer`);
        }
      }
      const range = normalizeRange(value.range, `${path}.range`);
      if (!range.ok) return range;
      return {
        ok: true,
        value: deepFreeze({
          kind: "trace",
          ref: value.ref as string,
          traceId: value.traceId as string,
          headId: value.headId as string,
          nodeId: value.nodeId as string,
          processStatus: value.processStatus,
          chainDistance: value.chainDistance as number,
          transactionIndex: value.transactionIndex as number,
          ...(range.value ? { range: range.value } : {}),
        }),
      };
    }
    case "citation": {
      const keys = exactKeys(value, [
        "kind",
        "ref",
        "nodeId",
        "approvedOrder",
        "processStatus",
        "traceId",
        "range",
      ]);
      if (keys) return malformed(path, keys);
      const nodeError = validateString(value.nodeId, `${path}.nodeId`, false);
      if (nodeError) return nodeError;
      if (!isNonNegativeSafeInteger(value.approvedOrder)) {
        return malformed(`${path}.approvedOrder`, "Approved citation order must be a non-negative safe integer");
      }
      if (
        value.processStatus !== undefined
        && value.processStatus !== "full-trace"
        && value.processStatus !== "snapshot-only"
        && value.processStatus !== "invalid"
      ) {
        return malformed(`${path}.processStatus`, "Unsupported trace process status");
      }
      if (value.traceId !== undefined) {
        const traceError = validateString(value.traceId, `${path}.traceId`, false);
        if (traceError) return traceError;
      }
      const range = normalizeRange(value.range, `${path}.range`);
      if (!range.ok) return range;
      return {
        ok: true,
        value: deepFreeze({
          kind: "citation",
          ref: value.ref as string,
          nodeId: value.nodeId as string,
          approvedOrder: value.approvedOrder,
          ...(value.processStatus !== undefined ? { processStatus: value.processStatus } : {}),
          ...(value.traceId !== undefined ? { traceId: value.traceId as string } : {}),
          ...(range.value ? { range: range.value } : {}),
        }),
      };
    }
    default:
      return malformed(`${path}.kind`, "Unsupported evidence source kind");
  }
}

function normalizeProcessFact(
  value: unknown,
  path: string,
): { ok: true; value: TraceProcessFactV1 } | TraceContextSelectionFailureV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return malformed(path, "Process fact must be a closed discriminated object");
  }
  switch (value.kind) {
    case "step-summary": {
      const keys = exactKeys(value, [
        "kind",
        "transactionCount",
        "rangeCount",
        "insertedCodePointCount",
        "deletedCodePointCount",
        "firstCapturedAtMs",
        "lastCapturedAtMs",
        "spanMs",
        "longestGapMs",
        "undoCount",
        "redoCount",
      ]);
      if (keys) return malformed(path, keys);
      for (const key of [
        "transactionCount",
        "rangeCount",
        "insertedCodePointCount",
        "deletedCodePointCount",
        "spanMs",
        "longestGapMs",
        "undoCount",
        "redoCount",
      ] as const) {
        if (!isNonNegativeSafeInteger(value[key])) {
          return malformed(`${path}.${key}`, `${key} must be a non-negative safe integer`);
        }
      }
      const hasFirst = value.firstCapturedAtMs !== undefined;
      const hasLast = value.lastCapturedAtMs !== undefined;
      if (hasFirst !== hasLast) {
        return malformed(path, "Step summary capture times must be present or absent together");
      }
      if (hasFirst) {
        if (
          !isNonNegativeSafeInteger(value.firstCapturedAtMs)
          || !isNonNegativeSafeInteger(value.lastCapturedAtMs)
          || value.lastCapturedAtMs < value.firstCapturedAtMs
        ) {
          return malformed(path, "Step summary capture times must be ordered non-negative integers");
        }
        if (value.spanMs !== value.lastCapturedAtMs - value.firstCapturedAtMs) {
          return malformed(`${path}.spanMs`, "Step summary span must exactly match its capture times");
        }
      } else if (value.spanMs !== 0) {
        return malformed(`${path}.spanMs`, "A summary without capture times must have zero span");
      }
      if ((value.longestGapMs as number) > (value.spanMs as number)) {
        return malformed(`${path}.longestGapMs`, "Longest gap cannot exceed the Step span");
      }
      return {
        ok: true,
        value: deepFreeze({
          kind: "step-summary",
          transactionCount: value.transactionCount as number,
          rangeCount: value.rangeCount as number,
          insertedCodePointCount: value.insertedCodePointCount as number,
          deletedCodePointCount: value.deletedCodePointCount as number,
          ...(hasFirst ? { firstCapturedAtMs: value.firstCapturedAtMs as number } : {}),
          ...(hasLast ? { lastCapturedAtMs: value.lastCapturedAtMs as number } : {}),
          spanMs: value.spanMs,
          longestGapMs: value.longestGapMs as number,
          undoCount: value.undoCount as number,
          redoCount: value.redoCount as number,
        }),
      };
    }
    case "transaction": {
      const keys = exactKeys(value, [
        "kind",
        "transactionIndex",
        "capturedAtMs",
        "intent",
        "changeCount",
        "voiceIds",
      ]);
      if (keys) return malformed(path, keys);
      for (const key of ["transactionIndex", "capturedAtMs"] as const) {
        if (!isNonNegativeSafeInteger(value[key])) {
          return malformed(`${path}.${key}`, `${key} must be a non-negative safe integer`);
        }
      }
      if (value.intent !== undefined && value.intent !== "undo" && value.intent !== "redo") {
        return malformed(`${path}.intent`, "Transaction intent must be undo or redo");
      }
      if (!isPositiveSafeInteger(value.changeCount)) {
        return malformed(`${path}.changeCount`, "Transaction change count must be a positive safe integer");
      }
      if (
        !Array.isArray(value.voiceIds)
        || value.voiceIds.length === 0
        || value.voiceIds.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxFactVoiceIds
      ) {
        return malformed(`${path}.voiceIds`, "Transaction voices must be a bounded non-empty array");
      }
      const voices: string[] = [];
      for (let index = 0; index < value.voiceIds.length; index += 1) {
        const error = validateString(value.voiceIds[index], `${path}.voiceIds[${index}]`, false);
        if (error) return error;
        voices.push(value.voiceIds[index] as string);
      }
      if (new Set(voices).size !== voices.length) {
        return malformed(`${path}.voiceIds`, "Transaction voice ids must be unique");
      }
      return {
        ok: true,
        value: deepFreeze({
          kind: "transaction",
          transactionIndex: value.transactionIndex as number,
          capturedAtMs: value.capturedAtMs as number,
          ...(value.intent !== undefined ? { intent: value.intent } : {}),
          changeCount: value.changeCount,
          voiceIds: voices.sort(compareUtf8),
        }),
      };
    }
    case "change": {
      const keys = exactKeys(value, [
        "kind",
        "transactionIndex",
        "operation",
        "range",
        "insertedCodePointCount",
        "deletedCodePointCount",
        "voiceId",
      ]);
      if (keys) return malformed(path, keys);
      if (!isNonNegativeSafeInteger(value.transactionIndex)) {
        return malformed(`${path}.transactionIndex`, "Transaction index must be a non-negative safe integer");
      }
      if (value.operation !== "insert" && value.operation !== "delete" && value.operation !== "replace") {
        return malformed(`${path}.operation`, "Change operation must be insert, delete, or replace");
      }
      const range = normalizeRange(value.range, `${path}.range`);
      if (!range.ok || !range.value) {
        return range.ok ? malformed(`${path}.range`, "Change requires an exact source range") : range;
      }
      for (const key of ["insertedCodePointCount", "deletedCodePointCount"] as const) {
        if (!isNonNegativeSafeInteger(value[key])) {
          return malformed(`${path}.${key}`, `${key} must be a non-negative safe integer`);
        }
      }
      const voiceError = validateString(value.voiceId, `${path}.voiceId`, false);
      if (voiceError) return voiceError;
      const emptyRange = range.value.fromUtf16 === range.value.toUtf16;
      const insertedCodePointCount = value.insertedCodePointCount as number;
      const deletedCodePointCount = value.deletedCodePointCount as number;
      const consistent = value.operation === "insert"
        ? emptyRange && insertedCodePointCount > 0 && deletedCodePointCount === 0
        : value.operation === "delete"
          ? !emptyRange && insertedCodePointCount === 0 && deletedCodePointCount > 0
          : !emptyRange && insertedCodePointCount > 0 && deletedCodePointCount > 0;
      if (!consistent) return malformed(path, "Change counts/range do not match its mechanical operation");
      return {
        ok: true,
        value: deepFreeze({
          kind: "change",
          transactionIndex: value.transactionIndex,
          operation: value.operation,
          range: range.value,
          insertedCodePointCount,
          deletedCodePointCount,
          voiceId: value.voiceId as string,
        }),
      };
    }
    default:
      return malformed(`${path}.kind`, "Unsupported mechanical process fact kind");
  }
}

function normalizeLimits(
  value: unknown,
): { ok: true; value?: TraceContextSelectionInputV1["limits"] } | TraceContextSelectionFailureV1 {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return malformed("$.limits", "Limits must be an object");
  const keys = exactKeys(value, [
    "version",
    "maxCandidates",
    "maxInputBytes",
    "maxCandidateInputBytes",
    "maxManifestBytes",
  ]);
  if (keys) return malformed("$.limits", keys);
  if (value.version !== 1) return malformed("$.limits.version", "Limits version must be 1");
  for (const [key, hardLimit] of [
    ["maxCandidates", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates],
    ["maxInputBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes],
    ["maxCandidateInputBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes],
    ["maxManifestBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxManifestBytes],
  ] as const) {
    if (value[key] !== undefined) {
      if (!isPositiveSafeInteger(value[key]) || value[key] > hardLimit) {
        return malformed(`$.limits.${key}`, `${key} must be a positive integer no greater than ${hardLimit}`);
      }
    }
  }
  return {
    ok: true,
    value: deepFreeze({
      version: 1,
      ...(value.maxCandidates !== undefined ? { maxCandidates: value.maxCandidates as number } : {}),
      ...(value.maxInputBytes !== undefined ? { maxInputBytes: value.maxInputBytes as number } : {}),
      ...(value.maxCandidateInputBytes !== undefined
        ? { maxCandidateInputBytes: value.maxCandidateInputBytes as number }
        : {}),
      ...(value.maxManifestBytes !== undefined
        ? { maxManifestBytes: value.maxManifestBytes as number }
        : {}),
    }),
  };
}

function validateSelectedProcessEvidence(
  input: NormalizedInput,
): TraceContextSelectionFailureV1 | null {
  if (input.policy !== "selected-trace-v1") return null;
  for (const candidate of input.candidates) {
    if (candidate.kind !== "process-fact" || candidate.source.kind !== "trace") continue;
    if (candidate.source.processStatus === "invalid") {
      return failure({
        version: 1,
        code: "INVALID_PROCESS_EVIDENCE",
        stage: "select",
        message: "Selected-trace preparation cannot complete with invalid process evidence",
        candidateId: candidate.id,
        sourceRef: candidate.source.ref,
      });
    }
    if (candidate.source.processStatus === "snapshot-only") {
      return failure({
        version: 1,
        code: "CONTEXT_INCOMPLETE",
        stage: "select",
        message: "Snapshot-only process cannot support a complete selected-trace context",
        candidateId: candidate.id,
        sourceRef: candidate.source.ref,
        reason: "snapshot-only-process",
      });
    }
    const sameTarget = candidate.source.traceId === input.operation.target.traceId
      && candidate.source.headId === input.operation.target.headId;
    const exactDistance = candidate.source.chainDistance === 0
      ? candidate.source.nodeId === input.operation.target.headId
      : candidate.source.nodeId !== input.operation.target.headId;
    const factTransactionMatches = candidate.fact?.kind === "step-summary"
      || candidate.fact?.transactionIndex === candidate.source.transactionIndex;
    if (!sameTarget || !exactDistance || !factTransactionMatches) {
      return failure({
        version: 1,
        code: "PROCESS_SOURCE_MISMATCH",
        stage: "select",
        message: "Process evidence does not belong to the prepared target head chain",
        candidateId: candidate.id,
        sourceRef: candidate.source.ref,
      });
    }
  }
  return null;
}

async function collapseCandidates(
  candidates: readonly NormalizedCandidate[],
  signal?: AbortSignal,
): Promise<
  | { ok: true; groups: readonly CandidateGroup[]; duplicateCount: number }
  | TraceContextSelectionFailureV1
> {
  const byKey = new Map<string, NormalizedCandidate[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    if (signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal.aborted) return cancelled("select");
    }
    const candidate = candidates[index]!;
    const existing = byKey.get(candidate.dedupeKey);
    if (existing) existing.push(candidate);
    else byKey.set(candidate.dedupeKey, [candidate]);
  }

  const groups: CandidateGroup[] = [];
  let duplicateCount = 0;
  let groupIndex = 0;
  for (const candidatesForKey of byKey.values()) {
    if (signal && groupIndex % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal.aborted) return cancelled("select");
    }
    groupIndex += 1;
    const representative = candidatesForKey[0]!;
    const identity = duplicateIdentity(representative);
    if (candidatesForKey.some((candidate) => duplicateIdentity(candidate) !== identity)) {
      return failure({
        version: 1,
        code: "DUPLICATE_CONFLICT",
        stage: "select",
        message: `Duplicate key ${representative.dedupeKey} names conflicting evidence`,
        dedupeKey: representative.dedupeKey,
        candidateIds: candidatesForKey.map((candidate) => candidate.id),
      });
    }
    duplicateCount += candidatesForKey.length - 1;
    groups.push(deepFreeze({
      representative,
      candidates: candidatesForKey,
      reasons: uniqueSortedStrings(candidatesForKey.flatMap((candidate) => candidate.reasons)),
      priorityClass: priorityClass(representative),
    }));
  }
  return { ok: true, groups: deepFreeze(groups), duplicateCount };
}

function frozenInputProjection(input: NormalizedInput): Omit<NormalizedInput, "projectedInputBytes"> {
  return {
    version: input.version,
    policy: input.policy,
    operation: input.operation,
    candidates: input.candidates,
    ...(input.limits ? { limits: input.limits } : {}),
  };
}

function isPolicyExcludedTextOnlyCandidate(value: unknown): boolean {
  return isRecord(value)
    && (value.kind === "correction" || value.kind === "explicit-preference" || value.kind === "process-fact");
}

/** Valid Unicode always occupies at least one UTF-8 byte per UTF-16 code unit. */
function firstOversizedOperationString(value: unknown, byteLimit: number): number | null {
  if (!isRecord(value)) return null;
  const target = isRecord(value.target) ? value.target : {};
  for (const candidate of [
    value.operation,
    target.traceId,
    target.headId,
    target.contentHash,
    target.currentText,
    target.chosenPath,
  ]) {
    if (typeof candidate === "string" && candidate.length > byteLimit) return candidate.length;
  }
  return null;
}

function firstOversizedCandidateString(value: unknown, byteLimit: number): number | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.source) ? value.source : {};
  const fact = isRecord(value.fact) ? value.fact : {};
  for (const candidate of [
    value.id,
    value.dedupeKey,
    value.text,
    source.ref,
    source.traceId,
    source.headId,
    source.nodeId,
    fact.voiceId,
  ]) {
    if (typeof candidate === "string" && candidate.length > byteLimit) return candidate.length;
  }
  if (Array.isArray(fact.voiceIds) && fact.voiceIds.length <= TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxFactVoiceIds) {
    for (const voiceId of fact.voiceIds) {
      if (typeof voiceId === "string" && voiceId.length > byteLimit) return voiceId.length;
    }
  }
  return null;
}

function boundedCandidateId(value: unknown, index: number): string {
  if (isRecord(value) && typeof value.id === "string" && value.id.length <= 128 && !hasUnpairedSurrogate(value.id)) {
    return value.id;
  }
  return `@candidate-${index}`;
}

function duplicateIdentity(candidate: NormalizedCandidate): string {
  return canonicalJson({
    kind: candidate.kind,
    claimClass: candidate.claimClass,
    source: candidate.source,
    ...(candidate.fact ? { fact: candidate.fact } : { text: candidate.text }),
  });
}

function priorityClass(candidate: NormalizedCandidate): EvidencePriorityClassV1 {
  switch (candidate.kind) {
    case "operation-instruction": return "operation-instruction";
    case "protected-range": return "protected-range";
    case "correction": return "correction";
    case "explicit-preference": return "explicit-preference";
    case "process-fact":
      return candidate.source.kind === "trace" && candidate.source.chainDistance === 0
        ? "prepared-head-process"
        : "prior-process";
    case "citation": return "direct-citation";
  }
}

function compareGroups(left: CandidateGroup, right: CandidateGroup): number {
  const priority = PRIORITY_RANK[left.priorityClass] - PRIORITY_RANK[right.priorityClass];
  if (priority !== 0) return priority;
  const leftSource = left.representative.source;
  const rightSource = right.representative.source;
  if (leftSource.kind === "trace" && rightSource.kind === "trace") {
    const distance = leftSource.chainDistance - rightSource.chainDistance;
    if (distance !== 0) return distance;
    const transaction = leftSource.transactionIndex - rightSource.transactionIndex;
    if (transaction !== 0) return transaction;
    const node = compareUtf8(leftSource.nodeId, rightSource.nodeId);
    if (node !== 0) return node;
  } else if (leftSource.kind === "citation" && rightSource.kind === "citation") {
    const order = leftSource.approvedOrder - rightSource.approvedOrder;
    if (order !== 0) return order;
    const leftNode = "nodeId" in leftSource ? leftSource.nodeId : "";
    const rightNode = "nodeId" in rightSource ? rightSource.nodeId : "";
    const node = compareUtf8(leftNode, rightNode);
    if (node !== 0) return node;
  }
  return compareUtf8(leftSource.ref, rightSource.ref)
    || compareUtf8(left.representative.dedupeKey, right.representative.dedupeKey)
    || compareUtf8(left.representative.id, right.representative.id);
}

function compareCandidatesForFrozenInput(left: NormalizedCandidate, right: NormalizedCandidate): number {
  return compareUtf8(left.dedupeKey, right.dedupeKey)
    || compareUtf8(left.id, right.id)
    || compareUtf8(duplicateIdentity(left), duplicateIdentity(right))
    || compareUtf8(canonicalJson(left.reasons), canonicalJson(right.reasons));
}

function renderCurrentTarget(text: string): string {
  return canonicalJson({
    version: 1,
    authority: "quoted-data",
    kind: "current-target",
    text,
  });
}

function renderCandidate(group: CandidateGroup): RenderedCandidate {
  const candidate = group.representative;
  const segment = canonicalJson({
    version: 1,
    authority: authorityFor(candidate.kind),
    evidenceId: candidate.id,
    kind: candidate.kind,
    claimClass: candidate.claimClass,
    source: candidate.source,
    reasons: group.reasons,
    text: candidate.fact ? renderProcessFact(candidate.fact, candidate.source) : candidate.text,
  });
  return { segment, segmentBytes: utf8Bytes(segment) };
}

function renderProcessFact(fact: TraceProcessFactV1, source: SelectedEvidenceSourceV1): string {
  const node = source.kind === "trace" ? source.nodeId : "unknown";
  switch (fact.kind) {
    case "step-summary":
      return `Step ${node} · ${fact.transactionCount} tx / ${fact.rangeCount} ranges · +${fact.insertedCodePointCount}/−${fact.deletedCodePointCount} · first ${fact.firstCapturedAtMs ?? "none"} · last ${fact.lastCapturedAtMs ?? "none"} · span ${fact.spanMs}ms · longest gap ${fact.longestGapMs}ms · undo ${fact.undoCount} · redo ${fact.redoCount}`;
    case "transaction":
      return `tx ${fact.transactionIndex} @ ${fact.capturedAtMs} · ${fact.intent ? `${fact.intent} · ` : ""}${fact.changeCount} changes · voices ${fact.voiceIds.join(",")}`;
    case "change":
      return `change tx ${fact.transactionIndex} · ${fact.operation} · range [${fact.range.fromUtf16},${fact.range.toUtf16}) · +${fact.insertedCodePointCount}/−${fact.deletedCodePointCount} · voice ${fact.voiceId}`;
  }
}

function buildDecisions(groupDecisions: readonly GroupDecision[]): readonly EvidenceSelectionDecisionV1[] {
  const decisions: EvidenceSelectionDecisionV1[] = [];
  for (const groupDecision of groupDecisions) {
    const representative = groupDecision.group.representative;
    decisions.push({
      version: 1,
      candidateId: representative.id,
      dedupeKey: representative.dedupeKey,
      inclusionReasons: representative.reasons,
      disposition: groupDecision.selected ? "selected" : "excluded",
      reason: groupDecision.reason,
      ...(groupDecision.selected ? { selectedEvidenceId: representative.id } : {}),
    });
    for (const duplicate of groupDecision.group.candidates.slice(1)) {
      decisions.push({
        version: 1,
        candidateId: duplicate.id,
        dedupeKey: duplicate.dedupeKey,
        inclusionReasons: duplicate.reasons,
        disposition: "collapsed",
        reason: "duplicate-collapsed",
        ...(groupDecision.selected ? { selectedEvidenceId: representative.id } : {}),
      });
    }
  }
  return deepFreeze(decisions);
}

function authorityFor(kind: EvidenceCandidateKindV1): "instruction" | "quoted-data" {
  return kind === "operation-instruction" ? "instruction" : "quoted-data";
}

function isMandatory(kind: EvidenceCandidateKindV1): boolean {
  return kind === "operation-instruction" || kind === "protected-range";
}

function emptyExclusionCounts(): EvidenceExclusionCountsV1 {
  return { budgetExceeded: 0, duplicateCollapsed: 0 };
}

function normalizeRange(
  value: unknown,
  path: string,
): { ok: true; value?: Utf16Range } | TraceContextSelectionFailureV1 {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return malformed(path, "Range must be an object");
  const keys = exactKeys(value, ["fromUtf16", "toUtf16"]);
  if (keys) return malformed(path, keys);
  if (
    !isNonNegativeSafeInteger(value.fromUtf16)
    || !isNonNegativeSafeInteger(value.toUtf16)
    || value.toUtf16 < value.fromUtf16
  ) {
    return malformed(path, "Range must be an ordered half-open UTF-16 range");
  }
  return {
    ok: true,
    value: deepFreeze({ fromUtf16: value.fromUtf16, toUtf16: value.toUtf16 }),
  };
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key)).sort(compareUtf8);
  return unknown.length > 0 ? `Unknown field ${unknown[0]}` : null;
}

function validateString(
  value: unknown,
  path: string,
  allowEmpty: boolean,
): TraceContextSelectionFailureV1 | null {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    return malformed(path, allowEmpty ? "Value must be a string" : "Value must be a non-empty string");
  }
  if (hasUnpairedSurrogate(value)) {
    return malformed(path, "String contains an unpaired UTF-16 surrogate");
  }
  return null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function valueType(value: unknown): TraceContextInputValueTypeV1 {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const primitiveType = typeof value;
  if (
    primitiveType === "undefined"
    || primitiveType === "boolean"
    || primitiveType === "number"
    || primitiveType === "string"
    || primitiveType === "object"
  ) {
    return primitiveType;
  }
  return "other";
}

function isOneOf<const T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === "string" && choices.some((choice) => choice === value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function uniqueSortedStrings<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function canonicalJson(value: unknown): string {
  return serialize(value);

  function serialize(current: unknown): string {
    if (current === null) return "null";
    if (typeof current === "string") {
      if (hasUnpairedSurrogate(current)) throw new TypeError("cannot canonicalize unpaired surrogate");
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("cannot canonicalize non-finite number");
      return JSON.stringify(current);
    }
    if (typeof current === "boolean") return current ? "true" : "false";
    if (Array.isArray(current)) return `[${current.map(serialize).join(",")}]`;
    if (isRecord(current)) {
      return `{${Object.keys(current)
        .filter((key) => current[key] !== undefined)
        .sort(compareUtf8)
        .map((key) => `${JSON.stringify(key)}:${serialize(current[key])}`)
        .join(",")}}`;
    }
    throw new TypeError(`cannot canonicalize ${typeof current}`);
  }
}

async function sha256Domain(domain: string, value: string): Promise<string> {
  const bytes = encoder.encode(`${domain}\0${value}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function malformed(path: string, message: string): TraceContextSelectionFailureV1 {
  return failure({
    version: 1,
    code: "MALFORMED_INPUT",
    stage: "validate",
    message,
    path,
  });
}

function cancelled(
  stage: Extract<TraceContextSelectionErrorV1, { code: "CANCELLED" }>["stage"],
): TraceContextSelectionFailureV1 {
  return failure({
    version: 1,
    code: "CANCELLED",
    stage,
    message: "Trace-context selection was cancelled before completeness could be established",
  });
}

function failure(error: TraceContextSelectionErrorV1): TraceContextSelectionFailureV1 {
  return deepFreeze({ version: 1, ok: false, error });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
