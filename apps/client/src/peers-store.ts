/**
 * Access-policy management — the bridge to the Rust peer-config commands.
 *
 * The peer list lives at ~/.tracer/peers.json and is read by the relay to
 * decide who may connect (transport.md §5). This module wraps the Tauri
 * commands that manage that file; the relay re-reads it on a 5s poll, so
 * changes here take effect without a restart.
 *
 * These commands only exist in the desktop (Tauri) build — the webapp has no
 * relay to gate access on. Callers must guard with isTauri().
 *
 * Migration note: the file was previously named friends.json with a "friends"
 * key. The Rust reader migrates it into peers.json on first read (see
 * migrate_legacy_friends_file in lib.rs), so callers don't need to know about
 * the old name.
 */

import { decode } from "nostr-tools/nip19";
import { isTauri } from "./identity.js";

export interface PeersState {
  /** The owner pubkey (64 hex). When set, networked mode is active. */
  owner: string;
  /** Peer pubkeys (read-only access). */
  peers: string[];
  /** Headless presses allowed to publish events signed as themselves. */
  writers: string[];
  /** True when an owner is set — the relay requires NIP-42 AUTH. */
  networkedMode: boolean;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/** Read the current access policy. Returns local-mode state if no peers.json. */
export async function listPeers(): Promise<PeersState> {
  if (!isTauri()) {
    return { owner: "", peers: [], writers: [], networkedMode: false };
  }
  return invoke<PeersState>("list_peers");
}

/** Set the owner pubkey — activates networked mode (relay starts requiring AUTH). */
export async function setOwner(pubkey: string): Promise<PeersState> {
  if (!isTauri()) throw new Error("access-policy management is desktop-only");
  return invoke<PeersState>("set_owner", { pubkey });
}

/**
 * Normalize a pubkey-shaped input to 64 lowercase hex. Accepts raw hex, an
 * npub (`npub1…`), or an nprofile (`nprofile1…` — its pubkey is extracted,
 * relays ignored). Anything else throws — the relay's add_peer rejects it
 * anyway, but decoding here surfaces a friendlier "unknown format" error than
 * the backend's "expected 64 hex chars".
 */
export function resolvePubkey(input: string): string {
  const trimmed = input.trim();
  if (/^[0-9a-f]{64}$/.test(trimmed)) return trimmed;
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(trimmed);
  } catch (e) {
    throw new Error(`unknown pubkey format: ${trimmed}`);
  }
  if (decoded.type === "npub") return decoded.data as string;
  if (decoded.type === "nprofile") return (decoded.data as { pubkey: string }).pubkey;
  throw new Error(`not a pubkey (got ${decoded.type}): ${trimmed}`);
}

/** Add a peer (read-only access). Dedupes; refuses the owner. */
export async function addPeer(pubkey: string): Promise<PeersState> {
  if (!isTauri()) throw new Error("access-policy management is desktop-only");
  return invoke<PeersState>("add_peer", { pubkey: resolvePubkey(pubkey) });
}

/** Remove a peer. */
export async function removePeer(pubkey: string): Promise<PeersState> {
  if (!isTauri()) throw new Error("access-policy management is desktop-only");
  return invoke<PeersState>("remove_peer", { pubkey });
}

/** Add a headless writer (read+write access, restricted to its own events). */
export async function addWriter(pubkey: string): Promise<PeersState> {
  if (!isTauri()) throw new Error("access-policy management is desktop-only");
  return invoke<PeersState>("add_writer", { pubkey: resolvePubkey(pubkey) });
}

/** Remove a headless writer. */
export async function removeWriter(pubkey: string): Promise<PeersState> {
  if (!isTauri()) throw new Error("access-policy management is desktop-only");
  return invoke<PeersState>("remove_writer", { pubkey });
}
