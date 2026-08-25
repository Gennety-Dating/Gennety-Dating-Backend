/**
 * Geohash, at exactly the resolution the Scratch Map stores
 * (PRODUCT_SPEC §Scratch Map).
 *
 * **This module is the privacy guarantee, not a coordinate utility.** Every
 * other geo value in the product is per-purpose and per-match — a departure
 * pin for ONE date, a venue for ONE evening — and disappears with the row that
 * held it. The scratch map is the first thing that ACCUMULATES, so the promise
 * "we can say Podil and never say which building" has to be a property of what
 * is written rather than a rule someone remembers at the call site. Precision 6
 * is ~1.2 km × 0.61 km: a neighbourhood, and nothing narrower is representable.
 *
 * Deliberately no `decode` to a point. A tile is an area; handing callers a
 * centre invites treating it as a location, which is the exact conversion this
 * file exists to make impossible. `tileBounds` returns the box, which is what a
 * map layer and a tile count both actually need.
 *
 * The precision itself lives in `date-lifecycle.ts` beside the rest of the
 * canvas's product constants, not here: it is the guarantee, and the guarantee
 * belongs with the feature rather than with the encoder that happens to
 * implement it.
 */

import { SCRATCH_TILE_PRECISION } from "./date-lifecycle.js";

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface TileBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/**
 * The geohash cell containing a point, at the Scratch Map's precision.
 *
 * Coordinates outside the real world answer `null` rather than clamping: a
 * client that sends latitude 500 has a bug, and silently filing it under the
 * north pole would put a tile on someone's map that they never stood in.
 */
export function tileFor(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;

  let hash = "";
  let bits = 0;
  let value = 0;
  // Geohash interleaves the two axes starting with longitude, which is why
  // a cell is twice as wide as it is tall at even precisions.
  let useLng = true;

  while (hash.length < SCRATCH_TILE_PRECISION) {
    if (useLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lng >= mid) {
        value = (value << 1) + 1;
        lngMin = mid;
      } else {
        value = value << 1;
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        value = (value << 1) + 1;
        latMin = mid;
      } else {
        value = value << 1;
        latMax = mid;
      }
    }
    useLng = !useLng;

    if (++bits === 5) {
      hash += BASE32[value];
      bits = 0;
      value = 0;
    }
  }

  return hash;
}

/** The box a tile covers. `null` for anything that is not a tile of ours. */
export function tileBounds(tile: string): TileBounds | null {
  if (tile.length !== SCRATCH_TILE_PRECISION) return null;

  let latMin = -90;
  let latMax = 90;
  let lngMin = -180;
  let lngMax = 180;
  let useLng = true;

  for (const char of tile) {
    const index = BASE32.indexOf(char);
    if (index < 0) return null;

    for (let bit = 4; bit >= 0; bit--) {
      const on = (index >> bit) & 1;
      if (useLng) {
        const mid = (lngMin + lngMax) / 2;
        if (on) lngMin = mid;
        else lngMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (on) latMin = mid;
        else latMax = mid;
      }
      useLng = !useLng;
    }
  }

  return { minLat: latMin, maxLat: latMax, minLng: lngMin, maxLng: lngMax };
}

/** Whether a string is a tile this product would have written. */
export function isTile(value: string): boolean {
  return (
    value.length === SCRATCH_TILE_PRECISION &&
    [...value].every((char) => BASE32.includes(char))
  );
}
