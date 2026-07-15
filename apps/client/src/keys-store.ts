/**
 * Nostr keypair keychain — the set of voices the user can sign and attribute
 * text with. Promotes the `keys` nav entry from placeholder to a real view,
 * following the `models-store.ts` / `relay-config.ts` precedent: a
 * localStorage-backed list with a stable active id and one builtin entry that
 * can never be deleted (there must always be a signer).
 *
 * GENERATIVE VISUAL IDENTITY. Each key carries an `identity` — a font + hue +
 * saturation, derived deterministically from the pubkey (see identityFromPubkey)
 * so the same key renders the same color on every device and across storage
 * loss/reseed. The identity is how a key's text renders in the editor AND the
 * swatch on its card. It is *visual* only: it does not touch signing. Colors
 * are derived (not stored) from the hue/sat via HSL so the same identity reads
 * on both light and dark themes (lightness comes from a `--voice-ink-l` token
 * set per theme, see App.css).
 *
 * SECURITY POSTURE: secret key material lives in localStorage as hex, exactly
 * as `identity.ts` already stored it pre-keychain. Routing only these secrets
 * through OS keychain would create the same asymmetry `models-store.ts` calls
 * out — better to move every secret (Nostr + LLM) to a keychain layer together,
 * as a later hardening pass. Until then, consistent and honest about the limit.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { fetchVoiceIdentity } from "./provenance.js";

export interface KeyIdentity {
  /** CSS font-family value (e.g. `"Newsreader", serif`). */
  font: string;
  /** 0–360. Generated to avoid the gold band so voices stay off the accent. */
  hue: number;
  /** 0–100. Muted-to-medium so the swatch and runs stay readable. */
  sat: number;
}

export interface KeyEntry {
  /** Stable id so edits survive reordering; builtins carry stable ids. */
  id: string;
  label: string;
  /** Hex secret (32 bytes → 64 hex chars). */
  secretHex: string;
  /** Derived npub-less hex pubkey (32 bytes → 64 hex chars). */
  pubkey: string;
  identity: KeyIdentity;
  createdAt: number;
  /** True for the seeded/migrated first key — can't be deleted, only edited. */
  builtin?: boolean;
  /** Identity-derivation schema. When missing or != IDENTITY_SCHEMA, loadKeys()
   *  re-derives `identity` from the pubkey (deterministic) and bumps this. The
   *  gate means the one-time migration runs once per key, then never again —
   *  so a later manual `identity` patch via patchKey survives. */
  schemaVersion?: number;
}

const STORAGE_KEY = "zine.keys";
/** Current identity-derivation schema. Bump when the identityFromPubkey
 *  mapping changes; loadKeys() re-derives any key below it on load. */
const IDENTITY_SCHEMA = 1;
const ACTIVE_KEY = "zine.keys.active";
/** The pre-keychain single-voice secret slot, migrated into the first key. */
const LEGACY_SECRET_KEY = "zine.voice.secretHex";

/**
 * Curated font pool for identity generation — readable body faces across the
 * three families, all loaded via the single Google Fonts `@import` in App.css.
 * `Big Shoulders Display` is deliberately NOT here: it's a condensed display
 * face for chrome/wordmarks, not comfortable for reading paragraphs. The pool
 * stays small (~8) so the `@import` stays cheap and any two voices are still
 * likely to differ.
 */
interface FontChoice {
  /** CSS font-family value. */
  family: string;
  /** Generic fallback appended in CSS. */
  generic: "serif" | "sans-serif" | "monospace";
}
export const KEYCHAIN_FONTS: FontChoice[] = [
  { family: "Newsreader", generic: "serif" },
  { family: "Fraunces", generic: "serif" },
  { family: "Lora", generic: "serif" },
  { family: "Spectral", generic: "serif" },
  { family: "Inter", generic: "sans-serif" },
  { family: "Atkinson Hyperlegible", generic: "sans-serif" },
  { family: "IBM Plex Mono", generic: "monospace" },
  { family: "JetBrains Mono", generic: "monospace" },
];

