/**
 * The palette sidebar panel — the curated set of recently minted spans
 * (protocol spec:226, "module of trace-nodes"). Each item is a minted
 * kind-4290 node; the panel caches its text for display (the node's
 * snapshot is authoritative).
 *
 * Two actions per row:
 *   - Copy: writes the full `[[ text | nodeId ]]` citation to the clipboard,
 *     so a ⌘V elsewhere (this doc, another doc, even another app) lands a
 *     real, resolvable citation. Pasting into a zine doc installs a
 *     reference; the next seal records the component trace (spec:189).
 *   - Remove: drops the curated reference. The minted node is immutable,
 *     so the node itself stays on the relay — only the curation moves.
 *
 * The `refreshKey` prop is bumped by App() after a minting pass mints new
 * nodes, so the panel re-fetches without needing an event bus.
 */

import { useEffect, useState } from "react";
import {
  fetchPalette,
  removeFromPalette,
  type PaletteItem,
} from "./provenance.js";
import { Copy, Trash2, Check } from "lucide-react";

export function PalettePanel({
  refreshKey,
  selectedNodeId,
  onSelect,
}: {
  refreshKey: number;
  /** nodeId of the currently-selected trace, if it is a minted span. Drives
   *  the gold box on the matching palette row. */
  selectedNodeId?: string;
  /** Select a palette item as the active trace (accent-soft outline). */
  onSelect?: (item: PaletteItem) => void;
}) {
  const [items, setItems] = useState<PaletteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // nodeId of the row currently showing the check-mark "copied" affordance.
  // Auto-clears after the brief flash so the icon returns to the copy glyph.
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPalette()
      .then((fetched) => {
        if (cancelled) return;
        setItems(fetched);
        setError(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  async function handleRemove(nodeId: string) {
    // Optimistic remove; the relay write follows. A failed write restores on
    // the next refreshKey bump (App re-fetches on seal).
    setItems((prev) => prev.filter((i) => i.nodeId !== nodeId));
    try {
      await removeFromPalette(nodeId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  /** Copy the full `[[ text | nodeId ]]` citation to the system clipboard.
   *  Mirrors the in-editor bracket chip's copy (brackets.ts): same payload
   *  shape, same flash-to-check affordance, same silent fallback when the
   *  clipboard API is unavailable. */
  function handleCopy(item: PaletteItem) {
    const payload = `[[ ${item.text} | ${item.nodeId} ]]`;
    navigator.clipboard
      ?.writeText(payload)
      .then(() => {
        setCopiedNodeId(item.nodeId);
        setTimeout(() => setCopiedNodeId(null), 1200);
      })
      .catch(() => {
        /* clipboard unavailable — no-op, mirrors KeysView's copy handler */
      });
  }

  return (
    <div className="palette-panel">
      {loading && items.length === 0 && <p className="palette-status">loading…</p>}
      {error && <p className="palette-status error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="palette-status">highlight text to capture a snapshot</p>
      )}
      {items.map((item) => {
        const selected = selectedNodeId === item.nodeId;
        const copied = copiedNodeId === item.nodeId;
        return (
          <div
            key={item.nodeId}
            className={"palette-item" + (selected ? " palette-item-selected" : "")}
            title={item.text}
          >
            <div
              className="palette-item-body"
              onClick={() => onSelect?.(item)}
              role={onSelect ? "button" : undefined}
              tabIndex={onSelect ? 0 : undefined}
            >
              <p className="palette-item-text">{previewText(item.text)}</p>
              {item.label || item.originPath ? (
                <span className="palette-item-origin">
                  {item.label ? (
                    <span className="palette-item-label">{item.label}</span>
                  ) : null}
                  {item.label && item.originPath ? " · " : ""}
                  {originLabel(item.originPath)}
                </span>
              ) : null}
            </div>
            <div className="palette-item-actions">
              <button
                type="button"
                className="palette-action"
                title="Copy citation"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopy(item);
                }}
              >
                {copied ? (
                  <Check size={12} aria-hidden="true" />
                ) : (
                  <Copy size={12} aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                className="palette-action palette-action--danger"
                title="Remove from palette"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(item.nodeId);
                }}
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? flat.slice(0, 60) + "…" : flat;
}

function originLabel(originPath: string): string {
  // Show the bare filename + span hash suffix, if any (e.g. "notes.md#a1b2c3d4"
  // → "notes.md"). Hardened spans carry the hash on their own synthetic path,
  // but originPath here is the *origin document*, which never has the suffix.
  const base = originPath.split("/").pop() || originPath;
  return base;
}
