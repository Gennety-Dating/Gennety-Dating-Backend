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
import { CADENCE } from "@gennety/shared";
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

/**
 * The D3 limits, resolved as `env ?? CADENCE` — an env var is an ops override,
 * the cadence profile is the source of truth.
 *
 * This is the seam that used to be missing. `DropCadence` has declared these
 * four fields since the cadence abstraction shipped, and until now **not one of
 * them was read anywhere** (only `rematchWindowMs` was), while `config.ts` baked
 * weekly-tuned literals in as defaults. So the abstraction looked complete for
 * Rematch and was not: flipping `DROP_CADENCE=daily` moved every other timing
 * knob in the product and silently left these four on their weekly values — most
 * visibly the blackout, which is ~3.5% of a 7-day interval and **25% of a 1-day
 * one** (12:00–18:00 Kyiv dead, every day).
 *
 * Resolved per call rather than at module load: `env` is mutated in place by the
 * test suite, and a cached object would freeze the first test's values for the
 * whole file.
 */
export function rematchLimits(): {
  maxPerInterval: number;
  cooldownMs: number;
  blackoutMs: number;
  giftCapMs: number;
} {
  return {
    maxPerInterval: env.REMATCH_MAX_PER_WEEK ?? CADENCE.rematchMaxPerInterval,
    cooldownMs:
      env.REMATCH_COOLDOWN_HOURS != null
        ? env.REMATCH_COOLDOWN_HOURS * HOUR_MS
        : CADENCE.rematchCooldownMs,
    blackoutMs:
      env.REMATCH_PRE_BATCH_BLACKOUT_HOURS != null
        ? env.REMATCH_PRE_BATCH_BLACKOUT_HOURS * HOUR_MS
        : CADENCE.rematchBlackoutMs,
    giftCapMs:
      env.REMATCH_GIFT_CAP_DAYS != null
        ? env.REMATCH_GIFT_CAP_DAYS * DAY_MS
        : CADENCE.rematchGiftCapMs,
  };
}

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
  // nothing, so it must not cost him an attempt. The rolling window itself is
  // CADENCE.rematchWindowMs (7 days on both profiles today) rather than a
  // second, independently-hardcoded `7 * DAY_MS` literal — this is the one the
  // original audit missed, found while wiring this file up for Phase 5.
  const windowStart = new Date(now.getTime() - CADENCE.rematchWindowMs);
  const recent = await prisma.rematchPurchase.findMany({
    where: { userId, status: REMATCH_SETTLED, createdAt: { gte: windowStart } },
    select: { createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  // The three limits below follow the active cadence profile, with the env vars
  // as ops overrides (`rematchLimits`). D8 — "turn Rematch off for the daily
  // pilot" — was NOT adopted: the limits move with the cadence instead, so a
  // `DROP_CADENCE` flip no longer needs the feature switched off to stay sane.
  const limits = rematchLimits();
  if (recent.length >= limits.maxPerInterval) {
    // The window frees up when the OLDEST purchase in it ages out.
    const oldest = recent[recent.length - 1];
    return oldest
      ? {
          ok: false,
          reason: "weekly_limit",
          retryAt: new Date(oldest.createdAt.getTime() + CADENCE.rematchWindowMs),
        }
      : { ok: false, reason: "weekly_limit" };
  }
  const last = recent[0];
  if (last) {
    const cooldownEnds = new Date(last.createdAt.getTime() + limits.cooldownMs);
    if (cooldownEnds > now) {
      return { ok: false, reason: "cooldown", retryAt: cooldownEnds };
    }
  }

  // Blackout: the batch is globally greedy-optimal, so a single-seeker run
  // just before it can take a candidate the optimal pairing needed.
  if (limits.blackoutMs > 0) {
    const nextBatch = getNextBatchDate(now);
    const blackoutStart = new Date(nextBatch.getTime() - limits.blackoutMs);
    if (now >= blackoutStart) {
      return { ok: false, reason: "pre_batch_blackout", retryAt: nextBatch };
    }
  }

  return { ok: true };
}

/**
 * Batched twin of `checkRematchEligibility`: which of these users could buy a
 * rematch right now.
 *
 * Exists for the pinned status banner, which reconciles EVERY active user EVERY
 * minute. Calling the single-user check there would be ~3 queries per user per
 * tick; this is 3 queries per tick total, whatever the pool size.
 *
 * **Returns an empty set unless the banner would actually use it.** Under
 * `weekly` — production today — `dropOutpacesNotices()` is false, the banner
 * never reaches its silent-drops branch, and this costs literally nothing: the
 * caller short-circuits before the first query.
 *
 * Deliberately reuses the same `rematchLimits()` and `ACTIVE_MATCH_STATUSES` as
 * the authoritative check, and `rematch.test.ts` pins the two to agree — a
 * button that fails on tap is worse than no button, so a divergence here is a
 * product bug, not an optimisation detail.
 */
export async function filterRematchEligible(
  userIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  if (!env.REMATCH_FEATURE_ENABLED || userIds.length === 0) return new Set();

  const limits = rematchLimits();

  // Same admission bar as the weekly batch and as checkRematchEligibility.
  const users = await prisma.user.findMany({
    where: {
      id: { in: userIds },
      gender: "male",
      status: "active",
      onboardingStep: "completed",
      OR: [
        { verificationStatus: "verified" },
        { verificationStatus: "unverified", verificationSkippedAt: { not: null } },
      ],
    },
    select: { id: true },
  });
  if (users.length === 0) return new Set();
  const eligible = new Set(users.map((u) => u.id));

  // Single-live-match (§3.2): he cannot buy while a match is in flight.
  const live = await prisma.match.findMany({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [
        { userAId: { in: [...eligible] } },
        { userBId: { in: [...eligible] } },
      ],
    },
    select: { userAId: true, userBId: true },
  });
  for (const row of live) {
    eligible.delete(row.userAId);
    eligible.delete(row.userBId);
  }
  if (eligible.size === 0) return eligible;

  // D3 limits. Only settled purchases consume quota, exactly as above.
  const windowStart = new Date(now.getTime() - CADENCE.rematchWindowMs);
  const purchases = await prisma.rematchPurchase.findMany({
    where: {
      userId: { in: [...eligible] },
      status: REMATCH_SETTLED,
      createdAt: { gte: windowStart },
    },
    select: { userId: true, createdAt: true },
  });
  const byUser = new Map<string, Date[]>();
  for (const p of purchases) {
    const list = byUser.get(p.userId);
    if (list) list.push(p.createdAt);
    else byUser.set(p.userId, [p.createdAt]);
  }
  for (const [userId, dates] of byUser) {
    if (dates.length >= limits.maxPerInterval) {
      eligible.delete(userId);
      continue;
    }
    const newest = dates.reduce((a, b) => (a > b ? a : b));
    if (newest.getTime() + limits.cooldownMs > now.getTime()) eligible.delete(userId);
  }

  // Blackout is a pure time computation — identical for everyone, so it is all
  // or nothing rather than a per-user filter.
  if (limits.blackoutMs > 0) {
    const blackoutStart = getNextBatchDate(now).getTime() - limits.blackoutMs;
    if (now.getTime() >= blackoutStart) return new Set();
  }

  return eligible;
}

/**
 * Candidate ids that are currently protected from receiving another
 * rematch-sourced pitch (`rematchLimits().giftCapMs`).
 *
 * The single-live-match invariant already prevents two SIMULTANEOUS matches, but
 * not a series: without this, one popular woman could be the top candidate for
 * many buyers and be serially gift-pitched until she burns out.
 *
 * This is the one D3 limit that must NOT shorten when the buyer's own limits
 * loosen. It protects HER, and the two are independent by design: he may be
 * allowed a run a day, she is still off-limits for a week after receiving one.
 * Both cadence profiles therefore carry the same 7 days.
 */
export async function findGiftCappedUserIds(
  candidateIds: string[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const giftCapMs = rematchLimits().giftCapMs;
  if (candidateIds.length === 0 || giftCapMs <= 0) return new Set();
  const cutoff = new Date(now.getTime() - giftCapMs);
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
  // `famine` takes precedence: being told "no match" is the sharper recent
  // experience, so answering it directly is what makes the gift land. Same
  // rolling window as the D3 purchase-count limit above.
  const dropCutoff = new Date(now.getTime() - CADENCE.rematchWindowMs);
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
