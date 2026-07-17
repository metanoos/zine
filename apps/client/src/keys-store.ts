/**
 * Nostr keypair keychain — the set of voices the user can sign and attribute
 * text with. Promotes the `keys` nav entry from placeholder to a real view,
 * following the `models-store.ts` / `relay-config.ts` precedent: a
 * localStorage-backed list with role ids and at least one entry.
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
 * SECURITY POSTURE: this module persists only public profiles. `secretRef` is
 * an opaque handle into the unlocked SecretStore session; raw signing bytes
 * never enter the JSON profile written to localStorage.
 */

import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { fetchVoiceIdentity } from "./provenance.js";
import {
  canSignWithSecrets,
  deleteSecret,
  getSecretCached,
  putSecret,
  putSecrets,
} from "./secret-store.js";

export interface KeyIdentity {
  /** CSS font-family value (e.g. `"Newsreader", serif`). */
  font: string;
  /** 0–360. Generated to avoid the gold band so voices stay off the accent. */
  hue: number;
  /** 0–100. Muted-to-medium so the swatch and runs stay readable. */
  sat: number;
}

export interface KeyEntry {
  /** Stable id so edits survive reordering. */
  id: string;
  label: string;
  /** Opaque reference to the 32-byte signing secret in SecretStore. */
  secretRef: string;
  /** Derived npub-less hex pubkey (32 bytes → 64 hex chars). */
  pubkey: string;
  identity: KeyIdentity;
  createdAt: number;
  /** Identity-derivation schema for rejecting unsupported stored profiles. */
  schemaVersion: number;
}

const STORAGE_KEY = "zine.keys";
/** Current identity-derivation schema. */
const IDENTITY_SCHEMA = 1;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;

function isCurrentKeyEntry(value: unknown): value is KeyEntry {
  if (!value || typeof value !== "object") return false;
  const key = value as Partial<KeyEntry>;
  return (
    key.schemaVersion === IDENTITY_SCHEMA &&
    typeof key.id === "string" &&
    key.id.length > 0 &&
    typeof key.label === "string" &&
    typeof key.secretRef === "string" &&
    key.secretRef.length > 0 &&
    typeof key.pubkey === "string" &&
    HEX_PUBKEY.test(key.pubkey) &&
    sanitizeVoiceIdentity(key.identity ?? null) !== null &&
    typeof key.createdAt === "number" &&
    Number.isFinite(key.createdAt)
  );
}

export function keySecretRef(id: string): string {
  return `nostr:key:${id}`;
}

function stageKeySecret(ref: string, secret: Uint8Array): void {
  void putSecret(ref, secret).catch((error) => {
    console.error(`[keys] could not persist ${ref}:`, error);
  });
}

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
 * Fresh-install palette, defined as a ROYGBIV-like sweep. The app's gold
 * accent owns hues 25–55, so orange and yellow sit just outside that band while
 * retaining the warm-to-cool progression. Fresh installs shuffle these styles
 * before assigning them, so semantic roles do not always inherit one color.
 */
export const DEFAULT_VOICE_PALETTE: KeyIdentity[] = [
  { font: fontCss(KEYCHAIN_FONTS[0]), hue: 355, sat: 58 },
  { font: fontCss(KEYCHAIN_FONTS[1]), hue: 18, sat: 56 },
  { font: fontCss(KEYCHAIN_FONTS[5]), hue: 62, sat: 50 },
  { font: fontCss(KEYCHAIN_FONTS[3]), hue: 125, sat: 52 },
  { font: fontCss(KEYCHAIN_FONTS[6]), hue: 215, sat: 55 },
  { font: fontCss(KEYCHAIN_FONTS[7]), hue: 250, sat: 54 },
  { font: fontCss(KEYCHAIN_FONTS[2]), hue: 285, sat: 52 },
];

/** Return a fresh Fisher–Yates permutation without mutating the source palette. */
export function shuffledDefaultVoicePalette(random: () => number = Math.random): KeyIdentity[] {
  const identities = DEFAULT_VOICE_PALETTE.map((identity) => ({ ...identity }));
  for (let i = identities.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [identities[i], identities[j]] = [identities[j], identities[i]];
  }
  return identities;
}

const SAFE_VOICE_FONTS = new Set(KEYCHAIN_FONTS.map((font) => fontCss(font)));

/**
 * Validate a visual identity received from a relay before it reaches an inline
 * style attribute. Relay events are signed, but their content is still
 * untrusted CSS input: restricting fonts to the app's curated pool and numeric
 * channels to their declared ranges prevents a crafted declaration from
 * appending arbitrary properties to `font-family`.
 */
