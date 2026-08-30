/**
 * Type Radar deck navigation — the pure half.
 *
 * The deck answers 12 cards client-side and POSTs the whole array once at the
 * end (`submitRadar`), so "go back and change my mind" is entirely local: no
 * request to undo, no server state to reconcile, no `/v1/*` change. That is the
 * only reason this is cheap, and it is worth knowing before anyone moves the
 * submit earlier — a per-card write would make undo a server concern.
 *
 * The rules live here rather than inside the component because this package has
 * no DOM test environment (vitest runs plain Node), so a decision that is not
 * extracted is a decision that is not tested. Same split as `onboarding-wheel`,
 * `calendar-selection` and `market-gate`.
 */
import type { RadarAnswerInput } from "../api.js";

export type DeckPhase = "rating" | "chips";

export interface DeckNavState {
  /** Card currently on screen. Invariant: equals `answers.length` — a card is
   *  recorded and advanced past in the same step, and stepped back the same
   *  way, so the two can never drift. */
  index: number;
  answers: RadarAnswerInput[];
  phase: DeckPhase;
}

/**
 * Minimum gap between two COMMITTING taps (a verdict, or a reason chip).
 *
 * This is the founder's "случайно два раза нажал одну и ту же кнопку" case, and
 * it is a real geometry problem rather than clumsiness: the next card mounts
 * under the same two buttons at the same coordinates, and the reason-chip panel
 * opens over that same foot of the card — so a double-tap lands a second, real
 * answer on a photo the user never saw.
 *
 * 350 ms is above a double-tap (iOS treats up to ~300 ms as one gesture) and far
 * below any deliberate look-at-a-face-and-decide, which is seconds. So the
 * false-positive cost is one repeated tap; the cost of not having it is a wrong
 * answer written into the preference vector.
 *
 * Deliberately NOT applied to the back control: that is the recovery path, and
 * the moment a user reaches for it is the instant after the tap that armed this
 * lockout. Blocking undo for 350 ms right when it is wanted is worse than an
 * over-shot back, which is visible on screen and undone by simply re-answering.
 */
export const TAP_LOCKOUT_MS = 350;

export function shouldAcceptTap(lastTapAt: number, now: number): boolean {
  return now - lastTapAt >= TAP_LOCKOUT_MS;
}

/** Is there anything to undo? Also decides whether the control is rendered at
 *  all — a back arrow on the very first card would do nothing, and a button
 *  that does nothing is its own bug. */
export function canStepBack(state: Pick<DeckNavState, "phase" | "answers">): boolean {
  return state.phase === "chips" || state.answers.length > 0;
}

/**
 * One step back, or the state unchanged when there is nothing to undo.
 *
 * Two different meanings, and the order matters. With the "why?" panel open the
 * verdict is chosen but NOT yet recorded, so back cancels that verdict and
 * re-offers the same card — the user's likely intent there is to pick the other
 * verdict, not to leave the card. Only from the rating phase does back drop the
 * previous answer and re-ask the previous card.
 *
 * A stepped-back card is re-asked clean (rating phase, no pending verdict): its
 * answer is popped rather than kept, so re-answering REPLACES it instead of
 * appending a second entry for the same photo.
 */
export function stepBack(state: DeckNavState): DeckNavState {
  if (state.phase === "chips") return { ...state, phase: "rating" };
  if (state.answers.length === 0) return state;
  return {
    index: state.index - 1,
    answers: state.answers.slice(0, -1),
    phase: "rating",
  };
}
