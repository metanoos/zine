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

function ipv4Octets(hostname: string): [number, number, number, number] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255)
    ? octets as [number, number, number, number]
    : null;
}

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** True when a locator hint explicitly addresses this device, a LAN-only
 * name, a non-public IP range, or a plaintext clearnet host that could be DNS
 * rebound after parsing. WSS certificate validation binds ordinary public
 * names; `.onion` transport already supplies Tor's authenticated encryption. */
export function relayHintRequiresApproval(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return true;
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!hostname) return true;
  const onion = hostname.endsWith(".onion");
  if (
    (url.protocol === "ws:" && !onion) ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "localtest.me" ||
    hostname.endsWith(".localtest.me") ||
    hostname === "lvh.me" ||
    hostname.endsWith(".lvh.me") ||
    hostname.endsWith(".nip.io") ||
    hostname.endsWith(".sslip.io") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home") ||
    hostname === "home.arpa" ||
    hostname.endsWith(".home.arpa") ||
    (!hostname.includes(".") && !onion)
  ) return true;

  const ipv4 = ipv4Octets(hostname);
  if (ipv4) return isPrivateIpv4(ipv4);

  // WHATWG URL canonicalization renders IPv4-mapped addresses as hex IPv6
  // (for example ::ffff:7f00:1). Treat the whole IPv4-compatible ::/96 range
  // as sensitive along with loopback, ULA, link-local, and multicast ranges.
  if (hostname.includes(":")) {
    if (hostname === "::" || hostname === "::1" || hostname.startsWith("::")) return true;
    const first = hostname.split(":", 1)[0] ?? "";
    const prefix = Number.parseInt(first, 16);
    if (!Number.isFinite(prefix)) return true;
    return (
      (prefix & 0xfe00) === 0xfc00 ||
      (prefix & 0xffc0) === 0xfe80 ||
      (prefix & 0xff00) === 0xff00
    );
  }
  return false;
}

export function relayHintsRequiringApproval(locator: TraceLocator): string[] {
  return locator.relayHints.filter(relayHintRequiresApproval);
}

export function unapprovedRelayHints(
  locator: TraceLocator,
  approved: readonly string[] = [],
): string[] {
  const approvedSet = new Set(approved);
  return relayHintsRequiringApproval(locator).filter((hint) => !approvedSet.has(hint));
}

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
    if (typeof raw !== "string" || raw.length > 2_048 || raw !== raw.trim()) {
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
