export type DeliveryPlan =
  | "unavailable"
  | "append-local-step"
  | "append-and-send"
  | "send-latest";

export type AttestationPlan =
  | "unavailable"
  | "append-send-attest"
  | "send-attest"
  | "attest-only";

/**
 * Decide whether a delivery gesture appends a Step or reuses the current one.
 * Every explicit Step appends one local checkpoint, including an unchanged
 * snapshot: the deliberate checkpoint is itself process evidence. Send still
 * appends only when state is pending (or the trace has no node yet); otherwise
 * it distributes the existing head.
 */
export function planDelivery(
  op: "step" | "send",
  hasPendingChanges: boolean,
  latestStepId: string,
): DeliveryPlan {
  if (op === "step") {
    return "append-local-step";
  }
  return hasPendingChanges || !latestStepId ? "append-and-send" : "send-latest";
}

/**
 * Decide which prerequisites the Attest gesture must compose before it can
 * endorse an exact, externally reachable node. Unknown reachability is treated
 * as unsent; Send is idempotent, and confirmation re-checks the relay before
 * publishing anything.
 */
export function planAttestation(
  hasPendingChanges: boolean,
  latestStepId: string,
  latestStepIsSent: boolean,
): AttestationPlan {
  if (hasPendingChanges || !latestStepId) return "append-send-attest";
  return latestStepIsSent ? "attest-only" : "send-attest";
}
