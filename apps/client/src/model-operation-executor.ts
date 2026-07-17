/**
 * PreparedOperation (approved bytes + captured revision)
 *                  |
 *                  v
 *        buffer provider response
 *                  |
 *                  v
 *   focus/head/content still identical? -- no --> recoverable stale result
 *                  |
 *                 yes
 *                  v
 *     one atomic local apply (still unstepped)
 */

import { completePrepared } from "./llm.js";
import type { ProviderConfig } from "./models-store.js";
import type {
  PreparedOperation,
  PreparedTargetRevision,
} from "./prepared-operation.js";
import { contentFingerprint } from "./context-snapshot.js";

export interface CurrentModelTarget extends PreparedTargetRevision {
  /** False when focus no longer names this exact live file locus. */
  focused: boolean;
}

export interface RecoverableModelResult {
  requestId: string;
  operation: PreparedOperation["operation"];
  response: string;
  preparedRequestHash: string;
  capturedTarget: PreparedTargetRevision;
  observedTarget: CurrentModelTarget | null;
}

export type ModelExecutionResult =
  | { status: "applied"; response: string }
  | { status: "stale"; recovery: RecoverableModelResult }
  | { status: "cancelled" };

export interface ExecutePreparedOperationInput {
  prepared: PreparedOperation;
  provider: ProviderConfig;
  maxTokens: number;
  signal?: AbortSignal;
  readCurrentTarget: () => CurrentModelTarget | null;
  apply: (response: string, prepared: PreparedOperation) => void | Promise<void>;
  onStale?: (recovery: RecoverableModelResult) => void | Promise<void>;
  complete?: typeof completePrepared;
}

function sameRevision(
  captured: PreparedTargetRevision,
  current: CurrentModelTarget | null,
): boolean {
  return Boolean(
    current?.focused &&
    current.folderId === captured.folderId &&
    current.path === captured.path &&
    current.traceId === captured.traceId &&
    current.headId === captured.headId &&
    current.contentHash === captured.contentHash,
  );
}

function recoveryFor(
  prepared: PreparedOperation,
  response: string,
  observedTarget: CurrentModelTarget | null,
): RecoverableModelResult {
  return Object.freeze({
    requestId: prepared.requestId,
    operation: prepared.operation,
    response,
    preparedRequestHash: prepared.preparedRequestHash,
    capturedTarget: prepared.targetRevision,
    observedTarget,
  });
}

/** Transport is deliberately non-streaming here: no document mutation occurs
 * until the full response is buffered and the captured target is revalidated. */
export async function executePreparedOperation(
  input: ExecutePreparedOperationInput,
): Promise<ModelExecutionResult> {
  if (input.signal?.aborted) return { status: "cancelled" };
  const before = input.readCurrentTarget();
  if (!sameRevision(input.prepared.targetRevision, before)) {
    const recovery = recoveryFor(input.prepared, "", before);
    await input.onStale?.(recovery);
    return {
      status: "stale",
      recovery,
    };
  }

  let response: string;
  try {
    response = await (input.complete ?? completePrepared)(
      input.prepared,
      input.provider,
      { maxTokens: input.maxTokens, signal: input.signal },
    );
  } catch (error) {
    if (input.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      return { status: "cancelled" };
    }
    throw error;
  }
  if (input.signal?.aborted) return { status: "cancelled" };

  const after = input.readCurrentTarget();
  if (!sameRevision(input.prepared.targetRevision, after)) {
    const recovery = recoveryFor(input.prepared, response, after);
    await input.onStale?.(recovery);
    return { status: "stale", recovery };
  }
  await input.apply(response, input.prepared);
  return { status: "applied", response };
}

export interface PreparedOperationBatch {
  version: 1;
  batchId: string;
  operation: PreparedOperation["operation"];
  children: readonly PreparedOperation[];
  targetRevision: PreparedTargetRevision;
  totalBudgetBytes: number;
  batchHash: string;
}

/** Freeze every call in a multi-call operation before its first network hop. */
export function prepareOperationBatch(
  children: readonly PreparedOperation[],
  maxTotalBytes = 600_000,
): PreparedOperationBatch {
  if (children.length === 0) throw new Error("A prepared operation batch cannot be empty");
  const first = children[0];
  for (const child of children) {
    if (child.operation !== first.operation) {
      throw new Error("Prepared batch children must use one operation kind");
    }
    if (JSON.stringify(child.targetRevision) !== JSON.stringify(first.targetRevision)) {
      throw new Error("Prepared batch children must capture one target revision");
    }
  }
  const totalBudgetBytes = children.reduce((total, child) => total + child.budget.totalBytes, 0);
  if (totalBudgetBytes > maxTotalBytes) {
    throw new Error(`Prepared batch exceeds ${maxTotalBytes} bytes (${totalBudgetBytes})`);
  }
  const batchId = globalThis.crypto?.randomUUID?.()
    ?? `batch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const batchHash = contentFingerprint(JSON.stringify({
    batchId,
    operation: first.operation,
    requestHashes: children.map((child) => child.preparedRequestHash),
    targetRevision: first.targetRevision,
    totalBudgetBytes,
  }));
  return Object.freeze({
    version: 1 as const,
    batchId,
    operation: first.operation,
    children: Object.freeze([...children]),
    targetRevision: first.targetRevision,
    totalBudgetBytes,
    batchHash,
  });
}
