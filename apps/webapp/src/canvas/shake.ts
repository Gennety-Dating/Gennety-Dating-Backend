/**
 * Shake detection for the Date Bump (PRODUCT_SPEC §6.2).
 *
 * The decision half is pure and lives here; the DOM half only feeds it
 * `DeviceMotionEvent` readings. That split matters more than usual, because a
 * shake threshold is the kind of number that gets retuned by feel and can
 * quietly become either "vibrates on a bus" or "unshakeable", and neither is
 * observable without two people at a table.
 *
 * ── What a shake is here ────────────────────────────────────────────────
 *
 * One sample over the threshold is not a shake — a phone put down hard clears
 * any threshold worth having. What separates a shake from a knock is that it
 * REVERSES: `SHAKE_MIN_SAMPLES` readings over the bar inside
 * `SHAKE_WINDOW_MS`. That is also why the magnitude is
 * `accelerationIncludingGravity` minus gravity rather than `acceleration`:
 * the latter is null on a large share of Android browsers, so a detector
 * built on it works on iOS and silently never fires elsewhere.
 */

/** m/s² above resting gravity that a sample must reach to count. */
export const SHAKE_THRESHOLD = 14;
/** How many qualifying samples make a shake. */
export const SHAKE_MIN_SAMPLES = 3;
/** They have to arrive inside this window, or it is not one motion. */
export const SHAKE_WINDOW_MS = 900;
/**
 * After a detected shake, ignore everything for this long.
 *
 * Not debounce for its own sake: one continuous shake produces samples for as
 * long as the hand moves, and without this the same motion would post several
 * bumps. The server is idempotent per side, so the cost is wasted requests
 * rather than wrong state — but on a phone at a restaurant table those are
 * real seconds of radio.
 */
export const SHAKE_COOLDOWN_MS = 2500;

const GRAVITY = 9.81;

export interface MotionSample {
  x: number | null;
  y: number | null;
  z: number | null;
  at: number;
}

/** How far this reading is from a phone lying still, in m/s². */
export function shakeMagnitude(sample: MotionSample): number {
  const x = sample.x ?? 0;
  const y = sample.y ?? 0;
  const z = sample.z ?? 0;
  return Math.abs(Math.sqrt(x * x + y * y + z * z) - GRAVITY);
}

/**
 * Rolling detector. Fed one reading at a time; answers true exactly once per
 * shake, then stays quiet for the cooldown.
 */
export function createShakeDetector(): {
  feed(sample: MotionSample): boolean;
  reset(): void;
} {
  let hits: number[] = [];
  let mutedUntil = 0;

  return {
    feed(sample: MotionSample): boolean {
      if (sample.at < mutedUntil) return false;
      if (shakeMagnitude(sample) < SHAKE_THRESHOLD) return false;

      hits = hits.filter((t) => sample.at - t <= SHAKE_WINDOW_MS);
      hits.push(sample.at);
      if (hits.length < SHAKE_MIN_SAMPLES) return false;

      hits = [];
      mutedUntil = sample.at + SHAKE_COOLDOWN_MS;
      return true;
    },
    reset(): void {
      hits = [];
      mutedUntil = 0;
    },
  };
}

export type MotionPermission = "granted" | "denied" | "unsupported";

interface MotionEventCtor {
  requestPermission?: () => Promise<"granted" | "denied">;
}

/**
 * iOS 13+ requires a user gesture before motion readings are delivered at all,
 * and a browser that never asks reports nothing rather than refusing — so
 * "unsupported" and "denied" have to stay distinct: one is a phone that cannot
 * do this, the other is a phone that will once the user says so.
 */
export async function requestMotionPermission(
  ctor: MotionEventCtor | undefined,
): Promise<MotionPermission> {
  if (!ctor) return "unsupported";
  if (typeof ctor.requestPermission !== "function") {
    // Android and desktop Chrome deliver motion without asking.
    return "granted";
  }
  try {
    const verdict = await ctor.requestPermission();
    return verdict === "granted" ? "granted" : "denied";
  } catch {
    // Thrown when called outside a user gesture. Treat as denied rather than
    // unsupported: asking again from a real tap is the fix, and telling the
    // user their phone cannot do this would be false.
    return "denied";
  }
}
