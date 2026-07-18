import type { Utf16Range } from "./types.js";
import {
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  type EvidenceCandidateKindV1,
  type EvidenceCandidateV1,
  type EvidenceDecisionReasonV1,
  type EvidenceExclusionCountsV1,
  type EvidenceInclusionReasonV1,
  type EvidencePriorityClassV1,
  type EvidenceSelectionDecisionV1,
  type EvidenceSourceV1,
  type SelectedEvidenceV1,
  type SelectedTraceContextManifestV1,
  type TraceContextPolicyV1,
  type TraceContextInputValueTypeV1,
  type TraceContextSelectionErrorV1,
  type TraceContextSelectionFailureV1,
  type TraceContextSelectionInputV1,
  type TraceContextSelectionOptionsV1,
  type TraceContextSelectionResultV1,
} from "./selection-types.js";

const encoder = new TextEncoder();
const CANCELLATION_YIELD_INTERVAL = 256;

const POLICIES: readonly TraceContextPolicyV1[] = [
  "text-only-v1",
  "bounded-trace-v1",
  "selected-trace-v1",
];

const CANDIDATE_KINDS: readonly EvidenceCandidateKindV1[] = [
  "operation-instruction",
  "protected-range",
  "correction",
  "explicit-preference",
  "process-fact",
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

interface NormalizedInput extends TraceContextSelectionInputV1 {
  candidates: readonly EvidenceCandidateV1[];
}

interface CandidateGroup {
  representative: EvidenceCandidateV1;
  candidates: readonly EvidenceCandidateV1[];
  reasons: readonly EvidenceInclusionReasonV1[];
  priorityClass: EvidencePriorityClassV1;
}

interface RenderedCandidate {
  group: CandidateGroup;
  segment: string;
  segmentBytes: number;
}

interface GroupDecision {
  group: CandidateGroup;
  reason: EvidenceDecisionReasonV1;
  selected?: SelectedEvidenceV1;
}

/**
 * Deterministically filters and renders adapter-materialized evidence.
 *
 * This package-local manifest is non-normative and is not the future encrypted
 * durable TraceContextManifest contract. The bounded policy filters already
 * materialized candidates; complete-Step suffix construction remains an
 * adapter/runtime concern until that contract is separately frozen.
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

  const grouped = await collapseCandidates(normalized.candidates, options.signal);
  if (!grouped.ok) return grouped;
  if (options.signal?.aborted) return cancelled("select");

  const effectiveContextBytes = Math.min(
    normalized.operation.maxContextBytes,
    TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxRenderedContextBytes,
  );
  const availableRenderedBytes = effectiveContextBytes - normalized.operation.reservedPromptBytes;
  if (availableRenderedBytes < 2) {
    return failure({
      version: 1,
      code: "MANDATORY_BUDGET_EXCEEDED",
      stage: "render",
      message: "The context budget cannot contain the empty rendered evidence envelope",
      available: Math.max(0, availableRenderedBytes),
      required: 2,
    });
  }

  const orderedGroups = [...grouped.groups].sort(compareGroups);
  const excludedCounts = emptyExclusionCounts();
  const decisions: GroupDecision[] = [];
  const selectedDrafts: RenderedCandidate[] = [];
  let usedRenderedBytes = 2; // The canonical JSON array brackets: `[]`.
  let firstBudgetRejectedRef: { candidateId: string; dedupeKey: string } | undefined;

  for (let index = 0; index < orderedGroups.length; index += 1) {
    if (options.signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (options.signal?.aborted) return cancelled("select");
    }
    const group = orderedGroups[index]!;
    const safetyExclusion = processEvidenceExclusion(group.representative);
    if (safetyExclusion) {
      decisions.push({ group, reason: safetyExclusion });
      incrementExclusion(excludedCounts, safetyExclusion);
      continue;
    }
    if (!policyAllows(normalized.policy, group.representative.kind)) {
      decisions.push({ group, reason: "policy-excluded" });
      excludedCounts.policyExcluded += 1;
      continue;
    }

    const rendered = renderCandidate(group);
    const separatorBytes = selectedDrafts.length === 0 ? 0 : 1;
    const renderedByteCost = rendered.segmentBytes + separatorBytes;
    const required = usedRenderedBytes + renderedByteCost;
    if (required > availableRenderedBytes) {
      if (isMandatory(group.representative.kind)) {
        return failure({
          version: 1,
          code: "MANDATORY_BUDGET_EXCEEDED",
          stage: "render",
          message: `Mandatory candidate ${group.representative.id} exceeds the rendered context budget`,
          available: availableRenderedBytes,
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
    const selected: SelectedEvidenceV1 = {
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
    };
    selectedDrafts.push(rendered);
    decisions.push({
      group,
      reason: isMandatory(group.representative.kind) ? "mandatory" : "policy-eligible",
      selected,
    });
  }

  if (options.signal?.aborted) return cancelled("render");
  const renderedContext = `[${selectedDrafts.map((draft) => draft.segment).join(",")}]`;
  if (utf8Bytes(renderedContext) !== usedRenderedBytes) {
    return failure({
      version: 1,
      code: "INTERNAL_INVARIANT",
      stage: "render",
      message: "Rendered-context byte accounting did not match the final output",
    });
  }

  const normalizedForHash = {
    version: normalized.version,
    policy: normalized.policy,
    operation: normalized.operation,
    candidates: normalized.candidates,
    ...(normalized.limits ? { limits: normalized.limits } : {}),
  };

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
    budget: {
      effectiveContextBytes,
      reservedPromptBytes: normalized.operation.reservedPromptBytes,
      availableRenderedBytes,
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
  if (!isOneOf(input.policy, POLICIES)) return malformed("$.policy", "Unsupported policy");

  const operationResult = normalizeOperation(input.operation);
  if (!operationResult.ok) return operationResult;
  if (!Array.isArray(input.candidates)) return malformed("$.candidates", "Candidates must be an array");
  const limitsResult = normalizeLimits(input.limits);
  if (!limitsResult.ok) return limitsResult;
  const candidateLimit = limitsResult.value?.maxCandidates
    ?? TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates;
  if (input.candidates.length > candidateLimit) {
    return failure({
      version: 1,
      code: "CANDIDATE_LIMIT_EXCEEDED",
      stage: "validate",
      message: `Candidate count ${input.candidates.length} exceeds limit ${candidateLimit}`,
      actual: input.candidates.length,
      limit: candidateLimit,
    });
  }

  const candidates: EvidenceCandidateV1[] = [];
  const candidateIds = new Set<string>();
  for (let index = 0; index < input.candidates.length; index += 1) {
    if (signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal?.aborted) return cancelled("validate");
    }
    const result = normalizeCandidate(input.candidates[index], `$.candidates[${index}]`);
    if (!result.ok) return result;
    if (candidateIds.has(result.value.id)) {
      return malformed(`$.candidates[${index}].id`, "Candidate ids must be unique");
    }
    candidateIds.add(result.value.id);
    candidates.push(result.value);
  }
  candidates.sort(compareCandidatesForFrozenInput);

  return {
    ok: true,
    value: deepFreeze({
      version: 1,
      policy: input.policy,
      operation: operationResult.value,
      candidates,
      ...(limitsResult.value ? { limits: limitsResult.value } : {}),
    }),
  };
}

function normalizeOperation(
  value: unknown,
): { ok: true; value: TraceContextSelectionInputV1["operation"] } | TraceContextSelectionFailureV1 {
  if (!isRecord(value)) return malformed("$.operation", "Operation must be an object");
  const keys = exactKeys(value, [
    "version",
    "operation",
    "target",
    "range",
    "maxContextBytes",
    "reservedPromptBytes",
  ]);
  if (keys) return malformed("$.operation", keys);
  if (value.version !== 1) return malformed("$.operation.version", "Operation version must be 1");
  if (value.operation !== "extend" && value.operation !== "settle") {
    return malformed("$.operation.operation", "Operation must be extend or settle");
  }
  if (!isRecord(value.target)) return malformed("$.operation.target", "Target must be an object");
  const targetKeys = exactKeys(value.target, ["traceId", "headId", "contentHash", "chosenPath"]);
  if (targetKeys) return malformed("$.operation.target", targetKeys);
  for (const key of ["traceId", "headId", "contentHash"] as const) {
    const stringError = validateString(value.target[key], `$.operation.target.${key}`, false);
    if (stringError) return stringError;
  }
  if (value.target.chosenPath !== undefined) {
    const stringError = validateString(value.target.chosenPath, "$.operation.target.chosenPath", false);
    if (stringError) return stringError;
  }
  const rangeResult = normalizeRange(value.range, "$.operation.range");
  if (!rangeResult.ok) return rangeResult;
  if (value.operation === "settle" && !rangeResult.value) {
    return malformed("$.operation.range", "Settle requires an exact UTF-16 range");
  }
  if (!isPositiveSafeInteger(value.maxContextBytes)) {
    return malformed("$.operation.maxContextBytes", "Maximum context bytes must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(value.reservedPromptBytes)) {
    return malformed("$.operation.reservedPromptBytes", "Reserved prompt bytes must be a non-negative safe integer");
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
        ...(value.target.chosenPath !== undefined
          ? { chosenPath: value.target.chosenPath as string }
          : {}),
      },
      ...(rangeResult.value ? { range: rangeResult.value } : {}),
      maxContextBytes: value.maxContextBytes,
      reservedPromptBytes: value.reservedPromptBytes,
    }),
  };
}

function normalizeCandidate(
  value: unknown,
  path: string,
): { ok: true; value: EvidenceCandidateV1 } | TraceContextSelectionFailureV1 {
  if (!isRecord(value)) return malformed(path, "Candidate must be an object");
  const keys = exactKeys(value, [
    "version",
    "id",
    "dedupeKey",
    "kind",
    "claimClass",
    "source",
    "reasons",
    "text",
  ]);
  if (keys) return malformed(path, keys);
  if (value.version !== 1) return malformed(`${path}.version`, "Candidate version must be 1");
  for (const key of ["id", "dedupeKey"] as const) {
    const stringError = validateString(value[key], `${path}.${key}`, false);
    if (stringError) return stringError;
  }
  const textError = validateString(value.text, `${path}.text`, true);
  if (textError) return textError;
  if (!isOneOf(value.kind, CANDIDATE_KINDS)) return malformed(`${path}.kind`, "Unsupported candidate kind");
  if (value.claimClass !== "explicit" && value.claimClass !== "mechanical") {
    return malformed(`${path}.claimClass`, "Claim class must be explicit or mechanical");
  }
  if (!Array.isArray(value.reasons) || value.reasons.length === 0) {
    return malformed(`${path}.reasons`, "At least one explicit inclusion reason is required");
  }
  const reasons: EvidenceInclusionReasonV1[] = [];
  for (let index = 0; index < value.reasons.length; index += 1) {
    const reason = value.reasons[index];
    if (!isOneOf(reason, INCLUSION_REASONS)) {
      return malformed(`${path}.reasons[${index}]`, "Unsupported inclusion reason");
    }
    reasons.push(reason);
  }
  const sourceResult = normalizeSource(value.source, `${path}.source`);
  if (!sourceResult.ok) return sourceResult;
  const compatibilityError = validateCandidateCompatibility(
    value.kind,
    value.claimClass,
    sourceResult.value,
    path,
  );
  if (compatibilityError) return compatibilityError;

  return {
    ok: true,
    value: deepFreeze({
      version: 1,
      id: value.id as string,
      dedupeKey: value.dedupeKey as string,
      kind: value.kind,
      claimClass: value.claimClass,
      source: sourceResult.value,
      reasons: uniqueSortedStrings(reasons),
      text: value.text as string,
    }),
  };
}

function normalizeSource(
  value: unknown,
  path: string,
): { ok: true; value: EvidenceSourceV1 } | TraceContextSelectionFailureV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return malformed(path, "Evidence source must be a discriminated object");
  }
  const refError = validateString(value.ref, `${path}.ref`, false);
  if (refError) return refError;

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

function validateCandidateCompatibility(
  kind: EvidenceCandidateKindV1,
  claimClass: "explicit" | "mechanical",
  source: EvidenceSourceV1,
  path: string,
): TraceContextSelectionFailureV1 | null {
  const expected: Readonly<Record<EvidenceCandidateKindV1, {
    claimClass: "explicit" | "mechanical";
    sourceKind: EvidenceSourceV1["kind"];
  }>> = {
    "operation-instruction": { claimClass: "explicit", sourceKind: "operation" },
    "protected-range": { claimClass: "explicit", sourceKind: "target" },
    correction: { claimClass: "explicit", sourceKind: "local" },
    "explicit-preference": { claimClass: "explicit", sourceKind: "local" },
    "process-fact": { claimClass: "mechanical", sourceKind: "trace" },
    citation: { claimClass: "explicit", sourceKind: "citation" },
  };
  const rule = expected[kind];
  if (claimClass !== rule.claimClass) {
    return malformed(`${path}.claimClass`, `${kind} candidates must be ${rule.claimClass}`);
  }
  if (source.kind !== rule.sourceKind) {
    return malformed(`${path}.source.kind`, `${kind} candidates require a ${rule.sourceKind} source`);
  }
  return null;
}

function normalizeLimits(
  value: unknown,
): { ok: true; value?: TraceContextSelectionInputV1["limits"] } | TraceContextSelectionFailureV1 {
  if (value === undefined) return { ok: true };
  if (!isRecord(value)) return malformed("$.limits", "Limits must be an object");
  const keys = exactKeys(value, ["version", "maxCandidates", "maxManifestBytes"]);
  if (keys) return malformed("$.limits", keys);
  if (value.version !== 1) return malformed("$.limits.version", "Limits version must be 1");
  for (const [key, hardLimit] of [
    ["maxCandidates", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates],
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
      ...(value.maxManifestBytes !== undefined
        ? { maxManifestBytes: value.maxManifestBytes as number }
        : {}),
    }),
  };
}

async function collapseCandidates(
  candidates: readonly EvidenceCandidateV1[],
  signal?: AbortSignal,
): Promise<
  | { ok: true; groups: readonly CandidateGroup[]; duplicateCount: number }
  | TraceContextSelectionFailureV1
> {
  const byKey = new Map<string, EvidenceCandidateV1[]>();
  for (let index = 0; index < candidates.length; index += 1) {
    if (signal && index % CANCELLATION_YIELD_INTERVAL === 0) {
      await yieldToHost();
      if (signal?.aborted) return cancelled("select");
    }
    const candidate = candidates[index]!;
    const existing = byKey.get(candidate.dedupeKey);
    if (existing) existing.push(candidate);
    else byKey.set(candidate.dedupeKey, [candidate]);
  }

  const groups: CandidateGroup[] = [];
  let duplicateCount = 0;
  for (const candidatesForKey of byKey.values()) {
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

function duplicateIdentity(candidate: EvidenceCandidateV1): string {
  return canonicalJson({
    kind: candidate.kind,
    claimClass: candidate.claimClass,
    source: candidate.source,
    text: candidate.text,
  });
}

function priorityClass(candidate: EvidenceCandidateV1): EvidencePriorityClassV1 {
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
    const node = compareUtf8(leftSource.nodeId, rightSource.nodeId);
    if (node !== 0) return node;
  }
  return compareUtf8(leftSource.ref, rightSource.ref)
    || compareUtf8(left.representative.dedupeKey, right.representative.dedupeKey)
    || compareUtf8(left.representative.id, right.representative.id);
}

function compareCandidatesForFrozenInput(left: EvidenceCandidateV1, right: EvidenceCandidateV1): number {
  return compareUtf8(left.dedupeKey, right.dedupeKey)
    || compareUtf8(left.id, right.id)
    || compareUtf8(duplicateIdentity(left), duplicateIdentity(right))
    || compareUtf8(canonicalJson(left.reasons), canonicalJson(right.reasons));
}

function processEvidenceExclusion(candidate: EvidenceCandidateV1): EvidenceDecisionReasonV1 | null {
  if (candidate.kind !== "process-fact" || candidate.source.kind !== "trace") return null;
  if (candidate.source.processStatus === "invalid") return "invalid-trace";
  if (candidate.source.processStatus === "snapshot-only") return "snapshot-only-trace";
  return null;
}

function policyAllows(policy: TraceContextPolicyV1, kind: EvidenceCandidateKindV1): boolean {
  switch (policy) {
    case "text-only-v1":
      return kind === "operation-instruction" || kind === "protected-range" || kind === "citation";
    case "bounded-trace-v1":
      return kind === "operation-instruction"
        || kind === "protected-range"
        || kind === "process-fact"
        || kind === "citation";
    case "selected-trace-v1":
      return true;
  }
}

function renderCandidate(group: CandidateGroup): RenderedCandidate {
  const segment = canonicalJson({
    version: 1,
    authority: authorityFor(group.representative.kind),
    evidenceId: group.representative.id,
    kind: group.representative.kind,
    claimClass: group.representative.claimClass,
    source: group.representative.source,
    reasons: group.reasons,
    text: group.representative.text,
  });
  return { group, segment, segmentBytes: utf8Bytes(segment) };
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
  return {
    policyExcluded: 0,
    invalidTrace: 0,
    snapshotOnlyTrace: 0,
    budgetExceeded: 0,
    duplicateCollapsed: 0,
  };
}

function incrementExclusion(counts: EvidenceExclusionCountsV1, reason: EvidenceDecisionReasonV1): void {
  if (reason === "invalid-trace") counts.invalidTrace += 1;
  else if (reason === "snapshot-only-trace") counts.snapshotOnlyTrace += 1;
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
