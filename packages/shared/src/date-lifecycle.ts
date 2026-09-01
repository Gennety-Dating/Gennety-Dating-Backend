/**
 * The Living Canvas state vocabulary — what the map's bottom sheet is showing
 * right now (PRODUCT_SPEC §Living Canvas).
 *
 * **This is a derived view, never a stored column.** `MatchStatus` stays the
 * only writable truth about where a match is; a state here is a pure function
 * of that status plus the clock plus the bump session. Two status columns on
 * one row eventually disagree, and the disagreement is invisible until a user
 * is looking at a screen that contradicts their own chat.
 *
 * Pure and env-free, like `type-radar.ts` and `relationship-intent.ts`: the
 * caller supplies the row and the clock, and the bot's `services/date-state.ts`
 * owns the branching. Shared rather than bot-local because both clients render
 * these names and `openapi/gennety-v1.yaml` carries them as an enum.
 */

/**
 * Every state the canvas can be in.
 *
 * The order is the user's own journey, and `deriveDateState` deliberately does
 * NOT branch in this order — see that function for why the ladder runs from the
 * most specific state backwards.
 */
export const DATE_LIFECYCLE_STATES = [
  /** Between drops: explore the map, watch the campus, wait for tonight. */
  "IDLE_EXPLORING",
  /** A pitch is on the table and THIS side has not answered it yet. */
  "DROP_PENDING_DECISION",
  /** Both accepted; the time and the place are still being agreed. */
  "LOGISTICS_SCHEDULING",
  /** Time and venue are locked, and the date is not today yet. */
  "DATE_SCHEDULED",
  /** Inside the last `DATE_RADAR_LEAD_MINUTES`: routes, ETA, arrival. */
  "DATE_RADAR_ACTIVE",
  /** At the venue, waiting for the two phones to be shaken together. */
  "DATE_BUMP_PENDING",
  /** Bump verified — the icebreaker deck is open. */
  "DATE_IN_PROGRESS",
  /** The date is closed and this side still owes an answer about it. */
  "POST_DATE_FEEDBACK",
] as const;

export type DateLifecycleState = (typeof DATE_LIFECYCLE_STATES)[number];

export function isDateLifecycleState(value: unknown): value is DateLifecycleState {
  return (
    typeof value === "string" &&
    (DATE_LIFECYCLE_STATES as readonly string[]).includes(value)
  );
}

/**
 * How long before `agreedTime` the radar starts computing ETAs.
 *
 * Product number from the spec, and the one bound worth stating: the radar is
 * the only surface that tells a partner anything about where the other person
 * physically is, so the window is deliberately short and closes on its own.
 */
export const DATE_RADAR_LEAD_MINUTES = 45;

/**
 * How long before `agreedTime` a Date Bump becomes acceptable — and, by
 * construction, when the canvas starts asking for one.
 *
 * **One number for both**, not two. The obvious split (show the prompt at T-5m,
 * accept a shake from T-15m) puts the product in the state where a shake would
 * be honoured and nothing on screen says so — and the opposite split is worse:
 * a prompt the server refuses. Whatever this is, it is both.
 */
export const DATE_BUMP_OPENS_MINUTES = 15;

/**
 * How long after `agreedTime` a Bump is still accepted, and how long the canvas
 * keeps showing the date at all.
 *
 * Matches `PROXY_CLOSE_AFTER_HOURS`, which is not a coincidence worth
 * collapsing into a shared constant: each bounds a different thing (a chat,
 * this), and they are free to move apart. **They already did** — the date-day
 * Live Activity used to end on this same number and now ends an hour later
 * (`DATE_DAY_END_HOURS`), because it acquired a question to ask at T+2h.
 */
export const DATE_BUMP_GRACE_HOURS = 2;

/** Max gap between the two shakes for a Bump to count. */
export const BUMP_SHAKE_WINDOW_MS = 10_000;

/** How close to the venue each shake must be, in metres. */
export const BUMP_VENUE_RADIUS_M = 100;

/**
 * How close both people must be for the radar to say "you are both here".
 *
 * Tighter than `BUMP_VENUE_RADIUS_M` on purpose: this one only ever produces a
 * reassuring line, so a false positive is cheap, while the bump grants tickets
 * and writes attendance and therefore gets the more forgiving radius.
 */
export const PROXIMITY_ARRIVED_RADIUS_M = 50;

/** Reliability granted to BOTH sides when a Bump verifies. */
export const BUMP_RELIABILITY_REWARD = 50;

/**
 * Geohash precision for a Scratch Map tile — 6 is about 1.2 km × 0.6 km.
 *
 * The privacy guarantee is this number. At 7 (~150 m) a stored tile starts
 * naming a street; at 5 (~5 km) the whole of Kyiv is a handful of tiles and the
 * map stops being a map. This is the coarsest precision that still draws a city.
 */
