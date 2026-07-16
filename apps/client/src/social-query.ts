import { loadFollows } from "./follows-store.js";
import { loadKeys } from "./keys-store.js";
import { listPeers } from "./peers-store.js";

const STORAGE_KEY = "zine.social-query";

export type SocialWindow = "24h" | "7d" | "30d" | "all";
export type SocialScope = "read-relays" | "following" | "peers" | "mine";

export interface SocialQuery {
  text: string;
  window: SocialWindow;
  scope: SocialScope;
}

export const DEFAULT_SOCIAL_QUERY: SocialQuery = {
  text: "",
  window: "7d",
  scope: "read-relays",
};

type QueryStorage = Pick<Storage, "getItem" | "setItem">;

export function normalizeSocialQuery(value: unknown): SocialQuery {
  if (!value || typeof value !== "object") return { ...DEFAULT_SOCIAL_QUERY };
  const raw = value as Partial<SocialQuery>;
  const window: SocialWindow =
    raw.window === "24h" || raw.window === "7d" || raw.window === "30d" || raw.window === "all"
      ? raw.window
      : DEFAULT_SOCIAL_QUERY.window;
  const scope: SocialScope =
    raw.scope === "read-relays" || raw.scope === "following" || raw.scope === "peers" || raw.scope === "mine"
      ? raw.scope
      : DEFAULT_SOCIAL_QUERY.scope;
  return {
    text: typeof raw.text === "string" ? raw.text.slice(0, 160) : "",
    window,
    scope,
  };
}

export function loadSocialQuery(storage: QueryStorage = localStorage): SocialQuery {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? normalizeSocialQuery(JSON.parse(raw)) : { ...DEFAULT_SOCIAL_QUERY };
  } catch {
    return { ...DEFAULT_SOCIAL_QUERY };
  }
}

export function saveSocialQuery(
  query: SocialQuery,
  storage: QueryStorage = localStorage,
): SocialQuery {
  const normalized = normalizeSocialQuery(query);
  storage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

const WINDOW_SECS: Record<Exclude<SocialWindow, "all">, number> = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
};

export function socialWindowSince(window: SocialWindow, nowSec = Math.floor(Date.now() / 1000)): number | undefined {
  return window === "all" ? undefined : nowSec - WINDOW_SECS[window];
}

/** Undefined means no author filter. An empty array is deliberately distinct:
 * the chosen reader scope currently contains nobody, so the query has no hits. */
export async function authorsForSocialScope(scope: SocialScope): Promise<string[] | undefined> {
  if (scope === "read-relays") return undefined;
  if (scope === "following") return loadFollows().map((entry) => entry.pubkey);
  if (scope === "mine") return [...new Set(loadKeys().map((entry) => entry.pubkey))];
  const peers = await listPeers();
  return peers.peers;
}

export function matchesSocialText(
  queryText: string,
  input: { folderId: string; name?: string; tags?: readonly string[] },
): boolean {
  const needle = queryText.trim().toLocaleLowerCase();
  if (!needle) return true;
  const haystack = [input.folderId, input.name ?? "", ...(input.tags ?? [])]
    .join("\n")
    .toLocaleLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term.replace(/^#/, "")));
}

