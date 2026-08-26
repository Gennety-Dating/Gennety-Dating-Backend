import { env } from "../config.js";
import { isPremiumHeadActive, type PremiumHead } from "./premium.js";
import { telegramReachable } from "./telegram-reach.js";
import { zonedParts } from "./profiler-schedule.js";
import {
  CALENDAR_TIME_SLOTS,
  CALENDAR_TIME_ZONE,
} from "../handlers/matching/scheduler.js";

/**
 * Prime Time — the paid evening band of the calendar grid
 * (PRIME_TIME_PRODUCT_SPEC.md).
 *
 * The last few time slots of each day are locked; the pair opens them with
 * either participant's Gennety Premium subscription or a one-off Telegram
 * Stars pass. Everything here is pure — no Prisma, no Telegram — so the rule
 * can be tested without a database, the same split `decide.ts` makes.
 *
 * **The unlock is a property of the MATCH, not of a user**, and that is forced
 * by mechanics rather than chosen: `processCalendarSlotsUpdate` only locks a
 * date when the two sides' availability sets intersect in exactly one slot. A
 * per-user unlock would therefore buy nothing — the payer marks 19:30, the
 * partner cannot, the intersection can never contain it, and the date they paid
 * to arrange is the one date they cannot have.
 */

/**
 * The locked band, derived as a SUFFIX of the real grid.
 *
 * Never a second list of hours. `CALENDAR_TIME_SLOTS` is the one definition of
 * what times exist, and a hardcoded `[18:30, 19:00, 19:30]` beside it would
 * drift the first time the grid moves — silently, and in the worst direction:
 * the server would refuse a slot the client is still drawing as free.
 */
export function primeTimeSlots(
  count: number = env.PRIME_TIME_SLOT_COUNT,
): ReadonlyArray<{ hour: number; minute: number }> {
  if (count <= 0) return [];
  return CALENDAR_TIME_SLOTS.slice(-count);
}

/**
 * Is this instant one of the locked times?
 *
 * Resolved against the pair's Kyiv wall clock, NOT UTC. The droplet runs in
 * UTC, so reading `date.getUTCHours()` here would classify 19:30 Kyiv as 16:30
 * or 17:30 depending on the season and lock the wrong three rows twice a year.
 * `generateProposalSlots` documents the same trap from the writing side.
 */
export function isPrimeTimeSlot(
  date: Date,
  count: number = env.PRIME_TIME_SLOT_COUNT,
): boolean {
  const band = primeTimeSlots(count);
  if (band.length === 0) return false;
  const { hour, minute } = zonedParts(date, CALENDAR_TIME_ZONE);
  return band.some((s) => s.hour === hour && s.minute === minute);
}

/** The participant fields the rule reads. Kept structural so callers select narrowly. */
export interface PrimeTimeParticipant extends PremiumHead {
  telegramId: bigint;
  platform?: string | null;
}

export interface PrimeTimeMatch {
  primeTimeUnlockedAt: Date | null;
  availableTimesA: Date[];
  availableTimesB: Date[];
  userA: PrimeTimeParticipant;
  userB: PrimeTimeParticipant;
}

export type PrimeTimeUnlockReason =
  /** The feature itself is off, or its subscription half cannot be bought. */
  | "feature-off"
  /** Neither side can reach a purchase path — locking would be a dead end. */
  | "no-purchase-path"
  /** Either participant's subscription is live. */
  | "premium"
  /** A Stars pass was paid, or a premium mark stamped the match. */
  | "unlocked"
  /** The pair already holds a prime slot from before the band existed. */
  | "grandfathered"
  /** Locked. */
  | null;

/**
 * Why the band is open for this match — or `null` when it is locked.
 *
 * Returning the reason rather than a boolean is what lets the caller decide
 * whether the open state is worth PERSISTING: `premium` is a live entitlement
 * that can lapse mid-negotiation, so the first prime mark made under it stamps
 * `primeTimeUnlockedAt` (§13.2). A bare boolean would have hidden that
 * distinction behind a `true` and re-locked slots the pair had already chosen.
 */
export function primeTimeUnlockReason(
  match: PrimeTimeMatch,
  now: Date = new Date(),
): PrimeTimeUnlockReason {
  if (!primeTimeFeatureLive()) return "feature-off";

  // A pair with no path to either half of the offer is not "gated equally", it
  // is gated permanently. Reachable today only in theory — the native client
  // has not shipped — and the predicate exists so it cannot become reachable
  // silently (§12).
  if (!telegramReachable(match.userA) && !telegramReachable(match.userB)) {
    return "no-purchase-path";
  }

  if (match.primeTimeUnlockedAt !== null) return "unlocked";
  if (isPremiumHeadActive(match.userA, now) || isPremiumHeadActive(match.userB, now)) {
    return "premium";
  }

  // Grandfather (§13.1): locking the band retroactively would take away a slot
  // a pair has already marked, and there is no honest message for that. Reading
  // the marks instead of migrating anything makes it self-healing.
  const held = [...match.availableTimesA, ...match.availableTimesB];
  if (held.some((d) => isPrimeTimeSlot(d))) return "grandfathered";

  return null;
}

/** Convenience wrapper for the call sites that only need the yes/no. */
export function primeTimeUnlocked(match: PrimeTimeMatch, now: Date = new Date()): boolean {
  return primeTimeUnlockReason(match, now) !== null;
}

/**
 * Whether the feature is live at all.
 *
 * `PREMIUM_FEATURE_ENABLED` is a hard dependency rather than a nicety: the pass
 * is one half of the offer and the subscription is the other, and a band locked
 * while the subscription cannot be bought is the dead-end shape §3.5b refuses.
 */
export function primeTimeFeatureLive(): boolean {
  return (
    env.PRIME_TIME_ENABLED &&
    env.PREMIUM_FEATURE_ENABLED &&
    env.PRIME_TIME_SLOT_COUNT > 0
  );
}

/**
 * Should this reason be written to `primeTimeUnlockedAt`?
 *
 * Only `premium` — the one reason that can stop being true. `unlocked` is
 * already persisted, and `feature-off` / `no-purchase-path` / `grandfathered`
 * are conditions rather than purchases: persisting them would permanently open
 * a band for a pair that merely happened to be in that state on one afternoon,
 * and would survive the flag being turned back on.
 */
export function shouldPersistUnlock(reason: PrimeTimeUnlockReason): boolean {
  return reason === "premium";
}

/** The locked slots of a grid, as ISO strings — what the clients draw a lock on. */
export function lockedSlotsOf(proposedTimes: Date[]): string[] {
  return proposedTimes.filter((d) => isPrimeTimeSlot(d)).map((d) => d.toISOString());
}
