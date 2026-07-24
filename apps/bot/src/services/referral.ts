import { prisma } from "@gennety/db";
import { env } from "../config.js";
import type { ReferralLadderRung } from "../config.js";
import { grantComplimentaryPremiumMonths } from "./premium.js";
import { grantTickets, isUniqueViolation } from "./ticket-wallet.js";

/**
 * Referral program core ("Give a date, get a date", PRODUCT_SPEC §Referral).
 *
 * A referrer shares a `t.me/<bot>?start=referral_<referrerUserId>` link; the
 * invitee's first-touch `User.referralSource` records it. When the invitee
 * clears verification, the referrer climbs a milestone ladder that pays Date
 * Tickets + complimentary Premium months. The invitee separately gets a
 * welcome Premium month on the onboarding wow screen.
 *
 * Everything here no-ops when `REFERRAL_FEATURE_ENABLED` is off. Rewards are
 * exactly-once via unique ledger `externalPaymentId`s; the ladder is
 * self-healing (every invocation grants all unclaimed rungs ≤ the current
 * verified count), so a rung skipped by the velocity guard is picked up later.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** Referrer statuses that forfeit referral rewards (moderation / bad actor). */
const REWARD_BLOCKED_STATUSES = new Set(["banned", "pending_investigation", "suspended"]);

/**
 * Extract the referrer's `User.id` from an invitee's `referralSource`, or null
 * when the source is not a referral link. Accepts the canonical `referral:<id>`
 * plus the legacy Telegram deep-link / Mini-App forms (`tg:referral_<id>`,
 * `tg-mini:referral_<id>`) so links attributed before the start.ts parser
 * landed still resolve.
 */
export function parseReferrer(referralSource: string | null | undefined): string | null {
  if (!referralSource) return null;
  const s = referralSource.trim();
  if (s.startsWith("referral:")) {
    const id = s.slice("referral:".length).trim();
    return id.length > 0 ? id : null;
  }
  const legacy = /^tg(?:-mini)?:referral_(.+)$/.exec(s);
  if (legacy) {
    const id = legacy[1].trim();
    return id.length > 0 ? id : null;
  }
  return null;
}

/** Build the invite deep link a referrer shares. */
export function buildReferralLink(referrerUserId: string, botUsername: string): string {
  return `https://t.me/${botUsername}?start=referral_${referrerUserId}`;
}

/** Cumulative reward totals unlocked once `verifiedCount` friends have verified. */
export function cumulativeLadderTotals(
  verifiedCount: number,
  ladder: readonly ReferralLadderRung[] = env.REFERRAL_LADDER,
): { tickets: number; months: number } {
  let tickets = 0;
  let months = 0;
  for (const rung of ladder) {
    if (rung.atCount <= verifiedCount) {
      tickets += rung.tickets;
      months += rung.months;
    }
  }
  return { tickets, months };
}

/** The next unreached rung and how many more verified friends it needs. */
export function nextLadderRung(
  verifiedCount: number,
  ladder: readonly ReferralLadderRung[] = env.REFERRAL_LADDER,
): { rung: ReferralLadderRung; remaining: number } | null {
  for (const rung of ladder) {
    if (rung.atCount > verifiedCount) {
      return { rung, remaining: rung.atCount - verifiedCount };
    }
  }
  return null;
}

export interface ReferralRewardResult {
  referrerId: string;
  /** Referrer's lifetime verified-friend tally after this event. */
  verifiedCount: number;
  /** Tickets actually credited in this invocation (0 if held/already granted). */
  ticketsApplied: number;
  /** Premium months actually credited in this invocation. */
  monthsApplied: number;
  /** True when the velocity guard held rewards for this event. */
  heldByVelocity: boolean;
}

/**
 * Grant any ladder rungs the referrer has reached but not yet been paid for,
 * up to `verifiedCount`. Self-healing + exactly-once: each rung is claimed via a
 * unique `externalPaymentId` (`referral-rung:<referrerId>:<atCount>`), so
 * duplicates are no-ops and a rung skipped earlier is settled here on a later
 * call. Returns the deltas that actually applied this call.
 */
export async function reconcileReferrerRungs(
  referrerId: string,
  verifiedCount: number,
): Promise<{ ticketsApplied: number; monthsApplied: number }> {
  let ticketsApplied = 0;
  let monthsApplied = 0;

  for (const rung of env.REFERRAL_LADDER) {
    if (rung.atCount > verifiedCount) continue;
    const idBase = `referral-rung:${referrerId}:${rung.atCount}`;

    if (rung.tickets > 0) {
      try {
        await grantTickets({
          userId: referrerId,
          count: rung.tickets,
          reason: "referral_milestone",
          externalPaymentId: `${idBase}:tickets`,
        });
        ticketsApplied += rung.tickets;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // already granted → no-op
      }
    }

    if (rung.months > 0) {
      const res = await grantComplimentaryPremiumMonths({
        userId: referrerId,
        months: rung.months,
        externalPaymentId: `${idBase}:premium`,
        note: "referral milestone reward",
      });
      if (res.applied) monthsApplied += rung.months;
    }
  }

  return { ticketsApplied, monthsApplied };
}

