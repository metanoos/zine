/**
 * Non-sensitive, pure presentation contract for the trace-context Inspector.
 *
 * The desktop adapter may resolve locally authorized private values into the
 * explicit `display*` fields below. This DTO deliberately has no payload
 * references, storage capabilities, provider request objects, or mutation
 * methods. It is safe for a presentational component to consume, but it is not
 * a protocol or durable manifest shape.
 */

export const TRACE_CONTEXT_INSPECTOR_PRESENTATION_VERSION = 1 as const;

export type TraceContextInspectorPolicyV1 =
  | "text-only-v1"
  | "bounded-trace-v1"
  | "selected-trace-v1";

export type TraceContextInspectorOperationV1 =
  | "extend"
  | "settle"
  | "stir"
  | "reply"
  | "analyze"
  | "run";

export type TraceContextInspectorClassificationV1 = "instruction" | "quoted-data";

export interface TraceContextInspectorRangeV1 {
  readonly fromUtf16: number;
  readonly toUtf16: number;
}

export interface TraceContextInspectorTargetRevisionV1 {
  readonly traceId: string;
  readonly headId: string;
  readonly contentHash: string;
  readonly displayPath?: string;
  readonly operationRange: TraceContextInspectorRangeV1;
}

export type TraceContextInspectorDirectiveStateV1 = "pending" | "consumed";

export type TraceContextInspectorLocalAnchorRelationV1 =
  | "containing"
  | "preceding"
  | "following"
  | "containing-empty";

export interface TraceContextInspectorLocalExcerptV1 {
  readonly displayText: string;
  readonly sourceRange: TraceContextInspectorRangeV1;
  readonly byteLength: number;
  readonly relation: TraceContextInspectorLocalAnchorRelationV1;
  readonly omittedBefore: boolean;
  readonly omittedAfter: boolean;
}

export interface TraceContextInspectorDirectiveV1 {
  readonly id: string;
  readonly ordinal: number;
  readonly marker: string;
  readonly displayInstruction: string;
  readonly classification: "instruction";
  readonly sourceRange: TraceContextInspectorRangeV1;
  readonly instructionRange?: TraceContextInspectorRangeV1;
  readonly localExcerpt: TraceContextInspectorLocalExcerptV1;
  readonly state?: TraceContextInspectorDirectiveStateV1;
  readonly consumptionReceiptLabel?: string;
  readonly cleanupStatusLabel?: string;
  readonly canExclude: boolean;
  readonly canReactivate: boolean;
}

export interface TraceContextInspectorProtectedRangeV1 {
  readonly id: string;
  readonly sourceRange: TraceContextInspectorRangeV1;
  readonly displayText: string;
  readonly classification: "quoted-data";
}

export type TraceContextInspectorInertDirectiveReasonV1 =
  | "outside-operation-range"
  | "crosses-operation-range"
  | "missing-authority"
  | "ineligible-authority"
  | "wrong-actor"
  | "mixed-authority"
  | "blocked-by-errors";

export interface TraceContextInspectorInertDirectiveV1 {
  readonly id: string;
  readonly ordinal: number;
  readonly displayCandidate: string;
  readonly sourceRange: TraceContextInspectorRangeV1;
  readonly classification: "quoted-data";
  readonly reason: TraceContextInspectorInertDirectiveReasonV1;
  readonly canPromote: boolean;
}

export type TraceContextInspectorCompilationErrorCodeV1 =
  | "INVALID_OPERATION_RANGE"
  | "INVALID_AUTHORITY_SPAN"
  | "UNSORTED_AUTHORITY_SPANS"
  | "OVERLAPPING_AUTHORITY_SPANS"
  | "RANGE_SPLITS_SURROGATE_PAIR"
  | "UNTERMINATED_PROTECTED_RANGE"
  | "UNEXPECTED_PROTECTED_CLOSE"
  | "UNTERMINATED_DIRECTIVE"
  | "UNEXPECTED_DIRECTIVE_CLOSE"
  | "NESTED_DIRECTIVE"
  | "CROSS_NESTED_SYNTAX"
  | "EMPTY_DIRECTIVE"
  | "ANCHOR_BUDGET_TOO_SMALL";

export interface TraceContextInspectorCompilationErrorV1 {
  readonly id: string;
  readonly code: TraceContextInspectorCompilationErrorCodeV1;
  readonly displayMessage: string;
  readonly sourceRange: TraceContextInspectorRangeV1;
  readonly relatedRange?: TraceContextInspectorRangeV1;
}

export interface TraceContextInspectorEvidenceSourceV1 {
  readonly displayLabel: string;
  readonly traceId?: string;
  readonly headId?: string;
  readonly nodeId?: string;
  readonly transactionId?: string;
  readonly sourceRange?: TraceContextInspectorRangeV1;
}

export type TraceContextInspectorEvidenceScopeV1 =
  | "operation"
  | "file"
  | "folder"
  | "user";

export type TraceContextInspectorSensitivityV1 =
  | "public"
  | "trace-private"
  | "profile-private";

