import type { Utf16Range } from "./types.js";

export type TraceContextPolicyV1 =
  | "text-only-v1"
  | "bounded-trace-v1"
  | "selected-trace-v1";

export type TraceContextOperationV1 = "extend" | "settle";

export interface TraceContextSelectionOperationV1 {
  version: 1;
  operation: TraceContextOperationV1;
  target: {
    traceId: string;
    headId: string;
    contentHash: string;
    chosenPath?: string;
  };
  range?: Utf16Range;
  maxContextBytes: number;
  reservedPromptBytes: number;
}

export type EvidenceClaimClassV1 = "explicit" | "mechanical";

export type EvidenceCandidateKindV1 =
  | "operation-instruction"
  | "protected-range"
  | "correction"
  | "explicit-preference"
  | "process-fact"
  | "citation";

export type EvidenceInclusionReasonV1 =
  | "explicit-operation-intent"
  | "protected-current-range"
  | "explicit-correction"
  | "explicit-scoped-preference"
  | "prepared-head-process"
  | "recent-target-process"
  | "approved-direct-citation"
  | "compatibility-history"
  | "caller-selected";

export type TraceProcessStatusV1 = "full-trace" | "snapshot-only" | "invalid";

export interface OperationEvidenceSourceV1 {
  kind: "operation";
  ref: string;
}

export interface TargetEvidenceSourceV1 {
  kind: "target";
  ref: string;
  traceId: string;
  headId: string;
  range: Utf16Range;
}

export interface LocalEvidenceSourceV1 {
  kind: "local";
  ref: string;
}

export interface TraceEvidenceSourceV1 {
  kind: "trace";
  ref: string;
  traceId: string;
  headId: string;
  nodeId: string;
  processStatus: TraceProcessStatusV1;
  chainDistance: number;
  transactionIndex: number;
  range?: Utf16Range;
}

export interface CitationEvidenceSourceV1 {
  kind: "citation";
  ref: string;
  nodeId: string;
  approvedOrder: number;
  processStatus?: TraceProcessStatusV1;
  traceId?: string;
  range?: Utf16Range;
}

export type EvidenceSourceV1 =
  | OperationEvidenceSourceV1
  | TargetEvidenceSourceV1
  | LocalEvidenceSourceV1
  | TraceEvidenceSourceV1
  | CitationEvidenceSourceV1;

/**
 * Adapter-materialized evidence. V1 accepts explicit and mechanical claims
 * only; it has no confidence, inferred preference, or psychological field.
 */
export interface EvidenceCandidateV1 {
  version: 1;
  id: string;
  dedupeKey: string;
  kind: EvidenceCandidateKindV1;
  claimClass: EvidenceClaimClassV1;
  source: EvidenceSourceV1;
  reasons: readonly EvidenceInclusionReasonV1[];
  text: string;
}

export interface TraceContextSelectionLimitsV1 {
  version: 1;
  maxCandidates?: number;
  maxManifestBytes?: number;
}

export interface TraceContextSelectionInputV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: TraceContextSelectionOperationV1;
  candidates: readonly EvidenceCandidateV1[];
  limits?: TraceContextSelectionLimitsV1;
}

export interface TraceContextSelectionOptionsV1 {
  signal?: AbortSignal;
}

export type EvidencePriorityClassV1 =
  | "operation-instruction"
  | "protected-range"
  | "correction"
  | "explicit-preference"
  | "prepared-head-process"
  | "prior-process"
  | "direct-citation";

export type EvidenceAuthorityV1 = "instruction" | "quoted-data";

export interface SelectedEvidenceV1 {
  version: 1;
  id: string;
  dedupeKey: string;
  kind: EvidenceCandidateKindV1;
  claimClass: EvidenceClaimClassV1;
  authority: EvidenceAuthorityV1;
  source: EvidenceSourceV1;
  reasons: readonly EvidenceInclusionReasonV1[];
  priorityClass: EvidencePriorityClassV1;
  renderedByteCost: number;
}

export type EvidenceDecisionDispositionV1 = "selected" | "excluded" | "collapsed";

