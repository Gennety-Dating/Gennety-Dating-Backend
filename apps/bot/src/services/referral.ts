import { prisma, type UserStatus } from "@gennety/db";
import { REFERRAL_RELEASE_SWEEP_BATCH } from "@gennety/shared";
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
const REWARD_BLOCKED_STATUSES = new Set<UserStatus>(["banned", "pending_investigation", "suspended"]);

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

/**
 * Canonical `User.referralSource` for a first-touch Telegram deep-link / Mini-App
 * `start`/`startapp` param. A `referral_<id>` payload becomes the resolvable
 * `referral:<id>`; anything else keeps its channel `prefix` (`tg` / `tg-mini`)
 * so ordinary campaign attribution is unchanged.
 */
export function referralSourceFromParam(param: string, channelPrefix: string): string {
  const m = /^referral_(.+)$/.exec(param);
  const id = m?.[1].trim();
  if (id) return `referral:${id}`;
  return `${channelPrefix}:${param}`;
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

function ticketUsd(): number {
  return env.TICKET_PRICE_CENTS / 100;
}

/** Numeric monthly Premium price parsed from the display string ("$11.99"). */
function premiumMonthlyUsd(): number {
  const m = /([\d]+(?:\.[\d]+)?)/.exec(env.PREMIUM_PRICE_USD_DISPLAY);
  return m ? Number(m[1]) : 0;
}

/** Dollar value of `tickets` Date Tickets + `months` Premium months ("$18.98"). */
export function referralUsdValue(tickets: number, months: number): string {
  const v = tickets * ticketUsd() + months * premiumMonthlyUsd();
  return `$${v.toFixed(2)}`;
}

export interface ReferralStateView {
  inviteLink: string;
  verifiedCount: number;
  earnedTickets: number;
  earnedMonths: number;
  earnedUsd: string;
  ladder: Array<{
    atCount: number;
    tickets: number;
    months: number;
    usd: string;
    reached: boolean;
  }>;
  next: { atCount: number; remaining: number; usd: string } | null;
  inviteeMonths: number;
}

/**
 * Assemble the referral ladder view (shared by the Telegram Mini App and the
 * iOS JWT surface). `verifiedCount` is the referrer's materialized tally; every
 * rung carries its cumulative $ value so a client never re-derives money.
 */
export function buildReferralStateView(
  userId: string,
  verifiedCount: number,
  botUsername: string,
): ReferralStateView {
  const ladder = env.REFERRAL_LADDER.map((rung) => {
    const cum = cumulativeLadderTotals(rung.atCount);
    return {
      atCount: rung.atCount,
      tickets: cum.tickets,
      months: cum.months,
      usd: referralUsdValue(cum.tickets, cum.months),
      reached: verifiedCount >= rung.atCount,
    };
  });
  const totals = cumulativeLadderTotals(verifiedCount);
  const next = nextLadderRung(verifiedCount);
  const nextCum = next ? cumulativeLadderTotals(next.rung.atCount) : null;
  return {
    inviteLink: buildReferralLink(userId, botUsername),
    verifiedCount,
    earnedTickets: totals.tickets,
    earnedMonths: totals.months,
    earnedUsd: referralUsdValue(totals.tickets, totals.months),
    ladder,
    next:
      next && nextCum
        ? {
            atCount: next.rung.atCount,
            remaining: next.remaining,
            usd: referralUsdValue(nextCum.tickets, nextCum.months),
          }
        : null,
    inviteeMonths: env.REFERRAL_INVITEE_PREMIUM_MONTHS,
  };
}

/**
 * Attribute an iOS/mobile invitee to a referrer by code (§Referral, iOS entry).
 * First-touch + guarded: only writes `referralSource` when the user has none
 * yet, the code resolves to a real *other* user, and it isn't a self-referral.
 * Returns whether attribution was applied.
 */
export async function claimReferralCode(
  inviteeUserId: string,
  code: string,
): Promise<{ applied: boolean; reason?: string }> {
  if (!env.REFERRAL_FEATURE_ENABLED) return { applied: false, reason: "disabled" };
  const referrerId = parseReferrer(`referral:${code.trim()}`);
  if (!referrerId || referrerId === inviteeUserId) {
    return { applied: false, reason: "invalid" };
  }
  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { id: true },
  });
  if (!referrer) return { applied: false, reason: "unknown-referrer" };

  // First-touch only: never overwrite an existing attribution.
  const cas = await prisma.user.updateMany({
    where: { id: inviteeUserId, referralSource: null },
    data: { referralSource: `referral:${referrerId}` },
  });
  return cas.count > 0 ? { applied: true } : { applied: false, reason: "already-attributed" };
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
  // self-healing: `releaseHeldReferralRewards` settles them once the burst is
  // out of the window — from the referrer's own referral screen and from the
  // hourly sweep — so a legit power-referrer is delayed, never denied.
  const recent = await countedInVelocityWindow(referrerId);
  if (recent !== null) {
    console.warn(
      `[referral] velocity cap hit: referrer=${referrerId} counted=${recent} in 24h — holding rewards`,
    );
    return { referrerId, verifiedCount, ticketsApplied: 0, monthsApplied: 0, heldByVelocity: true };
  }

  const { ticketsApplied, monthsApplied } = await reconcileReferrerRungs(
    referrerId,
    verifiedCount,
  );
  return { referrerId, verifiedCount, ticketsApplied, monthsApplied, heldByVelocity: false };
}

