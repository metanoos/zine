export interface TraceLocator {
  format: "zine-trace-locator";
  version: 1;
  kind: "file";
  rootId: string;
  traceId: string;
  nodeId: string;
  relativePath: string;
  ownerPubkey: string;
  relayHints: string[];
}

const PREFIX = "zine-trace:";
const HEX_64 = /^[0-9a-f]{64}$/;
const MAX_LOCATOR_CHARS = 32_768;
const MAX_RELAY_HINTS = 8;

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

export function validateTraceLocator(value: unknown): TraceLocator {
  if (!value || typeof value !== "object") throw new Error("trace locator must be an object");
  const locator = value as Partial<TraceLocator>;
  if (locator.format !== "zine-trace-locator" || locator.version !== 1 || locator.kind !== "file") {
    throw new Error("unsupported trace locator format");
  }
  for (const [name, id] of [
    ["rootId", locator.rootId],
    ["traceId", locator.traceId],
    ["nodeId", locator.nodeId],
    ["ownerPubkey", locator.ownerPubkey],
  ] as const) {
    if (typeof id !== "string" || !HEX_64.test(id)) throw new Error(`${name} must be a 64-char hex id`);
  }
  if (typeof locator.relativePath !== "string" || !locator.relativePath.trim()) {
    throw new Error("relativePath is required");
  }
  if (!Array.isArray(locator.relayHints) || locator.relayHints.length === 0) {
    throw new Error("relayHints must contain at least one ws:// or wss:// URL");
  }
  const relayHints = [...new Set(locator.relayHints)];
  if (relayHints.length > MAX_RELAY_HINTS) {
    throw new Error(`relayHints may contain at most ${MAX_RELAY_HINTS} destinations`);
  }
  for (const raw of relayHints) {
    if (typeof raw !== "string" || raw.length > 2_048) {
      throw new Error("relayHints contains an invalid URL");
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("relayHints contains an invalid URL");
    }
    if (
      (url.protocol !== "ws:" && url.protocol !== "wss:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("relayHints must contain plain ws:// or wss:// relay URLs");
    }
  }
  return { ...locator, relayHints } as TraceLocator;
}

export function encodeTraceLocator(locator: TraceLocator): string {
  return PREFIX + encodeBase64Url(JSON.stringify(validateTraceLocator(locator)));
}

export function parseTraceLocator(input: string): TraceLocator {
  const trimmed = input.trim();
  if (trimmed.length > MAX_LOCATOR_CHARS) {
    throw new Error("trace locator is too large");
  }
  let parsed: unknown;
  try {
    parsed = trimmed.startsWith(PREFIX)
      ? JSON.parse(decodeBase64Url(trimmed.slice(PREFIX.length)))
      : JSON.parse(trimmed);
  } catch {
    throw new Error("trace locator is neither zine-trace: data nor valid JSON");
  }
  return validateTraceLocator(parsed);
}
