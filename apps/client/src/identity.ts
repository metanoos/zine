import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { Event } from "nostr-tools";

/**
 * Browser-side signing identity for the desktop client.
 *
 * Key-generation posture: the only way key material enters the system here is
 * fresh local generation. There is deliberately no import-existing-key path —
 * "paste your nsec" is the phishing pattern this app refuses, in any surface.
 * NIP-46 (an external signer) is the
 * later path for unifying this browser identity with the CLI's voices.
 *
 * The key lives in `localStorage`, so it persists across reloads but is scoped
 * to this browser profile — it is NOT the same identity as `~/.tracer/voices`.
 * That separation is the accepted two-worlds cost of the first wire-up.
 */

const STORAGE_KEY = "zine.voice.secretHex";

export interface Voice {
  secretKey: Uint8Array;
  publicKey: string;
}

let cached: Voice | null = null;

/** Returns the browser voice, generating+persisting one on first use. */
export function loadOrCreateVoice(): Voice {
  if (cached) return cached;
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    const secretKey = hexToBytes(existing);
    cached = { secretKey, publicKey: getPublicKey(secretKey) };
    return cached;
  }
  // First run — generate fresh. The only key-entry path, by design.
  const secretKey = generateSecretKey();
  const publicKey = getPublicKey(secretKey);
  localStorage.setItem(STORAGE_KEY, bytesToHex(secretKey));
  cached = { secretKey, publicKey };
  return cached;
}

/**
 * The local sidecar relay that the desktop app spawns. Always 127.0.0.1; only
 * the desktop ever uses this as a write target. Kept as a constant because
 * the Tauri sidecar's listen port is fixed (see src-tauri/src/lib.rs).
 */
export const LOCAL_RELAY_URL = "ws://127.0.0.1:4869";

/**
 * Resolve the relay URL for *this* runtime. One build serves three shapes:
 *
 *   - Explicit override: `VITE_RELAY_URL` (power user / self-host pointing the
 *     webapp at a relay other than same-origin).
 *   - Desktop (Tauri): the local sidecar at ws://127.0.0.1:4869. This is the
 *     local-first posture — the webview never needs to know where it's served
 *     from, because writes go to the user's own machine.
 *   - Browser (webapp on the hosted image): derive from the page origin so the
 *     site and relay share a host. `http(s)://` → `ws(s)://`, path `/relay`.
 *     Deriving rather than hardcoding means the same bundle works behind any
 *     proxy/domain/TLS setup without a rebuild.
 *
 * NOTE: this is the *primary* relay. Multi-relay fan-out (read from many,
 * publish to many) lives in relay-config.ts + provenance.ts; this is just
 * the "where do I connect first" answer.
 */
export function resolveRelayUrl(): string {
  // Node (zine-mcp headless press): the `--relay` arg is exported here as
  // ZINE_RELAY_URL by apps/mcp before any shared module loads. Checked first
  // so the headless press pins its home relay without `import.meta.env`
  // (Vite-only) or `window`/`location` (browser-only). Unset in the browser
  // and Tauri, so existing desktop/webapp behavior is unchanged. The cast is
  // type-only: `process` exists under Node and is absent in the browser/Tauri
  // webview, so the typeof guard makes this a safe no-op there.
  const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> } };
  const nodeOverride = g.process?.env?.ZINE_RELAY_URL;
  if (nodeOverride) return nodeOverride;
  const override = import.meta.env.VITE_RELAY_URL as string | undefined;
  if (override) return override;
  if (isTauri()) return LOCAL_RELAY_URL;
  // Browser: same-origin /relay. An https page yields wss://; http yields ws://.
  const scheme = globalThis.location?.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${globalThis.location.host}/relay`;
}

/** True when running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// Re-export for the provenance bridge.
export type { Event };
