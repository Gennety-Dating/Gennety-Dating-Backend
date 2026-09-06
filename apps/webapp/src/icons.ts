/**
 * Authored icon set for the Mini Apps.
 *
 * Deliberately NOT emoji: a platform emoji renders as Apple's art on iOS,
 * Google's on Android and a font glyph on the web, and scaling/animating that
 * glyph rasterizes it (the venue-change heart went soft along its bottom edge).
 * These are hand-drawn vectors on a single 24×24 grid, inheriting `currentColor`
 * and stroke width from CSS, so one icon looks identical on every surface and
 * stays crisp at any size or scale.
 *
 * House style: 24×24 box, 1.6 stroke, round caps/joins, no fill unless the icon
 * is a "solid" state (a filled heart, a rating star).
 */

const NS = "http://www.w3.org/2000/svg";

export type IconName =
  | "heart"
  | "heart-filled"
  | "coffee"
  | "restaurant"
  | "park"
  | "museum"
  | "lounge"
  | "pin"
  | "map"
  | "map-nav"
  | "map-pin"
  | "map-fold"
  | "map-route"
  | "star"
  | "spark"
  | "bolt"
  | "letter"
  | "check"
  | "chevron"
  | "lock"
  | "ticket"
  | "close";

/** The 4 candidate map icon variants for live in-app comparison. */
export const MAP_VARIANTS = ["map-nav", "map-pin", "map-fold", "map-route"] as const;
export type MapVariantName = (typeof MAP_VARIANTS)[number];

/**
 * Rotate through candidate map icons by index so each card showcases a variant:
 * 0 -> map-nav (Navigation Arrow)
 * 1 -> map-pin (Bold Geo-Pin)
 * 2 -> map-fold (Clean Folded Map)
 * 3 -> map-route (Route Waypoint)
 */
export function getRotatingMapIcon(index: number): IconName {
  const safeIdx = Math.abs(Math.floor(index)) % MAP_VARIANTS.length;
  return MAP_VARIANTS[safeIdx];
}

/**
 * Path data per icon. `solid: true` icons paint with `fill: currentColor` and
 * no stroke (a filled heart reads as a state, not an outline).
 */
