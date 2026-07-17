import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import { createPortal } from "react-dom";
import { decodeGeohash, encodeGeohash, geohashLengthForZoom } from "../networking/geohash.js";

/**
 * Attest — endorse one exact node, with an optional note/location.
 *
 * The modal the AUTHOR row's Attest button opens (protocol §5A/§8). The
 * geohash is optional discovery metadata; the signed event's `created_at` is a
 * claimed publication time, not an OpenTimestamps proof.
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
 */

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";
const CAMERA_KEY = "zine.globe.camera";
const MIN_ZOOM = 2;
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

export function AttestModal({
  path,
  prerequisite,
  onClose,
  onConfirm,
}: {
  path: string;
  prerequisite: "step-and-send" | "send" | null;
  onClose: () => void;
  onConfirm: (geohash: string | undefined, message: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // The geohash the user has picked (click on map). Undefined until first pick.
  const [geohash, setGeohash] = useState<string | undefined>(undefined);
  // Current zoom, to drive the precision label / live re-encode feedback.
  const [zoom, setZoom] = useState<number>(loadCamera().zoom);
  // Optional curatorial note carried by the TraceAttestation event.
  const [message, setMessage] = useState("");

  // Draw (or clear) the selected cell + its ancestor outlines. Re-runs whenever
  // the picked geohash changes. Layer/source ids are stable so this is an
  // upsert; the map outlives these effects.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const redraw = () => {
      // Tear down any prior cell layers/sources from a previous pick.
      for (const id of ["attest-cell-fill", "attest-cell-line", "attest-parent-line", "attest-cell-label"]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of ["attest-cell", "attest-parents"]) {
        if (map.getSource(id)) map.removeSource(id);
      }
      const labelEl = document.getElementById("attest-cell-label");
      if (labelEl) labelEl.remove();

      if (!geohash) return;
      const feat = cellPolygon(geohash);
      if (!feat) return;

      // Selected cell: filled + outlined.
      map.addSource("attest-cell", { type: "geojson", data: feat });
      map.addLayer({
        id: "attest-cell-fill",
        type: "fill",
        source: "attest-cell",
        paint: { "fill-color": "var(--accent, #2563eb)", "fill-opacity": 0.18 },
      });
      map.addLayer({
        id: "attest-cell-line",
        type: "line",
        source: "attest-cell",
        paint: { "line-color": "var(--accent, #2563eb)", "line-width": 2 },
      });

      // Ancestors: each shorter prefix as a faint outline, coarsest first so
      // the finest draws on top. Makes the nesting legible.
      const parents = ancestors(geohash)
        .map((h) => cellPolygon(h))
        .filter((f): f is GeoJSON.Feature<GeoJSON.Polygon> => f !== null);
      if (parents.length) {
        map.addSource("attest-parents", { type: "geojson", data: { type: "FeatureCollection", features: parents } });
        map.addLayer({
          id: "attest-parent-line",
          type: "line",
          source: "attest-parents",
          paint: { "line-color": "#999", "line-width": 1, "line-opacity": 0.4 },
        });
      }

      // Label the selected cell at its center with the geohash string.
      const box = decodeGeohash(geohash);
      const el = document.createElement("div");
      el.id = "attest-cell-label";
      el.className = "attest-cell-label";
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

    map.on("style.load", () => {
      map.setProjection({ type: "globe" });
    });

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
    <div className="compose-overlay attest-overlay" onClick={onClose}>
      <div className="compose-dialog attest-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="attest-head">
          <h2 className="attest-title">Attest</h2>
          <button type="button" className="attest-close" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <p className="attest-blurb">
          {prerequisite === "step-and-send" ? (
            <>Step and Send the current draft of <strong>{fileName}</strong>, then mark that exact version as a position you stand behind.</>
          ) : prerequisite === "send" ? (
            <>Ensure this exact Step of <strong>{fileName}</strong> is Sent, then mark it as a position you stand behind.</>
          ) : (
            <>Mark the selected version of <strong>{fileName}</strong> as a position you stand behind.</>
          )}{" "}
          A note and a Spaces location are optional.
        </p>

        <div className="attest-map" ref={containerRef} />

        <div className="attest-hint">
          {geohash ? (
            <>
              <span className="attest-geohash-label">{geohash}</span>
              <span className="attest-precision">
                {geohash.length} chars · {precisionLabel(geohash.length)} · visible at this zoom level
              </span>
              <button type="button" className="attest-repick" onClick={() => setGeohash(undefined)}>
                clear location
              </button>
            </>
          ) : (
            <span>
              Optionally click the map to pin a geohash — zoom in for finer precision, out for coarser.
              Current zoom would pin a length-{geohashLengthForZoom(zoom)} cell ({precisionLabel(geohashLengthForZoom(zoom))}).
            </span>
          )}
        </div>

        <textarea
          className="attest-message"
          placeholder="optional note — a brief curatorial message attached to this published node"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
        />

        <div className="attest-actions">
          <button type="button" className="confirm-cancel" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="confirm-delete attest-confirm"
            onClick={() => onConfirm(geohash, message)}
          >
            Attest
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
