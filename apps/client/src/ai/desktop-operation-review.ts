import type {
  DesktopOperationEnvelopeV1,
  DesktopOperationStatusV1,
} from "./desktop-operation-envelope.js";
import { isDesktopOperationAuthorizationSatisfiedV1 } from "./desktop-operation-authorization.js";
import type { DesktopOperationRepositoryV1 } from "./desktop-operation-runtime.js";

export type DesktopOperationReviewActionV1 =
  | "accept"
  | "reject"
  | "retry"
  | "retry-possible-duplicate"
  | "abandon"
  | "reprepare"
  | "reprepare-possible-duplicate"
  | "resume";

export interface DesktopOperationReviewItemV1 {
  key: { operationId: string; attemptId: string };
  status: DesktopOperationStatusV1;
  targetPath: string;
  label: string;
  detail: string;
  responseText: string | null;
  actions: readonly DesktopOperationReviewActionV1[];
  localOnly: true;
  updatedAtMs: number;
}

export function compareDesktopOperationAttemptLineageV1(
  left: DesktopOperationEnvelopeV1,
  right: DesktopOperationEnvelopeV1,
): number {
  if (left.operationId !== right.operationId) {
    throw new Error("cannot compare attempt lineage across operations");
  }
  if (left.attempt.attemptId === right.attempt.attemptId) return 0;
  if (left.attempt.retryOfAttemptId === right.attempt.attemptId) return 1;
  if (right.attempt.retryOfAttemptId === left.attempt.attemptId) return -1;
  if (left.attempt.createdAtMs !== right.attempt.createdAtMs) {
    return left.attempt.createdAtMs - right.attempt.createdAtMs;
  }
  if (left.attempt.retryOfAttemptId === right.attempt.retryOfAttemptId) {
    // Concurrent siblings can share a millisecond. Their immutable ids provide
    // a stable final ordering; mutable display/update time does not.
    return left.attempt.attemptId < right.attempt.attemptId ? -1 : 1;
  }
  // A transitive retry tie is resolved by the archive scan observing each
  // direct parent edge, not by inventing chronology from opaque ids.
  return 0;
}

function newerAttempt(
  current: DesktopOperationEnvelopeV1 | undefined,
  candidate: DesktopOperationEnvelopeV1,
): DesktopOperationEnvelopeV1 {
  return !current || compareDesktopOperationAttemptLineageV1(candidate, current) > 0
    ? candidate
    : current;
}

/**
 * Keep a small set of current operation heads visible while archive pages move
 * independently through opaque record-id order. Terminal heads stay in this
 * set long enough to suppress an older actionable attempt from the same line.
 */
export function mergeDesktopOperationPinnedHeadsV1(
  current: readonly DesktopOperationEnvelopeV1[],
  candidates: readonly DesktopOperationEnvelopeV1[],
  limit = 16,
): readonly DesktopOperationEnvelopeV1[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new Error("desktop operation pinned-head limit is invalid");
  }
  const heads = new Map<string, DesktopOperationEnvelopeV1>();
  for (const envelope of [...current, ...candidates]) {
    heads.set(envelope.operationId, newerAttempt(heads.get(envelope.operationId), envelope));
  }
  return Object.freeze([...heads.values()]
    .sort((left, right) => (
      right.updatedAtMs - left.updatedAtMs
      || right.attempt.createdAtMs - left.attempt.createdAtMs
      || (left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0)
    ))
    .slice(0, limit));
}

/**
 * Resolve only the lineage heads needed by one native archive page. The full
 * journal is streamed in bounded pages, while the retained supersession set
 * never exceeds the attempt count of the requested page.
 */
