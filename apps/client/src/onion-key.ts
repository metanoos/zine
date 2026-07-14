/**
 * Tor v3 onion-address derivation from the Nostr key.
 *
 * See `protocol/transport.md` §3 for the normative scheme. The summary:
 *
 *   onionSeed   = HKDF-SHA256(nostrSecret, salt="zine-onion-v1", info="tor-ed25519-seed")
 *   onionPubkey = ed25519.getPublicKey(onionSeed)
 *   address     = base32(onionPubkey || checksum || 0x03) + ".onion"
 *
 * The onion address is a projection of the Nostr secret, not a sibling
 * credential: the seed holder reproduces it; an npub-holder cannot. There is no
 * persisted onion key file — the seed is re-derived every launch and handed to
 * Tor's control port inline via ADD_ONION.
 */

// @noble v2 exports require the .js suffix (see the package "exports" map).
// These are transitively present via nostr-tools; the package.json promotion
// to direct deps makes that explicit so a future nostr-tools version change
// can't silently drop them.
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { sha3_256 } from "@noble/hashes/sha3.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { loadOrCreateVoice } from "./identity.js";

/** Domain-separation salt for the HKDF step, UTF-8 encoded (because
 *  @noble/hashes v2 requires Uint8Array, not string, for salt/info). Versioned
 *  so a future scheme change produces a different onion without colliding with
 *  the old. transport.md §3.1 names these exact byte strings as normative. */
export const ONION_SALT = utf8Bytes("zine-onion-v1");

/** Domain-separation info string, UTF-8 encoded, naming the derived material. */
export const ONION_INFO = utf8Bytes("tor-ed25519-seed");

/**
 * Derive the 32-byte ed25519 seed from the 32-byte Nostr secp256k1 secret, per
 * transport.md §3.1. RFC 5869 HKDF-SHA256. Deterministic and one-way: the same
 * Nostr secret always yields the same ed25519 seed, and the ed25519 public key
 * (hence the onion) cannot be reversed back to the Nostr key.
 */
export function deriveOnionSeed(nostrSecret: Uint8Array): Uint8Array {
  return hkdf(sha256, nostrSecret, ONION_SALT, ONION_INFO, 32);
}

/**
 * Build the Tor v3 onion address from a 32-byte ed25519 seed, per transport.md
 * §3.2–3.3. The address is base32(pubkey || checksum || version) + ".onion",
 * where checksum = SHA3-256(".onion checksum" || pubkey || 0x03)[:2].
 */
export function onionAddressFromSeed(seed: Uint8Array): string {
  const pubkey = ed25519.getPublicKey(seed); // 32 bytes

  // Tor v3 address payload: [32 pubkey][2 checksum][1 version]
  const payload = new Uint8Array(35);
  payload.set(pubkey, 0);

  // Checksum input: the literal ".onion checksum" + pubkey + version byte.
  const checksumInput = new Uint8Array(15 + 32 + 1);
  checksumInput.set(asciiBytes(".onion checksum"), 0);
  checksumInput.set(pubkey, 15);
  checksumInput[47] = 0x03; // version
  const checksum = sha3_256(checksumInput);
  payload[32] = checksum[0];
  payload[33] = checksum[1];
  payload[34] = 0x03; // version

  return base32Encode(payload) + ".onion";
}

/** Build the 64-byte expanded private key Tor's control port expects.
 *
 * Tor's `ADD_ONION ED25519-V3:<base64>` requires a 64-byte blob that is NOT
 * `seed || pubkey` (a common mistake — that produces a different onion address).
 * It is the ed25519 expanded secret key: SHA-512(seed) split into two 32-byte
 * halves, with the first half clamped (the scalar), the second half unmodified
 * (the prefix/PRF nonce). This is the same format libsodium's
 * crypto_sign_seed_keypair produces internally.
 *
 * @noble/curves exposes this via getExtendedPublicKey(seed), which returns
 * { head (clamped scalar), prefix (nonce), pointBytes (pubkey) }. The expanded
 * key is head || prefix — verified against a live Tor daemon (Tor 0.4.9.11)
 * which generated the exact onion address our onionAddressFromSeed computes. */
export function expandedKeyFromSeed(seed: Uint8Array): Uint8Array {
  const ext = ed25519.utils.getExtendedPublicKey(seed);
  const expanded = new Uint8Array(64);
  expanded.set(ext.head, 0);    // 32-byte clamped scalar
  expanded.set(ext.prefix, 32); // 32-byte prefix (nonce)
  return expanded;
}

/** Convenience: derive the onion address + base64 expanded key from the
 *  current signing voice's secret. The expanded key (base64) is what gets
 *  passed to Tor's control port via `ADD_ONION ED25519-V3:<base64>`. */
export function deriveOnionAddress(): { address: string; seedBase64: string } {
  const voice = loadOrCreateVoice();
  const seed = deriveOnionSeed(voice.secretKey);
  const expanded = expandedKeyFromSeed(seed);
  return {
    address: onionAddressFromSeed(seed),
    // Tor expects the 64-byte expanded key (seed || pubkey), not just the seed.
    seedBase64: bytesToBase64(expanded),
  };
}

// --- base32 (RFC 4648, lowercase, no padding) ----------------------------

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

// --- small helpers --------------------------------------------------------

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
