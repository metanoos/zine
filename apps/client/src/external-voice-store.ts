/**
 * External-actor voice registry. Each external actor that writes to a traced
 * folder gets its own voice — a distinct keypair in the standard keychain
 * (`keys-store.ts`) — so the bytes it produced are signed by *its* key, never
 * the authoring key. The authoring key signs only changes the editor's own
 * transactions produced; an external process moving the machine's state is a
 * different speaker (§3.4 `external`, §8 "External write (file)").
 *
 * Two entry points:
 *
 *   - `getReconcilerVoice()` — the distinguished per-machine voice for bare
 *     disk drift (files changed while the app was closed, or by any process
 *     the app can't identify). One per machine, persisted, reused forever.
 *
 *   - `getMcpActorVoice(server, tool, model)` — the entry point for MCP tool
 *     write-back (future integration). Actor identity is the (server, tool,
 *     model) triple; each distinct triple gets its own voice, reused on every
 *     subsequent call. Per-actor distinction is carried by the signer pubkey,
 *     not the `action` tag — `external` is the one action, the key is the actor.
 *
 * Auto-provisioning is silent: first call for a new actor mints a keypair via
 * `addKey(label)` and records the binding; later calls look it up. Keys live in
 * the standard keychain, so they appear in KeysView and get a generative visual
 * identity (font + hue) for free — external edits render with their own color,
 * distinguishing them from authored edits at a glance.
 *
 * Like `voice-provider-store.ts` this is workflow state, not provenance: which
 * key speaks for a given actor on this machine is local setup and doesn't sync
 * to the relay manifest. The *consequence* (a node signed by a particular
 * pubkey) is what's durable; the binding that chose it is not.
 */

import { addKey, secretKeyForVoice } from "./keys-store.js";

export interface ExternalVoice {
  secretKey: Uint8Array;
  publicKey: string;
}

const RECONCILER_KEY = "zine.external.reconciler";
const MCP_ACTORS_KEY = "zine.external.mcp.actors";
const SUBSTRATE_KEY = "zine.external.substrates";

interface McpActorBinding {
  server: string;
  tool: string;
  model: string;
  pubkey: string;
}

interface SubstrateBinding {
  name: string;
  pubkey: string;
}

/** Provision a fresh voice with `label`, returning its key material. `addKey`
 *  appends to the keychain and returns the full list; the new entry is last. */
function provisionVoice(label: string): ExternalVoice {
  const keys = addKey(label);
  const entry = keys[keys.length - 1];
  const secretKey = secretKeyForVoice(entry.pubkey);
  if (!secretKey) {
    // Should be unreachable — we just added it — but fail loudly rather than
    // silently fall back to the authoring key, which would reintroduce the lie.
    throw new Error(`external-voice-store: provisioned key "${label}" not found`);
  }
  return { secretKey, publicKey: entry.pubkey };
}

/** Resolve a stored pubkey to key material, or null if the key was deleted from
 *  the keychain since the binding was recorded (re-provision on null). */
function resolvePubkey(pubkey: string): ExternalVoice | null {
  const secretKey = secretKeyForVoice(pubkey);
  return secretKey ? { secretKey, publicKey: pubkey } : null;
}

/** The per-machine reconciler voice for bare disk drift. Auto-provisions on
 *  first call, persists the pubkey, reuses forever after. */
export function getReconcilerVoice(): ExternalVoice {
  const stored = localStorage.getItem(RECONCILER_KEY);
  if (stored) {
  const voice = resolvePubkey(stored);
    if (voice) return voice;
    // Key was deleted from the keychain — fall through and re-provision.
  }
  const voice = provisionVoice("Disk reconciler");
  localStorage.setItem(RECONCILER_KEY, voice.publicKey);
  return voice;
}

function loadMcpActors(): McpActorBinding[] {
  try {
    const stored = localStorage.getItem(MCP_ACTORS_KEY);
    if (stored) return JSON.parse(stored) as McpActorBinding[];
  } catch {
    /* corrupt blob — treat as empty */
  }
  return [];
}

function saveMcpActors(actors: McpActorBinding[]): void {
  localStorage.setItem(MCP_ACTORS_KEY, JSON.stringify(actors));
}

/** The voice for a given MCP actor (server + tool + model). Auto-provisions on
 *  first call for a new triple, reuses on subsequent calls. Distinct triples
 *  get distinct keys so each MCP caller is its own author on the chain.
 *
 *  Not called today — MCP integration is not yet wired. This is the seam: when
 *  an MCP tool's write-back lands, it calls this and passes the result as the
 *  `signer` (+ `action: "external"`) into the write path. */
export function getMcpActorVoice(server: string, tool: string, model: string): ExternalVoice {
  const actors = loadMcpActors();
  const match = actors.find(
    (a) => a.server === server && a.tool === tool && a.model === model,
  );
  if (match) {
    const voice = resolvePubkey(match.pubkey);
    if (voice) return voice;
    // Key deleted — drop the stale binding and re-provision below.
  }
  // Label uses middle-dot separators; empty model collapses to "server · tool".
  const parts = [server, tool, model].filter((p) => p && p.length > 0);
  const voice = provisionVoice(parts.join(" · "));
  if (match) {
    match.pubkey = voice.publicKey;
  } else {
    actors.push({ server, tool, model, pubkey: voice.publicKey });
  }
  saveMcpActors(actors);
  return voice;
}

function loadSubstrates(): SubstrateBinding[] {
  try {
    const stored = localStorage.getItem(SUBSTRATE_KEY);
    if (stored) return JSON.parse(stored) as SubstrateBinding[];
  } catch {
    /* corrupt blob — treat as empty */
  }
  return [];
}

function saveSubstrates(substrates: SubstrateBinding[]): void {
  localStorage.setItem(SUBSTRATE_KEY, JSON.stringify(substrates));
}

/** The voice for a named substrate (FILESYSTEM/LAPTOP/DESKTOP/EXTERNAL, or any
 *  future substrate the scan/reify bar cycles to). Auto-provisions on first call
 *  for a new name, reuses on subsequent calls. The substrate is a peer with a
 *  voice: content scanned in from it is signed by *its* key, never the
 *  authoring key — so a trace's provenance shows who actually contributed it,
 *  whether that's a mesh peer or the local disk.
 *
 *  Same shape as getReconcilerVoice/getMcpActorVoice: workflow state, not
 *  provenance (the binding is local setup; the signed node is what's durable). */
export function getSubstrateVoice(name: string): ExternalVoice {
  const substrates = loadSubstrates();
  const match = substrates.find((s) => s.name === name);
  if (match) {
    const voice = resolvePubkey(match.pubkey);
    if (voice) return voice;
    // Key deleted — drop the stale binding and re-provision below.
  }
  const voice = provisionVoice(`Substrate · ${name}`);
  if (match) {
    match.pubkey = voice.publicKey;
  } else {
    substrates.push({ name, pubkey: voice.publicKey });
  }
  saveSubstrates(substrates);
  return voice;
}
