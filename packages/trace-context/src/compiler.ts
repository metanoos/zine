import { makeError } from "./errors.js";
import { containsRange, rangesOverlap, validateRange } from "./ranges.js";
import { scanAuthoringSyntax } from "./scanner.js";
import type {
  AuthoritySpanV1,
  CompileAuthoringSyntaxInputV1,
  CompiledAuthoringSyntaxV1,
  CompiledDirectiveV1,
  DirectiveCandidateV1,
  DirectiveDecisionReason,
  DirectiveDecisionV1,
  LocalAnchorRelation,
  LocalExcerptMode,
  LocalExcerptV1,
  TraceContextErrorV1,
  Utf16Range,
} from "./types.js";

const encoder = new TextEncoder();

export const DEFAULT_LOCAL_ANCHOR_MAX_BYTES = 1_024;

interface AuthorizationResult {
  reason: DirectiveDecisionReason;
  spans: readonly AuthoritySpanV1[];
  origin?: string;
}

interface DirectiveDraft {
  candidate: DirectiveCandidateV1;
  marker: string;
  authority: AuthorizationResult;
}

interface TextBlock {
  range: Utf16Range;
}

interface BuiltExcerpt {
  sourceRange: Utf16Range;
  text: string;
  mode: LocalExcerptMode;
  omittedBefore: boolean;
  omittedAfter: boolean;
}

/**
 * Applies operation scope and caller-provided authority to a lexical scan.
 * The kernel never derives provenance: missing, mixed, or ineligible coverage
 * stays inert. Any malformed syntax or invalid range makes the result fail
 * closed and leaves renderedText byte-identical to the input.
 */