/**
 * How many of `referrerId`'s invitees were counted inside the velocity window
 * — or null when the referrer is NOT over the cap (including when the cap is
 * off). One definition for the hold and for the release, so a reward is never
 * released under a looser rule than the one that held it.
 */
async function countedInVelocityWindow(referrerId: string): Promise<number | null> {
  if (env.REFERRAL_DAILY_REWARD_CAP <= 0) return null;
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
  return recent > env.REFERRAL_DAILY_REWARD_CAP ? recent : null;
}

/** The unique ledger ids every rung `verifiedCount` has reached must carry. */
function reachedRungKeys(
  referrerId: string,
  verifiedCount: number,
): { tickets: string[]; premium: string[] } {
  const tickets: string[] = [];
  const premium: string[] = [];
  for (const rung of env.REFERRAL_LADDER) {
    if (rung.atCount > verifiedCount) continue;
    const idBase = `referral-rung:${referrerId}:${rung.atCount}`;
    if (rung.tickets > 0) tickets.push(`${idBase}:tickets`);
    if (rung.months > 0) premium.push(`${idBase}:premium`);
  }
  return { tickets, premium };
}

/**
 * Which of these referrers have a reached rung with no ledger row yet — the
 * rewards the velocity cap held back. Two lookups for the whole batch, so the
 * sweep and the state screen ask "is anything owed" without replaying
 * `reconcileReferrerRungs`' inserts (each already-paid rung is a failed unique
 * insert) for referrers who are fully paid.
 */
async function referrersOwedRungs(
  referrers: ReadonlyArray<{ id: string; referralVerifiedCount: number }>,
): Promise<Set<string>> {
  const expected = referrers.map((r) => ({
    id: r.id,
    ...reachedRungKeys(r.id, r.referralVerifiedCount),
  }));
  const ticketKeys = expected.flatMap((e) => e.tickets);
  const premiumKeys = expected.flatMap((e) => e.premium);
  const [ticketRows, premiumRows] = await Promise.all([
    ticketKeys.length > 0
      ? prisma.ticketLedger.findMany({
          where: { externalPaymentId: { in: ticketKeys } },
          select: { externalPaymentId: true },
        })
      : Promise.resolve([]),
    premiumKeys.length > 0
      ? prisma.subscriptionLedger.findMany({
          where: { externalPaymentId: { in: premiumKeys } },
          select: { externalPaymentId: true },
        })
      : Promise.resolve([]),
  ]);
  const paid = new Set(
    [...ticketRows, ...premiumRows].flatMap((row) =>
      row.externalPaymentId ? [row.externalPaymentId] : [],
    ),
  );
  return new Set(
    expected
      .filter((e) => [...e.tickets, ...e.premium].some((key) => !paid.has(key)))
      .map((e) => e.id),
  );
}

