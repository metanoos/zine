/**
 * Per-voice custom prompt. Maps a voice's pubkey to a free-text instruction
 * that gets injected into that voice's single-shot LLM ops —
 * e.g. "write in terse, clinical prose" or "favor short declarative sentences".
 *
 * A LOCAL workflow preference, not provenance (a prompt is a machine-local
 * authoring aid, not something to sync to the relay). localStorage, keyed by
 * pubkey. Empty/missing means "no custom prompt" — the op's built-in system
 * prompt runs unmodified.
 *
 * Mirrors the localStorage-map posture of the other *-store.ts modules.
 */

const STORAGE_KEY = "zine.voice.prompt";

type VoicePromptMap = Record<string, string>;

function loadMap(): VoicePromptMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as VoicePromptMap;
  } catch {
    /* corrupt blob — treat as empty */
  }
  return {};
}

function saveMap(map: VoicePromptMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — the caller's controlled input still stays live */
  }
}

/** The custom prompt for a voice, or "" if unset. */
export function getVoicePrompt(pubkey: string): string {
  return loadMap()[pubkey] ?? "";
}

/** Set a voice's cross-operation style preference. Blank text clears it. */
export function setVoicePrompt(pubkey: string, prompt: string): void {
  const map = loadMap();
  const normalized = prompt.trim();
  if (normalized) map[pubkey] = normalized;
  else delete map[pubkey];
  saveMap(map);
}
