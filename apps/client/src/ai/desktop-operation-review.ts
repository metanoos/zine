import type {
  DesktopOperationEnvelopeV1,
  DesktopOperationStatusV1,
} from "./desktop-operation-envelope.js";
import { canonicalJsonV1 } from "./desktop-operation-envelope.js";
import {
  desktopOperationAttemptKeyV1,
  isDesktopOperationAuthorizationSatisfiedV1,
} from "./desktop-operation-authorization.js";
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
  if (left.attempt.attemptId === right.attempt.attemptId) {
    return left.updatedAtMs - right.updatedAtMs;
  }
  if (left.attempt.retryOfAttemptId === right.attempt.attemptId) return 1;
  if (right.attempt.retryOfAttemptId === left.attempt.attemptId) return -1;
  // Non-adjacent attempts require the graph reducer below. Bare timestamps and
  // opaque ids cannot establish retry ancestry, especially for legacy ties.
  return 0;
}

function reduceDesktopOperationLineageV1(
  envelopes: readonly DesktopOperationEnvelopeV1[],
): {
  heads: readonly DesktopOperationEnvelopeV1[];
  unresolved: readonly DesktopOperationEnvelopeV1[];
} {
  const snapshots = new Map<string, DesktopOperationEnvelopeV1>();
  const ambiguousOperations = new Set<string>();
  for (const envelope of envelopes) {
    const key = desktopOperationAttemptKeyV1(
      envelope.operationId,
      envelope.attempt.attemptId,
    );
    const existing = snapshots.get(key);
    if (!existing || envelope.updatedAtMs > existing.updatedAtMs) {
      snapshots.set(key, envelope);
    } else if (
      envelope.updatedAtMs === existing.updatedAtMs
      && canonicalJsonV1(envelope) !== canonicalJsonV1(existing)
    ) {
      ambiguousOperations.add(envelope.operationId);
    }
  }
  const byOperation = new Map<string, DesktopOperationEnvelopeV1[]>();
  for (const envelope of snapshots.values()) {
    const attempts = byOperation.get(envelope.operationId) ?? [];
    attempts.push(envelope);
    byOperation.set(envelope.operationId, attempts);
  }
  const heads: DesktopOperationEnvelopeV1[] = [];
  const unresolved: DesktopOperationEnvelopeV1[] = [];
  for (const [operationId, attempts] of byOperation) {
    const referenced = new Set<string>();
    const childByParent = new Map<string, string>();
    let ambiguous = ambiguousOperations.has(operationId);
    for (const envelope of attempts) {
      const parentAttemptId = envelope.attempt.retryOfAttemptId;
      if (!parentAttemptId) continue;
      const parentKey = desktopOperationAttemptKeyV1(operationId, parentAttemptId);
      if (snapshots.has(parentKey)) referenced.add(parentKey);
      const childKey = desktopOperationAttemptKeyV1(operationId, envelope.attempt.attemptId);
      const existingChild = childByParent.get(parentKey);
      if (existingChild && existingChild !== childKey) ambiguous = true;
      childByParent.set(parentKey, childKey);
    }
    const operationHeads = attempts.filter((envelope) => !referenced.has(
      desktopOperationAttemptKeyV1(operationId, envelope.attempt.attemptId),
    ));
    if (!ambiguous && operationHeads.length === 1) heads.push(operationHeads[0]!);
    else unresolved.push(...attempts);
  }
  return { heads, unresolved };
}

export interface DesktopOperationPinnedLineageFenceV1 {
  readonly blockedOperationIds: Set<string>;
  allOperationsBlocked: boolean;
}

