/**
 * Per-model voice derivation.
 *
 * Each distinct LLM model gets its own deterministic Nostr signing voice, so
 * the same model renders as the same color across the editor and file tree,
 * and a different model (a research subagent, a stronger synthesizer) renders
 * as a different color — the fan-out is visible in the prose itself, for free,
 * via the existing per-voice decoration layer.
 *
 * The scheme mirrors the Tor onion derivation in `onion-key.ts` (RFC 5869
 * HKDF-SHA256 over the browser Nostr secret), in a separate domain so the two
 * namespaces can never collide:
 *
 *   modelSecret = HKDF-SHA256(nostrSecret, salt="zine-model-voice-v1", info=modelId)
 *   modelPubkey = secp256k1.getPublicKey(modelSecret)
 *
 * Deterministic and one-way: the same Nostr secret + modelId always yields the
 * same keypair, and the derived pubkey can't be reversed back to the Nostr key.
 * The modelId (the provider's API model string, e.g. "glm-4.6") is the `info`
 * binding, so two models from the same provider get distinct voices.
 *
 * `ensureModelVoice` is idempotent: it derives the keypair and upserts it into
 * the keychain (stable id `model:<modelId>`), so `secretKeyForVoice` /
 * `identityForVoice` resolve it and assign a stable color. Re-derivation
 * reproduces the same entry, so there is no harm in calling it every run.
 */

// @noble v2 exports require the .js suffix (see package "exports" map),
// transitively present via nostr-tools (onion-key.ts uses the same imports).
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { getPublicKey } from "nostr-tools/pure";

import {
  keySecretRef,
  loadKeys,
  saveKeys,
  identityFromPubkey,
  type KeyEntry,
} from "../identity/keys-store.js";
import { putSecret } from "../identity/secret-store.js";

/** Domain-separation salt, UTF-8 encoded (@noble v2 needs Uint8Array, not
 *  string, for salt/info). Versioned so a future scheme change produces a
 *  different voice namespace without colliding with the old one or with the
 *  onion namespace (`zine-onion-v1`). */
export const MODEL_VOICE_SALT = new TextEncoder().encode("zine-model-voice-v1");

export interface ModelVoice {
  /** 32-byte secp256k1 secret scalar. */
  secret: Uint8Array;
  /** 64-char hex pubkey (npub-less). */
  pubkey: string;
}

/**
 * Derive a deterministic (secret, pubkey) pair for a model. Pure — does not
 * touch the keychain. The same `nostrSecret + modelId` always yields the same
 * pair; different `modelId`s (or a different `nostrSecret`) yield different pairs.
 */
export function deriveModelVoice(nostrSecret: Uint8Array, modelId: string): ModelVoice {
  const secret = hkdf(sha256, nostrSecret, MODEL_VOICE_SALT, new TextEncoder().encode(modelId), 32);
  return { secret, pubkey: getPublicKey(secret) };
}

/** Stable keychain id for a derived model voice. */
function modelKeyId(modelId: string): string {
  return `model:${modelId}`;
}

/**
 * Derive the model voice AND ensure it is present in the keychain, so it picks
 * up a stable visual identity (font + color) and so `secretKeyForVoice` can
 * resolve the secret later (e.g. when the human Steps a draft and `stepFile`
 * resolves the dominant voice's signer).
 *
 * Idempotent: if an entry with id `model:<modelId>` already exists, it is left
 * alone — re-derivation always reproduces the same secret/pubkey, so there is
 * no drift whether the entry pre-existed or not.
 *
 * @param label optional human-readable label for the keychain card; defaults
 *   to the modelId. Callers typically pass the provider's display label.
 */
export function ensureModelVoice(
  nostrSecret: Uint8Array,
  modelId: string,
  label?: string,
): ModelVoice {
  const { secret, pubkey } = deriveModelVoice(nostrSecret, modelId);
  const id = modelKeyId(modelId);
  const keys = loadKeys();
  if (!keys.some((k) => k.id === id)) {
    const secretRef = keySecretRef(id);
    // `putSecret` fills the unlocked session cache synchronously before its
    // durable Stronghold write, so the derived voice is immediately usable by
    // the existing synchronous signing boundary. Bootstrap has already made
    // this a desktop-only authoring path.
    void putSecret(secretRef, secret).catch((error) => {
      console.error(`[model-voice] could not persist ${secretRef}:`, error);
    });
    const entry: KeyEntry = {
      id,
      label: label || modelId,
      secretRef,
      pubkey,
      identity: identityFromPubkey(pubkey),
      // Match the current identity-derivation schema so loadKeys() doesn't
      // re-derive on the next load (IDENTITY_SCHEMA is private in keys-store;
      // copying the value here keeps model-voice free of an export churn).
      schemaVersion: 1,
      createdAt: Date.now(),
    };
    saveKeys([...keys, entry]);
  }
  return { secret, pubkey };
}
