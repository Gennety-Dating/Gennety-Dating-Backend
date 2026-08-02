/**
 * A two-way handshake between a background unit of work and the "agent is
 * working" status narrating it in the chat (`runStatusSequence`).
 *
 * The problem it solves: a status sequence and the work it describes are two
 * independent async chains. When the work is fast — and AWS Face Liveness plus
 * `CompareFaces` on three photos often is — its result message lands *while*
 * the shimmer is still saying "finishing the check". The user reads the verdict
 * ("these photos aren't you") underneath a status claiming the check is still
 * running, which reads as the bot contradicting itself.
 *
 * `until` alone cannot fix this: it tells the status when the work is done, but
 * nothing tells the work when the status is off the screen. So this carries
 * both signals:
 *
 *   work side      → `hold()`   before every user-facing message; resolves once
 *                               the narration has been torn down.
 *                  → `finish()` when the run is over with nothing more to say,
 *                               so a silent run doesn't leave the status
 *                               holding until the safety cap.
 *   narration side → `settled`  as the sequence's `until`, so a slow run holds
 *                               the last beat instead of ending in silence.
 *                  → `release()` once the status is gone.
 *
 * Ordering guarantee: the first held message is sent only after `release()`.
 * Everything after that passes straight through — the gate opens once.
 */

/**
 * Ceiling on the whole handshake. After this the gate stops coordinating in
 * BOTH directions — held messages go out, and `settled` resolves — so neither
 * side can strand the other: a narration that dies before its teardown can
 * never swallow the verdict, and a work item that hangs can never keep a
 * shimmer re-issuing itself forever. Comfortably above the ~7s script plus a
 * slow face-match run over a full photo set.
 */
export const OUTCOME_GATE_MAX_HOLD_MS = 30_000;

export interface OutcomeGate {
  /**
   * Resolves as soon as the work is ready to speak (first `hold()`) — or has
   * finished with nothing to say (`finish()`). Pass as the status sequence's
   * `until` so a slow run holds its last beat rather than falling silent.
   */
  readonly settled: Promise<void>;
  /**
   * Work side: hold this user-facing message until the narration is off the
   * screen. Resolves immediately once the gate is open.
   */
  hold(): Promise<void>;
  /** Work side: the run is over and had nothing (more) to say. Idempotent. */
  finish(): void;
  /** Narration side: the status is gone — let held messages through. Idempotent. */
  release(): void;
}

/**
 * Create a gate. The safety cap is armed at construction, not at the first
 * `hold()`: a narration that throws before it ever reaches its teardown would
 * otherwise leave the work waiting forever, and "the status broke" must never
 * become "the user never heard the verdict". The timer is unref'd so it can
 * never hold the process open.
 */
export function createOutcomeGate(maxHoldMs: number = OUTCOME_GATE_MAX_HOLD_MS): OutcomeGate {
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  let markOpen!: () => void;
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });

  const release = (): void => {
    clearTimeout(timer);
    markOpen();
  };
  const timer = setTimeout(() => {
    markSettled();
    markOpen();
  }, maxHoldMs);
  timer.unref?.();

  return {
    settled,
    async hold(): Promise<void> {
      markSettled();
      await opened;
    },
    finish(): void {
      markSettled();
    },
    release,
  };
}
