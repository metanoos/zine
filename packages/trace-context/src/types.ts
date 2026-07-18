export interface Utf16Range {
  fromUtf16: number;
  toUtf16: number;
}

export type TraceContextErrorCode =
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

export interface TraceContextErrorV1 {
  version: 1;
  code: TraceContextErrorCode;
  message: string;
  range: Utf16Range;
  relatedRange?: Utf16Range;
}

export interface ProtectedRangeV1 {
  version: 1;
  id: string;
  range: Utf16Range;
  text: string;
}

export interface DirectiveCandidateV1 {
  version: 1;
  id: string;
  ordinal: number;
  range: Utf16Range;
  instructionRange: Utf16Range;
  instruction: string;
}

export interface AuthoringSyntaxScanV1 {
  version: 1;
  protectedRanges: readonly ProtectedRangeV1[];
  directiveCandidates: readonly DirectiveCandidateV1[];
  errors: readonly TraceContextErrorV1[];
}

/**
 * Adapter-supplied authority over the exact current text revision. The kernel
 * does not infer these spans from edits or provenance. Spans must be ordered,
 * non-overlapping, and use half-open UTF-16 offsets.
 */
export interface AuthoritySpanV1 extends Utf16Range {
  id: string;
  actorId: string;
  origin: string;
  instructionEligible: boolean;
}

export interface DirectiveSourceRevisionV1 {
  traceId?: string;
  headId?: string;
  path?: string;
  contentHash?: string;
}

export type DirectiveDecisionReason =
  | "authorized"
  | "outside-operation-range"
  | "crosses-operation-range"
  | "missing-authority"
  | "ineligible-authority"
  | "wrong-actor"
  | "mixed-authority"
  | "blocked-by-errors";

export interface DirectiveDecisionV1 {
  version: 1;
  candidate: DirectiveCandidateV1;
  reason: DirectiveDecisionReason;
  authoritySpanIds: readonly string[];
}

export type LocalAnchorRelation =
  | "containing"
  | "preceding"
  | "following"
  | "containing-empty";

export type LocalExcerptMode =
  | "complete-block"
  | "balanced-window"
  | "preceding-suffix"
  | "following-prefix";

export interface LocalExcerptV1 {
  version: 1;
  id: string;
  sourceRange: Utf16Range;
  text: string;
  byteLength: number;
  mode: LocalExcerptMode;
  omittedBefore: boolean;
  omittedAfter: boolean;
}

export interface LocalAnchorV1 {
  version: 1;
  containingRange: Utf16Range;
  relation: LocalAnchorRelation;
  excerptId: string;
}

export interface CompiledDirectiveV1 {
  version: 1;
  id: string;
  ordinal: number;
  marker: string;
  instruction: string;
  operation: string;
  sourceRevision: DirectiveSourceRevisionV1;
  sourceRange: Utf16Range;
  instructionRange: Utf16Range;
  authority: {
    kind: "acting-author-current-target-v1";
    actorId: string;
    origin: string;
    spanIds: readonly string[];
  };
  lifecycle: {
    mode: "one-shot";
    state: "pending";
  };
  localAnchor: LocalAnchorV1;
}

export interface CompileAuthoringSyntaxInputV1 {
  text: string;
  operation: string;
  actingAuthorId: string;
  operationRange?: Utf16Range;
  authoritySpans?: readonly AuthoritySpanV1[];
  sourceRevision?: DirectiveSourceRevisionV1;
  localAnchorMaxBytes?: number;
}

export interface CompiledAuthoringSyntaxV1 {
  version: 1;
  ok: boolean;
  operationRange: Utf16Range;
  scan: AuthoringSyntaxScanV1;
  decisions: readonly DirectiveDecisionV1[];
  directives: readonly CompiledDirectiveV1[];
  excerpts: readonly LocalExcerptV1[];
  renderedText: string;
  errors: readonly TraceContextErrorV1[];
}

export interface ProtectedOutputMatchV1 {
  protectedRangeId: string;
  sourceRange: Utf16Range;
  outputRange: Utf16Range;
}

export interface ProtectedOutputViolationV1 {
  protectedRangeId: string;
  sourceRange: Utf16Range;
  expectedText: string;
}

export interface ProtectedOutputValidationV1 {
  version: 1;
  valid: boolean;
  matches: readonly ProtectedOutputMatchV1[];
  violations: readonly ProtectedOutputViolationV1[];
}
