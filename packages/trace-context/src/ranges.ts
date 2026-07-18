import { makeError } from "./errors.js";
import type { TraceContextErrorV1, Utf16Range } from "./types.js";

export function isUtf16Boundary(text: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function validateRange(
  text: string,
  range: Utf16Range,
  invalidCode: "INVALID_OPERATION_RANGE" | "INVALID_AUTHORITY_SPAN",
  label: string,
): TraceContextErrorV1 | null {
  if (
    !Number.isInteger(range.fromUtf16)
    || !Number.isInteger(range.toUtf16)
    || range.fromUtf16 < 0
    || range.toUtf16 < range.fromUtf16
    || range.toUtf16 > text.length
  ) {
    return makeError(
      invalidCode,
      `${label} must be an ordered half-open UTF-16 range within [0, ${text.length}]`,
      range,
    );
  }
  if (!isUtf16Boundary(text, range.fromUtf16) || !isUtf16Boundary(text, range.toUtf16)) {
    return makeError(
      "RANGE_SPLITS_SURROGATE_PAIR",
      `${label} splits a UTF-16 surrogate pair`,
      range,
    );
  }
  return null;
}

export function rangesOverlap(left: Utf16Range, right: Utf16Range): boolean {
  return left.fromUtf16 < right.toUtf16 && right.fromUtf16 < left.toUtf16;
}

export function containsRange(outer: Utf16Range, inner: Utf16Range): boolean {
  return outer.fromUtf16 <= inner.fromUtf16 && inner.toUtf16 <= outer.toUtf16;
}

export function intersectRanges(left: Utf16Range, right: Utf16Range): Utf16Range | null {
  const fromUtf16 = Math.max(left.fromUtf16, right.fromUtf16);
  const toUtf16 = Math.min(left.toUtf16, right.toUtf16);
  return fromUtf16 < toUtf16 ? { fromUtf16, toUtf16 } : null;
}
