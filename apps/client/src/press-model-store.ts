/**
 * @deprecated Unused. Model selection for LLM ops lives solely on Press →
 * MODEL via voice-provider-store. Kept only so any stale `zine.press.model`
 * localStorage blob from earlier builds is ignored rather than migrated.
 *
 * Previously mapped folder id → provider id as a per-press pin that fell back
 * to a global "active" provider in Models. Both that pin path and the active
 * designation were removed in favor of the single MODEL model select.
 */

const STORAGE_KEY = "zine.press.model";

type PressModelMap = Record<string, string>;

function loadMap(): PressModelMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored) as PressModelMap;
  } catch {
    /* corrupt blob — treat as empty */
  }
  return {};
}

function saveMap(map: PressModelMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

/** @deprecated Prefer voice-provider-store / MODEL model select. */
export function getPressModelId(folderId: string): string | null {
  return loadMap()[folderId] ?? null;
}

/** @deprecated Prefer voice-provider-store / MODEL model select. */
export function setPressModelId(folderId: string, providerId: string | null): void {
  const map = loadMap();
  if (providerId) map[folderId] = providerId;
  else delete map[folderId];
  saveMap(map);
}
