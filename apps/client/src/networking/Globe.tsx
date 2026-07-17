import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";
import {
  cellsInBbox,
  decodeGeohash,
  geohashLengthForZoom,
  type GeohashBox,
} from "./geohash.js";
import {
  fetchPinsByGeohash,
  fetchFolderDisplayName,
  fetchFolderIndex,
  type FolderIndexEntry,
  type ZinePin,
} from "../provenance/provenance.js";
import {
  DEFAULT_SOCIAL_QUERY,
  authorsForSocialScope,
  matchesSocialText,
  socialWindowSince,
  type SocialQuery,
} from "./social-query.js";

/**
 * Spaces — zines pinned to geohashes on a spherical map.
 *
 * A zine is pinned by carrying one or more `["g", geohash]` tags on its folder
 * node (see protocol §3.1). The geohash is arbitrary-length base-32; length
 * encodes precision (a length-2 cell is ~continental, length-8 is ~street).
 * Cells are prefix-hierarchical, so the "various levels" emerge from the
 * precision the author chose: a length-8 pin's cell sits inside its length-4
 * prefix cell.
 *
 * Spaces renders a pin ONLY at the zoom whose cell-width matches the pin's
 * geohash length. Zoom out and the fine pins drop away while coarse ones
 * appear; zoom in and the reverse. So the map reads as a stack of precision
 * layers, each showing a different cut of the zines.
 *
 * The globe itself is MapLibre's `globe` projection with OpenFreeMap tiles;
 * the camera persists to localStorage so leaving and returning drops you where
 * you left off (unchanged from the pre-Spaces globe).
 */

const STYLE_LIGHT = "https://tiles.openfreemap.org/styles/positron";
const STYLE_DARK = "https://tiles.openfreemap.org/styles/dark";

const CAMERA_KEY = "zine.globe.camera";

// Keep the globe large enough to navigate while still allowing broad
// whole-world context.
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

interface Camera {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

const DEFAULT_CAMERA: Camera = { lng: 0, lat: 20, zoom: 1.2, bearing: 0, pitch: 0 };

/** Load the saved camera, falling back to the default. */
function loadCamera(): Camera {
  try {
    const raw = localStorage.getItem(CAMERA_KEY);
    if (!raw) return DEFAULT_CAMERA;
    const c = JSON.parse(raw) as Partial<Camera>;
    if (typeof c.lng !== "number" || typeof c.lat !== "number") return DEFAULT_CAMERA;
    const zoom =
      typeof c.zoom === "number" ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom)) : DEFAULT_CAMERA.zoom;
    return {
      lng: c.lng,
      lat: c.lat,
      zoom,
      bearing: typeof c.bearing === "number" ? c.bearing : DEFAULT_CAMERA.bearing,
      pitch: typeof c.pitch === "number" ? c.pitch : DEFAULT_CAMERA.pitch,
    };
  } catch {
    return DEFAULT_CAMERA;
  }
}

function saveCamera(c: Camera) {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(c));
  } catch {
    // Storage full / disabled — camera permanence is best-effort, never fatal.
  }
}