export function compileAuthoringSyntax(
  input: CompileAuthoringSyntaxInputV1,
): CompiledAuthoringSyntaxV1 {
  const scan = scanAuthoringSyntax(input.text);
  const operationRange = input.operationRange ?? {
    fromUtf16: 0,
    toUtf16: input.text.length,
  };
  const authoritySpans = input.authoritySpans ?? [];
  const errors: TraceContextErrorV1[] = [];

  const operationError = validateRange(
    input.text,
    operationRange,
    "INVALID_OPERATION_RANGE",
    "Operation range",
  );
  if (operationError) errors.push(operationError);
  if (!operationError) {
    errors.push(...scan.errors.filter((error) => syntaxErrorAffectsRange(error, operationRange)));
  }
  errors.push(...validateAuthoritySpans(input.text, authoritySpans));

  const blocked = errors.length > 0;
  const decisions: DirectiveDecisionV1[] = [];
  const drafts: DirectiveDraft[] = [];
  let authorityIndex = 0;

  for (const candidate of scan.directiveCandidates) {
    let authorization: AuthorizationResult;
    if (blocked) {
      authorization = { reason: "blocked-by-errors", spans: [] };
    } else if (!rangesOverlap(operationRange, candidate.range)) {
      authorization = { reason: "outside-operation-range", spans: [] };
    } else if (!containsRange(operationRange, candidate.range)) {
      authorization = { reason: "crosses-operation-range", spans: [] };
    } else {
      while (
        authorityIndex < authoritySpans.length
        && authoritySpans[authorityIndex]!.toUtf16 <= candidate.range.fromUtf16
      ) {
        authorityIndex += 1;
      }
      authorization = classifyAuthority(
        candidate.range,
        input.actingAuthorId,
        authoritySpans,
        authorityIndex,
      );
    }

    decisions.push({
      version: 1,
      candidate,
      reason: authorization.reason,
      authoritySpanIds: authorization.spans.map((span) => span.id),
    });
    if (authorization.reason === "authorized") {
      drafts.push({
        candidate,
        marker: directiveMarker(candidate),
        authority: authorization,
      });
    }
  }

  const maxAnchorBytes = input.localAnchorMaxBytes ?? DEFAULT_LOCAL_ANCHOR_MAX_BYTES;
  if (!Number.isInteger(maxAnchorBytes) || maxAnchorBytes <= 0) {
    errors.push(makeError(
      "ANCHOR_BUDGET_TOO_SMALL",
      "Local-anchor byte ceiling must be a positive integer",
      operationRange,
    ));
  } else {
    for (const draft of drafts) {
      const markerBytes = utf8Bytes(draft.marker);
      if (markerBytes > maxAnchorBytes) {
        errors.push(makeError(
          "ANCHOR_BUDGET_TOO_SMALL",
          `Local-anchor byte ceiling ${maxAnchorBytes} cannot contain directive marker (${markerBytes} bytes)`,
          draft.candidate.range,
        ));
      }
    }
  }

  if (errors.length > 0) {
    return deepFreeze({
      version: 1,
      ok: false,
      operationRange,
      scan,
      decisions,
      directives: [],
      excerpts: [],
      renderedText: input.text,
      errors,
    });
  }

  const renderedText = renderRangeWithMarkers(
    input.text,
    { fromUtf16: 0, toUtf16: input.text.length },
    drafts,
  );
  const blocks = findTextBlocks(input.text, operationRange);
  const excerpts: LocalExcerptV1[] = [];
  const excerptIds = new Map<string, string>();
  const directives: CompiledDirectiveV1[] = [];

  for (const draft of drafts) {
    const anchorSelection = selectAnchorBlock(input.text, draft, blocks, operationRange, drafts);
    const built = buildExcerpt(
      input.text,
      draft,
      anchorSelection.selectedRange,
      anchorSelection.relation,
      drafts,
      maxAnchorBytes,
    );
    const excerptKey = JSON.stringify([
      built.sourceRange.fromUtf16,
      built.sourceRange.toUtf16,
      built.text,
      built.mode,
      built.omittedBefore,
      built.omittedAfter,
    ]);
    let excerptId = excerptIds.get(excerptKey);
    if (!excerptId) {
      excerptId = `excerpt-v1:${String(excerpts.length + 1).padStart(4, "0")}`;
      excerptIds.set(excerptKey, excerptId);
      excerpts.push({
        version: 1,
        id: excerptId,
        sourceRange: built.sourceRange,
        text: built.text,
        byteLength: utf8Bytes(built.text),
        mode: built.mode,
        omittedBefore: built.omittedBefore,
        omittedAfter: built.omittedAfter,
      });
    }

    directives.push({
      version: 1,
      id: draft.candidate.id,
      ordinal: draft.candidate.ordinal,
      marker: draft.marker,
      instruction: draft.candidate.instruction,
      operation: input.operation,
      sourceRevision: { ...(input.sourceRevision ?? {}) },
      sourceRange: draft.candidate.range,
      instructionRange: draft.candidate.instructionRange,
      authority: {
        kind: "acting-author-current-target-v1",
        actorId: input.actingAuthorId,
        origin: draft.authority.origin!,
        spanIds: draft.authority.spans.map((span) => span.id),
      },
      lifecycle: { mode: "one-shot", state: "pending" },
      localAnchor: {
        version: 1,
        containingRange: anchorSelection.containingRange,
        relation: anchorSelection.relation,
        excerptId,
      },
    });
  }

  return deepFreeze({
    version: 1,
    ok: true,
    operationRange,
    scan,
    decisions,
    directives,
    excerpts,
    renderedText,
    errors,
  });
}

function syntaxErrorAffectsRange(error: TraceContextErrorV1, operationRange: Utf16Range): boolean {
  if (!error.relatedRange) return rangesOverlap(error.range, operationRange);
  const constructRange = {
    fromUtf16: Math.min(error.range.fromUtf16, error.relatedRange.fromUtf16),
    toUtf16: Math.max(error.range.toUtf16, error.relatedRange.toUtf16),
  };
  return rangesOverlap(constructRange, operationRange);
}

