import { assembleOpMessages, type OpInputs, type OpKind } from "./op-prompts.js";
import type { OpLensId } from "./op-lenses.js";
import { prepareChatMessages, type ChatMessage } from "./llm.js";
import type { ProviderConfig } from "./models-store.js";
import { providerProfileFingerprint } from "./provider-fingerprint.js";
import {
  assertUsableContextSnapshot,
  contentFingerprint,
  type ContextSnapshot,
} from "./context-snapshot.js";
import { renderTraceProcessLog } from "../provenance/trace-process.js";
import type { AuthoritySpanV1 } from "@zine/trace-context";
import {
  compileTraceAuthoringOperation,
  type PreparedTraceAuthoringV1,
} from "./trace-authoring-adapter.js";

const encoder = new TextEncoder();
export const PREPARED_OPERATION_VERSION = 1;
export const PREPARED_REQUEST_MAX_BYTES = 300_000;
export const PROMPT_LAYER_VERSIONS = [
  "system-preamble:v1",
  "op-prompts:v2",
  "context-snapshot:v1",
  "trace-process:v1",
  "trace-authoring-adapter:v1",
] as const;

export interface PreparedTargetRevision {
  folderId: string;
  path: string;
  traceId: string;
  headId: string;
  contentHash: string;
}

export interface PreparedOperation {
  version: 1;
  requestId: string;
  operation: OpKind;
  operationInputs: Readonly<OpInputs>;
  contextSnapshot: ContextSnapshot;
  contextFingerprint: string;
  traceAuthoring: PreparedTraceAuthoringV1 | null;
  messages: readonly ChatMessage[];
  providerId: string;
  providerFingerprint: string;
  targetRevision: PreparedTargetRevision;
  provenance: {
    modelVoicePubkey: string;
    lensId: OpLensId;
    voicePromptHash: string;
    dependencyFingerprint: string;
  };
  budget: {
    maxBytes: number;
    totalBytes: number;
    estimatedTokens: number;
    contextBytes: number;
    promptLayerBytes: number;
  };
  preparedRequestHash: string;
  createdAt: number;
}

export interface PrepareOperationInput {
  operation: OpKind;
  operationInputs: OpInputs;
  contextSnapshot: ContextSnapshot;
  provider: ProviderConfig;
  modelVoicePubkey: string;
  voicePrompt?: string;
  lensId: OpLensId;
  dirtyTarget: boolean;
  requestId?: string;
  createdAt?: number;
  maxBytes?: number;
  /** Exact current-editor authority evidence. Omission fails closed. */
  actingAuthorId?: string;
  authoritySpans?: readonly AuthoritySpanV1[];
}

export class PreparedOperationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(issues.join("; "));
    this.name = "PreparedOperationError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function bytes(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Dependency fingerprint -> immutable PreparedOperation -> approval -> wire.
 * Any focus/head/context/provider/voice/lens/input change creates a different
 * object; transport receives this object and cannot rebuild its messages.
 */
