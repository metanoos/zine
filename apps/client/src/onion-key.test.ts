/**
 * Tests for the onion-address derivation (onion-key.ts).
 *
 * The known-answer vector was generated independently (raw @noble primitives +
 * a hand-rolled base32) and cross-verified against a Python reference of the
 * Tor v3 spec (SHA3-256 checksum + base32, per rend-spec-v3.txt). The address
 * `nwciicwezafhf3hvneekd3bk5xph6hf7pt3eurtiojcdx4x7cogndzid.onion` is the
 * canonical onion for the fixed secret `0102…1f20`, and two independent
 * implementations agree on it.
 *
 * The properties pinned here:
 *   1. Known-answer: the fixed secret yields the fixed address (catches any
 *      drift in the HKDF params, checksum, or base32 alphabet).
 *   2. Determinism: the same secret always yields the same seed + address.
 *   3. One-wayness: different secrets yield different addresses (a sanity check
 *      that we're not accidentally constant-folding or ignoring the input).
 *   4. Address shape: 56 chars + ".onion", all lowercase base32.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveOnionSeed, onionAddressFromSeed } from "./onion-key.js";

const KAT_SECRET = new Uint8Array(32);
for (let i = 0; i < 32; i++) KAT_SECRET[i] = i + 1;

const KAT_SEED =
  "6714bbf7cbc8a9d92b8c61f74d62fc3cdc93317b9da1c1e6bfe9aa6ed611f232";
const KAT_ADDRESS =
  "nwciicwezafhf3hvneekd3bk5xph6hf7pt3eurtiojcdx4x7cogndzid.onion";

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

test("known-answer: fixed secret → fixed seed + address", () => {
  const seed = deriveOnionSeed(KAT_SECRET);
  assert.equal(toHex(seed), KAT_SEED);
  assert.equal(onionAddressFromSeed(seed), KAT_ADDRESS);
});

test("determinism: same secret yields same seed and address", () => {
  const seed1 = deriveOnionSeed(KAT_SECRET);
  const seed2 = deriveOnionSeed(KAT_SECRET);
  assert.deepEqual(seed1, seed2);
  assert.equal(
    onionAddressFromSeed(seed1),
    onionAddressFromSeed(seed2),
  );
});

test("different secrets yield different addresses", () => {
  const other = new Uint8Array(32);
  for (let i = 0; i < 32; i++) other[i] = 0xff - i;
  const addrA = onionAddressFromSeed(deriveOnionSeed(KAT_SECRET));
  const addrB = onionAddressFromSeed(deriveOnionSeed(other));
  assert.notEqual(addrA, addrB);
});

test("address shape: 56 base32 chars + .onion suffix", () => {
  const addr = onionAddressFromSeed(deriveOnionSeed(KAT_SECRET));
  assert.ok(addr.endsWith(".onion"));
  const body = addr.slice(0, -6);
  assert.equal(body.length, 56);
  assert.match(body, /^[a-z2-7]+$/);
});
