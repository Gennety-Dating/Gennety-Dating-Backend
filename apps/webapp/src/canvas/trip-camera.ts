/**
 * Where the camera goes to show a whole trip: the user's own point, the venue,
 * and the line between them (change of 2026-09-13).
 *
 * Pure mercator arithmetic, and deliberately NOT `map.fitBounds`. MapLibre's
 * fit adds the camera's standing padding to the padding it is handed, while
 * the canvas eases that standing padding on its own every time the dock changes
 * height (`frameAbove`). Two camera moves then cut each other short, and which
 * one wins is a matter of milliseconds:
 * - a fit stopped where it started left the camera at the venue's own zoom,
 *   with the user's end of the line a screen and a half off the edge;
 * - a finished fit had already stopped the padding's ease, stranding it half
 *   way.
 * Computed here, the target carries its padding with it: ONE `easeTo` makes the
 * whole move, and a later one re-aims it instead of breaking it.
 */

/** Pixels per side, in the order CSS writes them. */
export interface Edges {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface TripCameraInput {
  from: { lat: number; lng: number };
  to: { lat: number; lng: number };
  /** The map container, in CSS pixels. */
  width: number;
  height: number;
  /**
   * What the sheet and the dock cover. It becomes the camera's padding, so the
   * centre of the map is the centre of what is left uncovered.
   */
  cover: Edges;
  /** Room kept inside what is left, so the pins are never cut by an edge. */
  margin: Edges;
  /** Never closer than this: two points a street apart are not a close-up. */
  maxZoom: number;
}

export interface TripCamera {
  lat: number;
  lng: number;
  zoom: number;
}

/** MapLibre's world: one 512 px square at zoom 0. */
const TILE_SIZE = 512;

/** Web-mercator, as MapLibre does it: x and y in 0..1, y growing southward. */
export function toWorld(lat: number, lng: number): { x: number; y: number } {
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

export function fromWorld(x: number, y: number): { lat: number; lng: number } {
  return {
    lat: (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90,
    lng: x * 360 - 180,
  };
}

/**
 * The camera that frames both ends: as close as the room allows (never past
 * `maxZoom`), with the pair centred in the box the cover and the margins leave.
 * `null` when there is no box left at all, which is when the caller should not
 * move the camera.
 */
export function tripCamera(input: TripCameraInput): TripCamera | null {
  const { from, to, width, height, cover, margin, maxZoom } = input;
  const roomX = width - cover.left - cover.right - margin.left - margin.right;
  const roomY = height - cover.top - cover.bottom - margin.top - margin.bottom;
  if (!(roomX > 0 && roomY > 0)) return null;

  const a = toWorld(from.lat, from.lng);
  const b = toWorld(to.lat, to.lng);
  // The pair's extent at zoom 0, in pixels.
  const spanX = Math.abs(a.x - b.x) * TILE_SIZE;
  const spanY = Math.abs(a.y - b.y) * TILE_SIZE;
  const fit = Math.min(spanX > 0 ? roomX / spanX : Infinity, spanY > 0 ? roomY / spanY : Infinity);
  const zoom = Math.min(maxZoom, Math.log2(fit));
  const scale = TILE_SIZE * 2 ** zoom;

  // With the cover as the padding, the camera's centre is drawn at the centre
  // of the uncovered area; the pair belongs at the centre of the box inside the
  // margins. Uneven margins put those two apart by half their difference.
  const offsetX = (margin.left - margin.right) / 2;
  const offsetY = (margin.top - margin.bottom) / 2;
  const centre = fromWorld((a.x + b.x) / 2 - offsetX / scale, (a.y + b.y) / 2 - offsetY / scale);
  return { lat: centre.lat, lng: centre.lng, zoom };
}
