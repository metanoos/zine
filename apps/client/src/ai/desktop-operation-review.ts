import type {
  DesktopOperationEnvelopeV1,
  DesktopOperationStatusV1,
} from "./desktop-operation-envelope.js";
import { isDesktopOperationAuthorizationSatisfiedV1 } from "./desktop-operation-authorization.js";

export type DesktopOperationReviewActionV1 =
  | "accept"
  | "reject"
  | "retry"
  | "retry-possible-duplicate"
  | "abandon"
  | "reprepare"
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
  if (!isDesktopOperationAuthorizationSatisfiedV1(envelope, isAuthorizedAttempt)) {
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
      return envelope.artifactReceipt
        ? null
        : { ...common, label: "Applying AI draft…", detail: "Local buffer only", actions: [] };
    case "stale":
      return {
        ...common,
        label: "AI draft is stale",
        detail: "The target changed · re-prepare exact context",
        actions: envelope.response ? ["reprepare", "reject"] : ["reprepare"],
      };
    case "rejected":
      return { ...common, label: "AI draft rejected", detail: "Nothing changed", actions: ["retry"] };
    case "abandoned":
      return null;
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
    if (
      !current
      || envelope.attempt.createdAtMs > current.attempt.createdAtMs
      || (
        envelope.attempt.createdAtMs === current.attempt.createdAtMs
        && envelope.updatedAtMs > current.updatedAtMs
      )
    ) {
      newest.set(envelope.operationId, envelope);
    }
  }
  return [...newest.values()]
    .map((envelope) => projectDesktopOperationReviewV1(envelope, isAuthorizedAttempt))
    .filter((item): item is DesktopOperationReviewItemV1 => item !== null)
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}