function validateAuthoritySpans(
  text: string,
  spans: readonly AuthoritySpanV1[],
): TraceContextErrorV1[] {
  const errors: TraceContextErrorV1[] = [];
  let previous: AuthoritySpanV1 | undefined;
  for (const span of spans) {
    const error = validateRange(text, span, "INVALID_AUTHORITY_SPAN", `Authority span ${span.id}`);
    if (error) errors.push(error);
    if (span.fromUtf16 === span.toUtf16) {
      errors.push(makeError(
        "INVALID_AUTHORITY_SPAN",
        `Authority span ${span.id} must not be empty`,
        span,
      ));
    }
    if (previous && span.fromUtf16 < previous.fromUtf16) {
      errors.push(makeError(
        "UNSORTED_AUTHORITY_SPANS",
        `Authority span ${span.id} is not in source order`,
        span,
        previous,
      ));
    } else if (previous && span.fromUtf16 < previous.toUtf16) {
      errors.push(makeError(
        "OVERLAPPING_AUTHORITY_SPANS",
        `Authority span ${span.id} overlaps ${previous.id}`,
        span,
        previous,
      ));
    }
    previous = span;
  }
  return errors;
}

function classifyAuthority(
  directiveRange: Utf16Range,
  actingAuthorId: string,
  spans: readonly AuthoritySpanV1[],
  startIndex: number,
): AuthorizationResult {
  const covering: AuthoritySpanV1[] = [];
  let cursor = directiveRange.fromUtf16;
  let index = startIndex;
  let missing = false;

  while (index < spans.length && spans[index]!.fromUtf16 < directiveRange.toUtf16) {
    const span = spans[index]!;
    if (span.fromUtf16 > cursor) missing = true;
    if (span.toUtf16 > cursor) {
      covering.push(span);
      cursor = Math.min(directiveRange.toUtf16, span.toUtf16);
    }
    index += 1;
  }
  if (cursor < directiveRange.toUtf16) missing = true;
  if (missing || covering.length === 0) return { reason: "missing-authority", spans: covering };

  const origins = new Set(covering.map((span) => span.origin));
  const actors = new Set(covering.map((span) => span.actorId));
  const eligibility = new Set(covering.map((span) => span.instructionEligible));
  if (origins.size !== 1 || actors.size !== 1 || eligibility.size !== 1) {
    return { reason: "mixed-authority", spans: covering };
  }
  if (!covering[0]!.instructionEligible) {
    return { reason: "ineligible-authority", spans: covering };
  }
  if (covering[0]!.actorId !== actingAuthorId) {
    return { reason: "wrong-actor", spans: covering };
  }
  return { reason: "authorized", spans: covering, origin: covering[0]!.origin };
}

function directiveMarker(candidate: DirectiveCandidateV1): string {
  return `⟪ZINE_DIRECTIVE_V1_${String(candidate.ordinal).padStart(4, "0")}_${candidate.range.fromUtf16}_${candidate.range.toUtf16}⟫`;
}

function renderRangeWithMarkers(
  text: string,
  sourceRange: Utf16Range,
  drafts: readonly DirectiveDraft[],
): string {
  let rendered = "";
  let cursor = sourceRange.fromUtf16;
  for (const draft of drafts) {
    if (!containsRange(sourceRange, draft.candidate.range)) continue;
    rendered += text.slice(cursor, draft.candidate.range.fromUtf16);
    rendered += draft.marker;
    cursor = draft.candidate.range.toUtf16;
  }
  rendered += text.slice(cursor, sourceRange.toUtf16);
  return rendered;
}

function renderRangeWithoutDirectives(
  text: string,
  sourceRange: Utf16Range,
  drafts: readonly DirectiveDraft[],
): string {
  let rendered = "";
  let cursor = sourceRange.fromUtf16;
  for (const draft of drafts) {
    if (!containsRange(sourceRange, draft.candidate.range)) continue;
    rendered += text.slice(cursor, draft.candidate.range.fromUtf16);
    cursor = draft.candidate.range.toUtf16;
  }
  rendered += text.slice(cursor, sourceRange.toUtf16);
  return rendered;
}