const ICONS: Record<IconName, { d: string[]; solid?: boolean }> = {
  // Outline heart — the "not picked yet" state.
  heart: {
    d: [
      "M12 20.3s-7.4-4.6-9.1-9.2C1.7 7.7 3.6 4.5 6.8 4.5c2 0 3.6 1.1 4.4 2.7l.8 1.5.8-1.5c.8-1.6 2.4-2.7 4.4-2.7 3.2 0 5.1 3.2 3.9 6.6-1.7 4.6-9.1 9.2-9.1 9.2Z",
    ],
  },
  // Solid heart — "I picked this".
  "heart-filled": {
    d: [
      "M12 20.3s-7.4-4.6-9.1-9.2C1.7 7.7 3.6 4.5 6.8 4.5c2 0 3.6 1.1 4.4 2.7l.8 1.5.8-1.5c.8-1.6 2.4-2.7 4.4-2.7 3.2 0 5.1 3.2 3.9 6.6-1.7 4.6-9.1 9.2-9.1 9.2Z",
    ],
    solid: true,
  },
  coffee: {
    d: [
      "M4 9h12v5.5a4.5 4.5 0 0 1-4.5 4.5h-3A4.5 4.5 0 0 1 4 14.5V9Z",
      "M16 10.5h1.8a2.4 2.4 0 0 1 0 4.8H16",
      "M7.5 3.2v2.4M11 2.6v3",
    ],
  },
  restaurant: {
    d: [
      "M6.4 3v6.2a2 2 0 0 0 2 2h.1a2 2 0 0 0 2-2V3",
      "M8.5 11.2V21",
      "M17.3 3c-1.6 0-2.6 1.7-2.6 4.3 0 2 .8 3.2 2 3.6V21",
    ],
  },
  park: {
    d: [
      "M12 3.2 7.2 10h2.6L6.6 14.6h10.8L14.2 10h2.6L12 3.2Z",
      "M12 14.6V21",
      "M9.4 21h5.2",
    ],
  },
  museum: {
    d: [
      "M3.6 9.2 12 4l8.4 5.2",
      "M5.6 9.8V17M10 9.8V17M14 9.8V17M18.4 9.8V17",
      "M3.6 20h16.8",
    ],
  },
  lounge: {
    d: [
      "M4.5 4.5h15L12 12.4 4.5 4.5Z",
      "M12 12.4V20",
      "M8.4 20h7.2",
    ],
  },
  pin: {
    d: [
      "M12 21s6.4-5.3 6.4-10.2A6.4 6.4 0 0 0 5.6 10.8C5.6 15.7 12 21 12 21Z",
      "M12 13a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z",
    ],
  },
  // Default map icon — solid modern Geo-Pin with cutout dot.
  map: {
    d: [
      "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7Zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5Z",
    ],
    solid: true,
  },
  // Candidate 1: Modern Navigation Arrow (dynamic 45° navigation pointer).
  "map-nav": {
    d: [
      "M3.8 11.3a1 1 0 0 1 .4-1.2L19.2 3.6a1 1 0 0 1 1.2 1.2L13.9 19.8a1 1 0 0 1-1.2.4l-3-1.5a1 1 0 0 0-.5-.1L3.8 11.3Z",
      "M10.2 13.8 15 9",
    ],
  },
  // Candidate 2: Bold Modern Geo-Pin (well-proportioned teardrop pin with center dot).
  "map-pin": {
    d: [
      "M12 21.5c-3.5-3.8-7-8.2-7-12a7 7 0 1 1 14 0c0 3.8-3.5 8.2-7 12Z",
      "M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    ],
  },
  // Candidate 3: Clean Folded Map (geometric 3-panel map with clean diagonals).
  "map-fold": {
    d: [
      "M9 5 3.5 7.5v12L9 17l6 2.5 5.5-2.5V5L15 7.5 9 5Z",
      "M9 5v12M15 7.5v12",
    ],
  },
  // Candidate 4: Location Route Waypoint (route connecting start to destination node).
  "map-route": {
    d: [
      "M6 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
      "M18 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
      "M6 15.5V11a5 5 0 0 1 5-5h4.5",
    ],
  },
  star: {
    d: ["M12 3.6l2.5 5.1 5.6.8-4 3.9 1 5.6-5.1-2.7-5 2.7 1-5.6-4.1-3.9 5.6-.8L12 3.6Z"],
    solid: true,
  },
  /**
   * The paired-sparkle mark — our "we agree / it's a match" symbol. Drawn with
   * deliberately FAT lobes (the control points sit well off the axis) so the
   * silhouette survives on a photo, a burgundy fill or a white button alike; a
   * thin four-point star disappears against busy backgrounds.
   */
  spark: {
    d: [
      "M12 2.6c1 4 2 5 6 6-4 1-5 2-6 6-1-4-2-5-6-6 4-1 5-2 6-6Z",
      "M18.6 14.8c.5 2 1 2.5 3 3-2 .5-2.5 1-3 3-.5-2-1-2.5-3-3 2-.5 2.5-1 3-3Z",
    ],
    solid: true,
  },
  bolt: {
    d: ["M13.4 2.8 5.2 13.4h5.4l-.8 7.8 8.2-10.6h-5.4l.8-7.8Z"],
    solid: true,
  },
  // Envelope with a heart seal — "ask them to cover it".
  letter: {
    d: [
      "M3.6 6.8h16.8v10.4H3.6V6.8Z",
      "M3.6 7.2 12 13l8.4-5.8",
      "M12 18.6c-1.6-1-2.6-1.9-2.6-3 0-.8.6-1.4 1.4-1.4.5 0 .9.2 1.2.6.3-.4.7-.6 1.2-.6.8 0 1.4.6 1.4 1.4 0 1.1-1 2-2.6 3Z",
    ],
  },
  check: {
    d: ["M4.8 12.6 9.6 17.4l9.6-10.8"],
  },
  // Date ticket — a rounded stub with side notches and a perforation line.
  ticket: {
    d: [
      "M5 8h14v3a1.5 1.5 0 0 0 0 3v3H5v-3a1.5 1.5 0 0 0 0-3z",
      "M14 8v2M14 13v1M14 16v1",
    ],
  },
  chevron: {
    d: ["M9.2 5.6 15.6 12l-6.4 6.4"],
  },
  // Padlock — the "premium, locked" state: a venue's select button, the Premium
  // screen's own benefit row, and the calendar's evening band.
  //
  // SOLID, not stroked, and that is the one decision here. Every surface that
  // draws this glyph draws it small (13–15px) beside type that is 10–18px and
  // 600–800 weight; at that size a 1.6 outline is thinner than the letters next
  // to it and the lock reads as a hairline sketch rather than as a lock. Filled
  // body + a filled shackle of the same weight keeps it legible as one shape at
  // any size, white on burgundy or neutral ink on a pale slab.
  //
  // The shackle is a closed staple — outer arc out, inner arc back — rather
  // than a stroked line, so it never thins out when the icon is scaled down;
  // it overlaps the body by ~1px so the two fills never show a seam between.
  lock: {
    d: [
      "M6.8 10.9V8.6a5.2 5.2 0 0 1 10.4 0v2.3H15V8.6a3 3 0 0 0-6 0v2.3Z",
      "M7.6 10h8.8a3.3 3.3 0 0 1 3.3 3.3v4a3.3 3.3 0 0 1-3.3 3.3H7.6a3.3 3.3 0 0 1-3.3-3.3v-4A3.3 3.3 0 0 1 7.6 10Z",
    ],
    solid: true,
  },
  // Dismiss — the fullscreen photo viewer's own close control. Distinct from
  // Telegram's floating × (which closes the whole Mini App), so it sits inside
  // its own tinted disc rather than floating bare on the photo.
  close: {
    d: ["M6.6 6.6 17.4 17.4", "M17.4 6.6 6.6 17.4"],
  },
};

/**
 * Build an `<svg>` element for `name`. `cls` is applied to the root so callers
 * size/color it from CSS (`width`, `height`, `color`, `stroke-width`).
 */
export function icon(name: IconName, cls = "icon"): SVGSVGElement {
  const spec = ICONS[name];
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  // Vector-correct rendering at any transform — the reason these replaced emoji.
  svg.setAttribute("shape-rendering", "geometricPrecision");

  for (const d of spec.d) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    if (spec.solid) {
      path.setAttribute("fill", "currentColor");
    } else {
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.6");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
    }
    svg.appendChild(path);
  }
  return svg;
}

/** Venue category → its authored mark. Unknown categories fall back to a pin. */
export function categoryIcon(category: string, cls = "icon"): SVGSVGElement {
  const map: Record<string, IconName> = {
    cafe: "coffee",
    coffee_shop: "coffee",
    restaurant: "restaurant",
    park: "park",
    museum: "museum",
    lounge: "lounge",
  };
  return icon(map[category] ?? "pin", cls);
}
