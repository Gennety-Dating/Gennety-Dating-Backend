import { prisma } from "@gennety/db";

/**
 * Universal Elo rating for the matching engine.
 *
 * The system proposes a Thursday match simultaneously to both users
 * (double-blind — no inviter / invitee). Each user's Accept/Decline is treated
 * as one independent rating "game" against the other side: A's decision moves
 * B's rating, and B's decision moves A's. So a single match resolves into two
 * independent updates, computed from each direction's own expected score.
 *
 * Outcome matrix (per the product decision matrix):
 *   - Mutual accept   → both gain
 *   - Mutual decline  → both lose
 *   - A accepts, B declines → B gains (cleared A's bar), A loses (failed B's bar)
 *
 * Dynamic K-factor — K=20 while a user has played < 10 matches (fast
 * calibration for newbies), K=10 thereafter. Each side uses its OWN
 * `eloMatchesPlayed` to pick its K, so a calibrated veteran's rating doesn't
 * jolt around when paired with a fresh user.
 *
 * The K values are intentionally half the textbook chess defaults (40 / 20):
 * the photo-derived cold-start seed (`services/elo-seed.ts`) is the
 * foundational signal, and accept/decline outcomes are a secondary refinement.
 * Halving K means a user's seed survives ~2x as many matches before the
 * behavioral signal can fully overwrite it. Tune up only if seed quality
 * is later shown to be noisy enough that fast post-hoc correction matters.
 *
 * Rating bounds: Elo math is unbounded, but the schema stores `eloScore` as
 * an Int defaulting to 500 with the conceptual range [0..1000]. We clamp
 * after each update so a long losing streak can't drive a rating below zero
 * or run past the league-penalty's calibrated band.
 */

export const K_FACTOR_CALIBRATING = 20;
export const K_FACTOR_STABLE = 10;
export const K_FACTOR_THRESHOLD = 10;

export const ELO_MIN = 0;
export const ELO_MAX = 1000;

/**
 * Flat Elo penalty for letting a proposal expire silently AFTER the
 * forgive-once warning. This is a behavioral signal, not a competitive
 * matchmaking signal — the silent user lost no contest, they just no-
 * showed. So:
 *   - We deduct a fixed amount (no K-factor, no expected-score math).
 *   - `eloMatchesPlayed` is NOT incremented (no actual match happened
 *     from a rating-system POV).
 *   - The peer's rating is left untouched. They did their part — getting
 *     ghosted shouldn't move their number.
 *
 * Tuned small (5) so it nudges behavior without nuking new accounts. Halved
 * alongside the K-factor for the same reason — the photo-derived seed is the
 * foundational signal and behavioral nudges should be secondary.
 */
export const SILENT_IGNORE_ELO_PENALTY = 5;

/**
 * Small priority/rating bump for the partner whose scheduled date was
 * emergency-cancelled by the other side. No penalty is applied to the
 * canceller because the reason may be legitimate, and `eloMatchesPlayed`
 * stays unchanged because no accept/decline contest resolved.
 */
export const EMERGENCY_CANCEL_PEER_ELO_BOOST = 5;

/**
 * Elo penalty for users who tap "Skip for now" on the verification CTA at the
 * end of onboarding. Default seed is 500 → drops to 350, which materially
 * decays the `V_league` multiplier in match scoring and surfaces fewer
 * candidates — exactly the friction the CTA copy promises.
 *
 * Reversible: when a previously-skipped user later runs Persona successfully,
 * the verification webhook refunds the penalty and clears
 * `verificationSkippedAt` (see `services/elo-seed.refundSkipPenalty`).
 *
 * Lives here (with the other Elo constants) rather than in the onboarding
 * handler so non-handler layers (`services/elo-seed.ts`) can import without
 * inverting dependencies.
 */
export const UNVERIFIED_ELO_PENALTY = 150;

/** Win = 1, loss = 0. Mirrors the standard Elo `S` term. */
export type EloOutcome = 1 | 0;

export interface EloPlayer {
  eloScore: number;
  eloMatchesPlayed: number;
}

export interface EloUpdate {
  /** New rating after the update, clamped to [ELO_MIN, ELO_MAX]. */
  eloScore: number;
  /** Incremented by 1. */
  eloMatchesPlayed: number;
}

/**
 * Standard Elo expected score: probability that A beats B given the rating
 * gap. `400` is the classical scale constant — a 400-point lead means the
 * higher-rated side is expected to win ~91% of the time.
 */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/** K-factor for a player based on their own match count. */
export function kFactor(matchesPlayed: number): number {
  return matchesPlayed < K_FACTOR_THRESHOLD ? K_FACTOR_CALIBRATING : K_FACTOR_STABLE;
}

/**
 * One direction of an Elo update — pure math, exported for tests.
 *
 *   newRating = oldRating + K * (S - E)
 *
 * where `S` is the actual outcome (1 = win, 0 = loss) and `E` is the expected
 * score given the gap. The result is clamped to [ELO_MIN, ELO_MAX] and the
 * match count is bumped by one.
 */
export function applyEloUpdate(
  player: EloPlayer,
  opponentRating: number,
  outcome: EloOutcome,
): EloUpdate {
  const k = kFactor(player.eloMatchesPlayed);
  const expected = expectedScore(player.eloScore, opponentRating);
  const raw = player.eloScore + k * (outcome - expected);
  const clamped = Math.max(ELO_MIN, Math.min(ELO_MAX, Math.round(raw)));
  return {
    eloScore: clamped,
    eloMatchesPlayed: player.eloMatchesPlayed + 1,
  };
}