function findTextBlocks(text: string, operationRange: Utf16Range): TextBlock[] {
  const blocks: TextBlock[] = [];
  let cursor = operationRange.fromUtf16;
  let blockStart: number | null = null;
  let blockEnd = cursor;

  while (cursor < operationRange.toUtf16) {
    const lineStart = cursor;
    while (
      cursor < operationRange.toUtf16
      && text.charCodeAt(cursor) !== 0x0a
      && text.charCodeAt(cursor) !== 0x0d
    ) {
      cursor += 1;
    }
    const contentEnd = cursor;
    if (cursor < operationRange.toUtf16) {
      if (
        text.charCodeAt(cursor) === 0x0d
        && cursor + 1 < operationRange.toUtf16
        && text.charCodeAt(cursor + 1) === 0x0a
      ) {
        cursor += 2;
      } else {
        cursor += 1;
      }
    }

    const blank = text.slice(lineStart, contentEnd).trim().length === 0;
    if (blank) {
      if (blockStart !== null) {
        blocks.push({ range: { fromUtf16: blockStart, toUtf16: blockEnd } });
        blockStart = null;
      }
      continue;
    }
    if (blockStart === null) blockStart = lineStart;
    blockEnd = contentEnd;
  }

  if (blockStart !== null) {
    blocks.push({ range: { fromUtf16: blockStart, toUtf16: blockEnd } });
  }
  return blocks;
}

function selectAnchorBlock(
  text: string,
  draft: DirectiveDraft,
  blocks: readonly TextBlock[],
  operationRange: Utf16Range,
  drafts: readonly DirectiveDraft[],
): {
  containingRange: Utf16Range;
  selectedRange: Utf16Range;
  relation: LocalAnchorRelation;
} {
  const containingIndex = blocks.findIndex((block) => containsRange(block.range, draft.candidate.range));
  const containingRange = containingIndex === -1
    ? {
        fromUtf16: Math.max(operationRange.fromUtf16, draft.candidate.range.fromUtf16),
        toUtf16: Math.min(operationRange.toUtf16, draft.candidate.range.toUtf16),
      }
    : blocks[containingIndex]!.range;
  const containingHasProse = renderRangeWithoutDirectives(text, containingRange, drafts).trim().length > 0;
  if (containingHasProse) {
    return { containingRange, selectedRange: containingRange, relation: "containing" };
  }

  const precedingStart = containingIndex === -1 ? blocks.length - 1 : containingIndex - 1;
  for (let index = precedingStart; index >= 0; index -= 1) {
    const block = blocks[index]!;
    if (block.range.toUtf16 > draft.candidate.range.fromUtf16) continue;
    if (renderRangeWithoutDirectives(text, block.range, drafts).trim().length > 0) {
      return { containingRange, selectedRange: block.range, relation: "preceding" };
    }
  }

  const followingStart = containingIndex === -1 ? 0 : containingIndex + 1;
  for (let index = followingStart; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.range.fromUtf16 < draft.candidate.range.toUtf16) continue;
    if (renderRangeWithoutDirectives(text, block.range, drafts).trim().length > 0) {
      return { containingRange, selectedRange: block.range, relation: "following" };
    }
  }

  return { containingRange, selectedRange: containingRange, relation: "containing-empty" };
}