/** The gold/amber band reserved for chrome (`--accent`). Voices dodge it. */
const GOLD_HUE_MIN = 25;
const GOLD_HUE_MAX = 55;

export function fontCss(f: FontChoice | undefined): string {
  // A dev-server / HMR inconsistency has been observed shipping
  // `KEYCHAIN_FONTS` as an empty array on first eval, which made
  // `identityFromPubkey` crash with "Cannot read properties of undefined
  // (reading 'family')" and white-screened <KeysView>. Fall back to a plain
  // system stack so a transient module-cache hiccup can never take the keys
  // view down — the deterministic hash still picks the same font once the
  // module settles.
  if (!f) return `"Newsreader", serif`;
  return `"${f.family}", ${f.generic}`;
}

/**
 * Derive a key's visual identity deterministically from its pubkey, so the
 * same key renders the same font + color on every device and survives storage
 * loss (the previous Math.random() form produced a *different* color on every
 * reseed — visible as "my editor changed background colors on reload" whenever
 * zine.keys was evicted/corrupt/private-mode).
 *
 * The previous comment claimed randomness "matching models-store.ts /
 * relay-config.ts" — but those randomize *ids* (`Math.random().toString(36)`),
 * not visual identity. Ids need uniqueness; identity needs stability.
 *
 * FNV-1a over the pubkey hex spreads bits well; the font/hue/sat buckets are
 * chosen to match the ranges the old random form produced:
 *   - font: uniform over the 8 KEYCHAIN_FONTS
 *   - hue: uniform over the 329 allowed hues (0–360 minus the gold band [25,55])
 *   - sat: uniform over [35,65] (the old `35 + floor(rand*31)` range)
 */
export function identityFromPubkey(pubkey: string): KeyIdentity {
  // FNV-1a 32-bit over the pubkey hex chars (UTF-8 == ASCII for hex).
  let h = 0x811c9dc5;
  for (let i = 0; i < pubkey.length; i++) {
    h ^= pubkey.charCodeAt(i);
    // Math.imul keeps this a 32-bit multiply without floating point.
    h = Math.imul(h, 0x01000193);
  }
  const font = KEYCHAIN_FONTS[(h >>> 0) % KEYCHAIN_FONTS.length];
  // Map into the 329 allowed hues (360 minus the 31 reserved by the gold band).
  // Allowed set: [0,24] ∪ [56,359]. Index < 25 → low arc; ≥ 25 → shift past gold.
  const hueIndex = (h >>> 7) % 329; // 0–328
  const hue = hueIndex < GOLD_HUE_MIN ? hueIndex : hueIndex + (GOLD_HUE_MAX - GOLD_HUE_MIN + 1);
  const sat = 35 + ((h >>> 14) % 31); // 35–65
  return { font: fontCss(font), hue, sat };
}

/** Kept as a random-identity fallback for any external caller that still wants
 *  a one-off identity not tied to a pubkey. The keychain itself no longer uses
 *  this — identityFromPubkey is the path for all keys. */
export function generateIdentity(): KeyIdentity {
  const font = KEYCHAIN_FONTS[Math.floor(Math.random() * KEYCHAIN_FONTS.length)];
  let hue = Math.floor(Math.random() * 360);
  while (hue >= GOLD_HUE_MIN && hue <= GOLD_HUE_MAX) {
    hue = Math.floor(Math.random() * 360);
  }
  const sat = 35 + Math.floor(Math.random() * 31); // 35–65
  return { font: fontCss(font), hue, sat };
}

/**
 * CSS color rules for a key identity, resolved against the current theme's
 * `--voice-ink-l` lightness token. Returns ready-to-use `hsl()` strings; the
 * caller picks the alpha per surface (card swatch vs. editor run).
 */
export function identityColors(id: KeyIdentity, alpha: number): {
  fg: string;
  bg: string;
} {
  const lightness = "var(--voice-ink-l)";
  return {
    fg: `hsl(${id.hue} ${id.sat}% ${lightness})`,
    bg: `hsl(${id.hue} ${id.sat}% ${lightness} / ${alpha})`,
  };
}