export interface EloPairResult {
  /** New rating for A, or `null` if B never passed a verdict. */
  userA: EloUpdate | null;
  /** New rating for B, or `null` if A never passed a verdict. */
  userB: EloUpdate | null;
}

/**
 * Resolve one Thursday match into two independent Elo updates.
 *
 * The convention matches the product spec:
 *   - User A's decision determines User B's rating change.
 *     accept → B wins (cleared A's bar); decline → B loses.
 *   - User B's decision determines User A's rating change.
 *     accept → A wins; decline → A loses.
 *
 * `null` for either decision means "user didn't pass a verdict" — for
 * example when one side declines before the other has seen the proposal,
 * cancelling the match. In that case the other side's Elo stays put: no
 * verdict, no rating change.
 */
export function resolveMatchElo(
  userA: EloPlayer,
  userB: EloPlayer,
  userADecision: boolean | null,
  userBDecision: boolean | null,
): EloPairResult {
  // B's outcome is driven by A's decision (and vice versa).
  const userBNext =
    userADecision === null
      ? null
      : applyEloUpdate(userB, userA.eloScore, userADecision ? 1 : 0);
  const userANext =
    userBDecision === null
      ? null
      : applyEloUpdate(userA, userB.eloScore, userBDecision ? 1 : 0);

  return { userA: userANext, userB: userBNext };
}

/**
 * Persist Elo updates for both users of a resolved match. Read-then-write
 * inside a transaction so a concurrent resolver of the same match can't
 * double-count. Idempotency at the call site is the caller's job — this
 * helper unconditionally applies one update per call.
 *
 * Never throws; logs and swallows on DB error so a flaky write never blocks
 * the user's accept/decline flow.
 */
export async function updateEloScores(
  userAId: string,
  userBId: string,
  userADecision: boolean | null,
  userBDecision: boolean | null,
): Promise<EloPairResult | null> {
  if (userADecision === null && userBDecision === null) return null;

  try {
    return await prisma.$transaction(async (tx) => {
      const [a, b] = await Promise.all([
        tx.profile.findUnique({
          where: { userId: userAId },
          select: { id: true, eloScore: true, eloMatchesPlayed: true },
        }),
        tx.profile.findUnique({
          where: { userId: userBId },
          select: { id: true, eloScore: true, eloMatchesPlayed: true },
        }),
      ]);
      if (!a || !b) return null;

      const result = resolveMatchElo(
        { eloScore: a.eloScore, eloMatchesPlayed: a.eloMatchesPlayed },
        { eloScore: b.eloScore, eloMatchesPlayed: b.eloMatchesPlayed },
        userADecision,
        userBDecision,
      );

      const writes: Promise<unknown>[] = [];
      if (result.userA) {
        writes.push(tx.profile.update({ where: { id: a.id }, data: result.userA }));
      }
      if (result.userB) {
        writes.push(tx.profile.update({ where: { id: b.id }, data: result.userB }));
      }
      await Promise.all(writes);
      return result;
    });
  } catch (err) {
    console.warn("[elo-calculator] updateEloScores failed:", err);
    return null;
  }
}

/**
 * Apply the flat silent-ignore penalty to a single user. Idempotency is
 * the caller's job — we unconditionally deduct `SILENT_IGNORE_ELO_PENALTY`
 * from `eloScore` (clamped to `ELO_MIN`) without touching
 * `eloMatchesPlayed`.
 *
 * Returns the new rating, or `null` if the profile doesn't exist or the
 * write fails.
 */
export async function applySilentIgnorePenalty(
  userId: string,
): Promise<number | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { id: true, eloScore: true },
      });
      if (!profile) return null;
      const next = Math.max(ELO_MIN, profile.eloScore - SILENT_IGNORE_ELO_PENALTY);
      if (next === profile.eloScore) return next;
      await tx.profile.update({
        where: { id: profile.id },
        data: { eloScore: next },
      });
      return next;
    });
  } catch (err) {
    console.warn("[elo-calculator] applySilentIgnorePenalty failed:", err);
    return null;
  }
}

/**
 * Apply the small emergency-cancel boost to the partner who was cancelled on.
 * Idempotency is the caller's job — this helper unconditionally adds
 * `EMERGENCY_CANCEL_PEER_ELO_BOOST` to `eloScore` (clamped to `ELO_MAX`)
 * without touching `eloMatchesPlayed`.
 *
 * Returns the new rating, or `null` if the profile doesn't exist or the
 * write fails.
 */
export async function applyEmergencyCancellationPeerBoost(
  userId: string,
): Promise<number | null> {
  try {
    return await prisma.$transaction(async (tx) => {
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { id: true, eloScore: true },
      });
      if (!profile) return null;
      const next = Math.min(ELO_MAX, profile.eloScore + EMERGENCY_CANCEL_PEER_ELO_BOOST);
      if (next === profile.eloScore) return next;
      await tx.profile.update({
        where: { id: profile.id },
        data: { eloScore: next },
      });
      return next;
    });
  } catch (err) {
    console.warn("[elo-calculator] applyEmergencyCancellationPeerBoost failed:", err);
    return null;
  }
}
