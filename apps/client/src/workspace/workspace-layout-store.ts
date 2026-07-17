/**
 * Per-press (per-folder) workspace layout: which tabs are open in which panels,
 * which panel is focused, the per-tab Preview/Markdown surface, and the column
 * width weights. Restored on attach so the editor reopens exactly where the
 * user left it after a reload.
 *
 * This is a LOCAL workflow preference, not provenance — which file is pinned
 * where on screen is a property of that machine's UI session, not something to
 * sync to the relay manifest. So it lives in localStorage, keyed by folder id,
 * the same posture as the voice stores. Tab paths are
 * folder-relative (the same keys local-store.ts uses), so they stay meaningful
 * when restored against the same folder. Paths that no longer exist on disk /
 * relay are pruned at restore time in openScanned rather than here.
 *
 * STORAGE_KEY holds a JSON `{ [folderId]: WorkspaceLayout }` object, with thin
 * load/save helpers. A corrupt or shape-mismatched blob is treated as empty
 * (non-fatal), so a bad entry never blocks boot.
 */

const STORAGE_KEY = "zine.workspace.layout";

// Self-contained structural types (no import from App.tsx) to avoid a cycle:
// App imports this store, so this module can't import PanelState from App.
export interface StoredPanel {
  tabs: string[];
  active: string;
}

export interface WorkspaceLayout {
  panels: StoredPanel[];
  // The per-tab surface (preview | markdown | diff). Kept as a literal union
  // rather than importing Mode from brackets.ts to avoid a module cycle (App
  // imports this store). The values are stored verbatim, so a newly added
  // surface round-trips directly.
  tabModes: Record<string, "preview" | "markdown" | "diff">;
  activePanel: number;
  panelWeights: number[];
}

type LayoutMap = Record<string, WorkspaceLayout>;

function isPanel(v: unknown): v is StoredPanel {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    Array.isArray(p.tabs) && p.tabs.every((t) => typeof t === "string") &&
    typeof p.active === "string"
  );
}

// Defensive parse: only accept entries that match the expected shape. Anything
// malformed (renamed field, half-written blob, an unrelated value left under
// this key by an old build) is dropped rather than crashing the restore path.
function loadMap(): LayoutMap {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: LayoutMap = {};
    for (const [id, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const v = val as Record<string, unknown>;
      if (!Array.isArray(v.panels) || !v.panels.every(isPanel)) continue;
      if (v.tabModes !== undefined && (typeof v.tabModes !== "object" || Array.isArray(v.tabModes))) continue;
      if (v.activePanel !== undefined && typeof v.activePanel !== "number") continue;
      if (v.panelWeights !== undefined && !Array.isArray(v.panelWeights)) continue;
      out[id] = {
        panels: v.panels as StoredPanel[],
        tabModes: (v.tabModes ?? {}) as Record<string, "preview" | "markdown" | "diff">,
        activePanel: typeof v.activePanel === "number" ? v.activePanel : 0,
        panelWeights: Array.isArray(v.panelWeights) ? (v.panelWeights as number[]) : [],
      };
    }
    return out;
  } catch {
    /* corrupt blob — treat as empty */
  }
  return {};
}

// Best-effort: private mode / quota exceeded must not crash the editor. Writes
// are idempotent and self-healing — the next successful write replaces this one.
function saveMap(map: LayoutMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable or full — skip; layout just won't persist this session */
  }
}

/** The saved layout for a folder, or null if none (fresh folder / corrupt entry). */
export function loadWorkspaceLayout(folderId: string): WorkspaceLayout | null {
  return loadMap()[folderId] ?? null;
}

/** Persist a folder's layout. Overwrites any prior layout for that folder. */
export function saveWorkspaceLayout(folderId: string, layout: WorkspaceLayout): void {
  const map = loadMap();
  map[folderId] = layout;
  saveMap(map);
}