/** Resolve the app's effective theme the same way App.tsx does. */
function resolvedMode(): "light" | "dark" {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** A plotted pin: its folder, the geohash, and the decoded cell center. */
interface PlottedPin extends ZinePin {
  lng: number;
  lat: number;
  name: string;
}

export function GlobeView({ query = DEFAULT_SOCIAL_QUERY }: { query?: SocialQuery } = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const queryRef = useRef(query);
  const eligibilityRef = useRef<Map<string, FolderIndexEntry> | null>(null);
  const plotPinsRef = useRef<(() => void) | null>(null);
  const eligibilitySeq = useRef(0);

  // Resolve the non-spatial half of the shared query once per bound change.
  // Map pans then intersect viewport pins against this cached folder index
  // instead of repeating a relay-wide scan on every moveend.
  useEffect(() => {
    queryRef.current = { ...queryRef.current, text: query.text };
    plotPinsRef.current?.();
  }, [query.text]);

  useEffect(() => {
    queryRef.current = query;
    eligibilityRef.current = null;
    const seq = ++eligibilitySeq.current;
    void (async () => {
      const authors = await authorsForSocialScope(query.scope);
      const index = await fetchFolderIndex({
        since: socialWindowSince(query.window),
        authors,
        limit: 2000,
      });
      if (seq !== eligibilitySeq.current) return;
      eligibilityRef.current = index;
      plotPinsRef.current?.();
    })().catch(() => {
      if (seq !== eligibilitySeq.current) return;
      eligibilityRef.current = new Map();
      plotPinsRef.current?.();
    });
  }, [query.scope, query.window]);

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

    // Persist the camera on every move (debounced with rAF).
    let camScheduled = false;
    const persistCamera = () => {
      if (camScheduled) return;
      camScheduled = true;
      requestAnimationFrame(() => {
        camScheduled = false;
        const c = map.getCenter();
        saveCamera({
          lng: c.lng,
          lat: c.lat,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        });
      });
    };
    map.on("move", persistCamera);
    map.on("moveend", persistCamera);

    // Globe projection + atmosphere are applied on every style load — a
    // setStyle() call (theme switch) resets both.
    const applyGlobeLook = () => {
      map.setProjection({ type: "globe" });
      map.setSky({
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 0.5, 6, 0],
      });
    };
    map.on("style.load", applyGlobeLook);

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    // --- pin plotting ----------------------------------------------------
    // On moveend, compute the geohash length for the zoom, enumerate the cells
    // covering the viewport, fetch pins, and (re)render markers. Debounced so
    // a continuous pan only re-plots once at rest. A fetchSeq token guards
    // against out-of-order completions overwriting a newer plot.
    let fetchSeq = 0;
    const plotPins = async () => {
      const eligible = eligibilityRef.current;
      if (!eligible) return;
      const zoom = map.getZoom();
      const length = geohashLengthForZoom(zoom);
      const bounds = map.getBounds();
      // MapLibre bounds: getWest/South/East/North in degrees. Clamp longitude
      // wraparound by skipping the plot when the viewport spans the antimeridian
      // beyond a sane bound (rare on a globe at these zoom floors).
      const bbox: [west: number, south: number, east: number, north: number] = [
        bounds.getWest(),
        Math.max(-90, bounds.getSouth()),
        bounds.getEast(),
        Math.min(90, bounds.getNorth()),
      ];
      const cells = cellsInBbox(bbox, length);
      const seq = ++fetchSeq;
      let pins: Awaited<ReturnType<typeof fetchPinsByGeohash>>;
      try {
        pins = await fetchPinsByGeohash(cells);
      } catch {
        pins = [];
      }
      if (seq !== fetchSeq) return; // a newer pan superseded this fetch

      // Clear the previous markers.
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];

      // Resolve names + decode cell centers in parallel. Dedupe by
      // (folderId, geohash) so one zine doesn't double-plot a cell.
      const seen = new Set<string>();
      const toPlot: PlottedPin[] = [];
      const nameCache = new Map<string, string>();
      const scopedPins = pins.filter((pin) => eligible.has(pin.folderId));
      const folderIds = [...new Set(scopedPins.map((p) => p.folderId))];
      await Promise.all(
        folderIds.map(async (id) => {
          nameCache.set(id, await fetchFolderDisplayName(id).catch(() => id.slice(0, 8)));
        }),
      );
      for (const pin of scopedPins) {
        const key = `${pin.folderId}\0${pin.geohash}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const box: GeohashBox = decodeGeohash(pin.geohash);
        if (Number.isNaN(box.lat)) continue;
        const name = nameCache.get(pin.folderId) ?? pin.folderId.slice(0, 8);
        const entry = eligible.get(pin.folderId);
        if (!matchesSocialText(queryRef.current.text, {
          folderId: pin.folderId,
          name,
          tags: entry?.topTags,
        })) continue;
        toPlot.push({
          ...pin,
          lng: box.lng,
          lat: box.lat,
          name,
        });
      }

      const accent = resolvedAccent();
      for (const p of toPlot) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "globe-pin";
        el.title = `${p.name} · ${p.geohash}`;
        el.style.background = accent;
        el.addEventListener("click", () => {
          // Open the folder id in the Press via a CustomEvent the shell listens
          // for (the rail's openFromStacks path). Kept decoupled: Globe doesn't
          // import the App shell.
          window.dispatchEvent(new CustomEvent("zine:open-folder", { detail: p.folderId }));
        });
        const marker = new maplibregl.Marker(el)
          .setLngLat([p.lng, p.lat])
          .setPopup(
            new maplibregl.Popup({ offset: 12 }).setHTML(
              `<div class="globe-pin-popup"><span class="globe-pin-name">${escapeHtml(p.name)}</span><span class="globe-pin-geo">${escapeHtml(p.geohash)}</span></div>`,
            ),
          )
          .addTo(map);
        markersRef.current.push(marker);
      }
    };
    plotPinsRef.current = () => {
      void plotPins();
    };
    map.on("moveend", plotPins);
    // Initial plot once the map has a size.
    map.once("idle", plotPins);

    // Swap basemap when the app theme changes.
    const themeObserver = new MutationObserver(() => {
      const m = resolvedMode();
      const current = map.getStyle()?.name;
      const want = m === "dark" ? "dark" : "positron";
      if (current && !current.toLowerCase().includes(want)) {
        map.setStyle(m === "dark" ? STYLE_DARK : STYLE_LIGHT);
      }
      // Re-tint existing pin markers with the new accent.
      const accent = resolvedAccent();
      for (const m of markersRef.current) {
        const el = m.getElement();
        if (el) el.style.background = accent;
      }
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => {
      const m = resolvedMode();
      map.setStyle(m === "dark" ? STYLE_DARK : STYLE_LIGHT);
    };
    mq.addEventListener("change", onScheme);

    return () => {
      themeObserver.disconnect();
      mq.removeEventListener("change", onScheme);
      for (const m of markersRef.current) m.remove();
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      plotPinsRef.current = null;
    };
  }, []);

  return (
    <section className="globe-view">
      <div className="globe-canvas" ref={containerRef} role="img" aria-label="Zines pinned to the map" />
    </section>
  );
}

/** The accent color as a CSS string, read from the live theme so pin markers
 *  match the chrome. Re-resolved on theme change in the effect above. */
function resolvedAccent(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#d99a0a";
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}
