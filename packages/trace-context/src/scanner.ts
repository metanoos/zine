import { makeError } from "./errors.js";
import type {
  AuthoringSyntaxScanV1,
  DirectiveCandidateV1,
  ProtectedRangeV1,
  TraceContextErrorV1,
  Utf16Range,
} from "./types.js";

function at(text: string, offset: number, pair: string): boolean {
  return text.charCodeAt(offset) === pair.charCodeAt(0)
    && text.charCodeAt(offset + 1) === pair.charCodeAt(1);
}

function range(fromUtf16: number, toUtf16: number): Utf16Range {
  return { fromUtf16, toUtf16 };
}

/**
 * Single-pass, position-aware scanner for Zine's authoring syntax.
 *
 * Protected `[[...]]` spans have lexical precedence: every delimiter-looking
 * byte inside one is literal. Outside protection, directives cannot nest or
 * cross with protected syntax. Offsets are JS string offsets, i.e. exact
 * half-open UTF-16 code-unit ranges.
 */
export function scanAuthoringSyntax(text: string): AuthoringSyntaxScanV1 {
  const protectedRanges: ProtectedRangeV1[] = [];
  const directiveCandidates: DirectiveCandidateV1[] = [];
  const errors: TraceContextErrorV1[] = [];
  let offset = 0;

  while (offset < text.length) {
    if (at(text, offset, "[[")) {
      const open = offset;
      offset += 2;
      while (offset < text.length && !at(text, offset, "]]")) offset += 1;
      if (offset >= text.length) {
        errors.push(makeError(
          "UNTERMINATED_PROTECTED_RANGE",
          `Protected range opened at UTF-16 offset ${open} is not closed`,
          range(open, text.length),
        ));
        break;
      }
      offset += 2;
      const ordinal = protectedRanges.length + 1;
      protectedRanges.push({
        version: 1,
        id: `protected-v1:${String(ordinal).padStart(4, "0")}:${open}:${offset}`,
        range: range(open, offset),
        text: text.slice(open, offset),
      });
      continue;
    }

    if (at(text, offset, "((")) {
      const open = offset;
      const instructionStart = open + 2;
      let malformed = false;
      offset += 2;
      while (offset < text.length && !at(text, offset, "))")) {
        if (!malformed && at(text, offset, "((")) {
          errors.push(makeError(
            "NESTED_DIRECTIVE",
            `Directive opened at UTF-16 offset ${open} contains another active directive opener`,
            range(offset, offset + 2),
            range(open, open + 2),
          ));
          malformed = true;
        } else if (!malformed && (at(text, offset, "[[") || at(text, offset, "]]"))) {
          errors.push(makeError(
            "CROSS_NESTED_SYNTAX",
            `Directive opened at UTF-16 offset ${open} crosses protected-range syntax`,
            range(offset, offset + 2),
            range(open, open + 2),
          ));
          malformed = true;
        }
        offset += 1;
      }
      if (offset >= text.length) {
        errors.push(makeError(
          "UNTERMINATED_DIRECTIVE",
          `Directive opened at UTF-16 offset ${open} is not closed`,
          range(open, text.length),
        ));
        break;
      }
      const instructionEnd = offset;
      offset += 2;
      if (malformed) continue;
      const instruction = text.slice(instructionStart, instructionEnd);
      if (instruction.trim().length === 0) {
        errors.push(makeError(
          "EMPTY_DIRECTIVE",
          `Directive at UTF-16 range [${open}, ${offset}) has no instruction text`,
          range(open, offset),
        ));
        continue;
      }
      const ordinal = directiveCandidates.length + 1;
      directiveCandidates.push({
        version: 1,
        id: `directive-v1:${String(ordinal).padStart(4, "0")}:${open}:${offset}`,
        ordinal,
        range: range(open, offset),
        instructionRange: range(instructionStart, instructionEnd),
        instruction,
      });
      continue;
    }

    if (at(text, offset, "]]")) {
      errors.push(makeError(
        "UNEXPECTED_PROTECTED_CLOSE",
        `Protected-range closer at UTF-16 offset ${offset} has no opener`,
        range(offset, offset + 2),
      ));
      offset += 2;
      continue;
    }

    if (at(text, offset, "))")) {
      errors.push(makeError(
        "UNEXPECTED_DIRECTIVE_CLOSE",
        `Directive closer at UTF-16 offset ${offset} has no opener`,
        range(offset, offset + 2),
      ));
      offset += 2;
      continue;
    }

    offset += 1;
  }

  return deepFreeze({ version: 1, protectedRanges, directiveCandidates, errors });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
