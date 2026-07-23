import {
  hashCanonicalV1,
  type DesktopOperationEnvelopeV1,
  type DesktopOperationStatusV1,
} from "./desktop-operation-envelope.js";
import {
  desktopOperationAttemptKeyV1,
  isDesktopOperationAuthorizationSatisfiedV1,
} from "./desktop-operation-authorization.js";
import type { DesktopOperationRepositoryV1 } from "./desktop-operation-runtime.js";

const DESKTOP_OPERATION_LINEAGE_ATTEMPT_LIMIT = 64;

interface DesktopOperationLineageNodeV1 {
  readonly attemptId: string;
  readonly retryOfAttemptId: string | null;
  readonly updatedAtMs: number;
  readonly snapshotSha256: string;
}

function desktopOperationLineageSnapshotSha256V1(
  envelope: DesktopOperationEnvelopeV1,
): string {
  return hashCanonicalV1("zine.desktop-operation.lineage-snapshot.v1", envelope);
}

function desktopOperationLineageHeadAttemptIdV1(
  nodes: readonly DesktopOperationLineageNodeV1[],
  allowAnyMissingOldestParent = false,
  allowedMissingOldestAttemptId: string | null = null,
): string | null {
  if (nodes.length < 1 || nodes.length > DESKTOP_OPERATION_LINEAGE_ATTEMPT_LIMIT) return null;
  const byAttempt = new Map(nodes.map((node) => [node.attemptId, node]));
  if (byAttempt.size !== nodes.length) return null;
  const roots = nodes.filter(({ attemptId, retryOfAttemptId }) => (
    retryOfAttemptId === null
    || (
      retryOfAttemptId !== null
      && !byAttempt.has(retryOfAttemptId)
      && (allowAnyMissingOldestParent || allowedMissingOldestAttemptId === attemptId)
    )
  ));
  if (roots.length !== 1) return null;
  const childByParent = new Map<string, string>();
  for (const node of nodes) {
    const parentAttemptId = node.retryOfAttemptId;
    if (parentAttemptId === null) continue;
    if (!byAttempt.has(parentAttemptId)) {
      if (
        node.attemptId === roots[0]!.attemptId
        && (allowAnyMissingOldestParent || allowedMissingOldestAttemptId === node.attemptId)
      ) continue;
      return null;
    }
    const existingChild = childByParent.get(parentAttemptId);
    if (existingChild && existingChild !== node.attemptId) return null;
    childByParent.set(parentAttemptId, node.attemptId);
  }
  const visited = new Set<string>();
  let headAttemptId = roots[0]!.attemptId;
  while (true) {
    if (visited.has(headAttemptId)) return null;
    visited.add(headAttemptId);
    const childAttemptId = childByParent.get(headAttemptId);
    if (!childAttemptId) break;
    headAttemptId = childAttemptId;
  }
  return visited.size === nodes.length ? headAttemptId : null;
}

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
  allowAnyMissingOldestParent = false,
  allowedMissingOldestByOperation: ReadonlyMap<string, string> = new Map<string, string>(),
): {
  heads: readonly DesktopOperationEnvelopeV1[];
  unresolved: readonly DesktopOperationEnvelopeV1[];
} {
  const snapshots = new Map<string, DesktopOperationEnvelopeV1>();
  const snapshotHashes = new Map<string, string>();
  const ambiguousOperations = new Set<string>();
  for (const envelope of envelopes) {
    const key = desktopOperationAttemptKeyV1(
      envelope.operationId,
      envelope.attempt.attemptId,
    );
    const existing = snapshots.get(key);
    const snapshotSha256 = desktopOperationLineageSnapshotSha256V1(envelope);
    if (!existing || envelope.updatedAtMs > existing.updatedAtMs) {
      snapshots.set(key, envelope);
      snapshotHashes.set(key, snapshotSha256);
    } else if (
      envelope.updatedAtMs === existing.updatedAtMs
      && snapshotSha256 !== snapshotHashes.get(key)
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
    const headAttemptId = ambiguousOperations.has(operationId)
      ? null
      : desktopOperationLineageHeadAttemptIdV1(attempts.map((envelope) => ({
          attemptId: envelope.attempt.attemptId,
          retryOfAttemptId: envelope.attempt.retryOfAttemptId,
          updatedAtMs: envelope.updatedAtMs,
          snapshotSha256: snapshotHashes.get(desktopOperationAttemptKeyV1(
            operationId,
            envelope.attempt.attemptId,
          ))!,
        })), allowAnyMissingOldestParent, (
          allowedMissingOldestByOperation.get(operationId) ?? null
        ));
    const head = headAttemptId === null
      ? undefined
      : attempts.find(({ attempt }) => attempt.attemptId === headAttemptId);
    if (head) heads.push(head);
    else unresolved.push(...attempts);
  }
  return { heads, unresolved };
}

export interface DesktopOperationPinnedLineageFenceV1 {
  readonly blockedOperationIds: Set<string>;
  readonly provenHeadAttemptIdsByOperation: Map<string, string>;
  allOperationsBlocked: boolean;
}

export function createDesktopOperationPinnedLineageFenceV1(): DesktopOperationPinnedLineageFenceV1 {
  return {
    blockedOperationIds: new Set<string>(),
    provenHeadAttemptIdsByOperation: new Map<string, string>(),
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
  ].filter(({ operationId }) => !fence.blockedOperationIds.has(operationId)), false, (
    fence.provenHeadAttemptIdsByOperation
  ));
  for (const { operationId } of reduced.unresolved) {
    if (fence.blockedOperationIds.has(operationId)) continue;
    fence.provenHeadAttemptIdsByOperation.delete(operationId);
    if (fence.blockedOperationIds.size >= limit) {
      fence.allOperationsBlocked = true;
      fence.blockedOperationIds.clear();
      fence.provenHeadAttemptIdsByOperation.clear();
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
  const visibleHeads = sortedHeads.slice(0, limit);
  const visibleOperations = new Set(visibleHeads.map(({ operationId }) => operationId));
  for (const operationId of fence.provenHeadAttemptIdsByOperation.keys()) {
    if (!visibleOperations.has(operationId)) {
      fence.provenHeadAttemptIdsByOperation.delete(operationId);
    }
  }
  for (const head of visibleHeads) {
    fence.provenHeadAttemptIdsByOperation.set(head.operationId, head.attempt.attemptId);
  }
  return Object.freeze(visibleHeads);
}

/**
 * Activate a durable child of a full-scan-proven archive head. The archive
 * head may itself be a retry whose older ancestors are absent from the small
 * activation overlay, so seed that exact verified cut before merging the
 * parent and child into the pinned lineage.
 */
export function mergeDesktopOperationPinnedDescendantV1(
  current: readonly DesktopOperationEnvelopeV1[],
  provenParent: DesktopOperationEnvelopeV1,
  descendant: DesktopOperationEnvelopeV1,
  limit = 16,
  fence: DesktopOperationPinnedLineageFenceV1 = createDesktopOperationPinnedLineageFenceV1(),
): readonly DesktopOperationEnvelopeV1[] {
  if (
    descendant.operationId !== provenParent.operationId
    || descendant.attempt.retryOfAttemptId !== provenParent.attempt.attemptId
  ) {
    throw new Error("desktop operation activated descendant must directly follow the proven head");
  }
  if (
    !fence.allOperationsBlocked
    && !fence.blockedOperationIds.has(provenParent.operationId)
  ) {
    fence.provenHeadAttemptIdsByOperation.set(
      provenParent.operationId,
      provenParent.attempt.attemptId,
    );
  }
  const otherPinnedOperations = current.filter(({ operationId }) => (
    operationId !== provenParent.operationId
  ));
  return mergeDesktopOperationPinnedHeadsV1(
    otherPinnedOperations,
    [provenParent, descendant],
    limit,
    fence,
  );
}

/**
 * Resolve only the lineage heads needed by one native archive page. The full
 * journal is streamed in bounded pages. For each visible-page operation the
 * scan retains only capped lineage metadata, then proves one connected root-
 * to-head chain before returning an actionable envelope.
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
  const latestCandidateSnapshots = new Map<string, DesktopOperationEnvelopeV1>();
  const ambiguousOperations = new Set<string>();
  const lineageByOperation = new Map<string, Map<string, DesktopOperationLineageNodeV1>>();
  const overLimitOperations = new Set<string>();
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
      if (!overLimitOperations.has(envelope.operationId)) {
        const lineage = lineageByOperation.get(envelope.operationId)
          ?? new Map<string, DesktopOperationLineageNodeV1>();
        const existing = lineage.get(envelope.attempt.attemptId);
        const snapshotSha256 = desktopOperationLineageSnapshotSha256V1(envelope);
        if (!existing && lineage.size >= DESKTOP_OPERATION_LINEAGE_ATTEMPT_LIMIT) {
          overLimitOperations.add(envelope.operationId);
          lineageByOperation.delete(envelope.operationId);
        } else {
          if (!existing || envelope.updatedAtMs > existing.updatedAtMs) {
            lineage.set(envelope.attempt.attemptId, {
              attemptId: envelope.attempt.attemptId,
              retryOfAttemptId: envelope.attempt.retryOfAttemptId,
              updatedAtMs: envelope.updatedAtMs,
              snapshotSha256,
            });
          } else if (
            envelope.updatedAtMs === existing.updatedAtMs
            && snapshotSha256 !== existing.snapshotSha256
          ) {
            ambiguousOperations.add(envelope.operationId);
          }
          lineageByOperation.set(envelope.operationId, lineage);
        }
      }
      if (candidateKeys.has(envelopeKey)) {
        const existing = latestCandidateSnapshots.get(envelopeKey);
        if (!existing || envelope.updatedAtMs > existing.updatedAtMs) {
          latestCandidateSnapshots.set(envelopeKey, envelope);
        } else if (
          envelope.updatedAtMs === existing.updatedAtMs
          && desktopOperationLineageSnapshotSha256V1(envelope)
            !== desktopOperationLineageSnapshotSha256V1(existing)
        ) {
          ambiguousOperations.add(envelope.operationId);
        }
      }
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const actionableHeadKeys = new Set<string>();
  for (const operationId of wanted) {
    if (overLimitOperations.has(operationId) || ambiguousOperations.has(operationId)) continue;
    const nodes = [...(lineageByOperation.get(operationId)?.values() ?? [])];
    const headAttemptId = desktopOperationLineageHeadAttemptIdV1(nodes);
    if (headAttemptId !== null) {
      actionableHeadKeys.add(desktopOperationAttemptKeyV1(operationId, headAttemptId));
    }
  }
  const emitted = new Set<string>();
  return Object.freeze(pageRecords.flatMap((envelope) => {
    const key = desktopOperationAttemptKeyV1(
      envelope.operationId,
      envelope.attempt.attemptId,
    );
    if (
      !actionableHeadKeys.has(key)
      || !latestCandidateSnapshots.has(key)
      || ambiguousOperations.has(envelope.operationId)
      || emitted.has(key)
    ) return [];
    emitted.add(key);
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
        actions: envelope.lifecycle.status === "failed"
          ? ["reprepare-possible-duplicate"]
          : ["reprepare-possible-duplicate", "abandon"],
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
      return { ...common, label: "Append saved", detail: "Not sent", actions: ["resume", "abandon"] };
    case "approved":
      return { ...common, label: "Append queued", detail: "Provider call not yet started", actions: ["resume", "abandon"] };
    case "dispatch-intent":
      return {
        ...common,
        label: "Reconciling saved Append…",
        detail: "No operator action is available yet",
        actions: [],
      };
    case "provider-io":
      return {
        ...common,
        label: "Reconciling saved Append…",
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
            label: "Append failed",
            detail: "No provider effect was recorded",
            actions: ["retry"],
          };
    case "cancelled":
      return { ...common, label: "Append cancelled", detail: "Not sent", actions: ["retry"] };
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
  // Both inputs are already proven heads (the current-session pin merge and
  // the full archive scan). Their older ancestors may intentionally be absent
  // from this final projection, so one missing oldest parent is a valid cut.
  const heads = reduceDesktopOperationLineageV1(envelopes, true).heads;
  return [...heads]
    .map((envelope) => projectDesktopOperationReviewV1(envelope, isAuthorizedAttempt))
    .filter((item): item is DesktopOperationReviewItemV1 => item !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
