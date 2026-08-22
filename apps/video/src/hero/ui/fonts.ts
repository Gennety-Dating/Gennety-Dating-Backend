import {continueRender, delayRender} from "remotion";

/**
 * Hold the render until Unbounded 700 is actually loaded.
 *
 * `src/index.css` has declared this family since the workspace was set up, but
 * **nothing had ever rendered a glyph in it** — the hero's only drawn line was
 * Roboto and the ad has its own type. So the declaration was never exercised,
 * and an `@font-face` that is merely declared is not a font that is ready: the
 * browser fetches it lazily, on first use, and Remotion captures frames as fast
 * as it can. A slogan card rendered a few milliseconds early does not fail — it
 * silently falls through to Roboto, which is narrower, so the line does not even
 * overflow to give the mistake away. It just stops being the brand's type.
 *
 * Two sample strings rather than one, and that is the load-bearing detail. The
 * family is declared TWICE with `unicode-range` (a Cyrillic subset and a Latin
 * one), which is what lets «Щоб бути щасливим,» take its letters from one file
 * and its comma from the other. `document.fonts.load` resolves the ranges
 * against the text it is given, so asking with Cyrillic alone would fetch one
 * file and leave the other to load lazily — i.e. exactly the original problem,
 * narrowed to the punctuation and to the word "Telegram".
 */
const handle = delayRender("Unbounded 700 (both unicode subsets)");

const ready =
  typeof document === "undefined" || !document.fonts
    ? Promise.resolve()
    : Promise.all([
        document.fonts.load('700 86px "Unbounded"', "Щоб"),
        document.fonts.load('700 86px "Unbounded"', "Telegram,"),
      ]);

// Never block the render on a font failure: a fallback frame is recoverable,
// a render that dies at 90% is not.
ready.then(
  () => continueRender(handle),
  () => continueRender(handle),
);