export function prepareOperation(input: PrepareOperationInput): PreparedOperation {
  const issues: string[] = [];
  try {
    assertUsableContextSnapshot(input.contextSnapshot);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  const target = input.contextSnapshot.target;
  if (input.dirtyTarget) issues.push(`${target.path} has unstepped changes`);
  if (!target.traceId || !target.headId) issues.push(`${target.path} has no stepped provenance identity`);
  if (!input.modelVoicePubkey) issues.push("AI voice has no provenance identity");
  if (!input.provider.baseUrl) issues.push(`provider ${input.provider.label} has no base URL`);
  if (!input.provider.modelId) issues.push(`provider ${input.provider.label} has no model id`);
  const unsteppedSources = input.contextSnapshot.inputs
    .filter((entry) => entry.path !== target.path && entry.unstepped)
    .map((entry) => entry.path);
  if (unsteppedSources.length > 0) {
    issues.push(`mounted inputs need Step: ${unsteppedSources.join(", ")}`);
  }
  if (issues.length > 0) throw new PreparedOperationError(issues);

  const compiledAuthoring = compileTraceAuthoringOperation({
    operation: input.operation,
    operationInputs: input.operationInputs,
    targetText: target.body,
    renderedContextBlock: input.contextSnapshot.renderedBlock,
    actingAuthorId: input.actingAuthorId ?? "",
    authoritySpans: input.authoritySpans ?? [],
    sourceRevision: {
      traceId: target.traceId ?? undefined,
      headId: target.headId ?? undefined,
      path: target.path,
      contentHash: target.contentHash,
    },
  });
  const operationInputs = compiledAuthoring.operationInputs;
  if (input.operation === "analyze") {
    operationInputs.traceLog = renderTraceProcessLog(
      input.contextSnapshot.inputs.flatMap((contextInput) =>
        contextInput.deltaLog
          .filter((entry) => entry.source === "file")
          .map((entry) => ({
            seq: entry.seq,
            nodeId: entry.nodeId,
            steppedAt: entry.steppedAt,
            relativePath: entry.relativePath,
            process: entry.process,
            conformance: entry.conformance,
            conformanceReason: entry.conformanceReason,
          })),
      ),
    );
  }
  const renderedContextBlock = compiledAuthoring.renderedContextBlock;
  const assembled = assembleOpMessages(input.operation, operationInputs, {
    voicePrompt: input.voicePrompt ?? "",
    contextBlock: renderedContextBlock,
    lensId: input.lensId,
    authorDirectiveInstructions: compiledAuthoring.authoring?.instructionSection,
    authorDirectiveExcerpts: compiledAuthoring.authoring?.quotedExcerptSection,
  });
  const messages = prepareChatMessages(input.provider, assembled)
    .map((message) => ({ ...message }));
  const totalBytes = messages.reduce((total, message) => total + bytes(message.content), 0);
  const contextBytes = bytes(renderedContextBlock);
  const maxBytes = input.maxBytes ?? PREPARED_REQUEST_MAX_BYTES;
  if (totalBytes > maxBytes) {
    throw new PreparedOperationError([
      `Prepared request exceeds ${maxBytes} bytes (${totalBytes}); context contributes ${contextBytes}`,
    ]);
  }

  const providerFingerprint = providerProfileFingerprint(input.provider);
  const voicePromptHash = contentFingerprint(input.voicePrompt ?? "");
  const dependencyFingerprint = contentFingerprint(canonical({
    operation: input.operation,
    operationInputs,
    contextFingerprint: input.contextSnapshot.fingerprint,
    traceAuthoring: compiledAuthoring.authoring,
    providerFingerprint,
    modelVoicePubkey: input.modelVoicePubkey,
    voicePromptHash,
    lensId: input.lensId,
    promptLayerVersions: PROMPT_LAYER_VERSIONS,
  }));
  const requestId = input.requestId ?? newRequestId();
  const createdAt = input.createdAt ?? Date.now();
  const targetRevision: PreparedTargetRevision = {
    folderId: target.folderId,
    path: target.path,
    traceId: target.traceId!,
    headId: target.headId!,
    contentHash: target.contentHash,
  };
  const preparedRequestHash = contentFingerprint(canonical({
    requestId,
    operation: input.operation,
    operationInputs,
    messages,
    traceAuthoring: compiledAuthoring.authoring,
    providerFingerprint,
    targetRevision,
    dependencyFingerprint,
    createdAt,
  }));
  return deepFreeze({
    version: PREPARED_OPERATION_VERSION,
    requestId,
    operation: input.operation,
    operationInputs,
    contextSnapshot: input.contextSnapshot,
    contextFingerprint: input.contextSnapshot.fingerprint,
    traceAuthoring: compiledAuthoring.authoring,
    messages,
    providerId: input.provider.id,
    providerFingerprint,
    targetRevision,
    provenance: {
      modelVoicePubkey: input.modelVoicePubkey,
      lensId: input.lensId,
      voicePromptHash,
      dependencyFingerprint,
    },
    budget: {
      maxBytes,
      totalBytes,
      estimatedTokens: Math.ceil(totalBytes / 4),
      contextBytes,
      promptLayerBytes: Math.max(0, totalBytes - contextBytes),
    },
    preparedRequestHash,
    createdAt,
  });
}

export class PreparedOperationApproval {
  private approved: PreparedOperation | null = null;

  approve(operation: PreparedOperation): void {
    this.approved = operation;
  }

  get(dependencyFingerprint: string): PreparedOperation | null {
    return this.approved?.provenance.dependencyFingerprint === dependencyFingerprint
      ? this.approved
      : null;
  }

  invalidate(): void {
    this.approved = null;
  }
}

function newRequestId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export { providerProfileFingerprint };
