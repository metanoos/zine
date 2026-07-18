import type {
  ProtectedOutputMatchV1,
  ProtectedOutputValidationV1,
  ProtectedOutputViolationV1,
  ProtectedRangeV1,
} from "./types.js";

/**
 * Pure, app-neutral acceptance check. Every protected fragment must survive
 * byte-for-byte (as represented by the JS string) and in source order. An
 * adapter with placeholder identity should additionally validate its own
 * placeholder map; this helper intentionally makes no editor assumptions.
 */
export function validateProtectedOutput(
  protectedRanges: readonly ProtectedRangeV1[],
  outputText: string,
): ProtectedOutputValidationV1 {
  const matches: ProtectedOutputMatchV1[] = [];
  const violations: ProtectedOutputViolationV1[] = [];
  let cursor = 0;

  for (const protectedRange of protectedRanges) {
    const found = outputText.indexOf(protectedRange.text, cursor);
    if (found === -1) {
      violations.push({
        protectedRangeId: protectedRange.id,
        sourceRange: protectedRange.range,
        expectedText: protectedRange.text,
      });
      continue;
    }
    matches.push({
      protectedRangeId: protectedRange.id,
      sourceRange: protectedRange.range,
      outputRange: {
        fromUtf16: found,
        toUtf16: found + protectedRange.text.length,
      },
    });
    cursor = found + protectedRange.text.length;
  }

  return deepFreeze({
    version: 1,
    valid: violations.length === 0,
    matches,
    violations,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
