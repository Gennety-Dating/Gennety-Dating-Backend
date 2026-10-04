/**
 * The hold — the gesture that replaced the shake (2026-09-29).
 *
 * Press the capsule and keep the finger on it for `HOLD_COMMIT_MS`; the fill
 * shows how long is left. Lifting early cancels. At the mark the hold COMMITS:
 * the request goes out, and from then on the finger no longer matters — the
 * server holds the request open for the partner, and lifting the finger while
 * it waits cancels nothing. The capsule comes back only when the server has
 * answered (`settle`).
 *
 * Pure, so the terminal's timing is tested without a finger.
 */

export const HOLD_COMMIT_MS = 600;

export type HoldState =
  | { kind: "idle" }
  | { kind: "pressing"; since: number }
  | { kind: "waiting"; since: number };

export type HoldEvent =
  | { type: "press"; at: number }
  | { type: "release"; at: number }
  | { type: "tick"; at: number }
  /** The server answered (either way) or the hold failed to send. */
  | { type: "settle" };

export interface HoldStep {
  state: HoldState;
  /** True exactly once per hold: send it now. */
  commit: boolean;
}

export const HOLD_IDLE: HoldState = { kind: "idle" };

export function holdStep(state: HoldState, event: HoldEvent): HoldStep {
  switch (event.type) {
    case "press":
      return state.kind === "idle"
        ? { state: { kind: "pressing", since: event.at }, commit: false }
        : { state, commit: false };
    case "tick":
    case "release":
      if (state.kind !== "pressing") return { state, commit: false };
      // A release after the mark still counts: the tick that would have
      // committed can be a frame late, and the finger was down long enough.
      if (event.at - state.since >= HOLD_COMMIT_MS) {
        return { state: { kind: "waiting", since: event.at }, commit: true };
      }
      return event.type === "release" ? { state: HOLD_IDLE, commit: false } : { state, commit: false };
    case "settle":
      return { state: HOLD_IDLE, commit: false };
  }
}

/** 0 → 1 while pressing; 1 while waiting for the server; 0 at rest. */
export function holdProgress(state: HoldState, now: number): number {
  if (state.kind === "waiting") return 1;
  if (state.kind === "idle") return 0;
  return Math.max(0, Math.min(1, (now - state.since) / HOLD_COMMIT_MS));
}
