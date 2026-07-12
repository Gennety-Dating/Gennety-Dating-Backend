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
  | "star"
  | "spark"
  | "bolt"
  | "letter"
  | "check"
  | "chevron";

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
  map: {
    d: [
      "M9 4.6 3.6 6.8V20l5.4-2.2 6 2.2 5.4-2.2V4.6L15 6.8 9 4.6Z",
      "M9 4.6v13.2M15 6.8V20",
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
  chevron: {
    d: ["M9.2 5.6 15.6 12l-6.4 6.4"],
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