export interface ReferralReleaseResult {
  ticketsApplied: number;
  monthsApplied: number;
  /** True while the referrer is still over the cap — nothing released yet. */
  stillHeld: boolean;
}

/**
 * Release ladder rewards the velocity cap held back (§Referral).
 *
 * The cap holds a reward; nothing used to give it back. The comment promised
 * "the next under-cap event settles them", but that event is another friend
 * verifying — a referrer whose burst was their last invites simply never got
 * what the screen told them they had earned. This is the release: once the
 * referrer is back under the cap, every reached-but-unpaid rung is paid through
 * the same exactly-once keys. Blocked referrers stay unpaid, as at the hold.
 */
export async function releaseHeldReferralRewards(
  referrerId: string,
): Promise<ReferralReleaseResult> {
  const nothing: ReferralReleaseResult = { ticketsApplied: 0, monthsApplied: 0, stillHeld: false };
  if (!env.REFERRAL_FEATURE_ENABLED) return nothing;

  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { id: true, status: true, referralVerifiedCount: true },
  });
  if (!referrer || referrer.referralVerifiedCount <= 0) return nothing;
  if (REWARD_BLOCKED_STATUSES.has(referrer.status)) return nothing;

  const owed = await referrersOwedRungs([referrer]);
  if (!owed.has(referrer.id)) return nothing;
  if ((await countedInVelocityWindow(referrer.id)) !== null) {
    return { ...nothing, stillHeld: true };
  }

  const applied = await reconcileReferrerRungs(referrer.id, referrer.referralVerifiedCount);
  if (applied.ticketsApplied > 0 || applied.monthsApplied > 0) {
    console.info(
      `[referral] released held rewards referrer=${referrer.id} ` +
        `tickets=${applied.ticketsApplied} months=${applied.monthsApplied}`,
    );
  }
  return { ...applied, stillHeld: false };
}

/**
 * Where the hourly sweep resumes. In memory on purpose: a restart only means
 * the next tick starts from the first referrer again, and every release is
 * exactly-once, so re-examining a referrer costs a read, never a double grant.
 */
let releaseSweepCursor: string | null = null;

/**
 * Hourly sweep: release held rewards for referrers who never open their
 * referral screen. Walks every referrer who reached at least one rung, one
 * bounded page (`REFERRAL_RELEASE_SWEEP_BATCH`) per tick, wrapping around.
 * Safe to run at any cadence — each release re-checks the cap itself.
 */
export async function sweepHeldReferralRewards(): Promise<{
  scanned: number;
  released: number;
  stillHeld: number;
}> {
  const result = { scanned: 0, released: 0, stillHeld: 0 };
  if (!env.REFERRAL_FEATURE_ENABLED) return result;
  const firstRung = Math.min(...env.REFERRAL_LADDER.map((rung) => rung.atCount));
  if (!Number.isFinite(firstRung)) return result;

  const page = await prisma.user.findMany({
    where: {
      referralVerifiedCount: { gte: firstRung },
      status: { notIn: [...REWARD_BLOCKED_STATUSES] },
      ...(releaseSweepCursor ? { id: { gt: releaseSweepCursor } } : {}),
    },
    orderBy: { id: "asc" },
    take: REFERRAL_RELEASE_SWEEP_BATCH,
    select: { id: true, referralVerifiedCount: true },
  });
  // A short page is the end of the list: start over next tick.
  releaseSweepCursor = page.length < REFERRAL_RELEASE_SWEEP_BATCH ? null : (page.at(-1)?.id ?? null);
  result.scanned = page.length;
  if (page.length === 0) return result;

  const owed = await referrersOwedRungs(page);
  for (const referrerId of owed) {
    try {
      const released = await releaseHeldReferralRewards(referrerId);
      if (released.stillHeld) result.stillHeld += 1;
      else if (released.ticketsApplied > 0 || released.monthsApplied > 0) result.released += 1;
    } catch (err) {
      console.error(`[referral] held-reward release failed referrer=${referrerId}:`, err);
    }
  }
  return result;
}

/** Test hook — the sweep's page cursor is module state. */
export function resetReferralReleaseSweepForTests(): void {
  releaseSweepCursor = null;
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
