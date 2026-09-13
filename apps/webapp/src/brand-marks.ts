/**
 * The partners' own marks, for the transit dock's buttons.
 *
 * A separate file from `icons.ts` on purpose: that set is the HOUSE set — one
 * 24×24 box, 1.6 stroke, `currentColor`, no fill — and it exists so the app's
 * glyphs look like one hand drew them. These do the opposite job. A maps button
 * is recognised before it is read, and it is recognised by a palette that is
 * not ours: the moment Google's pin is redrawn in our stroke weight and our
 * ink, it stops being the thing the thumb is looking for. So they keep their
 * own colours and their own fills, and they stay out of `IconName` so nobody
 * reaches for them where a house glyph belongs.
 *
 * **These are the apps' own logos, not redrawings.** A pared-down drawn tile
 * shipped here first and was replaced at the founder's request: a lookalike is
 * exactly the thing that makes a thumb hesitate over a button whose only job is
 * to be recognised. Apple's is the home-screen tile, Google's is the bare pin —
 * each app's current mark as its owner shows it, so the pair is deliberately
 * not two matching squares.
 *
 * Prepared by `~/Desktop/Gennety-отчёт/транспортный-док/prepare-maps-marks.py`
 * (crop to the mark, centre in a square, 108 px — 4× the 27 px they are drawn
 * at). Never copy an original in by hand: they are 1280 px against ~5 KB here.
 */
import appleMapsMark from "./brand/apple-maps.webp";
import googleMapsMark from "./brand/google-maps.webp";

export type BrandMarkName = "apple-maps" | "google-maps";

const MARKS: Readonly<Record<BrandMarkName, string>> = {
  "apple-maps": appleMapsMark,
  "google-maps": googleMapsMark,
};

export function brandMark(name: BrandMarkName, className = "brand-mark"): HTMLImageElement {
  const img = document.createElement("img");
  img.src = MARKS[name];
  img.className = className;
  // The button carries the name; a second announcement of the same thing is
  // noise in a screen reader.
  img.alt = "";
  img.setAttribute("aria-hidden", "true");
  img.draggable = false;
  img.decoding = "async";
  return img;
}
