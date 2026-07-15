/**
 * Folder-orchestration replay view: a chronological stream of every delta on
 * the folder's own chain — membership add/remove/rename plus focus mount/
 * unmount — so you can replay not just the actions *within* files but the
 * orchestration of files at the folder level: which traces entered/left, which
 * were renamed, which were mounted in which panel, over the folder's lifetime.
 *
 * The data comes from `fetchOrchestrationTimeline` (one entry per delta on the
 * folder chain, oldest-first). This is a read-only view — it does not touch
 * the editor's content replay (ReplayTransport) at all; the two are independent
 * lenses on the same folder. v1 is textual: one row per event with a glyph, a
 * label, and a timestamp. A running state panel shows the folder snapshot and
 * panel occupancy reconstructed up to the hovered/selected row.
 *
 * The stream is re-fetched when `folderId` changes and when App() bumps
 * `refreshKey` after a folder-chain mutation (membership change, rename, or a
 * focus drain that seals onto the next folder node) — see the files-signature
 * effect in App.tsx. This is the same `refreshKey` convention PalettePanel uses.
 *
 * Spec: protocol/trace-provenance.md §3.3 (FolderDelta vocabulary), §8 (focus
 * buffer drain — why one node can carry several deltas).
 */

import { useEffect, useMemo, useState } from "react";
import { FileText, Folder } from "lucide-react";
import { fetchOrchestrationTimeline, type FolderTimelineEntry, type FolderDelta } from "./provenance.js";

/** Reconstructed folder state at a point in the timeline: which paths are
 *  members (with their kind — file or folder), and which path is mounted in
 *  each panel (panelIndex → path). This is what replaying the orchestration
 *  stream up to a cursor produces — the folder-level analogue of
 *  `contentUpToHere` on the content-replay side.
 *
 *  `members` carries `kind` so the list can render a file/folder icon — the
 *  `kind` rides on every `add`/`rename` delta (spec §3.3), defaulting to
 *  `"file"` when absent (legacy pre-nesting deltas). */
interface OrchestrationState {
  members: Map<string, "file" | "folder">;
  /** Sparse: only panels with a known mount. Folder-tab sentinels are stored
   *  verbatim so a folder-focus shows distinctly from a file-focus. */
  panels: Map<number, string>;
}

function applyDelta(state: OrchestrationState, delta: FolderDelta): void {
  switch (delta.type) {
    case "add":
      state.members.set(delta.relativePath, delta.kind ?? "file");
      break;
    case "remove":
      state.members.delete(delta.relativePath);
      // A remove also vacates any panel still showing it.
      for (const [idx, p] of state.panels) if (p === delta.relativePath) state.panels.delete(idx);
      break;
    case "rename":
      // Carry the kind through the rename (spec §3.3: rename mirrors the
      // member entry's kind). Default to "file" for legacy deltas.
      const kind = delta.kind ?? state.members.get(delta.fromPath) ?? "file";
      state.members.delete(delta.fromPath);
      state.members.set(delta.toPath, kind);
      for (const [idx, p] of state.panels) if (p === delta.fromPath) state.panels.set(idx, delta.toPath);
      break;
    case "focus": {
      const sel = delta.selection;
      // Only file/folder selections carry a path; span focus is intra-file and
      // doesn't change panel occupancy at the path level.
      const path = sel.kind === "file" || sel.kind === "folder" ? sel.path : null;
      if (delta.op === "unmount") {
        state.panels.delete(delta.panelIndex);
      } else if (path !== null) {
        state.panels.set(delta.panelIndex, path);
      }
      break;
    }
  }
}

/** Render one delta as a compact label, e.g. `+ essay.md`, `refs → citations`,
 *  `▸ panel 2: draft.md`. Pure over its input — used both for the row and the
 *  running state panel. */
function deltaLabel(delta: FolderDelta): string {
  switch (delta.type) {
    case "add": return `+ ${delta.relativePath}`;
    case "remove": return `− ${delta.relativePath}`;
    case "rename": return `${delta.fromPath} → ${delta.toPath}`;
    case "focus": {
      const sel = delta.selection;
      const arrow = delta.op === "unmount" ? "◂" : "▸";
      const what = sel.kind === "file" || sel.kind === "folder" ? sel.path : `[span]`;
      return `${arrow} panel ${delta.panelIndex}: ${what}`;
    }
  }
}

