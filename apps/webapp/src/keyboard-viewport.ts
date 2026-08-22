/**
 * How much of the bottom of the onboarding shell the soft keyboard covers,
 * mirrored into `--kb-height` so the screens that own a text field can make
 * room for it (`.ob-basics--name`, `.gate-main`, `.gate-card`).
 *
 * The whole subtlety is WHAT the keyboard height is measured against, because
 * the CSS spends it as `calc(100% - var(--kb-height))` — and `100%` chains up
 * to `.onboarding-shell { height: 100dvh }`. So the reference has to be the
 * height that same `100dvh` currently resolves to, read at the same instant.
 *
 * Clients disagree about how a keyboard appears, and the two cases need the
 * same answer out of this function:
 *
 *  - it FLOATS over the page (iOS Safari's own behaviour): the layout viewport
 *    is untouched, `visualViewport.height` shrinks. The shell is still full
 *    height, so the inset is the difference — the screen shrinks by a keyboard.
 *  - the WebView is RESIZED for it (what Telegram's client does): the layout
 *    viewport shrinks, so `100dvh` — and the shell with it — has ALREADY made
 *    room. The inset must then be ZERO, or the screen makes room twice.
 *
 * The second case is the bug this module exists for. Measured on a 393x852
 * iPhone with a 298px keyboard: the name screen's box came out 235px tall in a
 * 554px space above the keyboard, i.e. one keyboard short of the room it had —
 * the shell was already 554 and 298 was subtracted from it anyway. It happened
 * intermittently because `window.innerHeight` was the reference and was only
 * re-read when `visualViewport` fired: the visual viewport shrinks first, the
 * layout viewport a beat later, and nothing asked again after that.
 *
 * Passing the shell's own live height makes both cases fall out of one
 * subtraction, with no branch on which kind of client this is.
 */

/**
 * Smallest `--kb-height` change worth writing. Deliberately tiny: it only
 * exists to absorb the per-pixel ramp WebKit produces while scrolling a focused
 * field into view, and a bigger step would leave the pill sitting up to that
 * many pixels off the top of the keyboard once the ramp settles.
 */
export const KB_HEIGHT_STEP_PX = 2;

export interface KeyboardInsetInput {
  /**
   * Live height of the element `calc(100% - ...)` resolves against — the
   * onboarding shell. NOT `window.innerHeight`: the two are the same number
   * right up until the moment that matters (see above).
   */
  shellHeight: number;
  /** `visualViewport.height` — the part of the page actually on screen. */
  viewportHeight: number;
  /**
   * `visualViewport.offsetTop` — how far the visible area has been scrolled
   * down inside the layout viewport. It reduces what is hidden at the BOTTOM,
   * which is the only thing this inset describes; the matching loss at the top
   * is a known imprecision, not something this value can express.
   */
  viewportOffsetTop: number;
}

/** The bottom inset to reserve, in CSS pixels. Never negative. */
export function keyboardInset(input: KeyboardInsetInput): number {
  const { shellHeight, viewportHeight, viewportOffsetTop } = input;
  // A shell that has not been laid out yet (0) must not be read as "the whole
  // viewport is covered" — reserve nothing until there is something to measure.
  if (!(shellHeight > 0) || !(viewportHeight > 0)) return 0;
  return Math.round(Math.max(0, shellHeight - viewportHeight - viewportOffsetTop));
}

/** Whether a freshly computed inset is a big enough change to write out. */
export function isWorthWriting(previous: number | null, next: number): boolean {
  if (previous === null) return true;
  return Math.abs(next - previous) >= KB_HEIGHT_STEP_PX;
}
