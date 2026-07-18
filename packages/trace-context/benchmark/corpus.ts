import { createHash } from "node:crypto";

import type {
  AuthoritySpanV1,
  CompiledAuthoringSyntaxV1,
  CompileAuthoringSyntaxInputV1,
  DirectiveDecisionReason,
  TraceContextErrorCode,
  Utf16Range,
} from "../src/index.js";

export const AUTHORING_SCALE_SIZES = [0, 100, 1_000, 10_000] as const;

export type AuthoringScaleSize = (typeof AUTHORING_SCALE_SIZES)[number];
export type AuthoringScaleMode = "bounded" | "degraded";

export interface AuthoringScaleFixtureV1 {
  version: 1;
  generator: "authoring-scale-v1";
  eventCount: number;
  mode: AuthoringScaleMode;
  input: CompileAuthoringSyntaxInputV1;
  candidateRanges: readonly Utf16Range[];
  degradedErrorRange: Utf16Range | null;
}

export interface AuthoringScaleSummaryV1 {
  version: 1;
  eventCount: number;
  mode: AuthoringScaleMode;
  inputSha256: string;
  resultSha256: string;
  inputUtf8Bytes: number;
  resultUtf8Bytes: number;
  renderedUtf8Bytes: number;
  observableUnitCount: number;
  authoritySpanCount: number;
  protectedRangeCount: number;
  candidateCount: number;
  scanErrorCodes: readonly TraceContextErrorCode[];
  compileErrorCodes: readonly TraceContextErrorCode[];
  decisionCounts: Readonly<Record<DirectiveDecisionReason, number>>;
  directiveCount: number;
  excerptCount: number;
  balancedWindowCount: number;
  operationRange: readonly [number, number];
  firstCandidateRange: readonly [number, number] | null;
  lastCandidateRange: readonly [number, number] | null;
  degradedErrorRange: readonly [number, number] | null;
}

const DECISION_REASONS: readonly DirectiveDecisionReason[] = [
  "authorized",
  "outside-operation-range",
  "crosses-operation-range",
  "missing-authority",
  "ineligible-authority",
  "wrong-actor",
  "mixed-authority",
  "blocked-by-errors",
];

/**
 * Builds a deterministic authoring-syntax workload. `eventCount` names active
 * directive candidates, not trace transactions: manifest selection, cache,
 * quota, and cancellation do not exist in the synchronous Wave 0 API.
 */
export function buildAuthoringScaleFixture(
  eventCount: number,
  mode: AuthoringScaleMode,
): AuthoringScaleFixtureV1 {
  if (!Number.isInteger(eventCount) || eventCount < 0) {
    throw new RangeError("eventCount must be a non-negative integer");
  }

  if (eventCount === 0) {
    const degraded = mode === "degraded";
    const text = degraded ? "))" : "";
    return deepFreeze({
      version: 1,
      generator: "authoring-scale-v1",
      eventCount,
      mode,
      input: {
        text,
        operation: "settle",
        actingAuthorId: "author-scale",
        operationRange: { fromUtf16: 0, toUtf16: text.length },
        authoritySpans: [],
        sourceRevision: scaleRevision(eventCount, mode, text),
        localAnchorMaxBytes: 256,
      },
      candidateRanges: [],
      degradedErrorRange: degraded ? { fromUtf16: 0, toUtf16: 2 } : null,
    });
  }

  if (eventCount < 4) {
    throw new RangeError("non-empty scale fixtures require at least four events for clipping");
  }

  let text = "";
  const candidateRanges: Utf16Range[] = [];
  const eventStarts: number[] = [];

  for (let index = 0; index < eventCount; index += 1) {
    if (index > 0) text += "\n\n";
    eventStarts.push(text.length);
    const label = String(index).padStart(5, "0");
    const oversized = index % 100 === 5;
    const before = oversized
      ? `Event ${label} ${"前文😀".repeat(96)} `
      : `Event ${label} café 🧠 `;
    const directive = `((revise ${label} with care 🪶))`;
    const protectedText = index % 17 === 7
      ? ` [[ exact ((shadow ${label})) 文 ]]`
      : "";
    const after = oversized
      ? ` ${"後文🧠".repeat(96)}`
      : " done.";

    text += before;
    const fromUtf16 = text.length;
    text += directive;
    candidateRanges.push({ fromUtf16, toUtf16: text.length });
    text += protectedText;
    text += after;
  }

  // This malformed suffix is intentionally outside the prepared range. It
  // pins the contract that unrelated document damage remains inspectable but
  // does not degrade an otherwise valid operation.
  text += "\n\nOutside operation: ((unfinished";

  const operationRange = {
    fromUtf16: candidateRanges[1]!.fromUtf16 + 2,
    toUtf16: candidateRanges[eventCount - 2]!.toUtf16 - 2,
  };
  const authoritySpans = buildAuthoritySpans(candidateRanges);
  let degradedErrorRange: Utf16Range | null = null;

  if (mode === "degraded") {
    const errorOffset = eventStarts[2]!;
    text = `${text.slice(0, errorOffset)}))${text.slice(errorOffset + 2)}`;
    degradedErrorRange = { fromUtf16: errorOffset, toUtf16: errorOffset + 2 };
  }

  return deepFreeze({
    version: 1,
    generator: "authoring-scale-v1",
    eventCount,
    mode,
    input: {
      text,
      operation: "settle",
      actingAuthorId: "author-scale",
      operationRange,
      authoritySpans,
      sourceRevision: scaleRevision(eventCount, mode, text),
      localAnchorMaxBytes: 256,
    },
    candidateRanges,
    degradedErrorRange,
  });
}