export const SCRATCH_TILE_PRECISION = 6;

/** Topics per side in a generated icebreaker deck. */
export const BUMP_ICEBREAKER_COUNT = 5;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The window a Date Bump is accepted in.
 *
 * Lives here rather than in `services/date-bump.ts` for one reason: the demo
 * driver's decision table has to know whether the window is open before it asks
 * the puppet to shake, and that table is pure by design — it must not import a
 * module that pulls in Prisma. Two copies of this arithmetic would drift, and
 * the drift would show up as a demo that gives up three times and announces
 * itself stuck.
 */
export function bumpWindowFor(agreedTime: Date): { opens: Date; closes: Date } {
  const ms = agreedTime.getTime();
  return {
    opens: new Date(ms - DATE_BUMP_OPENS_MINUTES * MINUTE_MS),
    closes: new Date(ms + DATE_BUMP_GRACE_HOURS * HOUR_MS),
  };
}

export function checkBumpWindow(
  agreedTime: Date,
  at: Date,
): "ok" | "too-early" | "too-late" {
  const { opens, closes } = bumpWindowFor(agreedTime);
  if (at.getTime() < opens.getTime()) return "too-early";
  if (at.getTime() >= closes.getTime()) return "too-late";
  return "ok";
}

// ---------------------------------------------------------------------------
// The date-day Live Activity's later beats (iOS §4.2)
// ---------------------------------------------------------------------------

/**
 * When the card turns from the route to the spotter sign.
 *
 * The same moment the pre-date proxy chat opens, and for the same reason: at
 * half an hour out the question stops being "how do I get there" and becomes
 * "how do we find each other".
 */
export const DATE_DAY_SPOTTER_LEAD_MINUTES = 30;

/** When the card asks how the evening went. */
export const DATE_DAY_VIBE_AFTER_HOURS = 2;

/**
 * When the card comes down.
 *
 * An hour after the question, not at the same moment as it: ending at T+2h
 * would take the question away in the tick that posed it.
 */
export const DATE_DAY_END_HOURS = 3;

/**
 * How wide each beat's firing window is.
 *
 * The tick that fires these runs every couple of minutes and they are bounded
 * by time windows rather than by idempotency columns, so this is the trade:
 * a stage push carries no alert and replaces a content state with an identical
 * one, meaning a duplicate costs two APNs calls and changes nothing on screen,
 * whereas a MISSED beat leaves the card describing the wrong half of the
 * evening until the next one. Six minutes is three ticks — enough that a slow
 * tick or a restart does not drop a beat, small enough that duplicates stay in
 * single digits.
 */
export const DATE_DAY_BEAT_WINDOW_MINUTES = 6;

/**
 * How far back the END beat looks, so a restarted process still catches it.
 *
 * Wider than the other two on purpose: a missed spotter or vibe beat costs a
 * stale-looking card for a few minutes, but a missed end leaves a dead card on
 * someone's lock screen until the system's own 12-hour display cap expires it.
 */
export const DATE_DAY_END_GRACE_MINUTES = 30;

/** Which date-day beat, if any, falls in this tick for a match. */
export type DateDayBeat = "spotter" | "vibe_check" | "end";

/**
 * Which beat a match crosses at `now`, or `null`.
 *
 * Pure and env-free so it can be tested without a database — the arithmetic is
 * the whole of the behaviour, and the tick around it is plumbing.
 *
 * Every branch asks "did `now` just CROSS this boundary", never "is `now` past
 * it": the latter would re-fire every tick for the rest of the day. And the
 * ladder runs from the latest beat backwards, so a tick that wakes up late on a
 * match already past its end does not walk it back through the earlier two.
 */
export function dateDayBeatFor(
  agreedTime: Date,
  now: Date,
  windowMinutes: number = DATE_DAY_BEAT_WINDOW_MINUTES,
): DateDayBeat | null {
  const since = (offsetMs: number): number => now.getTime() - (agreedTime.getTime() + offsetMs);
  const within = (elapsed: number, spanMinutes: number): boolean =>
    elapsed >= 0 && elapsed < spanMinutes * MINUTE_MS;

  if (within(since(DATE_DAY_END_HOURS * HOUR_MS), DATE_DAY_END_GRACE_MINUTES)) return "end";
  if (within(since(DATE_DAY_VIBE_AFTER_HOURS * HOUR_MS), windowMinutes)) return "vibe_check";
  if (within(since(-DATE_DAY_SPOTTER_LEAD_MINUTES * MINUTE_MS), windowMinutes)) return "spotter";
  return null;
}
