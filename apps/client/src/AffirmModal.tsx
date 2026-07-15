import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { createPortal } from "react-dom";
import { decodeGeohash, encodeGeohash, geohashLengthForZoom } from "./geohash.js";

/**
 * Affirm — pin a published position to a geohash + acknowledge the timestamp.
 *
 * The modal the AUTHOR row's Affirm button opens (protocol §8). Affirm marks an
 * already-sent node as the author's published position. Before attesting, the
 * author picks *where* this affirmation lives on Spaces (a geohash) and
 * *when* (the acknowledged timestamp the NIP-03 OTS attestation anchors from).
 *
 * The map is a precision picker, not a pin viewer. The geohash is rendered as
 * a labeled quadrant (cell box), and the cell's precision follows the map
 * zoom — zoom in for a street-level (length ~8) cell, out for a continental
 * (length ~2) one. Parent cells (progressively shorter prefixes) draw as faint
 * outlines so the author sees the nesting: this is the scale at which a zine
 * carrying this geohash will appear, and the scale at which finer pins sit
 * inside coarser ones. That makes the Spaces rule — a pin shows only at the
 * zoom matching its geohash length — legible at pick time rather than a
 * mystery when a zine later "disappears."
 *
 * The clock shows the current time as the acknowledgment stamp. The OTS
 * attestation itself is fire-and-forget (see affirmNode); the "next NIP-03
 * timestamp" is the next Bitcoin block the commitment will anchor into, which
 * can't be known ahead of time — so we show now and frame it honestly.
 */

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const CAMERA_KEY = "zine.globe.camera";
const MIN_ZOOM = 3;
const MAX_ZOOM = 18;

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}
const DEFAULT_CAMERA: Camera = { lng: 0, lat: 20, zoom: 3, bearing: 0, pitch: 0 };

function loadCamera(): Camera {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    if (!raw) return DEFAULT_CAMERA;
    const c = JSON.parse(raw) as Partial<Camera>;
    if (typeof c.lng !== "number" || typeof c.lat !== "number") return DEFAULT_CAMERA;
    const zoom = typeof c.zoom === "number" ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom)) : DEFAULT_CAMERA.zoom;
    return { lng: c.lng, lat: c.lat, zoom, bearing: c.bearing ?? 0, pitch: c.pitch ?? 0 };
  } catch {
    return DEFAULT_CAMERA;
  }
}

function resolvedMode(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Build a GeoJSON polygon ring (closed) for a geohash cell from its decode
 *  bbox. Returns null on an invalid hash. */
function cellPolygon(hash: string): GeoJSON.Feature<GeoJSON.Polygon> | null {
  const box = decodeGeohash(hash);
  if (!Number.isFinite(box.lat) || !Number.isFinite(box.lng)) return null;
  const [s, n] = [box.lat - box.latErr, box.lat + box.latErr];
  const [w, e] = [box.lng - box.lngErr, box.lng + box.lngErr];
  return {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
    },
    properties: { hash },
  };
}

/** The prefix ancestors of a geohash: every progressively shorter prefix down
 *  to length 1. Used to draw the nesting as faint outlines so the author sees
 *  which coarser cells this one sits inside. */
function ancestors(hash: string): string[] {
  const out: string[] = [];
  for (let n = hash.length - 1; n >= 1; n--) out.push(hash.slice(0, n));
  return out;
}

/** A human label for a geohash length — what scale a cell of that precision
 *  represents, so the author understands the choice. */
function precisionLabel(length: number): string {
  if (length <= 2) return "≈continental";
  if (length <= 3) return "≈country";
  if (length <= 4) return "≈regional";
  if (length <= 5) return "≈province";
  if (length <= 6) return "≈city";
  if (length <= 7) return "≈district";
  if (length <= 8) return "≈street";
  return "≈building";
}

