/** Minimal NIP-01 event shape consumed by the protocol kernel. */
export interface ProtocolEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Cryptographic event verification remains a caller-owned trust dependency. */
export type TraceEventVerifier = (event: ProtocolEvent) => boolean;

const TRACE_OPERATION_ID_PATTERN = /^[0-9a-f]{64}$/;

export type FolderCheckpointCause =
  | "genesis"
  | "explicit-step"
  | "structure-change"
  | "child-advance"
  | "metadata-change";

export interface FolderCheckpoint {
  version: 1;
  cause: FolderCheckpointCause;
  sourceNodeId?: string;
}

/** Create the causal id shared by every checkpoint in one logical gesture. */
export function createTraceOperationId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isTraceOperationId(value: unknown): value is string {
  return typeof value === "string" && TRACE_OPERATION_ID_PATTERN.test(value);
}

/** Read a TraceNode operation id without treating malformed content as valid. */
export function traceOperationIdFromEvent(event: Pick<ProtocolEvent, "content">): string | null {
  try {
    const parsed = JSON.parse(event.content) as { operationId?: unknown };
    return isTraceOperationId(parsed.operationId) ? parsed.operationId : null;
  } catch {
    return null;
  }
}