export type TraceContextInspectorEvidenceKindV1 =
  | "instruction"
  | "protected-range"
  | "correction"
  | "preference"
  | "process-fact"
  | "citation";

export type TraceContextInspectorByteCostLabelV1 =
  | "rendered context bytes"
  | "source record bytes";

export interface TraceContextInspectorSelectedEvidenceV1 {
  readonly id: string;
  readonly selectionOrder: number;
  readonly kind: TraceContextInspectorEvidenceKindV1;
  readonly displayClaim: string;
  readonly classification: TraceContextInspectorClassificationV1;
  readonly source: TraceContextInspectorEvidenceSourceV1;
  readonly scope?: TraceContextInspectorEvidenceScopeV1;
  readonly selectionReasons: readonly string[];
  readonly sensitivity: TraceContextInspectorSensitivityV1;
  readonly byteCost: number;
  readonly byteCostLabel: TraceContextInspectorByteCostLabelV1;
  readonly canExclude: boolean;
}

export type TraceContextInspectorExclusionReasonV1 =
  | "budget"
  | "user-excluded"
  | "policy-excluded"
  | "invalid-source"
  | "incomplete-source"
  | "duplicate"
  | "ineligible"
  | "unavailable"
  | "other";

export interface TraceContextInspectorExcludedEvidenceSummaryV1 {
  readonly reason: TraceContextInspectorExclusionReasonV1;
  readonly count: number;
  readonly displayLabel: string;
  readonly firstRejectedSource?: TraceContextInspectorEvidenceSourceV1;
}

export interface TraceContextInspectorCompletenessFailureV1 {
  readonly code: string;
  readonly displayLabel: string;
}

export interface TraceContextInspectorMetadataV1 {
  readonly completeness: {
    readonly complete: boolean;
    readonly failures: readonly TraceContextInspectorCompletenessFailureV1[];
  };
  readonly budget: {
    readonly effectiveContextBytes: number;
    readonly usedContextBytes: number;
    readonly candidateCount: number;
    readonly selectedCount: number;
    readonly truncated: boolean;
  };
  readonly versions: {
    readonly compiler: string;
    readonly selector: string;
    readonly renderer: string;
    readonly promptLayers: readonly string[];
  };
  readonly fingerprint: string;
  /** Exact package-local identities when V1 selection, rather than the legacy snapshot, was used. */
  readonly selectionIdentities?: {
    readonly frozenInputsSha256: string;
    readonly renderedContextSha256: string;
    readonly manifestSha256: string;
  };
}

export interface TraceContextInspectorPresentationV1 {
  readonly version: typeof TRACE_CONTEXT_INSPECTOR_PRESENTATION_VERSION;
  readonly policy: TraceContextInspectorPolicyV1;
  readonly operation: TraceContextInspectorOperationV1;
  readonly targetRevision: TraceContextInspectorTargetRevisionV1;
  readonly directives: readonly TraceContextInspectorDirectiveV1[];
  readonly protectedRanges: readonly TraceContextInspectorProtectedRangeV1[];
  readonly inertDirectives: readonly TraceContextInspectorInertDirectiveV1[];
  readonly compilationErrors: readonly TraceContextInspectorCompilationErrorV1[];
  readonly selectedEvidence: readonly TraceContextInspectorSelectedEvidenceV1[];
  readonly excludedEvidence: readonly TraceContextInspectorExcludedEvidenceSummaryV1[];
  readonly metadata: TraceContextInspectorMetadataV1;
}

export type TraceContextInspectorSourceKindV1 =
  | "directive"
  | "protected-range"
  | "inert-directive"
  | "compilation-error"
  | "evidence"
  | "excluded-evidence";

export interface TraceContextInspectorSourceIntentV1 {
  readonly kind: TraceContextInspectorSourceKindV1;
  readonly id: string;
  readonly sourceRange?: TraceContextInspectorRangeV1;
  readonly source?: TraceContextInspectorEvidenceSourceV1;
}

export interface TraceContextInspectorExcludeIntentV1 {
  readonly kind: "directive" | "evidence";
  readonly id: string;
}

export interface TraceContextInspectorDirectiveIntentV1 {
  readonly directiveId: string;
}

export interface TraceContextInspectorCandidateIntentV1 {
  readonly candidateId: string;
}

export const TRACE_CONTEXT_INSPECTOR_POLICY_LABELS: Readonly<
  Record<TraceContextInspectorPolicyV1, string>
> = Object.freeze({
  "text-only-v1": "Text only",
  "bounded-trace-v1": "Bounded chronological trace",
  "selected-trace-v1": "Selected trace",
});

export const TRACE_CONTEXT_INSPECTOR_OPERATION_LABELS: Readonly<
  Record<TraceContextInspectorOperationV1, string>
> = Object.freeze({
  extend: "Append",
  settle: "Settle",
  stir: "Stir",
  reply: "Reply",
  analyze: "Analyze",
  run: "Run",
});

export const TRACE_CONTEXT_INSPECTOR_CLASSIFICATION_LABELS: Readonly<
  Record<TraceContextInspectorClassificationV1, string>
> = Object.freeze({
  instruction: "Instruction",
  "quoted-data": "Quoted data",
});

