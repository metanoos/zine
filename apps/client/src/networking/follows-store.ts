import { resolvePubkey } from "./peers-store.js";
import { vaultStorage as localStorage } from "../storage/vault-storage.js";

const STORAGE_KEY = "zine.follows";

export interface FollowEntry {
  pubkey: string;
  /** Local reader-side alias. It is not published and makes no identity claim. */
  label?: string;
}

type FollowStorage = Pick<Storage, "getItem" | "setItem">;

function normalize(value: unknown): FollowEntry[] {
  if (!Array.isArray(value)) return [];
  const out: FollowEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const pubkey = (raw as { pubkey?: unknown }).pubkey;
    const label = (raw as { label?: unknown }).label;
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey) || seen.has(pubkey)) continue;
    seen.add(pubkey);
    out.push({
      pubkey,
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
    });
  }
  return out;
}

/** Reader preference only. Following never grants relay access and is not the
 * private Peers ACL or a public contact-list event. */
export function loadFollows(storage: FollowStorage = localStorage): FollowEntry[] {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? normalize(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveFollows(
  entries: readonly FollowEntry[],
  storage: FollowStorage = localStorage,
): FollowEntry[] {
  const normalized = normalize(entries);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function addFollow(
  input: string,
  label = "",
  storage: FollowStorage = localStorage,
): FollowEntry[] {
  const pubkey = resolvePubkey(input);
  const current = loadFollows(storage);
  const existing = current.find((entry) => entry.pubkey === pubkey);
  const cleanLabel = label.trim();
  if (existing) {
    return saveFollows(
      current.map((entry) =>
        entry.pubkey === pubkey
          ? { pubkey, ...(cleanLabel ? { label: cleanLabel } : entry.label ? { label: entry.label } : {}) }
          : entry,
      ),
      storage,
    );
  }
  return saveFollows(
    [...current, { pubkey, ...(cleanLabel ? { label: cleanLabel } : {}) }],
    storage,
  );
}

export function removeFollow(
  pubkey: string,
  storage: FollowStorage = localStorage,
): FollowEntry[] {
  return saveFollows(loadFollows(storage).filter((entry) => entry.pubkey !== pubkey), storage);
}