function deltaKind(delta: FolderDelta): "add" | "remove" | "rename" | "mount" | "unmount" {
  switch (delta.type) {
    case "add": return "add";
    case "remove": return "remove";
    case "rename": return "rename";
    case "focus": return delta.op === "unmount" ? "unmount" : "mount";
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function OrchestrationTimeline({
  folderId,
  refreshKey,
}: {
  folderId: string | null;
  /** Bumped by App() after a folder-chain mutation (membership change, rename,
   *  or a focus drain that lands on the next folder-node seal) so this panel
   *  re-fetches the stream without needing an event bus. Mirrors PalettePanel's
   *  `refreshKey`. */
  refreshKey: number;
}) {
  const [entries, setEntries] = useState<FolderTimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number>(-1);

  // Fetch the orchestration stream when the folder changes. Best-effort: a
  // relay failure sets an error row rather than crashing the sidebar.
  useEffect(() => {
    let cancelled = false;
    if (!folderId) {
      setEntries([]);
      setSelected(-1);
      return;
    }
    setLoading(true);
    setError(null);
    fetchOrchestrationTimeline(folderId)
      .then((es) => {
        if (cancelled) return;
        setEntries(es);
        setSelected(es.length - 1); // rest at the latest event (live folder state)
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e?.message ?? e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId, refreshKey]);

  // Reconstruct folder state up to (and including) the selected row by replaying
  // the stream. O(selected) per selection; selected is bounded by the chain
  // length, which is bounded-frequency by §8. Memoized so dragging the selection
  // doesn't recompute when entries haven't changed.
  const stateAtSelected = useMemo<OrchestrationState>(() => {
    const state: OrchestrationState = { members: new Map(), panels: new Map() };
    const upto = selected < 0 ? entries.length : Math.min(selected + 1, entries.length);
    for (let i = 0; i < upto; i++) applyDelta(state, entries[i].delta);
    return state;
  }, [entries, selected]);

  if (!folderId) {
    return <div className="orchestration-empty">Attach a folder to replay its orchestration.</div>;
  }
  if (loading) {
    return <div className="orchestration-empty">Loading folder orchestration…</div>;
  }
  if (error) {
    return <div className="orchestration-empty">Couldn’t load orchestration: {error}</div>;
  }
  if (entries.length === 0) {
    return <div className="orchestration-empty">No folder events yet.</div>;
  }

  const panelList = [...stateAtSelected.panels.entries()].sort((a, b) => a[0] - b[0]);
  // Sort by path for a stable list; Map iteration is insertion-ordered, but the
  // replay order isn't meaningful to a reader scanning the current snapshot.
  const memberList = [...stateAtSelected.members.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="orchestration" role="group" aria-label="Folder orchestration">
      <div className="orchestration-state">
        <div className="orchestration-state-section">
          <span className="orchestration-state-label">Members ({memberList.length})</span>
          <ul className="orchestration-state-list">
            {memberList.map(([p, kind]) => (
              <li key={p} className="orchestration-member">
                {kind === "folder"
                  ? <Folder size={12} className="orchestration-member-icon" />
                  : <FileText size={12} className="orchestration-member-icon" />}
                <span>{p}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="orchestration-state-section">
          <span className="orchestration-state-label">Panels</span>
          <ul className="orchestration-state-list">
            {panelList.length === 0 ? <li className="muted">none mounted</li> : null}
            {panelList.map(([idx, p]) => <li key={idx}>panel {idx}: {p}</li>)}
          </ul>
        </div>
      </div>
      <ol className="orchestration-stream">
        {entries.map((e, i) => {
          const kind = deltaKind(e.delta);
          const isSel = i === selected;
          return (
            <li
              key={i}
              className={"orchestration-row orchestration-" + kind + (isSel ? " is-selected" : "")}
              title={fmtTime(e.sealedAt)}
              onClick={() => setSelected(i)}
            >
              <span className="orchestration-row-label">{deltaLabel(e.delta)}</span>
              <span className="orchestration-row-time">{fmtTime(e.sealedAt)}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
