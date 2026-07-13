import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { Relay } from "nostr-tools/relay";
import type { Event } from "nostr-tools";

/**
 * Browser-side signing identity for the desktop client.
 *
 * This mirrors `apps/harness/src/voice.ts`'s `createLocal` posture: the only
 * way key material enters the system here is fresh local generation. There is
 * deliberately no import-existing-key path — "paste your nsec" is the phishing
 * pattern this app refuses, in any surface. NIP-46 (an external signer) is the
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

const RELAY_URL = "ws://127.0.0.1:4869";

/**
 * Connects to the local relay, retrying briefly while the Tauri-spawned
 * sidecar finishes booting. Mirrors the harness's connectLocalRelay retry
 * loop, minus the spawn (the client relies on Tauri to spawn, not Node).
 */
export async function connectRelay(maxAttempts = 30): Promise<Relay> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await Relay.connect(RELAY_URL);
    } catch (e) {
      lastErr = e;
      await delay(150);
    }
  }
  throw new Error(
    `Could not connect to local relay at ${RELAY_URL} after ${maxAttempts} attempts. ` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : lastErr}. ` +
      `Is the Tauri sidecar running?`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
