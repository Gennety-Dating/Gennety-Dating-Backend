/**
 * Rematch — a paid, on-demand re-run of the matching engine for ONE man.
 * See REMATCH_PRODUCT_SPEC.md.
 *
 * The important thing about this file is how little matching logic is in it.
 * `findCandidatesFor()` is already a single-seeker matching engine — same
 * candidate SQL, same multi-factor re-rank as the weekly batch — so a rematch
 * inherits every invariant for free: the lifetime pair ban (he can never be
 * re-shown someone he already saw, including the woman he just declined), the
 * single-live-match rule, the verification/contact-rail gates, city scoping, and
 * the 24h candidate cooldown. This module only adds the things the engine has no
 * opinion about: who may BUY, how often, whom we protect from being re-pitched,
 * and how her invitation is framed.
 *
 * Deliberately free of any Telegram `Api` handle: `runRematch()` creates the
 * match and returns its id, and the caller (the `successful_payment` trust
 * boundary) dispatches it. That keeps the money-critical path unit-testable
 * without a bot. Provider I/O (refunds + their durable retry) lives in
 * `rematch-refund.ts`.
 */

import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";
import {
  createProposedMatch,
  findCandidatesFor,
  type ScoredCandidate,
} from "./match-engine.js";
import { getNextBatchDate } from "./next-batch.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How many ranked candidates to scan before applying the gift cap. The engine
 * returns them best-first, so scanning a few and taking the first survivor keeps
 * the top-1 semantics of the weekly batch while letting the cap skip a
 * recently-gift-pitched woman instead of failing the whole run.
 */
const REMATCH_CANDIDATE_SCAN = 5;

/** Purchase states (`RematchPurchase.status`). */
export const REMATCH_PROCESSING = "processing";
export const REMATCH_SETTLED = "settled";
export const REMATCH_REFUNDED_NO_CANDIDATE = "refunded_no_candidate";
export const REMATCH_REFUNDED_INELIGIBLE = "refunded_ineligible";
export const REMATCH_REFUND_FAILED = "refund_failed";

/** Why a rematch purchase/run was refused. */
export type RematchIneligibleReason =
  | "feature_off"
  | "not_found"
  | "not_male"
  | "not_matchable"
  | "live_match"
  | "weekly_limit"
  | "cooldown"
  | "pre_batch_blackout";

export interface RematchEligibility {
  ok: boolean;
  reason?: RematchIneligibleReason;
  /** When the blocking condition clears (cooldown / blackout only). */
  retryAt?: Date;
}

/** Which gift framing the partner's invitation uses. */
export type RematchFraming = "famine" | "failed" | "neutral";

export interface RematchRunResult {
  ok: boolean;
  matchId?: string;
  partnerId?: string;
  framing?: RematchFraming;
  /** Set when `ok` is false. `no_candidate` is the refundable outcome (D1). */
  reason?: RematchIneligibleReason | "no_candidate" | "create_failed";
}

/**
 * May this user BUY a rematch right now?
 *
 * Called twice by design: once at render time (so we don't show a button that
 * would fail) and again at `successful_payment` (the trust boundary — a reusable
 * Telegram invoice link can be opened twice, and state moves between the two).
 * Only the second call is authoritative.
 */
