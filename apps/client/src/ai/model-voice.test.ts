/**
 * Tests for the per-model voice derivation (model-voice.ts).
 *
 * The properties pinned here:
 *   1. Determinism: the same (nostrSecret, modelId) always yields the same pair.
 *   2. Distinctness across modelIds: different models yield different pubkeys.
 *   3. Distinctness across secrets: different users yield different pubkeys
 *      for the same model.
 *   4. Namespace isolation from the onion derivation: the same secret yields
 *      a different 32-byte seed under the model-voice salt than under the
 *      onion salt, so the two can never share a key.
 *   5. Pubkey is the secp256k1 public key of the derived secret (round-trip).
 *   6. ensureModelVoice is idempotent — re-calling leaves the keychain stable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// localStorage shim — keys-store reads/writes "zine.keys" on load.
const store = new Map<string, string>();
// @ts-expect-error minimal shim for the localStorage the keychain depends on
globalThis.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

import { getPublicKey } from "nostr-tools/pure";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

import {
  deriveModelVoice,
  ensureModelVoice,
  MODEL_VOICE_SALT,
} from "./model-voice.js";
import { loadKeys, secretKeyForVoice } from "../identity/keys-store.js";

const SECRET_A = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET_A[i] = i + 1;
const SECRET_B = new Uint8Array(32);
for (let i = 0; i < 32; i++) SECRET_B[i] = 255 - i;

test("deriveModelVoice is deterministic for the same (secret, modelId)", () => {
  const a = deriveModelVoice(SECRET_A, "glm-4.6");
  const b = deriveModelVoice(SECRET_A, "glm-4.6");
  assert.equal(a.pubkey, b.pubkey);
  assert.deepEqual(Array.from(a.secret), Array.from(b.secret));
});

test("different modelIds yield different pubkeys", () => {
  const a = deriveModelVoice(SECRET_A, "glm-4.6");
  const b = deriveModelVoice(SECRET_A, "claude-3-5-sonnet");
  assert.notEqual(a.pubkey, b.pubkey);
  assert.notEqual(a.secret, b.secret);
});

test("different secrets yield different pubkeys for the same model", () => {
  const a = deriveModelVoice(SECRET_A, "glm-4.6");
  const b = deriveModelVoice(SECRET_B, "glm-4.6");
  assert.notEqual(a.pubkey, b.pubkey);
});

test("the derived secret's pubkey matches the returned pubkey", () => {
  const { secret, pubkey } = deriveModelVoice(SECRET_A, "glm-4.6");
  assert.equal(getPublicKey(secret), pubkey);
});

test("model-voice namespace is isolated from the onion namespace", () => {
  const ONION_SALT = new TextEncoder().encode("zine-onion-v1");
  const onionSeed = hkdf(sha256, SECRET_A, ONION_SALT, new TextEncoder().encode("tor-ed25519-seed"), 32);
  const modelSeed = hkdf(sha256, SECRET_A, MODEL_VOICE_SALT, new TextEncoder().encode("glm-4.6"), 32);
  assert.notDeepEqual(Array.from(onionSeed), Array.from(modelSeed));
});

test("ensureModelVoice upserts into the keychain and is resolvable", () => {
  const { pubkey, secret } = ensureModelVoice(SECRET_A, "glm-4.6", "GLM 4.6");
  const entry = loadKeys().find((k) => k.id === "model:glm-4.6");
  assert.ok(entry, "keychain entry should exist after ensureModelVoice");
  assert.equal(entry!.pubkey, pubkey);
  assert.equal(entry!.label, "GLM 4.6");
  // secretKeyForVoice must resolve the derived secret.
  const resolved = secretKeyForVoice(pubkey);
  assert.ok(resolved, "secretKeyForVoice should resolve the model voice");
  assert.deepEqual(Array.from(resolved!), Array.from(secret));
});

test("ensureModelVoice is idempotent — re-calling does not duplicate", () => {
  ensureModelVoice(SECRET_A, "glm-4.6", "GLM 4.6");
  const countAfter1 = loadKeys().filter((k) => k.id === "model:glm-4.6").length;
  ensureModelVoice(SECRET_A, "glm-4.6", "GLM 4.6");
  const countAfter2 = loadKeys().filter((k) => k.id === "model:glm-4.6").length;
  assert.equal(countAfter1, 1);
  assert.equal(countAfter2, 1);
});