// --- bech32 encoding (NIP-19) ---------------------------------------------
// npub/nsec are the idiomatic shareable forms — what other Nostr clients
// expect to receive on paste. We expose both so the UI copies the right shape
// rather than raw hex, and keeps the encoding out of the view.

/** The key's public key as an npub (`npub1…`). */
export function keyNpub(k: KeyEntry): string {
  return npubEncode(k.pubkey);
}

/** The key's secret key as an nsec (`nsec1…`). */
export function keyNsec(k: KeyEntry): string {
  return nsecEncode(hexToBytes(k.secretHex));
}

function newId(): string {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function entryFromSecret(secretHex: string, label: string, builtin: boolean): KeyEntry {
  const secretKey = hexToBytes(secretHex);
  const pubkey = getPublicKey(secretKey);
  return {
    id: builtin ? "builtin-alice" : newId(),
    label,
    secretHex,
    pubkey,
    identity: identityFromPubkey(pubkey),
    schemaVersion: IDENTITY_SCHEMA,
    createdAt: Date.now(),
    builtin,
  };
}

/** Generate a fresh keypair entry with a given label. Never builtin. */
function freshKey(label: string): KeyEntry {
  return entryFromSecret(bytesToHex(generateSecretKey()), label, false);
}

/**
 * Ensure the keychain is seeded. Three cases:
 *
 *   - Legacy migration: a pre-keychain install has `zine.voice.secretHex`. We
 *     absorb it into the first builtin key ("alice") so the user keeps their
 *     signing identity and provenance chain continuity, and set it as the
 *     AUTHOR + MODEL + NODE roles so existing behavior is unchanged. The legacy
 *     slot is left in place so a downgrade remains harmless.
 *
 *   - Fresh install: nothing present — mint a full starter set of ~8 keys, one
 *     per purpose, and pre-assign the NODE / AUTHOR / MODEL roles. This gives
 *     every feature a working key out of the box (networking, authoring, LLM
 *     ops, doors, external writers) without the user having to generate keys
 *     manually before anything works. The user can rename, restyle, add, or
 *     regenerate any of them freely via the Keys view.
 *
 *   - Existing keychain: no-op. We never clobber a user's keys.
 *
 * Idempotent: if a keychain already exists, this returns immediately.
 */
function seedIfEmpty(): void {
  const existing = localStorage.getItem(STORAGE_KEY);
  if (existing) {
    // Already initialized with at least one key — leave it alone. An empty
    // array or a corrupt blob falls through and reseeds: "always have a
    // signer" is a hard invariant (removeKey guards against emptying the list
    // through normal use; this repairs direct-storage tampering).
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed) && parsed.length > 0) return;
    } catch {
      // Corrupt blob — fall through and reseed.
    }
  }

  // --- Legacy migration: absorb the old single-key slot as the builtin key,
  //     and assign it to every role so existing behavior is unchanged. ---
  const legacy = localStorage.getItem(LEGACY_SECRET_KEY);
  if (legacy && /^[0-9a-fA-F]{64}$/.test(legacy)) {
    const alice = entryFromSecret(legacy, "alice", true);
    saveKeys([alice]);
    localStorage.setItem(AUTHOR_ROLE_KEY, alice.id);
    localStorage.setItem("zine.roles.inject", alice.id);
    localStorage.setItem(NODE_ROLE_KEY, alice.id);
    return;
  }

  // --- Fresh install: mint a full starter set. ---
  // The set covers every role the app uses, so nothing requires manual key
  // generation before it works. Labels name the purpose; the user can rename.
  const node = freshKey("node");          // owns the relay, derives the .onion
  const door1 = freshKey("door-1");       // extra .onion address
  const door2 = freshKey("door-2");       // extra .onion address
  const author1 = freshKey("author-1");   // primary writing voice
  const author2 = freshKey("author-2");   // second writing voice
  const model = freshKey("model");        // LLM ops (Extend/Settle/Stir/Reply)
  const external = freshKey("external");  // cited imports / federated text
  const spare = freshKey("spare");        // unused — add as door, voice, etc.

  const keys = [node, door1, door2, author1, author2, model, external, spare];
  saveKeys(keys);

  // Pre-assign the three roles so every feature works out of the box. The slot
  // strings keep their legacy pen/inject names so an upgrade preserves picks.
  localStorage.setItem(NODE_ROLE_KEY, node.id);
  localStorage.setItem(AUTHOR_ROLE_KEY, author1.id);
  localStorage.setItem("zine.roles.inject", model.id);
}