export async function checkRematchEligibility(
  userId: string,
  now: Date = new Date(),
): Promise<RematchEligibility> {
  if (!env.REMATCH_FEATURE_ENABLED) return { ok: false, reason: "feature_off" };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      gender: true,
      status: true,
      onboardingStep: true,
      verificationStatus: true,
      verificationSkippedAt: true,
    },
  });
  if (!user) return { ok: false, reason: "not_found" };

  // v1 is male-only by product decision: women receive rematches as a gift and
  // never buy one. The button is never rendered for them, so reaching this is
  // either a stale card or a tampered invoice — refuse and let the caller refund.
  if (user.gender !== "male") return { ok: false, reason: "not_male" };

  // Same admission bar as the weekly batch — a paid run never lowers it.
  const verificationAdmits =
    user.verificationStatus === "verified" ||
    (user.verificationStatus === "unverified" && user.verificationSkippedAt !== null);
  if (
    user.status !== "active" ||
    user.onboardingStep !== "completed" ||
    !verificationAdmits
  ) {
    return { ok: false, reason: "not_matchable" };
  }

  // Single-live-match (§3.2): buying while a match is in flight would run two
  // women in parallel and break the blind-decision invariant.
  const liveMatch = await prisma.match.findFirst({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true },
  });
  if (liveMatch) return { ok: false, reason: "live_match" };

  // D3 limits. Only `settled` purchases consume quota — a refunded run delivered
  // nothing, so it must not cost him an attempt.
  const windowStart = new Date(now.getTime() - 7 * DAY_MS);
  const recent = await prisma.rematchPurchase.findMany({
    where: { userId, status: REMATCH_SETTLED, createdAt: { gte: windowStart } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  if (recent.length >= env.REMATCH_MAX_PER_WEEK) {
    // The window frees up when the OLDEST purchase in it ages out.
    const oldest = recent[recent.length - 1];
    return oldest
      ? {
          ok: false,
          reason: "weekly_limit",
          retryAt: new Date(oldest.createdAt.getTime() + 7 * DAY_MS),
        }
      : { ok: false, reason: "weekly_limit" };
  }
  const last = recent[0];
  if (last) {
    const cooldownEnds = new Date(
      last.createdAt.getTime() + env.REMATCH_COOLDOWN_HOURS * HOUR_MS,
    );
    if (cooldownEnds > now) {
      return { ok: false, reason: "cooldown", retryAt: cooldownEnds };
    }
  }

  // Blackout: the Thursday batch is globally greedy-optimal, so a single-seeker
  // run just before it can take a candidate the optimal pairing needed.
  if (env.REMATCH_PRE_BATCH_BLACKOUT_HOURS > 0) {
    const nextBatch = getNextBatchDate(now);
    const blackoutStart = new Date(
      nextBatch.getTime() - env.REMATCH_PRE_BATCH_BLACKOUT_HOURS * HOUR_MS,
    );
    if (now >= blackoutStart) {
      return { ok: false, reason: "pre_batch_blackout", retryAt: nextBatch };
    }
  }

  return { ok: true };
}

/**
 * Candidate ids that are currently protected from receiving another
 * rematch-sourced pitch (`REMATCH_GIFT_CAP_DAYS`).
 *
 * The single-live-match invariant already prevents two SIMULTANEOUS matches, but
 * not a series: without this, one popular woman could be the top candidate for
 * many buyers and be serially gift-pitched until she burns out.
 */
export async function findGiftCappedUserIds(
  candidateIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (candidateIds.length === 0 || env.REMATCH_GIFT_CAP_DAYS <= 0) return new Set();
  const cutoff = new Date(now.getTime() - env.REMATCH_GIFT_CAP_DAYS * DAY_MS);
  const rows = await prisma.match.findMany({
    where: {
      source: "rematch",
      createdAt: { gte: cutoff },
      OR: [{ userAId: { in: candidateIds } }, { userBId: { in: candidateIds } }],
    },
    select: { userAId: true, userBId: true },
  });
  const capped = new Set<string>();
  const wanted = new Set(candidateIds);
  for (const row of rows) {
    if (wanted.has(row.userAId)) capped.add(row.userAId);
    if (wanted.has(row.userBId)) capped.add(row.userBId);
  }
  return capped;
}

/**
 * The best rematch candidate for this buyer, or null when there is nobody left.
 *
 * Null is a legitimate, expected outcome — his city pool is finite and the
 * lifetime pair ban permanently consumes one candidate per rematch — and it is
 * precisely the case D1 refunds.
 */
export async function findRematchCandidate(
  userId: string,
  now: Date = new Date(),
): Promise<ScoredCandidate | null> {
  const ranked = await findCandidatesFor(userId, REMATCH_CANDIDATE_SCAN);
  if (ranked.length === 0) return null;
  const capped = await findGiftCappedUserIds(
    ranked.map((c) => c.userId),
    now,
  );
  return ranked.find((c) => !capped.has(c.userId)) ?? null;
}

/**
 * Choose how the partner's invitation is framed, from HER OWN recent history —
 * never from the buyer's, and never from anything he paid or decided.
 *
 * `excludeMatchId` skips the rematch match we just created, which would
 * otherwise look like "her most recent match" and mask the real signal.
 */
export async function pickGiftFraming(
  partnerId: string,
  now: Date = new Date(),
  excludeMatchId?: string,
): Promise<RematchFraming> {
  // `famine` takes precedence: being told "no match this week" is the sharper
  // recent experience, so answering it directly is what makes the gift land.
  const dropCutoff = new Date(now.getTime() - 7 * DAY_MS);
  const famine = await prisma.noMatchNotice.findFirst({
    where: { userId: partnerId, dropDate: { gte: dropCutoff } },
    select: { id: true },
  });
  if (famine) return "famine";

  const failedCutoff = new Date(
    now.getTime() - env.REMATCH_FAILED_LOOKBACK_DAYS * DAY_MS,
  );
  const failed = await prisma.match.findFirst({
    where: {
      ...(excludeMatchId ? { id: { not: excludeMatchId } } : {}),
      status: { in: ["cancelled", "expired"] },
      updatedAt: { gte: failedCutoff },
      OR: [{ userAId: partnerId }, { userBId: partnerId }],
    },
    select: { id: true },
    orderBy: { updatedAt: "desc" },
  });
  if (failed) return "failed";

  return "neutral";
}

/**
 * The gift framing recorded for a delivered rematch, for the pitch to render.
 *
 * Reads the value we PERSISTED at purchase rather than re-deriving it, so what
 * she sees is exactly what the audit row says — and so a framing decision can't
 * silently drift if her state changes between purchase and dispatch.
 */
export async function getGiftFramingForMatch(
  matchId: string,
): Promise<RematchFraming | null> {
  const purchase = await prisma.rematchPurchase
    .findFirst({
      where: { resultMatchId: matchId, status: REMATCH_SETTLED },
      select: { framing: true },
    })
    .catch(() => null);
  if (!purchase) return null;
  const framing = purchase.framing;
  return framing === "famine" || framing === "failed" || framing === "neutral"
    ? framing
    : "neutral";
}

/**
 * Run one paid rematch: re-validate, find a candidate, create the pair.
 *
 * Does NOT dispatch the pitch — the caller does, so this stays testable without
 * a Telegram Api. A false result with reason `no_candidate` is the refundable
 * outcome; every other false reason means he should not have been able to pay at
 * all and is likewise refunded by the caller.
 */
export async function runRematch(
  userId: string,
  now: Date = new Date(),
): Promise<RematchRunResult> {
  const eligibility = await checkRematchEligibility(userId, now);
  if (!eligibility.ok) {
    return { ok: false, reason: eligibility.reason ?? "not_matchable" };
  }

  const candidate = await findRematchCandidate(userId, now);
  if (!candidate) return { ok: false, reason: "no_candidate" };

  const match = await createProposedMatch(
    userId,
    candidate.userId,
    {
      ...candidate.breakdown,
      // A single-seeker run has no pairwise preview, so there is no captured
      // embedding distance or starvation bonus to freeze. Log them as neutral
      // rather than inventing values — and note that `MatchScoreLog` rows for
      // rematch pairs are excluded from weekly-optimizer analytics anyway.
      embeddingDistance: 0,
      starvationBonus: 0,
    },
    undefined,
    { source: "rematch", rematchPaidById: userId },
  );
  // Null means the in-transaction re-check refused (he or she acquired a live
  // match, or the pair already existed). Treated as "no candidate" so the caller
  // refunds — we never keep money for a pair that was not created.
  if (!match) return { ok: false, reason: "create_failed" };

  // Mirror the weekly batch: a successful pairing clears both sides' famine
  // counters. Without this she would keep accruing a starvation bonus for a week
  // she was, in fact, matched.
  await prisma.profile.updateMany({
    where: { userId: { in: [userId, candidate.userId] } },
    data: { standbyCount: 0, missedWeeks: 0 },
  });

  const framing = await pickGiftFraming(candidate.userId, now, match.id);
  return { ok: true, matchId: match.id, partnerId: candidate.userId, framing };
}