export function sanitizeVoiceIdentity(identity: KeyIdentity | null): KeyIdentity | null {
  if (
    !identity ||
    !SAFE_VOICE_FONTS.has(identity.font) ||
    !Number.isFinite(identity.hue) ||
    identity.hue < 0 ||
    identity.hue > 360 ||
    !Number.isFinite(identity.sat) ||
    identity.sat < 0 ||
    identity.sat > 100
  ) {
    return null;
  }
  return identity;
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
  const secret = getSecretCached(k.secretRef);
  if (!secret) throw new Error(`Private key unavailable for ${k.label}`);
  return nsecEncode(secret);
}

/** Resolve raw hex only for an explicit, confirmed export gesture. */
export function keySecretHex(k: KeyEntry): string {
  const secret = getSecretCached(k.secretRef);
  if (!secret) throw new Error(`Private key unavailable for ${k.label}`);
  return bytesToHex(secret);
}

function newId(): string {
  return `k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Pick the next neutral voice label without counting infrastructure keys.
 * Labels describe an identity; NODE / AUTHOR / MODEL / DOOR describe roles
 * that identity can hold and therefore should not leak into its name. */
function nextVoiceLabel(keys: KeyEntry[]): string {
  const highest = keys.reduce((max, key) => {
    const match = /^voice-(\d+)$/i.exec(key.label.trim());
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `voice-${highest + 1}`;
}

function entryFromSecret(
  secretHex: string,
  label: string,
  identity?: KeyIdentity,
): KeyEntry {
  const secretKey = hexToBytes(secretHex);
  const pubkey = getPublicKey(secretKey);
  const id = newId();
  const secretRef = keySecretRef(id);
  stageKeySecret(secretRef, secretKey);
  return {
    id,
    label,
    secretRef,
    pubkey,
    identity: identity ?? identityFromPubkey(pubkey),
    schemaVersion: IDENTITY_SCHEMA,
    createdAt: Date.now(),
  };
}

/** Generate a fresh keypair entry with a given label. */
function freshKey(label: string, identity?: KeyIdentity): KeyEntry {
  return entryFromSecret(bytesToHex(generateSecretKey()), label, identity);
}

/**
 * Ensure the keychain is seeded. On a fresh install, mint AUTHOR, MODEL, NODE,
 * EXTERNAL, and three spare voices. The spares complete the starter color
 * spectrum and give system starter text a voice distinct from both AUTHOR and
 * MODEL. Doors are created only when requested. The user can rename, restyle,
 * add, or regenerate any identity freely via the Keys view.
 *
 * An existing keychain is never clobbered. Idempotent: if a keychain already
 * exists, this returns immediately.
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
      if (Array.isArray(parsed) && parsed.length > 0 && parsed.every(isCurrentKeyEntry)) return;
    } catch {
      // Corrupt blob — fall through and reseed.
    }
  }

  // Hosted/browser builds are readers until they have an encrypted vault.
  // Never manufacture a plaintext identity merely because a reader view asks
  // for the public key list.
  if (!canSignWithSecrets()) return;

  // Mint the operational identities + three spare voices.
  // The ordinary identities retain neutral labels because roles are freely
  // reassignable. NODE owns the relay; EXTERNAL signs filesystem scans. Doors
  // are absent until the user deliberately opens one. Styles are shuffled once
  // per profile; list order remains voices first, then infrastructure identities.
  const palette = shuffledDefaultVoicePalette();
  const voice1 = freshKey("voice-1", palette[0]);
  const voice2 = freshKey("voice-2", palette[1]);
  const voice3 = freshKey("voice-3", palette[2]);
  const voice4 = freshKey("voice-4", palette[3]);
  const voice5 = freshKey("voice-5", palette[4]);
  const node = freshKey("node-1", palette[5]);
  const external = freshKey("external-1", palette[6]);

  const keys = [voice1, voice2, voice3, voice4, voice5, node, external];
  saveKeys(keys);

  // Pre-assign the three roles so every feature works out of the box.
  localStorage.setItem(NODE_ROLE_KEY, node.id);
  localStorage.setItem(AUTHOR_ROLE_KEY, voice1.id);
  localStorage.setItem(MODEL_ROLE_KEY, voice3.id);
}

/** Read the persisted key list, seeding on first run. Unsupported profile
 * schemas are rejected instead of rewritten in place. */
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
  return raw.filter(isCurrentKeyEntry);
}

/** Persist only the current public profile shape. */
export function saveKeys(keys: KeyEntry[]): void {
  const publicProfiles = keys.map((key) => ({
    id: key.id,
    label: key.label,
    secretRef: key.secretRef,
    pubkey: key.pubkey,
    identity: key.identity,
    createdAt: key.createdAt,
    schemaVersion: key.schemaVersion,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(publicProfiles));
}

/**
 * Desktop bootstrap invariant: every persisted profile resolves from the
 * already-unlocked vault, or a fresh profile set is durably created before App
 * renders.
 */
export async function initializeKeyStoreForAuthoring(): Promise<KeyEntry[]> {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed) && parsed.length > 0) {
      if (!parsed.every(isCurrentKeyEntry)) {
        throw new Error("Unsupported key profile schema; factory reset is required");
      }
      for (const key of parsed) {
        if (!key.secretRef || !getSecretCached(key.secretRef)) {
          throw new Error(`Secure key material is unavailable for ${key.label || key.id}`);
        }
      }
      return loadKeys();
    }
  }

  const palette = shuffledDefaultVoicePalette();
  const specs: Array<[string, KeyIdentity]> = [
    ["voice-1", palette[0]],
    ["voice-2", palette[1]],
    ["voice-3", palette[2]],
    ["voice-4", palette[3]],
    ["voice-5", palette[4]],
    ["node-1", palette[5]],
    ["external-1", palette[6]],
  ];
  const profiles: KeyEntry[] = [];
  const secrets: Array<readonly [string, Uint8Array]> = [];
  for (const [label, identity] of specs) {
    const secret = generateSecretKey();
    const pubkey = getPublicKey(secret);
    const id = newId();
    const secretRef = keySecretRef(id);
    secrets.push([secretRef, secret]);
    profiles.push({
      id,
      label,
      secretRef,
      pubkey,
      identity,
      schemaVersion: IDENTITY_SCHEMA,
      createdAt: Date.now(),
    });
  }
  try {
    await putSecrets(secrets);
  } finally {
    for (const [, secret] of secrets) secret.fill(0);
  }
  saveKeys(profiles);
  const node = profiles.find((key) => key.label === "node-1")!;
  localStorage.setItem(NODE_ROLE_KEY, node.id);
  localStorage.setItem(AUTHOR_ROLE_KEY, profiles[0].id);
  localStorage.setItem(MODEL_ROLE_KEY, profiles[2].id);
  return profiles;
}

const AUTHOR_ROLE_KEY = "zine.roles.author";

/** The id of the AUTHOR key, or null. Defaults to the first keychain key when
 *  the role is unset or points at a deleted key — never to a separate "active"
 *  slot. This is the user's AUTHOR control and the default signer for every
 *  non-LLM step. */
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
 *  Save/auto-save/send. */
export function authorVoice(): string {
  return getAuthorKey()?.pubkey ?? "voice-1";
}

/** Set the AUTHOR key by id. Changing it means new text is signed by a
 *  different key — existing zines keep their original signatures. Callers
 *  should warn the user before reassigning (see KeysView's confirm modal). */
export function setAuthorKeyId(id: string): void {
  localStorage.setItem(AUTHOR_ROLE_KEY, id);
}

// --- MODEL role: the LLM-ops key ----------------------------------------

const MODEL_ROLE_KEY = "zine.roles.model";

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
//   - AUTHOR (`zine.roles.author`)   signs the zines it writes
//   - MODEL  (`zine.roles.model`)    drives LLM ops
//   - NODE   (`zine.roles.node`)     owns this machine's relay: derives the Tor
//                                    onion, is the `owner` in peers.json, and
//                                    signs the NIP-42 AUTH challenge that proves
//                                    ownership to the local relay. Set once per
//                                    install — it is your *address*, not a pen.
//
// The NODE role decouples the onion/AUTH identity (which must be stable so your
// address doesn't change and peers keep reaching you) from the AUTHOR role
// (which the user may switch freely while writing).

/** localStorage key for the NODE role. */
const NODE_ROLE_KEY = "zine.roles.node";

/** The id of the NODE key, or null. Defaults to the first keychain key when the
 *  role is unset or points at a deleted key — same fallback posture as AUTHOR. */
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
  return getNodeKey()?.pubkey ?? "node-1";
}

/** The NODE key's secret bytes — used to sign NIP-42 AUTH (proving ownership of
 *  the local relay) and to derive the Tor onion seed. Falls back to null only
 *  when the keychain is empty, which seedIfEmpty() prevents. */
export function nodeSecretKey(): Uint8Array | null {
  const entry = getNodeKey();
  return entry ? getSecretCached(entry.secretRef) : null;
}

export function authorSecretKey(): Uint8Array | null {
  const entry = getAuthorKey();
  return entry ? getSecretCached(entry.secretRef) : null;
}

export function modelSecretKey(): Uint8Array | null {
  const id = getModelKeyId();
  const entry = id ? loadKeys().find((key) => key.id === id) : null;
  return entry ? getSecretCached(entry.secretRef) : null;
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
 * federated text); reader surfaces then use the resolved/published identity or
 * a deterministic per-pubkey fallback.
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
const voiceIdentityPending = new Map<string, Promise<KeyIdentity>>();
type VoiceIdentityListener = (pubkey: string) => void;
const voiceIdentityListeners = new Set<VoiceIdentityListener>();

/** Subscribe reader surfaces that need to repaint when a remote identity
 * finishes resolving. Returns the usual unsubscribe function. */
export function subscribeVoiceIdentities(listener: VoiceIdentityListener): () => void {
  voiceIdentityListeners.add(listener);
  return () => voiceIdentityListeners.delete(listener);
}

function cacheVoiceIdentity(pubkey: string, identity: KeyIdentity): KeyIdentity {
  voiceIdentityCache.set(pubkey, identity);
  for (const listener of voiceIdentityListeners) listener(pubkey);
  return identity;
}

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
  const pending = voiceIdentityPending.get(pubkey);
  if (pending) return pending;
  const request = (async () => {
    let published: KeyIdentity | null = null;
    try {
      published = await fetchVoiceIdentity(pubkey);
    } catch {
      // Identity is optional reader metadata. A relay failure must degrade to
      // the deterministic style rather than reject the document render.
    }
    const safePublished = sanitizeVoiceIdentity(published);
    return cacheVoiceIdentity(pubkey, safePublished ?? identityFromPubkey(pubkey));
  })();
  voiceIdentityPending.set(pubkey, request);
  try {
    return await request;
  } finally {
    voiceIdentityPending.delete(pubkey);
  }
}

/** Synchronous identity used by document text and its legend. It never leaves
 * a foreign voice unstyled: local key → resolved remote declaration → stable
 * per-pubkey fallback. An async identityForPubkey() call may later populate
 * the cache and notify subscribers to repaint with the author's declaration. */
export function identityForDisplayVoice(pubkey: string): KeyIdentity {
  return identityForVoice(pubkey) ?? voiceIdentityCache.get(pubkey) ?? identityFromPubkey(pubkey);
}

/** Resolve a voice to the className + inline style a colored span should
 * carry. Every pubkey receives a full font/hue identity, including foreign
 * voices, so two authors are no longer forced through the old six-color
 * collision bucket. Called by CodeMirror and the document legend; Markdown
 * and Preview therefore render the same voice identically. */
export function voiceSpanStyle(voice: string): { className: string; style?: string } {
  const id = identityForDisplayVoice(voice);
  const { fg, bg } = identityColors(id, 0.13);
  return {
    className: "voice-span",
    style: `color:${fg};background:${bg};font-family:${id.font}`,
  };
}

/** The secret key bytes for a voice's pubkey, or null if no such key exists.
 *  Used by the per-voice Send/zine affordance to sign a trace as that voice
 *  rather than the active keychain key. */
export function secretKeyForVoice(pubkey: string): Uint8Array | null {
  const entry = loadKeys().find((k) => k.pubkey === pubkey);
  return entry ? getSecretCached(entry.secretRef) : null;
}

/** Generate a new keypair with a fresh identity and append it. An omitted label
 *  continues the neutral `voice-N` sequence. Returns the new full list. */
export async function addKey(label?: string): Promise<KeyEntry[]> {
  const keys = loadKeys();
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const id = newId();
  const secretRef = keySecretRef(id);
  const entry: KeyEntry = {
    id,
    label: label || nextVoiceLabel(keys),
    secretRef,
    pubkey,
    identity: identityFromPubkey(pubkey),
    schemaVersion: IDENTITY_SCHEMA,
    createdAt: Date.now(),
  };
  const next = [...keys, entry];
  try {
    await putSecret(secretRef, secretKey);
    try {
      saveKeys(next);
    } catch (error) {
      await deleteSecret(secretRef);
      throw error;
    }
    return next;
  } finally {
    secretKey.fill(0);
  }
}

/** Remove a key. The last remaining key can't be deleted (there must always be
 *  a signer) — surfaced as a no-op here and a disabled button in the UI. If the
 *  removed key was selected for any role (AUTHOR, MODEL, or NODE), repoint that
 *  role at the first remaining key so none ever dangles.
 *  Returns the new full list. */
export function removeKey(id: string): KeyEntry[] {
  const keys = loadKeys();
  if (keys.length <= 1) return keys; // never empty the keychain
  const removed = keys.find((key) => key.id === id);
  const next = keys.filter((k) => k.id !== id);
  saveKeys(next);
  if (removed) {
    void deleteSecret(removed.secretRef).catch((error) => {
      console.error(`[keys] could not delete ${removed.secretRef}:`, error);
    });
  }
  const fallback = next[0]?.id ?? null;
  // Reassign any role that pointed at the deleted key.
  for (const slot of [AUTHOR_ROLE_KEY, MODEL_ROLE_KEY, NODE_ROLE_KEY]) {
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
  const changed = next.find((key) => key.id === id);
  if (changed) {
    for (const listener of voiceIdentityListeners) listener(changed.pubkey);
  }
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
