/**
 * Extra onion "doors" — additional `.onion` addresses that forward to the local
 * relay, each derived from a different keychain key.
 *
 * An onion is a *door*, not an identity. The owner key (NODE role in
 * keys-store.ts) is who you ARE — it signs AUTH and owns networked mode. A door is
 * where peers FIND you. Adding a door opens another address into the same
 * relay; it grants no privilege and changes nothing about ownership. This is
 * the Tor-honest framing: a hidden service can be registered many times with
 * different keys (Tor's `ADD_ONION` is repeatable), all forwarding to
 * `127.0.0.1:4869`.
 *
 * Why doors exist alongside the owner key: zero-downtime rotation. You stand up
 * a new door, hand peers the new address, leave the old one live while they
 * migrate, and retire it later. Replace-semantics (one slot, old dies on
 * switch) make that impossible — there's always a gap where half your peers
 * hold a dead address.
 *
 * Storage shape mirrors relay-config.ts: a JSON array in localStorage, each
 * entry stable by id so add/remove survive edits. The onion address is cached
 * on the entry so the UI renders without re-deriving on every paint; it's a
 * pure function of the referenced key secret, so it never drifts.
 */

import { loadKeys, secretKeyForVoice } from "./keys-store.js";
import { onionAddressForSecret } from "./onion-key.js";

export interface DoorEntry {
  /** Stable id (so removals survive edits). */
  id: string;
  /** The keychain key whose secret derives this door's onion. */
  keyId: string;
  /** Cached derived `.onion` address (pure function of keyId's secret). */
  address: string;
  /** When the door was added — for ordering and debugging. */
  createdAt: number;
}

const STORAGE_KEY = "zine.doors";

/** Resolve key bytes for a keyId, or null if it was deleted or locked. */
function secretFor(keyId: string): Uint8Array | null {
  const key = loadKeys().find((entry) => entry.id === keyId);
  return key ? secretKeyForVoice(key.pubkey) : null;
}

/**
 * Read the persisted doors list. Entries whose keychain key was deleted are
 * pruned (a dangling door has no secret to derive from — and Tor can't register
 * it), and the address is re-derived so it never drifts from the stored secret.
 */
export function loadDoors(): DoorEntry[] {
  let raw: DoorEntry[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as DoorEntry[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  const keys = loadKeys();
  let changed = false;
  const live = raw.flatMap((d) => {
    const key = keys.find((entry) => entry.id === d.keyId);
    const secret = key ? secretKeyForVoice(key.pubkey) : null;
    if (!secret) {
      changed = true;
      return []; // key deleted — prune the door
    }
    const address = onionAddressForSecret(secret).address;
    if (address !== d.address) {
      changed = true;
      return [{ ...d, address }];
    }
    return [d];
  });
  if (changed) saveDoors(live);
  return live;
}

/** Persist the list. */
export function saveDoors(doors: DoorEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(doors));
}

/**
 * Add a door for the given keychain key. Derives the onion from the key's
 * secret and caches it on the entry. Dedupes by keyId — a key can only be one
 * door. Returns the new full list.
 */
export function addDoor(keyId: string): DoorEntry[] {
  const doors = loadDoors();
  const secret = secretFor(keyId);
  if (!secret) return doors; // key vanished — nothing to add
  if (doors.some((d) => d.keyId === keyId)) return doors; // dedupe
  const entry: DoorEntry = {
    id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    keyId,
    address: onionAddressForSecret(secret).address,
    createdAt: Date.now(),
  };
  const next = [...doors, entry];
  saveDoors(next);
  return next;
}

/** Remove a door by id. The keychain key is untouched. */
export function removeDoor(id: string): DoorEntry[] {
  const next = loadDoors().filter((d) => d.id !== id);
  saveDoors(next);
  return next;
}
