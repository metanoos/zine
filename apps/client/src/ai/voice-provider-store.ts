import { vaultStorage as localStorage } from "../storage/vault-storage.js";

/**
 * Per-voice model selection. Maps a voice's pubkey to a provider id
 * (`ProviderConfig.id` from models-store). This is what Press → MODEL's
 * model dropdown writes — the sole assignment for which provider Append /
 * Settle / Stir / Reply run against.
 *
 * Models view only catalogs providers (credentials + endpoints); it does not
 * designate an "active" one. When a voice has no pin (or a dangling id after
 * a provider was deleted), callers fall back to the first configured provider.
 *
 * Like other local workflow prefs this is not provenance. Which provider a
 * given machine composes against is a property of that machine's setup (API
 * keys, network) and shouldn't sync to the relay manifest. So it lives in
 * localStorage, keyed by pubkey.
 */

const STORAGE_KEY = "zine.voice.provider";

type VoiceProviderMap = Record<string, string>;

function loadMap(): VoiceProviderMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as VoiceProviderMap;
  } catch {
    /* corrupt blob — treat as empty */
  }
  return {};
}

function saveMap(map: VoiceProviderMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** The provider id pinned to a voice, or null if unset. */
export function getVoiceProvider(pubkey: string): string | null {
  return loadMap()[pubkey] ?? null;
}

/** Pin a provider to a voice. Empty/null clears it (caller falls back to the
 *  first configured provider). */
export function setVoiceProvider(pubkey: string, providerId: string | null): void {
  const map = loadMap();
  if (providerId) map[pubkey] = providerId;
  else delete map[pubkey];
  saveMap(map);
}