export function summarizeAuthoringScaleFixture(
  fixture: AuthoringScaleFixtureV1,
  result: CompiledAuthoringSyntaxV1,
): AuthoringScaleSummaryV1 {
  const serializedInput = JSON.stringify(fixture.input);
  const serializedResult = JSON.stringify(result);
  const decisions = Object.fromEntries(
    DECISION_REASONS.map((reason) => [reason, 0]),
  ) as Record<DirectiveDecisionReason, number>;
  for (const decision of result.decisions) decisions[decision.reason] += 1;

  const firstCandidate = result.scan.directiveCandidates[0]?.range ?? null;
  const lastCandidate = result.scan.directiveCandidates.at(-1)?.range ?? null;
  const operationRange = fixture.input.operationRange!;

  return deepFreeze({
    version: 1,
    eventCount: fixture.eventCount,
    mode: fixture.mode,
    inputSha256: sha256(serializedInput),
    resultSha256: sha256(serializedResult),
    inputUtf8Bytes: Buffer.byteLength(fixture.input.text, "utf8"),
    resultUtf8Bytes: Buffer.byteLength(serializedResult, "utf8"),
    renderedUtf8Bytes: Buffer.byteLength(result.renderedText, "utf8"),
    observableUnitCount: fixture.input.text.length
      + result.renderedText.length
      + (fixture.input.authoritySpans?.length ?? 0)
      + result.scan.protectedRanges.length
      + result.scan.directiveCandidates.length
      + result.scan.errors.length
      + result.decisions.length
      + result.directives.length
      + result.excerpts.length
      + result.errors.length,
    authoritySpanCount: fixture.input.authoritySpans?.length ?? 0,
    protectedRangeCount: result.scan.protectedRanges.length,
    candidateCount: result.scan.directiveCandidates.length,
    scanErrorCodes: result.scan.errors.map((error) => error.code),
    compileErrorCodes: result.errors.map((error) => error.code),
    decisionCounts: decisions,
    directiveCount: result.directives.length,
    excerptCount: result.excerpts.length,
    balancedWindowCount: result.excerpts.filter((excerpt) => excerpt.mode === "balanced-window").length,
    operationRange: asTuple(operationRange),
    firstCandidateRange: firstCandidate ? asTuple(firstCandidate) : null,
    lastCandidateRange: lastCandidate ? asTuple(lastCandidate) : null,
    degradedErrorRange: fixture.degradedErrorRange ? asTuple(fixture.degradedErrorRange) : null,
  });
}

function buildAuthoritySpans(candidateRanges: readonly Utf16Range[]): AuthoritySpanV1[] {
  const spans: AuthoritySpanV1[] = [];
  for (let index = 0; index < candidateRanges.length; index += 1) {
    const candidate = candidateRanges[index]!;
    const common = {
      actorId: "author-scale",
      origin: "manual",
      instructionEligible: true,
    };
    switch (index % 5) {
      case 0:
        spans.push({ id: `authority-${index}-manual`, ...common, ...candidate });
        break;
      case 1:
        // Missing coverage is deliberately inert.
        break;
      case 2:
        spans.push({
          id: `authority-${index}-paste`,
          ...common,
          origin: "paste",
          instructionEligible: false,
          ...candidate,
        });
        break;
      case 3:
        spans.push({
          id: `authority-${index}-other`,
          ...common,
          actorId: "other-author",
          ...candidate,
        });
        break;
      case 4: {
        const split = candidate.fromUtf16 + 2;
        spans.push({
          id: `authority-${index}-manual-a`,
          ...common,
          fromUtf16: candidate.fromUtf16,
          toUtf16: split,
        });
        spans.push({
          id: `authority-${index}-promoted-b`,
          ...common,
          origin: "explicit-promotion",
          fromUtf16: split,
          toUtf16: candidate.toUtf16,
        });
        break;
      }
    }
  }
  return spans;
}

function scaleRevision(
  eventCount: number,
  mode: AuthoringScaleMode,
  text: string,
): CompileAuthoringSyntaxInputV1["sourceRevision"] {
  return {
    traceId: "trace-scale-v1",
    headId: `head-${eventCount}-${mode}`,
    path: "benchmark.md",
    contentHash: sha256(text),
  };
}

function asTuple(range: Utf16Range): readonly [number, number] {
  return [range.fromUtf16, range.toUtf16];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
