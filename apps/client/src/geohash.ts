/**
 * Geohash for Spaces.
 *
 * Spaces pins zines to arbitrary-length base-32 geohashes. Length encodes
 * precision: a length-2 cell is ~1250km (continent), a length-8 cell is ~38m
 * (street). Cells are prefix-hierarchical — a length-4 cell contains every
 * length-8 cell that starts with those 4 characters. That hierarchy is what
 * makes "show pins at the zoom matching their length" work: zoom out and you
 * see the coarse pins inside the viewport; zoom in and the coarse ones drop
 * away while finer ones appear.
 *
 * Implemented here rather than pulled in as a dependency: the subset Spaces and
 * the Press pin affordance need (encode, decode, cell coverage of a bbox,
 * zoom↔length) is small and stable, and the project keeps its dependency
 * surface minimal (see apps/client/package.json). The base-32 geohash alphabet
 * and bit-interleaving are the standard Nievergelt scheme.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const DECODE32 = new Map<string, number>();
for (let i = 0; i < BASE32.length; i++) DECODE32.set(BASE32[i], i);

/** Map a MapLibre zoom level to the geohash length Spaces renders at that zoom.
 *  Each band roughly doubles the cell resolution; the bands were chosen so a
 *  viewport at zoom N shows a bounded number of cells (≤ a few hundred). */
export function geohashLengthForZoom(zoom: number): number {
  if (zoom < 4) return 2; // continents
  if (zoom < 7) return 4; // regions
  if (zoom < 10) return 6; // cities
  if (zoom < 13) return 7; // neighborhoods
  return 8; // street level and finer
}

export interface GeohashBox {
  lat: number;
  lng: number;
  /** Half the cell's lat/lng span — the error margin of the center point. */
  latErr: number;
  lngErr: number;
}

/** Decode a geohash to its cell center and per-axis error. Pure: same input →
 *  same output. Invalid characters are rejected with NaN. */
export function decodeGeohash(hash: string): GeohashBox {
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let even = true; // longitude first
  for (const ch of hash.toLowerCase()) {
    const cv = DECODE32.get(ch);
    if (cv === undefined) {
      return { lat: NaN, lng: NaN, latErr: NaN, lngErr: NaN };
    }
    for (let bit = 4; bit >= 0; bit--) {
      const b = (cv >> bit) & 1;
      if (even) {
        const mid = (lngLo + lngHi) / 2;
        if (b) lngLo = mid;
        else lngHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (b) latLo = mid;
        else latHi = mid;
      }
      even = !even;
    }
  }
  const lat = (latLo + latHi) / 2;
  const lng = (lngLo + lngHi) / 2;
  return { lat, lng, latErr: (latHi - latLo) / 2, lngErr: (lngHi - lngLo) / 2 };
}

/** Encode a coordinate to `length` geohash characters. Length clamped to [1, 12]
 *  — beyond 12 the double precision is exhausted. */
export function encodeGeohash(lat: number, lng: number, length: number): string {
  const len = Math.max(1, Math.min(12, Math.floor(length)));
  let latLo = -90;
  let latHi = 90;
  let lngLo = -180;
  let lngHi = 180;
  let even = true; // longitude first
  let bits = 0;
  let cv = 0;
  let out = "";
  while (out.length < len) {
    if (even) {
      const mid = (lngLo + lngHi) / 2;
      if (lng >= mid) {
        cv = (cv << 1) | 1;
        lngLo = mid;
      } else {
        cv = cv << 1;
        lngHi = mid;
      }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) {
        cv = (cv << 1) | 1;
        latLo = mid;
      } else {
        cv = cv << 1;
        latHi = mid;
      }
    }
    even = !even;
    bits++;
    if (bits === 5) {
      out += BASE32[cv];
      bits = 0;
      cv = 0;
    }
  }
  return out;
}

/** Longest common prefix of two geohashes. Used to test cell containment: pin
 *  B's cell contains pin A iff A starts with B (B is a coarser prefix). */
export function commonPrefix(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

/** Enumerate every geohash cell of `length` that intersects the bbox. Bounded:
 *  at the lengths Spaces renders (2–8), a viewport never yields more than a few
 *  hundred cells. Used to drive a per-cell `#g` fetch for the visible region.
 *  bbox is [west, south, east, north] in degrees. */
export function cellsInBbox(
  bbox: [west: number, south: number, east: number, north: number],
  length: number,
): string[] {
  const [west, south, east, north] = bbox;
  // Each base-32 character is 5 bits, alternating lng/lat starting with lng.
  // So a length-L string has ceil(5L/2) lng bits and floor(5L/2) lat bits; the
  // per-axis cell span is the world span (360° lng / 180° lat) over 2^bits.
  const totalBits = length * 5;
  const lngBits = Math.ceil(totalBits / 2);
  const latBits = Math.floor(totalBits / 2);
  const lngSpan = 360 / 2 ** lngBits;
  const latSpan = 180 / 2 ** latBits;
  // Walk the grid of cell centers covering the bbox. Clamp to valid ranges and
  // cap the count defensively — a malformed bbox shouldn't freeze the UI.
  const out: string[] = [];
  const startLat = Math.floor((south + 90) / latSpan) * latSpan - 90;
  const startLng = Math.floor((west + 180) / lngSpan) * lngSpan - 180;
  const maxCells = 2000;
  for (let lat = startLat; lat < north; lat += latSpan) {
    for (let lng = startLng; lng < east; lng += lngSpan) {
      out.push(encodeGeohash(lat + latSpan / 2, lng + lngSpan / 2, length));
      if (out.length >= maxCells) return out;
    }
  }
  return out;
}
