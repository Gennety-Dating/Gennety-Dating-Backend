/**
 * The inline "are you sure" of the ticket gate — the same two-tap ask the native
 * app uses for «Мне подходит» (`TimeAcceptRow`), «Иду» on the pitch and
 * «Беру на себя» on the gate (iOS decisions 2026-10-23, 2026-10-25, 2026-10-30).
 *
 * The first tap only opens the question: the button is overlaid by a glass
 * capsule «Подтвердить» + «✕». The second tap commits. Two guards, both copied
 * from iOS so the clients feel the same under the finger:
 *
 *  - `ASK_GUARD_MS` — «Подтвердить» lands under the very finger that opened it,
 *    so for the first 350 ms it does not listen: the second half of a double
 *    tap must not spend a ticket.
 *  - `ASK_HOLD_MS` — an abandoned question closes by itself after 6 s, unless a
 *    request is in flight (then it stays until the answer lands).
 *
 * Pure — no React, no timers — so the rules are unit-tested (confirm-ask.test.ts).
 */
export const ASK_GUARD_MS = 350;
export const ASK_HOLD_MS = 6000;

/** Whether a tap on «Подтвердить» at `now` may commit a question opened at `armedAt`. */
export function canConfirm(armedAt: number | null, now: number): boolean {
  if (armedAt == null) return false;
  return now - armedAt >= ASK_GUARD_MS;
}

/**
 * Whether an open question should fold back on its own at `now`. A request in
 * flight holds it open — the capsule must not vanish under a spend that may
 * still come back refused.
 */
export function shouldAutoClose(armedAt: number | null, now: number, working: boolean): boolean {
  if (armedAt == null || working) return false;
  return now - armedAt >= ASK_HOLD_MS;
}