/**
 * Called when `inviteeUserId` reaches `verified`. Resolves the referrer,
 * counts the invitee exactly once toward them (CAS on `referralCountedAt`),
 * increments the referrer's lifetime tally, applies the velocity guard, and
 * settles any reached ladder rungs. Best-effort and fully idempotent — safe to
 * call from every path that can land a user on `verified`.
 *
 * Returns the result (with applied deltas for the notifier) or null when there
 * is nothing to do (feature off, no/invalid referrer, self-referral, or the
 * invitee was already counted).
 */
export async function grantReferralRewardsForVerifiedInvitee(
  inviteeUserId: string,
): Promise<ReferralRewardResult | null> {
  if (!env.REFERRAL_FEATURE_ENABLED) return null;

  const invitee = await prisma.user.findUnique({
    where: { id: inviteeUserId },
    select: { id: true, referralSource: true, referralCountedAt: true, phone: true },
  });
  if (!invitee) return null;

  const referrerId = parseReferrer(invitee.referralSource);
  if (!referrerId || referrerId === invitee.id) return null;

  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { id: true, status: true, phone: true },
  });
  if (!referrer) return null;
  if (REWARD_BLOCKED_STATUSES.has(referrer.status)) return null;
  // Self-referral by shared verified phone (same human, two accounts).
  if (invitee.phone && referrer.phone && invitee.phone === referrer.phone) return null;

  // Count this invitee exactly once toward the referrer, and bump the tally in
  // the same transaction so concurrent verifications can't double-count.
  const verifiedCount = await prisma.$transaction(async (tx) => {
    const cas = await tx.user.updateMany({
      where: { id: invitee.id, referralCountedAt: null },
      data: { referralCountedAt: new Date() },
    });
    if (cas.count === 0) return null; // already counted → idempotent no-op
    const updated = await tx.user.update({
      where: { id: referrerId },
      data: { referralVerifiedCount: { increment: 1 } },
      select: { referralVerifiedCount: true },
    });
    return updated.referralVerifiedCount;
  });
  if (verifiedCount === null) return null;

  // Velocity guard: hold rewards (not the honest tally) when this referrer has
  // had more than the cap of invitees counted in the last 24h — a fraud-burst
  // throttle that matters most while Persona is sandbox. Held rungs are
  // self-healing: the next under-cap event (or a Mini-App reconcile) settles
  // them, so a legit power-referrer is delayed, never denied.
  if (env.REFERRAL_DAILY_REWARD_CAP > 0) {
    const since = new Date(Date.now() - ONE_DAY_MS);
    const recent = await prisma.user.count({
      where: {
        referralCountedAt: { gte: since },
        OR: [
          { referralSource: `referral:${referrerId}` },
          { referralSource: `tg:referral_${referrerId}` },
          { referralSource: `tg-mini:referral_${referrerId}` },
        ],
      },
    });
    if (recent > env.REFERRAL_DAILY_REWARD_CAP) {
      console.warn(
        `[referral] velocity cap hit: referrer=${referrerId} counted=${recent} in 24h — holding rewards`,
      );
      return { referrerId, verifiedCount, ticketsApplied: 0, monthsApplied: 0, heldByVelocity: true };
    }
  }

  const { ticketsApplied, monthsApplied } = await reconcileReferrerRungs(
    referrerId,
    verifiedCount,
  );
  return { referrerId, verifiedCount, ticketsApplied, monthsApplied, heldByVelocity: false };
}

/**
 * Grant the INVITEE their one-time welcome Premium month (shown on the
 * onboarding wow screen). Exactly-once via the unique
 * `referral-invitee-premium:<inviteeId>` ledger id; also stamps
 * `referralInviteePremiumAt` so the screen shows once. Only for genuinely
 * invited users (a real referrer, not self).
 */
export async function grantInviteePremium(
  inviteeUserId: string,
): Promise<{ applied: boolean; months: number }> {
  const months = env.REFERRAL_INVITEE_PREMIUM_MONTHS;
  if (!env.REFERRAL_FEATURE_ENABLED || months <= 0) return { applied: false, months };

  const invitee = await prisma.user.findUnique({
    where: { id: inviteeUserId },
    select: { id: true, referralSource: true, referralInviteePremiumAt: true },
  });
  if (!invitee) return { applied: false, months };
  if (invitee.referralInviteePremiumAt) return { applied: false, months };

  const referrerId = parseReferrer(invitee.referralSource);
  if (!referrerId || referrerId === invitee.id) return { applied: false, months };

  const res = await grantComplimentaryPremiumMonths({
    userId: invitee.id,
    months,
    externalPaymentId: `referral-invitee-premium:${invitee.id}`,
    note: "referral welcome gift",
  });
  // Stamp the once-marker (the ledger id already guarantees exactly-once premium;
  // this only drives the "show the wow screen once" flag).
  await prisma.user.updateMany({
    where: { id: invitee.id, referralInviteePremiumAt: null },
    data: { referralInviteePremiumAt: new Date() },
  });
  return { applied: res.applied, months };
}
