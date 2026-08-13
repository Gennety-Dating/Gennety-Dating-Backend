/**
 * The brand butterfly's geometry — one source of truth for every Mini App mark
 * built out of the logo.
 *
 * Two marks consume it today: the loading mark (`butterfly-loader.ts`, three
 * butterflies flying inside a waist) and the success mark
 * (`butterfly-success.ts`, one butterfly flying the checkmark). They are
 * deliberately different pictures — nerves versus their resolution — but they
 * must be the SAME butterfly, and a mark whose silhouette is a hand-copied path
 * string is a mark that drifts from the logo one edit at a time.
 *
 * Nothing here is a rendering decision. Sizing, colour and motion belong to
 * each mark's own stylesheet; this module only answers "what shape is it".
 */

/**
 * The logo butterfly, split at the body axis and re-authored around x=0 so a
 * bare `scaleX()` folds each wing about the body — no `transform-origin`, and
 * therefore no `transform-box` (which resolves differently on SVG than on
 * HTML). Coordinates are the logo's, shifted by (-50, -50).
 *
 * Splitting the one-path logo in two is what buys an independent wingbeat; at
 * rest the two halves reassemble the logo exactly, so a mark caught mid-fade is
 * still the brand rather than an approximation of it.
 */
export const WING_LEFT = "M 0 -15 C -30 -50, -60 -20, -35 5 C -55 25, -25 50, -2 15 L 0 15 Z";
export const WING_RIGHT = "M 0 -15 L 0 15 L 2 15 C 25 50, 55 25, 35 5 C 60 -20, 30 -50, 0 -15 Z";

/**
 * The butterfly's bounding box in the re-authored (origin-centred) space, i.e.
 * the logo's own bbox shifted by (-50, -50).
 *
 * Exported because a mark that scales the butterfly has to know how big it
 * actually is: `scale(0.4)` means nothing on its own, and the success mark sizes
 * its flight so the landed butterfly clears the viewBox edge. Measuring it by
 * eye is how a wing ends up clipped on one locale's screen and nobody's.
 */
export const WING_BBOX = { width: 88.63, height: 63.44 } as const;

/**
 * The logo's radial wing gradient, as a `<defs>`-ready string.
 *
 * `userSpaceOnUse` over the FULL butterfly bbox (x 5.69..94.31, y 19.07..82.51
 * in logo coords, shifted by (-50, -50)) is the load-bearing part: the wings are
 * two separate paths, so an `objectBoundingBox` gradient would restart at each
 * one and quietly turn the butterfly symmetric, losing the off-centre magenta
 * glow the single-path logo has.
 *
 * Because the units are user space, the gradient is evaluated in the coordinate
 * system of the element referencing it — so it travels and scales WITH a
 * transformed butterfly instead of staying pinned to the SVG root. That is what
 * lets one definition serve three butterflies at three scales (the loader) and a
 * butterfly in flight (the success mark) with no per-instance gradient.
 *
 * @param id  Referenced as `fill="url(#id)"`. Each mark passes its own so two
 *            marks briefly coexisting on one page (a React transition from
 *            loading to success) cannot collide on a document-wide id.
 */
export function logoWingGradient(id: string): string {
  return (
    `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="-17.73" cy="32.51" r="88.63">` +
    `<stop offset="0%" stop-color="#FF00FF"/>` +
    `<stop offset="30%" stop-color="#C82356"/>` +
    `<stop offset="70%" stop-color="#8B253B"/>` +
    `<stop offset="100%" stop-color="#3B0B1E"/>` +
    `</radialGradient>`
  );
}

/** Escapes a caller-supplied caption for interpolation into a markup string. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
