export type DeliveryPlan =
  | "unavailable"
  | "append-local-step"
  | "append-and-send"
  | "send-latest";

/**
 * Decide whether a delivery gesture appends a Step or reuses the current one.
 * Step records pending work or creates the first node; a current trace has no
 * Step action. Send appends only when state is pending (or the trace has no
 * Step yet); otherwise it distributes the head.
 */
export function planDelivery(
  op: "step" | "send",
  hasPendingChanges: boolean,
  latestStepId: string,
): DeliveryPlan {
  if (op === "step") {
    return hasPendingChanges || !latestStepId ? "append-local-step" : "unavailable";
  }
  return hasPendingChanges || !latestStepId ? "append-and-send" : "send-latest";
}
