/**
 * Operator-layer client for the hosted relay.
 *
 * This is the webapp-only counterpart to relay/cmd/hosted/operator.go. The
 * desktop sidecar doesn't serve /operator/*, so nothing here is called in a
 * Tauri build — callers gate on `isTauri()` first (see App.tsx's boot effect).
 *
 * Design posture mirrors identity.ts: the browser signs NIP-98 HTTP-auth events
 * with the already-seeded AUTHOR key. No secret key is ever typed or
 * pasted. The bootstrap token is the one enrollment secret, and it authorizes
 * the relay to trust a freshly-generated pubkey — nothing more.
 *
 * State is cached in localStorage (`zine.operator`) so a reload doesn't flash
 * an unbound setup screen while the fresh GET is in flight, and so alpha-config
 * (Phase 4) can read the operator+team synchronously.
 */

import { getToken } from "nostr-tools/nip98";
import { finalizeEvent } from "nostr-tools/pure";
import { isTauri, loadOrCreateVoice } from "./identity.js";

/** The operator/team/ban snapshot served by GET /operator/state. `operator` is
 *  "" when no operator is bound. */
export interface OperatorState {
  operator: string;
  curation_team: string[];
  banned: string[];
  updated_at: number;
}

const STORAGE_KEY = "zine.operator";

const EMPTY: OperatorState = {
  operator: "",
  curation_team: [],
  banned: [],
  updated_at: 0,
};

let cached: OperatorState | null = null;

/** The last-known operator state — synchronous, from the in-memory cache.
 *  Returns the empty state (no operator) if nothing has been fetched yet, so
 *  callers can treat the unbound case uniformly. */
export function getOperatorState(): OperatorState {
  return cached ?? loadCached() ?? EMPTY;
}

/** The pubkeys whose signed TraceOpinion events should shape this reader's
 *  Stacks page at operator weight: the bound operator plus their curation
 *  team. Empty on the desktop sidecar and on a relay with no operator bound.
 *  This is the single hook alpha-config.ts unions into `operatorPubkeys`. */
export function relayOperatorPubkeys(): string[] {
  const st = getOperatorState();
  const out = new Set<string>();
  if (st.operator) out.add(st.operator);
  for (const pk of st.curation_team) out.add(pk);
  return [...out];
}

/** True if the current browser voice is the relay's operator. */
export function isOperator(): boolean {
  const st = getOperatorState();
  if (!st.operator) return false;
  return st.operator === loadOrCreateVoice().publicKey;
}

/** True if the current browser voice is the operator OR on the curation team.
 *  Gates the operator nav entry and the moderation affordances. */
export function isStaff(): boolean {
  const me = loadOrCreateVoice().publicKey;
  const st = getOperatorState();
  if (st.operator === me) return true;
  return st.curation_team.includes(me);
}

/** Fetch the operator state from the relay and refresh the cache. No-op on the
 *  desktop sidecar. A network failure leaves the existing cache intact and
 *  resolves to null rather than throwing, so a transient relay hiccup can't
 *  break boot. */
export async function refreshOperatorState(): Promise<OperatorState | null> {
  if (isTauri()) return null;
  try {
    const resp = await fetch("/operator/state", { headers: { Accept: "application/json" } });
    if (!resp.ok) return null;
    const st = (await resp.json()) as OperatorState;
    cached = normalize(st);
    saveCached(cached);
    return cached;
  } catch {
    return null;
  }
}

/** Bind this browser's AUTHOR key as the relay's operator. The browser
 *  key is fresh-generated (never pasted); the token authorizes the relay to
 *  trust its pubkey. Throws on non-2xx with the server's message. */
export async function bindOperator(token: string): Promise<OperatorState> {
  if (isTauri()) throw new Error("operator bind is not available on the desktop app");
  const tokenTrim = token.trim();
  if (!tokenTrim) throw new Error("enter the bootstrap token");
  const pubkey = loadOrCreateVoice().publicKey;
  const resp = await fetch("/operator/bind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenTrim, pubkey }),
  });
  if (!resp.ok) {
    // 503 → "bootstrap not configured"; 401 → wrong token. Surface the body.
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(msg || `bind failed (${resp.status})`);
  }
  const st = normalize((await resp.json()) as OperatorState);
  cached = st;
  saveCached(cached);
  return st;
}

/** Add or remove a pubkey from the curation team. Operator-only. Signs a NIP-98
 *  event over the exact URL + body the request will carry, so the relay can
 *  verify the signature against this very fetch. */
export async function setTeamMember(
  pubkey: string,
  action: "add" | "remove",
): Promise<OperatorState> {
  return mutate("/operator/team", { pubkey, action });
}

/** Add or remove a pubkey from the ban list. Operator or curation team. */
export async function setBan(
  pubkey: string,
  action: "add" | "remove",
): Promise<OperatorState> {
  return mutate("/operator/ban", { pubkey, action });
}

/** The shared team/ban path: build the body, sign a NIP-98 token over it, send.
 *  `nip98.getToken` handles the kind-27235 construction + base64 encoding; we
 *  pass it a signer built from the AUTHOR key's secret bytes. */
async function mutate(
  path: string,
  body: { pubkey: string; action: "add" | "remove" },
): Promise<OperatorState> {
  if (isTauri()) throw new Error("operator actions are not available on the desktop app");
  const voice = loadOrCreateVoice();
  const url = `${globalThis.location.origin}${path}`;
  const json = JSON.stringify(body);
  const signer = (template: Parameters<typeof finalizeEvent>[0]) =>
    finalizeEvent(template, voice.secretKey);
  // getToken(url, method, sign, includeScheme, payload). Passing the parsed
  // body as the payload makes nip98 hash it and add the `payload` tag — which
  // the relay re-derives server-side and compares.
  const token = await getToken(url, "POST", signer, true, JSON.parse(json));
  const resp = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token, // getToken with includeScheme=true yields "Nostr <b64>"
    },
    body: json,
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(msg || `request failed (${resp.status})`);
  }
  const st = normalize((await resp.json()) as OperatorState);
  cached = st;
  saveCached(cached);
  return st;
}

// --- cache helpers ---------------------------------------------------------

function normalize(st: Partial<OperatorState>): OperatorState {
  return {
    operator: typeof st.operator === "string" ? st.operator : "",
    curation_team: Array.isArray(st.curation_team) ? st.curation_team.filter(isString) : [],
    banned: Array.isArray(st.banned) ? st.banned.filter(isString) : [],
    updated_at: typeof st.updated_at === "number" ? st.updated_at : 0,
  };
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function loadCached(): OperatorState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalize(JSON.parse(raw) as Partial<OperatorState>);
  } catch {
    return null;
  }
}

function saveCached(st: OperatorState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
  } catch {
    // Quota / private mode — non-fatal; the next refresh re-populates.
  }
}