export const TRACE_CONTEXT_INSPECTOR_EVIDENCE_KIND_LABELS: Readonly<
  Record<TraceContextInspectorEvidenceKindV1, string>
> = Object.freeze({
  instruction: "Operation instruction",
  "protected-range": "Protected range",
  correction: "Correction",
  preference: "Preference",
  "process-fact": "Process fact",
  citation: "Citation",
});

export const TRACE_CONTEXT_INSPECTOR_INERT_REASON_LABELS: Readonly<
  Record<TraceContextInspectorInertDirectiveReasonV1, string>
> = Object.freeze({
  "outside-operation-range": "Outside the prepared operation range",
  "crosses-operation-range": "Crosses the prepared operation boundary",
  "missing-authority": "No authority record covers the complete directive",
  "ineligible-authority": "The recorded origin is not instruction-eligible",
  "wrong-actor": "The bytes are not authorized by the acting author",
  "mixed-authority": "The directive contains mixed authority",
  "blocked-by-errors": "Blocked by compilation errors",
});

const EXCLUSION_REASON_ORDER: Readonly<Record<TraceContextInspectorExclusionReasonV1, number>> =
  Object.freeze({
    budget: 0,
    "user-excluded": 1,
    "policy-excluded": 2,
    "invalid-source": 3,
    "incomplete-source": 4,
    duplicate: 5,
    ineligible: 6,
    unavailable: 7,
    other: 8,
  });

export function formatTraceContextInspectorRange(range: TraceContextInspectorRangeV1): string {
  return `${range.fromUtf16}–${range.toUtf16} UTF-16`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRange(
  left: TraceContextInspectorRangeV1,
  right: TraceContextInspectorRangeV1,
): number {
  return left.fromUtf16 - right.fromUtf16 || left.toUtf16 - right.toUtf16;
}

function frozenSorted<T>(values: readonly T[], compare: (left: T, right: T) => number): readonly T[] {
  return Object.freeze([...values].sort(compare));
}

export interface GroupedTraceContextInspectorPresentationV1 {
  readonly directives: readonly TraceContextInspectorDirectiveV1[];
  readonly protectedRanges: readonly TraceContextInspectorProtectedRangeV1[];
  readonly inertDirectives: readonly TraceContextInspectorInertDirectiveV1[];
  readonly compilationErrors: readonly TraceContextInspectorCompilationErrorV1[];
  readonly selectedEvidence: readonly TraceContextInspectorSelectedEvidenceV1[];
  readonly excludedEvidence: readonly TraceContextInspectorExcludedEvidenceSummaryV1[];
}

/** Returns deterministic display groups without mutating the adapter's DTO. */
export function groupTraceContextInspectorPresentationV1(
  presentation: TraceContextInspectorPresentationV1,
): GroupedTraceContextInspectorPresentationV1 {
  return Object.freeze({
    directives: frozenSorted(
      presentation.directives,
      (left, right) =>
        compareRange(left.sourceRange, right.sourceRange)
        || left.ordinal - right.ordinal
        || compareText(left.id, right.id),
    ),
    protectedRanges: frozenSorted(
      presentation.protectedRanges,
      (left, right) => compareRange(left.sourceRange, right.sourceRange) || compareText(left.id, right.id),
    ),
    inertDirectives: frozenSorted(
      presentation.inertDirectives,
      (left, right) =>
        compareRange(left.sourceRange, right.sourceRange)
        || left.ordinal - right.ordinal
        || compareText(left.id, right.id),
    ),
    compilationErrors: frozenSorted(
      presentation.compilationErrors,
      (left, right) =>
        compareRange(left.sourceRange, right.sourceRange)
        || compareText(left.code, right.code)
        || compareText(left.id, right.id),
    ),
    selectedEvidence: frozenSorted(
      presentation.selectedEvidence,
      (left, right) => left.selectionOrder - right.selectionOrder || compareText(left.id, right.id),
    ),
    excludedEvidence: frozenSorted(
      presentation.excludedEvidence,
      (left, right) =>
        EXCLUSION_REASON_ORDER[left.reason] - EXCLUSION_REASON_ORDER[right.reason]
        || compareText(left.displayLabel, right.displayLabel),
    ),
  });
}

function cloneAndFreezeDisplayData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeDisplayData(entry)));
  }
  if (value !== null && typeof value === "object") {
    const source = value as Readonly<Record<string, unknown>>;
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareText)) {
      if (source[key] !== undefined) clone[key] = cloneAndFreezeDisplayData(source[key]);
    }
    return Object.freeze(clone);
  }
  return value;
}

/**
 * Clones and deeply freezes presentation data at the adapter/view boundary.
 * V1's fixed ASCII object keys are copied in lexical order; array order remains
 * part of the DTO and display helpers apply their documented deterministic
 * ordering.
 */
export function freezeTraceContextInspectorPresentationV1(
  presentation: TraceContextInspectorPresentationV1,
): TraceContextInspectorPresentationV1 {
  return cloneAndFreezeDisplayData(presentation) as TraceContextInspectorPresentationV1;
}