function fmtClock(d: Date): string {
  // ISO-like, second precision, UTC. UTC because the OTS anchor is a global
  // (blockchain) timestamp, not a local one.
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC`;
}

export function AffirmModal({
  path,
  onClose,
  onConfirm,
}: {
  path: string;
  onClose: () => void;
  onConfirm: (geohash: string | undefined, message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // The geohash the user has picked (click on map). Undefined until first pick.
  const [geohash, setGeohash] = useState<string | undefined>(undefined);
  // Current zoom, to drive the precision label / live re-encode feedback.
  const [zoom, setZoom] = useState<number>(loadCamera().zoom);
  const [now, setNow] = useState(() => new Date());
  // Optional curatorial note attached to the affirmation. Content-only on the
  // affirm node (covered by the OTS stamp via the event id). Free text; the
  // caller decides whether to require it (today: optional, geohash still gates).
  const [message, setMessage] = useState("");

  // Live clock — ticks every second while the modal is open.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // Draw (or clear) the selected cell + its ancestor outlines. Re-runs whenever
  // the picked geohash changes. Layer/source ids are stable so this is an
  // upsert; the map outlives these effects.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const redraw = () => {
      // Tear down any prior cell layers/sources from a previous pick.
      for (const id of ["affirm-cell-fill", "affirm-cell-line", "affirm-parent-line", "affirm-cell-label"]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of ["affirm-cell", "affirm-parents"]) {
        if (map.getSource(id)) map.removeSource(id);
      }
      const labelEl = document.getElementById("affirm-cell-label");
      if (labelEl) labelEl.remove();

      if (!geohash) return;
      const feat = cellPolygon(geohash);
      if (!feat) return;

      // Selected cell: filled + outlined.
      map.addSource("affirm-cell", { type: "geojson", data: feat });
      map.addLayer({
        id: "affirm-cell-fill",
        type: "fill",
        source: "affirm-cell",
        paint: { "fill-color": "var(--accent, #2563eb)", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "affirm-cell-line",
        type: "line",
        source: "affirm-cell",
        paint: { "line-color": "var(--accent, #2563eb)", "line-width": 2 },
      });

      // Ancestors: each shorter prefix as a faint outline, coarsest first so
      // the finest draws on top. Makes the nesting legible.
      const parents = ancestors(geohash)
        .map((h) => cellPolygon(h))
        .filter((f): f is GeoJSON.Feature<GeoJSON.Polygon> => f !== null);
      if (parents.length) {
        map.addSource("affirm-parents", { type: "geojson", data: { type: "FeatureCollection", features: parents } });
        map.addLayer({
          id: "affirm-parent-line",
          type: "line",
          source: "affirm-parents",
          paint: { "line-color": "#999", "line-width": 1, "line-opacity": 0.4 },
        });
      }

      // Label the selected cell at its center with the geohash string.
      const box = decodeGeohash(geohash);
      const el = document.createElement("div");
      el.id = "affirm-cell-label";
      el.className = "affirm-cell-label";
      el.textContent = geohash;
      new maplibregl.Marker({ element: el, anchor: "center" }).setLngLat([box.lng, box.lat]).addTo(map);
    };
    // The map may not be loaded yet on the first pick; guard with isStyleLoaded.
    if (map.isStyleLoaded()) redraw();
    else map.once("style.load", redraw);
  }, [geohash]);

  // Initialise the map once.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const saved = loadCamera();
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: resolvedMode() === "dark" ? STYLE_DARK : STYLE_LIGHT,
      center: [saved.lng, saved.lat],
      zoom: saved.zoom,
      bearing: saved.bearing,
      pitch: saved.pitch,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      keyboard: false,
    });
    mapRef.current = map;

    map.on("moveend", () => setZoom(map.getZoom()));

    // Click picks a geohash: encode the clicked point at the precision matching
    // the current zoom. Zooming in narrows the cell; zooming out widens it.
    map.on("click", (e: maplibregl.MapMouseEvent) => {
      const len = geohashLengthForZoom(map.getZoom());
      setGeohash(encodeGeohash(e.lngLat.lat, e.lngLat.lng, len));
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  const fileName = path.split("/").pop() ?? path;

  return createPortal(
    <div className="compose-overlay affirm-overlay" onClick={onClose}>
      <div className="compose-dialog affirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="affirm-head">
          <h2 className="affirm-title">Affirm</h2>
          <button type="button" className="affirm-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="affirm-blurb">
          Mark <strong>{fileName}</strong> as your published position. Pin it to a geohash on Spaces and
          acknowledge the timestamp the NIP-03 attestation anchors from.
        </p>

        <div className="affirm-map" ref={containerRef} />

        <div className="affirm-hint">
          {geohash ? (
            <>
              <span className="affirm-geohash-label">{geohash}</span>
              <span className="affirm-precision">
                {geohash.length} chars · {precisionLabel(geohash.length)} · visible at this zoom level
              </span>
              <span className="affirm-repick">click again to refine</span>
            </>
          ) : (
            <span>
              Click the map to pin a geohash — zoom in for finer precision, out for coarser.
              Current zoom would pin a length-{geohashLengthForZoom(zoom)} cell ({precisionLabel(geohashLengthForZoom(zoom))}).
            </span>
          )}
        </div>

        <div className="affirm-clock-row">
          <span className="affirm-clock-label">Acknowledged timestamp</span>
          <span className="affirm-clock">{fmtClock(now)}</span>
          <span className="affirm-clock-note">OTS anchors to the next Bitcoin block from this moment.</span>
        </div>

        <textarea
          className="affirm-message"
          placeholder="optional note — a brief curatorial message attached to this affirmation"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />

        <div className="affirm-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="confirm-delete affirm-confirm"
            disabled={!geohash}
            onClick={() => onConfirm(geohash, message)}
          >
            Affirm
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