export function createDesktopOperationPinnedLineageFenceV1(): DesktopOperationPinnedLineageFenceV1 {
  return {
    blockedOperationIds: new Set<string>(),
    allOperationsBlocked: false,
  };
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
  fence: DesktopOperationPinnedLineageFenceV1 = createDesktopOperationPinnedLineageFenceV1(),
): readonly DesktopOperationEnvelopeV1[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
    throw new Error("desktop operation pinned-head limit is invalid");
  }
  if (current.length > 64 || candidates.length > 64) {
    throw new Error("desktop operation pinned-head input exceeds its bounded size");
  }
  if (fence.allOperationsBlocked) return Object.freeze([]);
  const reduced = reduceDesktopOperationLineageV1([
    ...current,
    ...candidates,
  ].filter(({ operationId }) => !fence.blockedOperationIds.has(operationId)));
  for (const { operationId } of reduced.unresolved) {
    if (fence.blockedOperationIds.has(operationId)) continue;
    if (fence.blockedOperationIds.size >= limit) {
      fence.allOperationsBlocked = true;
      fence.blockedOperationIds.clear();
      return Object.freeze([]);
    }
    fence.blockedOperationIds.add(operationId);
  }
  const sortedHeads = reduced.heads
    .filter(({ operationId }) => !fence.blockedOperationIds.has(operationId))
    .sort((left, right) => (
      right.updatedAtMs - left.updatedAtMs
      || right.attempt.createdAtMs - left.attempt.createdAtMs
      || (left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0)
    ));
  // Malformed/disconnected lineages reserve only their operation id in the
  // bounded fence. They never consume the visible pin cap or become actionable
  // again from a later partial callback; the full archive scan is authoritative.
  return Object.freeze(sortedHeads.slice(0, limit));
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
  const candidateKeys = new Set(pageRecords.map((envelope) => (
    desktopOperationAttemptKeyV1(envelope.operationId, envelope.attempt.attemptId)
  )));
  const superseded = new Set<string>();
  const observedCandidates = new Set<string>();
  const latestCandidateSnapshots = new Map<string, DesktopOperationEnvelopeV1>();
  const ambiguousOperations = new Set<string>();
  const firstSiblingByCandidateParent = new Map<string, string>();
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
      const envelopeKey = desktopOperationAttemptKeyV1(
        envelope.operationId,
        envelope.attempt.attemptId,
      );
      if (candidateKeys.has(envelopeKey)) {
        observedCandidates.add(envelopeKey);
        const existing = latestCandidateSnapshots.get(envelopeKey);
        if (!existing || envelope.updatedAtMs > existing.updatedAtMs) {
          latestCandidateSnapshots.set(envelopeKey, envelope);
        } else if (
          envelope.updatedAtMs === existing.updatedAtMs
          && canonicalJsonV1(envelope) !== canonicalJsonV1(existing)
        ) {
          ambiguousOperations.add(envelope.operationId);
        }
      }
      for (const candidate of pageRecords) {
        const candidateKey = desktopOperationAttemptKeyV1(
          candidate.operationId,
          candidate.attempt.attemptId,
        );
        if (
          candidate.operationId !== envelope.operationId
          || candidate.attempt.attemptId === envelope.attempt.attemptId
          || superseded.has(candidateKey)
        ) continue;
        if (envelope.attempt.retryOfAttemptId === candidate.attempt.attemptId) {
          superseded.add(candidateKey);
          continue;
        }
        const candidateParent = candidate.attempt.retryOfAttemptId;
        if (candidateParent && envelope.attempt.retryOfAttemptId === candidateParent) {
          const parentKey = desktopOperationAttemptKeyV1(candidate.operationId, candidateParent);
          const siblingKey = desktopOperationAttemptKeyV1(
            envelope.operationId,
            envelope.attempt.attemptId,
          );
          const firstSibling = firstSiblingByCandidateParent.get(parentKey) ?? candidateKey;
          if (firstSibling !== siblingKey) ambiguousOperations.add(candidate.operationId);
          firstSiblingByCandidateParent.set(parentKey, firstSibling);
        } else if (
          candidateParent === null
          && envelope.attempt.retryOfAttemptId === null
        ) {
          ambiguousOperations.add(candidate.operationId);
        }
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return Object.freeze(pageRecords.flatMap((envelope) => {
    const key = desktopOperationAttemptKeyV1(
      envelope.operationId,
      envelope.attempt.attemptId,
    );
    if (
      !observedCandidates.has(key)
      || superseded.has(key)
      || ambiguousOperations.has(envelope.operationId)
    ) return [];
    return [latestCandidateSnapshots.get(key) ?? envelope];
  }));
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
  const heads = reduceDesktopOperationLineageV1(envelopes).heads;
  return [...heads]
    .map((envelope) => projectDesktopOperationReviewV1(envelope, isAuthorizedAttempt))
    .filter((item): item is DesktopOperationReviewItemV1 => item !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
