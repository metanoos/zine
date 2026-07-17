/**
 * PinPanel — pin the active zine to one or more geohashes.
 *
 * This is the Spaces authoring surface: where a folder gets its `["g", geohash]`
 * tags. It's an authoring act, so it lives in the Press context — conceptually
 * adjacent to Save/SEND. Opened via a `zine:open-pin` CustomEvent carrying the
 * active folder id (the same decoupled-event pattern the Globe uses to open a
 * folder); renders as a portal modal, ESC/outside-click to dismiss.
 *
 * The picker takes a lat/lng and a precision (geohash length), encodes a geohash,
 * and shows the resulting cell box on a tiny preview. Pins are add/remove — the
 * folder's current set is read with `fetchFolderGeohashes`, written with
 * `setFolderGeohashes` (which republishes the folder node carrying the new `g`
 * tags; folder-node publication keeps them across routine steps).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import {
  encodeGeohash,
  decodeGeohash,
  geohashLengthForZoom,
} from "../networking/geohash.js";
import { fetchFolderGeohashes, setFolderGeohashes } from "./provenance.js";

/** The precision picker: a human label, the geohash length, and a rough cell
 *  width. Mirrors the zoom↔length bands the Globe renders, so "what you set here
 *  is what readers see at that zoom." */
const PRECISIONS: { label: string; length: number; width: string }[] = [
  { label: "continental", length: 2, width: "~1250km" },
  { label: "regional", length: 4, width: "~40km" },
  { label: "city", length: 6, width: "~1.2km" },
  { label: "neighborhood", length: 7, width: "~150m" },
  { label: "street", length: 8, width: "~38m" },
];

export function PinPanel() {
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [length, setLength] = useState(6);
  const [error, setError] = useState<string | null>(null);

  // Open on the shell-dispatched event (the Press triggers it with the active
  // folder id). Close on ESC/outside handled below.
  useEffect(() => {
    const onOpen = (e: globalThis.Event) => {
      const id = (e as globalThis.CustomEvent<string>).detail;
      if (typeof id === "string") setOpenFolder(id);
    };
    window.addEventListener("zine:open-pin", onOpen);
    return () => window.removeEventListener("zine:open-pin", onOpen);
  }, []);

  // Load current pins when a folder opens.
  useEffect(() => {
    if (!openFolder) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchFolderGeohashes(openFolder)
      .then((found) => {
        if (!cancelled) setPins(found);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [openFolder]);

  const close = useCallback(() => setOpenFolder(null), []);

  // ESC to close.
  useEffect(() => {
    if (!openFolder) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFolder, close]);

  const preview = useMemo(() => {
    const la = parseFloat(lat);
    const ln = parseFloat(lng);
    if (Number.isNaN(la) || Number.isNaN(ln)) return null;
    const gh = encodeGeohash(la, ln, length);
    const box = decodeGeohash(gh);
    return { gh, box };
  }, [lat, lng, length]);

  const addPin = async () => {
    if (!openFolder || !preview) return;
    const next = [...new Set([...pins, preview.gh])];
    setBusy(true);
    setError(null);
    try {
      await setFolderGeohashes(openFolder, next);
      setPins(next);
      setLat("");
      setLng("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const removePin = async (gh: string) => {
    if (!openFolder) return;
    const next = pins.filter((p) => p !== gh);
    setBusy(true);
    setError(null);
    try {
      await setFolderGeohashes(openFolder, next);
      setPins(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!openFolder) return null;

  return createPortal(
    <div
      className="pin-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Pin zine to map"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="pin-panel">
        <header className="pin-header">
          <h2 className="pin-title">Pin to Spaces</h2>
          <button type="button" className="pin-close" onClick={close} aria-label="Close">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <p className="pin-folder" title={openFolder}>
          folder <code>{openFolder.slice(0, 12)}</code>
        </p>

        {error && <p className="sampler-status error">{error}</p>}

        {/* Current pins */}
        <div className="pin-current">
          <span className="pin-current-label">current pins · {pins.length}</span>
          {loading ? (
            <span className="pin-loading">loading…</span>
          ) : pins.length === 0 ? (
            <span className="pin-empty">no pins yet</span>
          ) : (
            <ul className="pin-list">
              {pins.map((gh) => (
                <li key={gh} className="pin-row">
                  <code className="pin-geo">{gh}</code>
                  <span className="pin-cell">{describeCell(gh)}</span>
                  <button
                    type="button"
                    className="pin-remove"
                    onClick={() => removePin(gh)}
                    disabled={busy}
                    aria-label={`Remove pin ${gh}`}
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Add a pin */}
        <div className="pin-add">
          <span className="pin-current-label">add a pin</span>
          <div className="pin-coords">
            <label className="pin-coord">
              <span>lat</span>
              <input
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="51.5074"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </label>
            <label className="pin-coord">
              <span>lng</span>
              <input
                type="number"
                step="any"
                inputMode="decimal"
                placeholder="-0.1278"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
              />
            </label>
          </div>
          <div className="pin-precisions">
            {PRECISIONS.map((p) => (
              <button
                key={p.length}
                type="button"
                className={"times-pill pin-precision" + (length === p.length ? " active" : "")}
                onClick={() => setLength(p.length)}
                title={`level ${p.length} · ${p.width} cell`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preview && (
            <p className="pin-preview">
              geohash <code>{preview.gh}</code> · center{" "}
              {preview.box.lat.toFixed(3)}, {preview.box.lng.toFixed(3)}
            </p>
          )}
          <button
            type="button"
            className="run-agent-btn pin-add-btn"
            onClick={addPin}
            disabled={busy || !preview}
          >
            pin
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** One-line human description of a geohash cell, for the pin list. */
function describeCell(gh: string): string {
  if (gh.length === 0) return "";
  const band = geohashLengthForZoom(gh.length * 2 - 2); // reverse-approx the band
  const prec = PRECISIONS.find((p) => p.length === gh.length) ?? PRECISIONS.find((p) => p.length === band);
  return prec ? `level ${gh.length} · ${prec.width}` : `level ${gh.length}`;
}