export type EvidenceDecisionReasonV1 =
  | "mandatory"
  | "policy-eligible"
  | "policy-excluded"
  | "invalid-trace"
  | "snapshot-only-trace"
  | "budget-exceeded"
  | "duplicate-collapsed";

export interface EvidenceSelectionDecisionV1 {
  version: 1;
  candidateId: string;
  dedupeKey: string;
  inclusionReasons: readonly EvidenceInclusionReasonV1[];
  disposition: EvidenceDecisionDispositionV1;
  reason: EvidenceDecisionReasonV1;
  selectedEvidenceId?: string;
}

export interface EvidenceExclusionCountsV1 {
  policyExcluded: number;
  invalidTrace: number;
  snapshotOnlyTrace: number;
  budgetExceeded: number;
  duplicateCollapsed: number;
}

export interface SelectedTraceContextManifestV1 {
  version: 1;
  contract: "package-local-non-normative-v1";
  policy: TraceContextPolicyV1;
  operation: TraceContextSelectionOperationV1;
  selected: readonly SelectedEvidenceV1[];
  exclusionSummary: {
    countsByReason: EvidenceExclusionCountsV1;
    firstBudgetRejectedRef?: {
      candidateId: string;
      dedupeKey: string;
    };
  };
  budget: {
    effectiveContextBytes: number;
    reservedPromptBytes: number;
    availableRenderedBytes: number;
    usedRenderedBytes: number;
    candidateCount: number;
    uniqueCandidateCount: number;
    selectedCount: number;
    truncated: boolean;
  };
  completeness: {
    selectionComplete: true;
    examinedCandidateCount: number;
  };
  hashes: {
    frozenInputsSha256: string;
    renderedContextSha256: string;
  };
}

export interface TraceContextSelectionSuccessV1 {
  version: 1;
  ok: true;
  manifest: SelectedTraceContextManifestV1;
  manifestSha256: string;
  renderedContext: string;
  decisions: readonly EvidenceSelectionDecisionV1[];
}

interface SelectionErrorBaseV1 {
  version: 1;
  message: string;
}

export type TraceContextInputValueTypeV1 =
  | "undefined"
  | "null"
  | "boolean"
  | "number"
  | "string"
  | "object"
  | "array"
  | "other";

export type TraceContextSelectionErrorV1 =
  | (SelectionErrorBaseV1 & {
      code: "UNSUPPORTED_INPUT_VERSION";
      stage: "validate";
      receivedVersionType: TraceContextInputValueTypeV1;
    })
  | (SelectionErrorBaseV1 & {
      code: "MALFORMED_INPUT";
      stage: "validate";
      path: string;
    })
  | (SelectionErrorBaseV1 & {
      code: "CANCELLED";
      stage: "validate" | "select" | "render" | "hash";
    })
  | (SelectionErrorBaseV1 & {
      code: "CANDIDATE_LIMIT_EXCEEDED";
      stage: "validate";
      actual: number;
      limit: number;
    })
  | (SelectionErrorBaseV1 & {
      code: "DUPLICATE_CONFLICT";
      stage: "select";
      dedupeKey: string;
      candidateIds: readonly string[];
    })
  | (SelectionErrorBaseV1 & {
      code: "MANDATORY_BUDGET_EXCEEDED";
      stage: "render";
      available: number;
      required: number;
      candidateId?: string;
    })
  | (SelectionErrorBaseV1 & {
      code: "MANIFEST_LIMIT_EXCEEDED";
      stage: "render";
      actual: number;
      limit: number;
    })
  | (SelectionErrorBaseV1 & {
      code: "HASH_UNAVAILABLE";
      stage: "hash";
    })
  | (SelectionErrorBaseV1 & {
      code: "INTERNAL_INVARIANT";
      stage: "render";
    });

export interface TraceContextSelectionFailureV1 {
  version: 1;
  ok: false;
  error: TraceContextSelectionErrorV1;
}

export type TraceContextSelectionResultV1 =
  | TraceContextSelectionSuccessV1
  | TraceContextSelectionFailureV1;

export const TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1 = Object.freeze({
  maxCandidates: 10_000,
  maxRenderedContextBytes: 256 * 1_024,
  maxManifestBytes: 512 * 1_024,
});