export async function resolveDesktopOperationPageLineageV1(
  repository: DesktopOperationRepositoryV1,
  pageRecords: readonly DesktopOperationEnvelopeV1[],
  options: { pageSize?: number; isCancelled?: () => boolean } = {},
): Promise<readonly DesktopOperationEnvelopeV1[]> {
  const pageSize = options.pageSize ?? 16;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 64) {
    throw new Error("desktop operation lineage scan page size is invalid");
  }
  if (pageRecords.length > pageSize) {
    throw new Error("desktop operation archive page exceeds its bounded size");
  }
  const wanted = new Set(pageRecords.map(({ operationId }) => operationId));
  const superseded = new Set<string>();
  const observedCandidates = new Set<string>();
  let cursor: string | null = null;
  while (true) {
    if (options.isCancelled?.()) throw new Error("desktop operation lineage scan cancelled");
    const page = await repository.listPage(cursor, pageSize);
    if (options.isCancelled?.()) throw new Error("desktop operation lineage scan cancelled");
    if (page.records.length > pageSize) {
      throw new Error("desktop operation repository returned an oversized lineage page");
    }
    if (page.nextCursor !== null && page.records.length === 0) {
      throw new Error("desktop operation repository made no lineage scan progress");
    }
    if (page.nextCursor !== null && page.nextCursor === cursor) {
      throw new Error("desktop operation repository repeated a lineage cursor");
    }
    for (const envelope of page.records) {
      if (!wanted.has(envelope.operationId)) continue;
      if (pageRecords.some((candidate) => (
        candidate.operationId === envelope.operationId
        && candidate.attempt.attemptId === envelope.attempt.attemptId
      ))) {
        observedCandidates.add(envelope.attempt.attemptId);
      }
      for (const candidate of pageRecords) {
        if (
          candidate.operationId !== envelope.operationId
          || candidate.attempt.attemptId === envelope.attempt.attemptId
          || superseded.has(candidate.attempt.attemptId)
        ) continue;
        if (envelope.attempt.retryOfAttemptId === candidate.attempt.attemptId) {
          superseded.add(candidate.attempt.attemptId);
          continue;
        }
        if (candidate.attempt.retryOfAttemptId === envelope.attempt.attemptId) continue;
        if (envelope.attempt.createdAtMs > candidate.attempt.createdAtMs) {
          superseded.add(candidate.attempt.attemptId);
          continue;
        }
        if (
          envelope.attempt.createdAtMs === candidate.attempt.createdAtMs
          && envelope.attempt.retryOfAttemptId === candidate.attempt.retryOfAttemptId
          && envelope.attempt.attemptId > candidate.attempt.attemptId
        ) {
          superseded.add(candidate.attempt.attemptId);
        }
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return Object.freeze(pageRecords.filter(
    (envelope) => observedCandidates.has(envelope.attempt.attemptId)
      && !superseded.has(envelope.attempt.attemptId),
  ));
}

/**
 * Project the private lifecycle into the press's compact review vocabulary.
 * Provider completion is never treated as an editor mutation or publication.
 */
export function projectDesktopOperationReviewV1(
  envelope: DesktopOperationEnvelopeV1,
  isAuthorizedAttempt?: (envelope: DesktopOperationEnvelopeV1) => boolean,
): DesktopOperationReviewItemV1 | null {
  const common = {
    key: {
      operationId: envelope.operationId,
      attemptId: envelope.attempt.attemptId,
    },
    status: envelope.lifecycle.status,
    targetPath: envelope.prepared.targetRevision.path,
    responseText: envelope.response?.text ?? null,
    localOnly: true as const,
    updatedAtMs: envelope.updatedAtMs,
  };
  // Durable terminal suppression precedes ephemeral authorization. A restored
  // exact receipt is already applied and abandoned work is intentionally gone;
  // neither may reappear as an authorization-expired action after restart.
  if (envelope.lifecycle.status === "abandoned") return null;
  if (envelope.lifecycle.status === "accepted" && envelope.artifactReceipt) return null;
  if (!isDesktopOperationAuthorizationSatisfiedV1(envelope, isAuthorizedAttempt)) {
    if (envelope.lifecycle.retryPolicy === "operator-confirmation-required") {
      return {
        ...common,
        label: "AI draft authorization expired · provider outcome uncertain",
        detail: "Re-prepare the exact target; final dispatch may duplicate provider work",
        actions: ["reprepare-possible-duplicate", "abandon"],
      };
    }
    return {
      ...common,
      label: "AI draft authorization expired",
      detail: "Open the exact target and re-prepare",
      actions: ["reprepare"],
    };
  }
  switch (envelope.lifecycle.status) {
    case "prepared":
      return { ...common, label: "Extend saved", detail: "Not sent", actions: ["resume", "abandon"] };
    case "approved":
      return { ...common, label: "Extend queued", detail: "Provider call not yet started", actions: ["resume", "abandon"] };
    case "dispatch-intent":
      return {
        ...common,
        label: "Reconciling saved Extend…",
        detail: "No operator action is available yet",
        actions: [],
      };
    case "provider-io":
      return {
        ...common,
        label: "Reconciling saved Extend…",
        detail: "No operator action is available yet",
        actions: [],
      };
    case "response-completed":
      return {
        ...common,
        label: "AI draft ready",
        detail: "Provisional · nothing changed yet",
        actions: ["accept", "reject"],
      };
    case "failed":
      return envelope.lifecycle.retryPolicy === "operator-confirmation-required"
        ? {
            ...common,
            label: "Provider outcome uncertain",
            detail: "Retry may create a duplicate provider result",
            actions: ["retry-possible-duplicate"],
          }
        : {
            ...common,
            label: "Extend failed",
            detail: "No provider effect was recorded",
            actions: ["retry"],
          };
    case "cancelled":
      return { ...common, label: "Extend cancelled", detail: "Not sent", actions: ["retry"] };
    case "unknown":
      return {
        ...common,
        label: "Dispatch unknown",
        detail: "The prior attempt will not be resent",
        actions: ["retry-possible-duplicate", "abandon"],
      };
    case "accepted":
      return { ...common, label: "Applying AI draft…", detail: "Local buffer only", actions: [] };
    case "stale":
      return {
        ...common,
        label: "AI draft is stale",
        detail: "The target changed · re-prepare exact context",
        actions: envelope.response ? ["reprepare", "reject"] : ["reprepare"],
      };
    case "rejected":
      return { ...common, label: "AI draft rejected", detail: "Nothing changed", actions: ["retry"] };
  }
}

/** Keep only the newest linked attempt per operation, then order newest first. */
export function desktopOperationReviewQueueV1(
  envelopes: readonly DesktopOperationEnvelopeV1[],
  isAuthorizedAttempt?: (envelope: DesktopOperationEnvelopeV1) => boolean,
): readonly DesktopOperationReviewItemV1[] {
  const newest = new Map<string, DesktopOperationEnvelopeV1>();
  for (const envelope of envelopes) {
    const current = newest.get(envelope.operationId);
    if (!current || compareDesktopOperationAttemptLineageV1(envelope, current) > 0) {
      newest.set(envelope.operationId, envelope);
    }
  }
  return [...newest.values()]
    .map((envelope) => projectDesktopOperationReviewV1(envelope, isAuthorizedAttempt))
    .filter((item): item is DesktopOperationReviewItemV1 => item !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
