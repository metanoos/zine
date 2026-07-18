import type { ProtocolEvent, TraceEventVerifier } from "@zine/protocol";
import {
  selectTraceContextV1,
  type TraceContextPolicyV1,
  type TraceContextSelectionErrorV1,
  type TraceContextSelectionLimitsV1,
  type TraceContextSelectionSuccessV1,
  type Utf16Range,
} from "@zine/trace-context";

import { contentFingerprint } from "./context-snapshot.js";
import {
  PREPARED_REQUEST_MAX_BYTES,
  measurePreparedRequestReservedBytes,
  prepareOperationWithSelectedTraceContext,
  type PreparedOperation,
  type PrepareOperationInput,
} from "./prepared-operation.js";
import {
  adaptDesktopTraceContextSelectionV1,
  type DesktopTraceContextSelectionAdapterInputV1,
} from "./trace-context-selection-adapter.js";

export interface DesktopTraceContextPreparationBoundaryV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  /** Exact fetched genesis-to-head material; the adapter clones before verification. */
  chain: readonly ProtocolEvent[];
  verifyEvent: TraceEventVerifier;
  maxContextBytes?: number;
  limits?: TraceContextSelectionLimitsV1;
}

export class DesktopTraceContextPreparationError extends Error {
  constructor(
    message: string,
    readonly selectionError?: TraceContextSelectionErrorV1,
  ) {
    super(`Desktop trace-context preparation: ${message}`);
    this.name = "DesktopTraceContextPreparationError";
  }
}

/**
 * Verify, select, and bind package-local context to one immutable desktop
 * request. The first selection exists only to measure prompt bytes; the second
 * selection uses that exact remainder and is the only result retained.
 * Nothing returned here is durable or a protocol commitment.
 */
export async function prepareDesktopTraceContextOperationV1(
  input: PrepareOperationInput,
  boundary: DesktopTraceContextPreparationBoundaryV1,
  signal?: AbortSignal,
): Promise<PreparedOperation> {
  if (boundary.version !== 1) {
    throw new DesktopTraceContextPreparationError("boundary version must be 1");
  }
  if (input.operation !== "extend" && input.operation !== "settle") {
    throw new DesktopTraceContextPreparationError("only Extend and Settle have a selector boundary");
  }
  const operationRange = operationRangeFor(input);
  const preparedRequestMaxBytes = input.maxBytes ?? PREPARED_REQUEST_MAX_BYTES;
  const adapterInput: DesktopTraceContextSelectionAdapterInputV1 = {
    version: 1,
    policy: boundary.policy,
    operation: {
      version: 1,
      operation: input.operation,
      ...(operationRange ? { range: operationRange } : {}),
      maxContextBytes: boundary.maxContextBytes ?? input.contextSnapshot.budget.maxBytes,
      preparedRequestMaxBytes,
      reservedPromptBytes: 0,
    },
    chain: boundary.chain,
    verifyEvent: boundary.verifyEvent,
    ...(boundary.limits ? { limits: boundary.limits } : {}),
    ...(signal ? { signal } : {}),
  };
  const adapted = await adaptDesktopTraceContextSelectionV1(adapterInput);
  const preliminary = requireCompleteSelection(
    await selectTraceContextV1(adapted, { signal }),
  );
  const reservedPromptBytes = measurePreparedRequestReservedBytes(input, preliminary);
  const exactInput = {
    ...adapted,
    operation: {
      ...adapted.operation,
      reservedPromptBytes,
    },
  };
  const selection = requireCompleteSelection(
    await selectTraceContextV1(exactInput, { signal }),
  );
  return prepareOperationWithSelectedTraceContext({
    ...input,
    maxBytes: preparedRequestMaxBytes,
  }, selection);
}

/** Cache/approval dependency only; verification still happens inside prepare. */
export function desktopTraceContextBoundaryFingerprintV1(
  boundary: DesktopTraceContextPreparationBoundaryV1 | undefined,
): string | undefined {
  if (!boundary) return undefined;
  return contentFingerprint(stable({
    version: boundary.version,
    policy: boundary.policy,
    chain: boundary.chain,
    maxContextBytes: boundary.maxContextBytes,
    limits: boundary.limits,
  }));
}

function requireCompleteSelection(
  result: Awaited<ReturnType<typeof selectTraceContextV1>>,
): TraceContextSelectionSuccessV1 {
  if (result.ok) return result;
  throw new DesktopTraceContextPreparationError(
    `${result.error.code} at ${result.error.stage}: ${result.error.message}`,
    result.error,
  );
}

function operationRangeFor(input: PrepareOperationInput): Utf16Range | undefined {
  const body = input.contextSnapshot.target.body;
  const values = input.operationInputs;
  if (values.sourceFrom !== undefined || values.sourceTo !== undefined) {
    return {
      fromUtf16: values.sourceFrom ?? 0,
      toUtf16: values.sourceTo ?? body.length,
    };
  }
  if (input.operation === "settle") {
    return {
      fromUtf16: values.rangeFrom ?? 0,
      toUtf16: values.rangeTo ?? body.length,
    };
  }
  const toUtf16 = values.rangeFrom ?? body.length;
  const seed = values.seed ?? "";
  const fromUtf16 = body.slice(Math.max(0, toUtf16 - seed.length), toUtf16) === seed
    ? Math.max(0, toUtf16 - seed.length)
    : toUtf16;
  return { fromUtf16, toUtf16 };
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(",")}}`;
}
