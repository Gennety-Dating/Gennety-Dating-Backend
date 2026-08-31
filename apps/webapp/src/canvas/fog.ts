/**
 * The Scratch Map's fog (PRODUCT_SPEC §Scratch Map).
 *
 * A dark veil over the whole city with a hole punched through it for every
 * tile this person has actually been in. Two things about that shape are
 * decisions rather than implementation:
 *
 * **The fog is translucent, not opaque.** The city under it stays legible —
 * street shapes, the river, where you are. An opaque veil would turn the map
 * into a scratch card that happens to be a city, and the canvas exists to show
 * the city. What uncovering changes is emphasis, not visibility.
 *
 * **Nothing is drawn until the tiles have arrived.** A fully-fogged map with
 * no data is strictly worse than no fog at all: it hides everything and says
 * nothing, and it looks identical to a bug. This module renders `null` for an
 * empty state and the caller simply does not add the layer.
 *
 * Pure geometry, no map library: it turns a tile list plus a viewport into an SVG
 * path string, which is the one thing here worth testing without a browser.
 *
 * **The geohash decode is inlined rather than imported**, because this
 * workspace deliberately does not depend on `@gennety/shared` (see
 * `src/i18n.ts` — the same call the localization tables make). The duplication
 * is real, so both copies are pinned to the SAME published reference vector
 * (`u4pruy`): a drift between them stops being invisible and becomes a failing
 * test on whichever side moved.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export interface TileBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

/** The box a geohash tile covers. `null` for anything that is not one. */
export function tileBounds(tile: string): TileBounds | null {
  if (tile.length !== 6) return null;

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

export interface FogViewport {
  /** Pixel size of the map container. */
  width: number;
  height: number;
  /** Projects a lat/lng to a pixel in that container. */
  project(lat: number, lng: number): { x: number; y: number };
}

/**
 * The veil as one SVG path, holes included.
 *
 * One path rather than a rectangle plus N holes because SVG's even-odd fill
 * rule does exactly this: an outer ring plus inner rings, and the inner ones
 * are cut out. N separate elements would need N composite operations and would
 * seam visibly where two uncovered tiles touch — which is the common case,
 * since a person walks through adjacent tiles.
 */
export function fogPath(
  tiles: readonly string[],
  viewport: FogViewport,
): string | null {
  if (tiles.length === 0) return null;

  const outer = `M0 0H${viewport.width}V${viewport.height}H0Z`;

  const holes: string[] = [];
  for (const tile of tiles) {
    const bounds = tileBounds(tile);
    if (!bounds) continue;

    // Latitude grows northward and pixels grow downward, so the tile's max
    // latitude is its TOP edge. Getting this backwards draws a valid rectangle
    // in the wrong place, which is the kind of wrong that looks plausible.
    const topLeft = viewport.project(bounds.maxLat, bounds.minLng);
    const bottomRight = viewport.project(bounds.minLat, bounds.maxLng);

    const x = topLeft.x;
    const y = topLeft.y;
    const w = bottomRight.x - topLeft.x;
    const h = bottomRight.y - topLeft.y;

    // A tile scrolled off-screen contributes nothing but still costs a path
    // segment, and at city zoom most of them are off-screen.
    if (x + w < 0 || y + h < 0 || x > viewport.width || y > viewport.height) continue;

    holes.push(`M${x} ${y}h${w}v${h}h${-w}Z`);
  }

  if (holes.length === 0) return null;
  return `${outer}${holes.join("")}`;
}

/**
 * How much of the city is uncovered, as the string the sheet prints.
 *
 * Rounded to one decimal and floored at 0.1% once anything at all is
 * uncovered: a single tile of Kyiv is 0.034%, and rendering "0.0%" to someone
 * who has just walked their first square tells them the feature is broken.
 */
export function formatExplored(percent: number): string {
  if (percent <= 0) return "0%";
  const shown = Math.max(0.1, Math.round(percent * 1000) / 10);
  return `${shown}%`;
}
