/**
 * "Butterflies in the stomach" — the shared loading mark for every Mini App.
 *
 * One source of truth for the markup, consumed by both rails: the vanilla-TS
 * apps drop `butterflyLoaderMarkup()` into `innerHTML`, and the React ones
 * render it through `dangerouslySetInnerHTML` (the string is fully static
 * apart from a caller-supplied label, which is escaped here). Duplicating it
 * as JSX would give the animation two definitions that drift apart.
 *
 * The butterfly is the LOGO's own path (`apps/bot/src/assets/brand/butterfly-
 * logo.svg`), split once down the body axis so the two wings can flap
 * independently. Everything else about it is untouched — including the radial
 * gradient, which is re-expressed in `userSpaceOnUse` over the full butterfly
 * bbox so the split halves keep the single continuous magenta→burgundy glow
 * the one-path logo has. An `objectBoundingBox` gradient would restart at each
 * wing and quietly turn the mark symmetric.
 *
 * Sizing/animation live in `butterfly-loader.css`, imported here so any app
 * that imports this module gets the styles with it.
 */

import "./butterfly-loader.css";
import { WING_LEFT, WING_RIGHT, escapeHtml, logoWingGradient } from "./brand-butterfly.js";

/**
 * The waist. Two open flanks, never closed at the bottom: joining them reads
 * as a jar or a bag, and the butterflies stop being *inside a person*. The
 * proportions are the load-bearing part — the rib hook has to resolve fast at
 * the top (a long taper reads as the neck of a vase), then a real waist pinch,
 * then hips as the widest point. `RIGHT` is `LEFT` mirrored about x=60.
 */
const BELLY_LEFT =
  "M 46 4 C 40 12, 28 16, 26 30 C 24 42, 29 48, 29 58 C 29 76, 17 86, 17 102 C 17 114, 19 122, 22 128";
const BELLY_RIGHT =
  "M 74 4 C 80 12, 92 16, 94 30 C 96 42, 91 48, 91 58 C 91 76, 103 86, 103 102 C 103 114, 101 122, 98 128";

/** Gradient id. Stable rather than per-call: two loaders on one page is not a
 *  real state, and if it ever happened both defs would be byte-identical, so
 *  the duplicate resolves to an identical gradient. A per-call id would
 *  instead change the markup string on every React render and restart the
 *  animation mid-wait. */
const GRADIENT_ID = "gnt-bfl-wing";

function wings(index: 1 | 2 | 3): string {
  return (
    `<g class="bfl-fly bfl-fly--${index}">` +
    `<g class="bfl-wing"><path d="${WING_LEFT}" fill="url(#${GRADIENT_ID})"/></g>` +
    `<g class="bfl-wing"><path d="${WING_RIGHT}" fill="url(#${GRADIENT_ID})"/></g>` +
    `</g>`
  );
}

export interface ButterflyLoaderOptions {
  /** Caption under the mark. Omitted → the mark alone. */
  label?: string;
  /**
   * Accessible name for the live region. Falls back to `label`; pass this
   * explicitly on a mark with no visible caption so the state is still
   * announced.
   */
  ariaLabel?: string;
}

/**
 * Markup for the loading mark, as a string.
 *
 * `role="status"` on the wrapper (not the SVG) means a screen reader announces
 * the caption when it appears; the drawing itself is decorative and hidden.
 */
export function butterflyLoaderMarkup(options: ButterflyLoaderOptions = {}): string {
  const { label, ariaLabel } = options;
  const announced = ariaLabel ?? label;
  const caption = label ? `<p class="bfl-label">${escapeHtml(label)}</p>` : "";
  return (
    `<div class="bfl" role="status"${announced ? ` aria-label="${escapeHtml(announced)}"` : ""}>` +
    `<div class="bfl-mark">` +
    `<svg class="bfl-svg" viewBox="0 0 120 132" aria-hidden="true" focusable="false">` +
    `<defs>` +
    logoWingGradient(GRADIENT_ID) +
    `</defs>` +
    `<g class="bfl-belly"><path d="${BELLY_LEFT}"/><path d="${BELLY_RIGHT}"/></g>` +
    wings(1) +
    wings(2) +
    wings(3) +
    `</svg>` +
    `</div>` +
    caption +
    `</div>`
  );
}

/** DOM-node flavour, for call sites that build with `document.createElement`. */
export function butterflyLoader(options: ButterflyLoaderOptions = {}): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = butterflyLoaderMarkup(options);
  return host.firstElementChild as HTMLElement;
}