function buildExcerpt(
  text: string,
  draft: DirectiveDraft,
  selectedRange: Utf16Range,
  relation: LocalAnchorRelation,
  drafts: readonly DirectiveDraft[],
  maxBytes: number,
): BuiltExcerpt {
  const complete = renderRangeWithMarkers(text, selectedRange, drafts);
  if (utf8Bytes(complete) <= maxBytes) {
    return {
      sourceRange: selectedRange,
      text: complete,
      mode: "complete-block",
      omittedBefore: false,
      omittedAfter: false,
    };
  }

  if (relation === "preceding") {
    const textWindow = takeUtf8Suffix(complete, maxBytes);
    return {
      sourceRange: selectedRange,
      text: textWindow,
      mode: "preceding-suffix",
      omittedBefore: textWindow.length < complete.length,
      omittedAfter: false,
    };
  }
  if (relation === "following") {
    const textWindow = takeUtf8Prefix(complete, maxBytes);
    return {
      sourceRange: selectedRange,
      text: textWindow,
      mode: "following-prefix",
      omittedBefore: false,
      omittedAfter: textWindow.length < complete.length,
    };
  }

  const before = renderRangeWithMarkers(
    text,
    { fromUtf16: selectedRange.fromUtf16, toUtf16: draft.candidate.range.fromUtf16 },
    drafts,
  );
  const after = renderRangeWithMarkers(
    text,
    { fromUtf16: draft.candidate.range.toUtf16, toUtf16: selectedRange.toUtf16 },
    drafts,
  );
  const balanced = balancedUtf8Window(before, draft.marker, after, maxBytes);
  return {
    sourceRange: selectedRange,
    text: balanced.text,
    mode: "balanced-window",
    omittedBefore: balanced.before.length < before.length,
    omittedAfter: balanced.after.length < after.length,
  };
}

function balancedUtf8Window(
  before: string,
  marker: string,
  after: string,
  maxBytes: number,
): { text: string; before: string; after: string } {
  const beforePoints = [...before].map((value) => ({ value, bytes: utf8Bytes(value) }));
  const afterPoints = [...after].map((value) => ({ value, bytes: utf8Bytes(value) }));
  const selectedBefore: string[] = [];
  const selectedAfter: string[] = [];
  let beforeIndex = beforePoints.length - 1;
  let afterIndex = 0;
  let beforeBytes = 0;
  let afterBytes = 0;
  let remaining = maxBytes - utf8Bytes(marker);
  let beforeBlocked = false;
  let afterBlocked = false;

  while (remaining > 0 && (!beforeBlocked || !afterBlocked)) {
    const preferBefore = beforeBytes <= afterBytes;
    const first = preferBefore ? "before" : "after";
    const second = preferBefore ? "after" : "before";
    if (!takePoint(first) && !takePoint(second)) break;
  }

  const beforeText = selectedBefore.reverse().join("");
  const afterText = selectedAfter.join("");
  return { text: `${beforeText}${marker}${afterText}`, before: beforeText, after: afterText };

  function takePoint(side: "before" | "after"): boolean {
    if (side === "before") {
      if (beforeBlocked || beforeIndex < 0) {
        beforeBlocked = true;
        return false;
      }
      const point = beforePoints[beforeIndex]!;
      if (point.bytes > remaining) {
        beforeBlocked = true;
        return false;
      }
      selectedBefore.push(point.value);
      beforeIndex -= 1;
      beforeBytes += point.bytes;
      remaining -= point.bytes;
      return true;
    }
    if (afterBlocked || afterIndex >= afterPoints.length) {
      afterBlocked = true;
      return false;
    }
    const point = afterPoints[afterIndex]!;
    if (point.bytes > remaining) {
      afterBlocked = true;
      return false;
    }
    selectedAfter.push(point.value);
    afterIndex += 1;
    afterBytes += point.bytes;
    remaining -= point.bytes;
    return true;
  }
}

function takeUtf8Prefix(value: string, maxBytes: number): string {
  let bytes = 0;
  let result = "";
  for (const point of value) {
    const pointBytes = utf8Bytes(point);
    if (bytes + pointBytes > maxBytes) break;
    result += point;
    bytes += pointBytes;
  }
  return result;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  const points = [...value];
  const result: string[] = [];
  let bytes = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const pointBytes = utf8Bytes(points[index]!);
    if (bytes + pointBytes > maxBytes) break;
    result.push(points[index]!);
    bytes += pointBytes;
  }
  return result.reverse().join("");
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
