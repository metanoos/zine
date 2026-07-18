import type { TraceContextErrorV1, Utf16Range } from "./types.js";

export class TraceContextCompilationError extends Error {
  constructor(readonly errors: readonly TraceContextErrorV1[]) {
    super(errors.map((error) => error.message).join("; "));
    this.name = "TraceContextCompilationError";
  }
}

export function assertCompiledAuthoringSyntax(
  result: { readonly ok: boolean; readonly errors: readonly TraceContextErrorV1[] },
): void {
  if (!result.ok) throw new TraceContextCompilationError(result.errors);
}

export function makeError(
  code: TraceContextErrorV1["code"],
  message: string,
  range: Utf16Range,
  relatedRange?: Utf16Range,
): TraceContextErrorV1 {
  return relatedRange
    ? { version: 1, code, message, range, relatedRange }
    : { version: 1, code, message, range };
}
