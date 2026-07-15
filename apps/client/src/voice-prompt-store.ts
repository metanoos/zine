/**
 * Per-voice custom prompt. Maps a voice's pubkey to a free-text instruction
 * that gets injected into that voice's LLM ops (Extend/Settle/Stir/Reply) —
 * e.g. "write in terse, clinical prose" or "always cite the trace verbatim".
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
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** The custom prompt for a voice, or "" if unset. */
export function getVoicePrompt(pubkey: string): string {
  return loadMap()[pubkey] ?? "";
}

/** Set the custom prompt for a voice. Empty string clears it. */
export function setVoicePrompt(pubkey: string, prompt: string): void {
  const map = loadMap();
  if (prompt) map[pubkey] = prompt;
  else delete map[pubkey];
  saveMap(map);
}
