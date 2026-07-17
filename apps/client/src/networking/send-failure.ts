export type SendFailureView = "networking" | "keys";

export interface SendFailure {
  title: string;
  summary: string;
  detail: string;
  destination: SendFailureView | null;
  actionLabel: string | null;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** Turn transport-level Send errors into plain-language recovery guidance.
 *  The exact error remains available as technical detail, while known setup
 *  failures point to the view where the user can actually fix them. */
export function describeSendFailure(cause: unknown): SendFailure {
  const detail = errorMessage(cause) || "Unknown Send failure";
  const normalized = detail.toLowerCase();

  if (
    normalized.includes("no key for voice") ||
    normalized.includes("signing key") ||
    normalized.includes("private key")
  ) {
    return {
      title: "Send needs a signing key",
      summary:
        "Zine could not find the private key for the selected author voice. Choose an available key or restore that voice before trying again.",
      detail,
      destination: "keys",
      actionLabel: "Open Keys",
    };
  }

  if (
    normalized.includes("relay") ||
    normalized.includes("publish") ||
    normalized.includes("network") ||
    normalized.includes("websocket") ||
    normalized.includes("socket") ||
    normalized.includes("connection") ||
    normalized.includes("auth-required")
  ) {
    return {
      title: "Couldn’t send this trace",
      summary:
        "Zine could not reach a relay that accepts your writing. Your draft is still here. Check your home node and write-enabled relays, then try Send again.",
      detail,
      destination: "networking",
      actionLabel: "Open Networks",
    };
  }

  return {
    title: "Couldn’t send this trace",
    summary:
      "The trace was not sent. Your draft is still here. Review the technical detail below, then close this message and try again.",
    detail,
    destination: null,
    actionLabel: null,
  };
}
