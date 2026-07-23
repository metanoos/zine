import {
  TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1,
  type TraceContextPolicyV1,
  type TraceContextSelectionLimitsV1,
  type TraceContextSelectionOperationV1,
} from "./selection-types.js";
import type { Utf16Range } from "./types.js";

export interface TraceContextAdapterOperationMetadataV1 {
  version: 1;
  operation: TraceContextSelectionOperationV1["operation"];
  range?: Utf16Range;
  maxContextBytes: number;
  preparedRequestMaxBytes: number;
  reservedPromptBytes: number;
}

export interface ValidatedTraceContextAdapterMetadataV1 {
  version: 1;
  policy: TraceContextPolicyV1;
  operation: TraceContextAdapterOperationMetadataV1;
  limits?: TraceContextSelectionLimitsV1;
}

/**
 * Validate and clone the surface-neutral selector metadata shared by desktop
 * and MCP. Transport-specific chain and verifier values remain owned by each
 * adapter, but neither surface may emit an impossible selector operation.
 */
export function validateTraceContextAdapterMetadataV1(
  input: unknown,
): ValidatedTraceContextAdapterMetadataV1 {
  const record = requireRecord(input, "input");
  if (record.version !== 1) fail("input version must be 1");
  if (record.policy !== "text-only-v1" && record.policy !== "selected-trace-v1") {
    fail("policy must be text-only-v1 or selected-trace-v1");
  }

  const operation = requireRecord(record.operation, "operation");
  if (operation.version !== 1) fail("operation version must be 1");
  if (operation.operation !== "extend" && operation.operation !== "settle") {
    fail("operation must be Append (internal id: extend) or Settle");
  }
  const range = operation.range === undefined
    ? undefined
    : validateRange(operation.range, "operation range");
  if (operation.operation === "settle" && range === undefined) {
    fail("Settle requires an exact UTF-16 range");
  }
  const maxContextBytes = requirePositiveSafeInteger(
    operation.maxContextBytes,
    "maxContextBytes",
  );
  const preparedRequestMaxBytes = requirePositiveSafeInteger(
    operation.preparedRequestMaxBytes,
    "preparedRequestMaxBytes",
  );
  const reservedPromptBytes = requireNonNegativeSafeInteger(
    operation.reservedPromptBytes,
    "reservedPromptBytes",
  );
  if (reservedPromptBytes > preparedRequestMaxBytes) {
    fail("reservedPromptBytes cannot exceed preparedRequestMaxBytes");
  }

  const limits = validateLimits(record.limits);
  return deepFreeze({
    version: 1,
    policy: record.policy,
    operation: {
      version: 1,
      operation: operation.operation,
      ...(range ? { range } : {}),
      maxContextBytes,
      preparedRequestMaxBytes,
      reservedPromptBytes,
    },
    ...(limits ? { limits } : {}),
  });
}

export function validateTraceContextAbortSignalV1(value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    value === null
    || typeof value !== "object"
    || typeof (value as { aborted?: unknown }).aborted !== "boolean"
    || typeof (value as { addEventListener?: unknown }).addEventListener !== "function"
  ) {
    fail("signal must be an AbortSignal");
  }
  return value as AbortSignal;
}

/**
 * Cheap pre-verification bound for the only process shape that can later earn
 * a FULL verdict. Malformed histories still flow to the authoritative verifier,
 * but valid oversized histories cannot consume full-chain verification first.
 */
export function validateTraceContextAdapterProcessBoundsV1(
  eventContents: readonly string[],
  maxCandidates: number | undefined,
): void {
  if (eventContents.length > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates) {
    fail("file chain exceeds the bounded Step ceiling");
  }
  let candidates = eventContents.length;
  let activitySlots = 0;
  if (maxCandidates !== undefined && candidates > maxCandidates) {
    fail("projected candidate count exceeds the selector ceiling");
  }
  for (const content of eventContents) {
    let parsed: { editorTransactions?: unknown };
    try {
      parsed = JSON.parse(content) as { editorTransactions?: unknown };
    } catch {
      continue;
    }
    if (!Array.isArray(parsed.editorTransactions)) continue;
    for (const value of parsed.editorTransactions) {
      activitySlots += 1;
      if (activitySlots > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateSlots) {
        fail("file chain exceeds the bounded editor transaction scan ceiling");
      }
      if (value === null || typeof value !== "object") continue;
      const transaction = value as Record<string, unknown>;
      const changes = Array.isArray(transaction.changes) ? transaction.changes : [];
      activitySlots += changes.length;
      if (activitySlots > TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateSlots) {
        fail("file chain exceeds the bounded editor activity scan ceiling");
      }
      if (maxCandidates === undefined) continue;
      candidates += 1;
      for (const value of changes) {
        if (value === null || typeof value !== "object") continue;
        const change = value as Record<string, unknown>;
        if (
          typeof change.text === "string"
          && (change.text.length > 0 || change.from !== change.to)
        ) candidates += 1;
      }
      if (candidates > maxCandidates) {
        fail("projected candidate count exceeds the selector ceiling");
      }
    }
  }
}

function validateLimits(value: unknown): TraceContextSelectionLimitsV1 | undefined {
  if (value === undefined) return undefined;
  const limits = requireRecord(value, "limits");
  if (limits.version !== 1) fail("limits version must be 1");
  const output: TraceContextSelectionLimitsV1 = { version: 1 };
  for (const [key, hardLimit] of [
    ["maxCandidates", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidates],
    ["maxInputBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxInputBytes],
    ["maxCandidateInputBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxCandidateInputBytes],
    ["maxManifestBytes", TRACE_CONTEXT_SELECTION_HARD_LIMITS_V1.maxManifestBytes],
  ] as const) {
    if (limits[key] === undefined) continue;
    const normalized = requirePositiveSafeInteger(limits[key], `limits.${key}`);
    if (normalized > hardLimit) fail(`limits.${key} cannot exceed ${hardLimit}`);
    output[key] = normalized;
  }
  return deepFreeze(output);
}

function validateRange(value: unknown, subject: string): Utf16Range {
  const range = requireRecord(value, subject);
  const fromUtf16 = requireNonNegativeSafeInteger(range.fromUtf16, `${subject}.fromUtf16`);
  const toUtf16 = requireNonNegativeSafeInteger(range.toUtf16, `${subject}.toUtf16`);
  if (toUtf16 < fromUtf16) fail(`${subject} must be ordered`);
  return deepFreeze({ fromUtf16, toUtf16 });
}

function requireRecord(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requirePositiveSafeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${subject} must be a positive safe integer`);
  }
  return value as number;
}

function requireNonNegativeSafeInteger(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${subject} must be a non-negative safe integer`);
  }
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function fail(message: string): never {
  throw new TypeError(`Trace-context adapter metadata: ${message}`);
}