/** Read the persisted key list, seeding on first run. Also migrates any key
 *  whose identity was derived under an older (or absent) schema to the current
 *  deterministic identityFromPubkey form — the relay-config.ts normalize()
 *  pattern: a stored list never needs a manual migration step. */
export function loadKeys(): KeyEntry[] {
  seedIfEmpty();
  let raw: KeyEntry[] = [];
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) raw = JSON.parse(stored) as KeyEntry[];
  } catch {
    raw = [];
  }
  if (!Array.isArray(raw)) raw = [];
  // Re-derive identity for any key below the current schema. Pre-schema keys
  // carried a Math.random() identity that changed on every reseed — the source
  // of "my editor's background colors changed on reload" when zine.keys was
  // evicted/corrupt/private-mode. After migration the identity is a pure
  // function of the pubkey, so it's stable forever. The schemaVersion gate
  // means this runs once per existing key, then never again — a later manual
  // identity patch (patchKey) sets the field directly and isn't overridden
  // because it persists schemaVersion: IDENTITY_SCHEMA alongside it.
  let changed = false;
  const migrated = raw.map((k) => {
    if (k.schemaVersion === IDENTITY_SCHEMA) return k;
    changed = true;
    return { ...k, identity: identityFromPubkey(k.pubkey), schemaVersion: IDENTITY_SCHEMA };
  });
  if (changed) saveKeys(migrated);
  return migrated;
}

/** Persist the key list. (No builtin-reinsertion guard here — removeKey
 *  already refuses to empty the list, and seedIfEmpty repairs a wiped slot
 *  on the next load.) */
