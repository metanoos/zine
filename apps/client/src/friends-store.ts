/**
 * Friend ACL management — the bridge to the Rust friend-config commands.
 *
 * The friend list lives at ~/.tracer/friends.json and is read by the relay to
 * decide who may connect (transport.md §5). This module wraps the Tauri
 * commands that manage that file; the relay re-reads it on a 5s poll, so
 * changes here take effect without a restart.
 *
 * These commands only exist in the desktop (Tauri) build — the webapp has no
 * relay to gate access on. Callers must guard with isTauri().
 */

import { isTauri } from "./identity.js";

export interface FriendsState {
  /** The owner pubkey (64 hex). When set, friend mode is active. */
  owner: string;
  /** Friend pubkeys (read-only access). */
  friends: string[];
  /** True when an owner is set — the relay requires NIP-42 AUTH. */
  friendMode: boolean;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/** Read the current friend ACL. Returns open-mode state if no friends.json. */
export async function listFriends(): Promise<FriendsState> {
  if (!isTauri()) {
    return { owner: "", friends: [], friendMode: false };
  }
  return invoke<FriendsState>("list_friends");
}

/** Set the owner pubkey — activates friend mode (relay starts requiring AUTH). */
export async function setOwner(pubkey: string): Promise<FriendsState> {
  if (!isTauri()) throw new Error("friend management is desktop-only");
  return invoke<FriendsState>("set_owner", { pubkey });
}

/** Add a friend (read-only access). Dedupes; refuses the owner. */
export async function addFriend(pubkey: string): Promise<FriendsState> {
  if (!isTauri()) throw new Error("friend management is desktop-only");
  return invoke<FriendsState>("add_friend", { pubkey });
}

/** Remove a friend. */
export async function removeFriend(pubkey: string): Promise<FriendsState> {
  if (!isTauri()) throw new Error("friend management is desktop-only");
  return invoke<FriendsState>("remove_friend", { pubkey });
}
