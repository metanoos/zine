import { sha256 } from "@noble/hashes/sha2.js";

import type { DeltaLogEntry } from "./context-block.js";

const encoder = new TextEncoder();
export const DEFAULT_SNAPSHOT_BUDGET_BYTES = 256_000;

export interface ContextSnapshotFailure {
  stage: "target" | "chain" | "folder-log" | "cancelled";
  path: string;
  message: string;
}

export interface ContextSnapshotTarget {
  kind: "file";
  folderId: string;
  path: string;
  traceId: string | null;
  headId: string | null;
  contentHash: string;
  body: string;
}

export interface ContextSnapshotInput {
  path: string;
  traceId: string | null;
  headId: string | null;
  contentHash: string;
  body: string;
  citations: readonly string[];
  deltaLog: readonly DeltaLogEntry[];
  unstepped: boolean;
}

export interface ContextShieldDecision {
  path: string;
  decision: "included" | "shielded" | "outside-mount";
  boundary: string | null;
}

export interface ContextBudgetContribution {
  path: string;
  bodyBytes: number;
  citationBytes: number;
  deltaLogBytes: number;
  totalBytes: number;
}

export interface ContextSnapshotBudget {
  maxBytes: number;
  totalBytes: number;
  estimatedTokens: number;
  overBudget: boolean;
  targetBytes: number;
  mountedBodyBytes: number;
  citationBytes: number;
  deltaLogBytes: number;
  structureBytes: number;
  contributions: readonly ContextBudgetContribution[];
}

export interface ContextSnapshot {
  version: 1;
  target: ContextSnapshotTarget;
  mount: { kind: "file" | "folder"; path: string } | null;
  shields: readonly ContextShieldDecision[];
  inputs: readonly ContextSnapshotInput[];
  renderedBlock: string;
  completeness: {
    complete: boolean;
    failures: readonly ContextSnapshotFailure[];
  };
  budget: ContextSnapshotBudget;
  fingerprint: string;
  createdAt: number;
}

export interface CreateContextSnapshotInput {
  target: Omit<ContextSnapshotTarget, "contentHash"> & { contentHash?: string };
  mount: ContextSnapshot["mount"];
  shields: readonly ContextShieldDecision[];
  inputs: ReadonlyArray<Omit<ContextSnapshotInput, "contentHash"> & { contentHash?: string }>;
  renderedBlock: string;
  failures?: readonly ContextSnapshotFailure[];
  maxBytes?: number;
  createdAt?: number;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).length;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function contentFingerprint(content: string): string {
  return hex(sha256(encoder.encode(content)));
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/**
 * Canonical snapshot pipeline:
 *
 * gather -> canonical path/order -> completeness -> budget -> fingerprint
 *                         |               |             |
 *                         +---- Inspector / estimate / preparation ----+
 *
 * `createdAt` is intentionally excluded from the fingerprint. Two gathers of
 * identical authoring state are the same dependency object even when observed
 * at different wall-clock moments.
 */
export function createContextSnapshot(input: CreateContextSnapshotInput): ContextSnapshot {
  const target: ContextSnapshotTarget = {
    ...input.target,
    contentHash: input.target.contentHash || contentFingerprint(input.target.body),
  };
  const inputs: ContextSnapshotInput[] = input.inputs
    .map((entry) => ({
      ...entry,
      contentHash: entry.contentHash || contentFingerprint(entry.body),
      citations: [...new Set(entry.citations)].sort(),
      deltaLog: [...entry.deltaLog].sort((a, b) =>
        a.steppedAt - b.steppedAt ||
        a.relativePath.localeCompare(b.relativePath) ||
        a.seq - b.seq),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const shields = [...input.shields].sort((a, b) => a.path.localeCompare(b.path));
  const failures = [...(input.failures ?? [])].sort((a, b) =>
    a.path.localeCompare(b.path) || a.stage.localeCompare(b.stage) || a.message.localeCompare(b.message));
  const contributions = inputs.map((entry) => {
    const bodyBytes = utf8Bytes(entry.body);
    const citationBytes = utf8Bytes(JSON.stringify(entry.citations));
    const deltaLogBytes = utf8Bytes(JSON.stringify(entry.deltaLog));
    return {
      path: entry.path,
      bodyBytes,
      citationBytes,
      deltaLogBytes,
      totalBytes: bodyBytes + citationBytes + deltaLogBytes,
    };
  });
  const targetBytes = utf8Bytes(target.body);
  const mountedBodyBytes = contributions
    .filter((entry) => entry.path !== target.path)
    .reduce((total, entry) => total + entry.bodyBytes, 0);
  const citationBytes = contributions.reduce((total, entry) => total + entry.citationBytes, 0);
  const deltaLogBytes = contributions.reduce((total, entry) => total + entry.deltaLogBytes, 0);
  const totalBytes = utf8Bytes(input.renderedBlock);
  const structureBytes = Math.max(
    0,
    totalBytes - targetBytes - mountedBodyBytes - citationBytes - deltaLogBytes,
  );
  const maxBytes = input.maxBytes ?? DEFAULT_SNAPSHOT_BUDGET_BYTES;
  const budget: ContextSnapshotBudget = {
    maxBytes,
    totalBytes,
    estimatedTokens: Math.ceil(totalBytes / 4),
    overBudget: totalBytes > maxBytes,
    targetBytes,
    mountedBodyBytes,
    citationBytes,
    deltaLogBytes,
    structureBytes,
    contributions,
  };
  const fingerprint = contentFingerprint(canonicalStringify({
    version: 1,
    target,
    mount: input.mount,
    shields,
    inputs,
    renderedBlock: input.renderedBlock,
    completeness: { complete: failures.length === 0, failures },
    budget,
  }));
  return deepFreeze({
    version: 1 as const,
    target,
    mount: input.mount,
    shields,
    inputs,
    renderedBlock: input.renderedBlock,
    completeness: { complete: failures.length === 0, failures },
    budget,
    fingerprint,
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function assertUsableContextSnapshot(snapshot: ContextSnapshot): void {
  if (!snapshot.completeness.complete) {
    const detail = snapshot.completeness.failures
      .map((failure) => `${failure.path || "Root"}: ${failure.message}`)
      .join("; ");
    throw new Error(`Context is incomplete — ${detail}`);
  }
  if (snapshot.budget.overBudget) {
    const largest = [...snapshot.budget.contributions]
      .sort((a, b) => b.totalBytes - a.totalBytes)
      .slice(0, 3)
      .map((entry) => `${entry.path} (${entry.totalBytes} bytes)`)
      .join(", ");
    throw new Error(
      `Context exceeds ${snapshot.budget.maxBytes} bytes (${snapshot.budget.totalBytes}); largest sources: ${largest}`,
    );
  }
}