export function saveKeys(keys: KeyEntry[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
}

/** The id of the active key, or null. Falls back to the first key if unset. */
export function getActiveKeyId(): string | null {
  const id = localStorage.getItem(ACTIVE_KEY);
  if (id) return id;
  const keys = loadKeys();
  return keys[0]?.id ?? null;
}

/** Set the active key by id. */
export function setActiveKeyId(id: string | null): void {
  if (id === null) localStorage.removeItem(ACTIVE_KEY);
  else localStorage.setItem(ACTIVE_KEY, id);
}

/** The full active key entry, or null. */
export function getActiveKey(): KeyEntry | null {
  const id = getActiveKeyId();
  if (!id) return null;
  return loadKeys().find((k) => k.id === id) ?? null;
}

/**
 * The active key's pubkey — the voice name new text is attributed to. Matches
 * the pre-keychain role of `ACTIVE_VOICE = "alice"` (a stable string), but now
 * resolves to the active key's pubkey so editor runs and signing agree.
 *
 * @deprecated The "active key" is a hidden internal default with no UI surface.
 * The two user-facing key concepts are the **AUTHOR** key (the AUTHOR control,
 * `zine.roles.pen`, the default signer for Save/auto-save) and the **MODEL**
 * key (the MODEL control, `zine.roles.inject`, used by LLM ops). New code
 * should resolve to one of those via `getAuthorKey()`/`authorVoice()` or the
 * MODEL role, not this fallback.
 */
export function activeVoice(): string {
  return getActiveKey()?.pubkey ?? "alice";
}

/** localStorage key for the AUTHOR role. The string value `"zine.roles.pen"` is
 *  a stable storage name (not renamed to `zine.roles.author`) so an upgrade
 *  keeps the user's picked key without a migration step. */
const AUTHOR_ROLE_KEY = "zine.roles.pen";

/** The id of the AUTHOR key, or null. Defaults to the first keychain key when
 *  the role is unset or points at a deleted key — never to a separate "active"
 *  slot. This is the user's AUTHOR control and the default signer for every
 *  non-LLM seal. */
export function getAuthorKeyId(): string | null {
  const stored = localStorage.getItem(AUTHOR_ROLE_KEY);
  if (stored) {
    const keys = loadKeys();
    if (keys.some((k) => k.id === stored)) return stored;
  }
  return loadKeys()[0]?.id ?? null;
}

/** The full AUTHOR key entry, or null. */
export function getAuthorKey(): KeyEntry | null {
  const id = getAuthorKeyId();
  if (!id) return null;
  return loadKeys().find((k) => k.id === id) ?? null;
}

/** The AUTHOR key's pubkey — the default voice for new text and the signer for
 *  Save/auto-save/send. Replaces `activeVoice()` as the canonical "default
 *  signer" resolution now that the active key concept is retired. */
export function authorVoice(): string {
  return getAuthorKey()?.pubkey ?? "alice";
}

/** Set the AUTHOR key by id. Changing it means new text is signed by a
 *  different key — existing zines keep their original signatures. Callers
 *  should warn the user before reassigning (see KeysView's confirm modal). */
export function setAuthorKeyId(id: string): void {
  localStorage.setItem(AUTHOR_ROLE_KEY, id);
}

// --- MODEL role: the LLM-ops key ----------------------------------------

/** localStorage key for the MODEL role (legacy stable storage name). */
const MODEL_ROLE_KEY = "zine.roles.inject";

/** The id of the MODEL key, or null. Defaults to the first keychain key when
 *  unset or dangling — same fallback as AUTHOR/NODE. The MODEL key drives LLM
 *  ops (Extend/Settle/Stir/Reply); switching it is harmless (no provenance
 *  impact), so it needs no confirmation. */
export function getModelKeyId(): string | null {
  const stored = localStorage.getItem(MODEL_ROLE_KEY);
  if (stored) {
    const keys = loadKeys();
    if (keys.some((k) => k.id === stored)) return stored;
  }
  return loadKeys()[0]?.id ?? null;
}

/** Set the MODEL key by id. Safe to toggle freely — no warning needed. */
export function setModelKeyId(id: string): void {
  localStorage.setItem(MODEL_ROLE_KEY, id);
}

// --- NODE role: the per-machine identity --------------------------------
//
// Three roles share one keychain, each a different *purpose*:
//   - AUTHOR (`zine.roles.pen`)      signs the zines it writes
//   - MODEL  (`zine.roles.inject`)   drives LLM ops
//   - NODE   (`zine.roles.node`)     owns this machine's relay: derives the Tor
//                                    onion, is the `owner` in peers.json, and
//                                    signs the NIP-42 AUTH challenge that proves
//                                    ownership to the local relay. Set once per
//                                    install — it is your *address*, not a pen.
//
// The NODE role decouples the onion/AUTH identity (which must be stable so your
// address doesn't change and peers keep reaching you) from the AUTHOR role
// (which the user may switch freely while writing). Before this role existed,
// onauth and onion-key.ts both read loadOrCreateVoice() — the legacy single key
// — which silently diverged from the user's chosen keys the moment a non-builtin
// key was involved.

/** localStorage key for the NODE role. */
const NODE_ROLE_KEY = "zine.roles.node";

/** The id of the NODE key, or null. Defaults to the first keychain key when the
 *  role is unset or points at a deleted key — same fallback posture as AUTHOR.
 *  On a fresh install the builtin "alice" key (seeded from the legacy slot) is
 *  the node key, so existing onions/AUTH identities stay stable without a
 *  migration step. */
export function getNodeKeyId(): string | null {
  const stored = localStorage.getItem(NODE_ROLE_KEY);
  if (stored) {
    const keys = loadKeys();
    if (keys.some((k) => k.id === stored)) return stored;
  }
  return loadKeys()[0]?.id ?? null;
}

/** The full NODE key entry, or null. */
export function getNodeKey(): KeyEntry | null {
  const id = getNodeKeyId();
  if (!id) return null;
  return loadKeys().find((k) => k.id === id) ?? null;
}

/** The NODE key's pubkey — the machine's identity for relay ownership, networked
 *  mode, and the .onion address derivation. */
export function nodeVoice(): string {
  return getNodeKey()?.pubkey ?? "alice";
}

/** The NODE key's secret bytes — used to sign NIP-42 AUTH (proving ownership of
 *  the local relay) and to derive the Tor onion seed. Falls back to null only
 *  when the keychain is empty, which seedIfEmpty() prevents. */
export function nodeSecretKey(): Uint8Array | null {
  const entry = getNodeKey();
  return entry ? hexToBytes(entry.secretHex) : null;
}

/** Set the NODE key by id. Changing it means the machine's .onion address and
 *  AUTH identity change — callers should warn the user that peers must
 *  re-share the new address. */
export function setNodeKeyId(id: string): void {
  localStorage.setItem(NODE_ROLE_KEY, id);
}

/** Which roles a key currently holds. Used by the Keys view to render role
 *  chips on each card. `doorKeyIds` is the set of keyIds that are doors —
 *  passed in by the caller (KeysView) to avoid a keys-store → doors-store
 *  import cycle (doors-store imports keys-store for loadKeys). */
export function rolesForKey(
  keyId: string,
  doorKeyIds: Set<string>,
): { node: boolean; author: boolean; model: boolean; door: boolean } {
  return {
    node: getNodeKeyId() === keyId,
    author: getAuthorKeyId() === keyId,
    model: getModelKeyId() === keyId,
    door: doorKeyIds.has(keyId),
  };
}

/**
 * Look up the visual identity for a voice name (a run's `voice` field, which is
 * a pubkey for app-authored text). Returns null for unknown pubkeys (sampled /
 * federated text), so the editor falls back to the 6-color hash bucket.
 */
export function identityForVoice(voiceName: string): KeyIdentity | null {
  return loadKeys().find((k) => k.pubkey === voiceName)?.identity ?? null;
}

/** Session cache of resolved voice identities, keyed by pubkey. An absent
 *  declaration still resolves (to the hash fallback), so the cache always holds
 *  a concrete KeyIdentity and a pubkey is queried at most once per session. The
 *  Times view can name dozens of minter pubkeys; without this each re-render
 *  would re-fetch. */
const voiceIdentityCache = new Map<string, KeyIdentity>();

/** The network-aware identity resolver foreign readers use: for any pubkey,
 *  resolve its visual identity with the precedence
 *    (a) local keychain → the user's own key (their chosen identity, live)
 *    (b) published kind-34292 declaration on the relays → the author's chosen
 *        identity, carried on the network so foreign readers see real colors
 *    (c) identityFromPubkey → the deterministic hash fallback
 *  Cached per-session per-pubkey. This is the single resolution point for
 *  rendering an author's colors when all you have is their pubkey (e.g. the
 *  Times chart "color by voice" mode). Synchronous callers that only ever see
 *  the user's own keys (editor voice spans) keep using identityForVoice. */
export async function identityForPubkey(pubkey: string): Promise<KeyIdentity> {
  const cached = voiceIdentityCache.get(pubkey);
  if (cached !== undefined) return cached;
  const local = identityForVoice(pubkey);
  if (local) return local; // own key — live, no relay fetch, not cached (edits show)
  const published = await fetchVoiceIdentity(pubkey);
  if (!published) {
    const fallback = identityFromPubkey(pubkey);
    voiceIdentityCache.set(pubkey, fallback);
    return fallback;
  }
  voiceIdentityCache.set(pubkey, published);
  return published;
}

/** Bucket an unknown voice into one of six stable color slots (0–5). Used as
 *  the fallback when a run's voice isn't a known keychain key (sampled /
 *  federated text) so it still gets a deterministic color rather than none.
 *  Kept here so the editor and the preview derive the same bucket. */
export function hashVoice(voice: string): number {
  let h = 0;
  for (let i = 0; i < voice.length; i++) h = (h * 31 + voice.charCodeAt(i)) >>> 0;
  return h % 6;
}

/** Resolve a voice to the className (+ optional inline style) a colored span
 *  should carry. Known keychain keys get their generative identity (fg/bg +
 *  font) as an inline style; unknown pubkeys fall back to the 6-bucket hash
 *  class. Called by App.tsx's CodeMirror voice decorations — Markdown and
 *  Preview are the same editor doc (see modeFacet in brackets.ts), so a
 *  voice renders the same color in both modes for free. */
export function voiceSpanStyle(voice: string): { className: string; style?: string } {
  const id = identityForVoice(voice);
  if (id) {
    const { fg, bg } = identityColors(id, 0.13);
    return {
      className: "voice-span",
      style: `color:${fg};background:${bg};font-family:${id.font}`,
    };
  }
  return { className: `voice-span voice-${hashVoice(voice)}` };
}

/** The secret key bytes for a voice's pubkey, or null if no such key exists.
 *  Used by the per-voice Send/zine affordance to sign a trace as that voice
 *  rather than the active keychain key. */
export function secretKeyForVoice(pubkey: string): Uint8Array | null {
  const entry = loadKeys().find((k) => k.pubkey === pubkey);
  return entry ? hexToBytes(entry.secretHex) : null;
}

/** Generate a new keypair with a fresh identity and append it. Returns the new
 *  full list. New keys are never builtin. */
export function addKey(label: string): KeyEntry[] {
  const keys = loadKeys();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const entry: KeyEntry = {
    id: newId(),
    label: label || `Voice ${keys.length + 1}`,
    secretHex: bytesToHex(secretKey),
    pubkey,
    identity: identityFromPubkey(pubkey),
    schemaVersion: IDENTITY_SCHEMA,
    createdAt: Date.now(),
  };
  const next = [...keys, entry];
  saveKeys(next);
  return next;
}

/** Remove a key. The last remaining key can't be deleted (there must always be
 *  a signer) — surfaced as a no-op here and a disabled button in the UI. If the
 *  removed key was selected for any role (AUTHOR, MODEL, or NODE), repoint that
 *  role at the first remaining key so none ever dangles.
 *  Returns the new full list. */
export function removeKey(id: string): KeyEntry[] {
  const keys = loadKeys();
  if (keys.length <= 1) return keys; // never empty the keychain
  const next = keys.filter((k) => k.id !== id);
  saveKeys(next);
  const fallback = next[0]?.id ?? null;
  // Reassign any role that pointed at the deleted key. The legacy
  // `zine.keys.active` slot is also repointed for backward-compat with any
  // reader that hasn't migrated yet (harmless — it's no longer seeded).
  if (getActiveKeyId() === id) setActiveKeyId(fallback);
  // The slot strings keep their legacy pen/inject names (stable storage keys);
  // they're the AUTHOR and MODEL roles respectively. NODE is the relay-owning
  // identity.
  for (const slot of ["zine.roles.pen", "zine.roles.inject", "zine.roles.node"]) {
    if (localStorage.getItem(slot) === id && fallback) {
      localStorage.setItem(slot, fallback);
    }
  }
  return next;
}

/** Patch a key's editable fields (label, identity). Never id/secret/pubkey.
 *  Persists immediately. Returns the new full list. */
export function patchKey(
  id: string,
  patch: Partial<Pick<KeyEntry, "label" | "identity">>,
): KeyEntry[] {
  const keys = loadKeys();
  const next = keys.map((k) => (k.id === id ? { ...k, ...patch } : k));
  saveKeys(next);
  return next;
}

// --- hex helpers (duplicated from identity.ts to keep this module importable
//     before identity.ts is rewired to depend on it) ------------------------

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
