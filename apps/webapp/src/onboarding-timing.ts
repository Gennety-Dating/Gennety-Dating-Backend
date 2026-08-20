const LONG_LINE_MIN_CHARS = 50;
const LONG_LINE_HOLD_MS = 2200;

export function typewriterLineHoldMs(
  parts: readonly string[],
  baseHoldMs: number,
): number {
  const lineLength = parts.join("").trim().length;
  return lineLength >= LONG_LINE_MIN_CHARS
    ? Math.max(baseHoldMs, LONG_LINE_HOLD_MS)
    : baseHoldMs;
}

/**
 * The gender screen's colour bloom (§1.3): the portrait goes from warm
 * monochrome to full colour on the tap that commits the answer.
 *
 * `GENDER_REVEAL_MS` is the CSS transition's own duration and must stay equal
 * to `--gender-reveal` in onboarding.css; a test reads both.
 *
 * `GENDER_ADVANCE_HOLD_MS` is the floor the screen is held for before it
 * advances, and it exists because the tap both starts the reaction and ends the
 * screen: without it the bloom is cut off by the scene change at whatever point
 * the save happened to return. It is a real addition to the onboarding funnel,
 * so it is a named number with a ceiling a test enforces rather than something
 * that drifts one retune at a time — the same treatment the success mark's
 * timings get. The hold runs in PARALLEL with the request, so a tap costs
 * `max(request, hold)` rather than their sum.
 */
export const GENDER_REVEAL_MS = 520;
export const GENDER_ADVANCE_HOLD_MS = 600;

/** Ceiling on what this screen may add to the funnel. */
export const GENDER_ADVANCE_HOLD_CEILING_MS = 900;
