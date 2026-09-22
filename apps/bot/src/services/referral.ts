import { prisma, type Prisma, type UserStatus } from "@gennety/db";
import { REFERRAL_RELEASE_SWEEP_BATCH } from "@gennety/shared";
import { env } from "../config.js";
import { hasTrackVerifiedContact } from "./contact-verification.js";
import { keyedIdentitiesOf } from "./safety-tombstone.js";
import { grantTicketsInTx } from "./ticket-wallet.js";

/**
 * Referral program core ("Give a date, get a date", §Referral).
 *
 * A referrer shares a `t.me/<bot>?start=referral_<referrerUserId>` link; the
 * invitee's first-touch `User.referralSource` records it. When the invitee
 * clears verification, BOTH sides are paid in Date Tickets — never Premium
 * (founder decision 2026-09-22: a Premium reward cannibalised the subscription
 * and priced the program in money):
 *   - the referrer gets `REFERRAL_TICKETS_PER_FRIEND` per friend, for at most
 *     `REFERRAL_MAX_REWARDED_FRIENDS` friends, throttled by the 24h velocity
 *     cap (`REFERRAL_DAILY_REWARD_CAP`) — a held reward is released later;
 *   - the invitee gets `REFERRAL_INVITEE_TICKETS`.
 *
 * Each counted invitee is one `ReferralQualification`, written in the same
 * transaction that stamps `referralCountedAt` and credits the tickets, with the
 * invitee's proven identities kept as keyed hashes (`ReferralIdentity`) so a
 * deleted account that re-registers is recognised and pays nobody. Ledger rows
 * carry `reason: "referral_reward"` and the unique
 * `referral:<qualificationId>:referrer|invitee` key.
 *
 * Everything here no-ops when `REFERRAL_FEATURE_ENABLED` is off.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** User statuses that forfeit referral rewards (moderation / bad actor). */
const REWARD_BLOCKED_STATUSES = new Set<UserStatus>(["banned", "pending_investigation", "suspended"]);

/**
 * Key label for `referral_identities` hashes. Its own label, so these rows can
 * never be joined to `safety_tombstones`. Bumping it forgets every counted
 * identity — a deliberate, total reset.
 */
const REFERRAL_IDENTITY_LABEL = "referral-identity/v1";

/** The referrer side of a `ReferralQualification` (see the model). */
export type ReferralQualificationStatus = "credited" | "held" | "capped" | "duplicate";

/** Rows that took (or reserve) one of the referrer's rewarded slots. */
const SLOT_STATUSES: ReferralQualificationStatus[] = ["credited", "held"];
/** Rows that are a counted friend — what the velocity window counts. */
const COUNTED_STATUSES: ReferralQualificationStatus[] = ["credited", "held", "capped"];

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

export interface ReferralStateView {
  inviteLink: string;
  /** Friends who cleared verification through this referrer's link. */
  verifiedCount: number;
  /** Tickets already credited to the referrer by the program. */
  earnedTickets: number;
  /** Tickets earned but held by the daily cap; credited automatically. */
  pendingTickets: number;
  /** What the referrer earns per verified friend. */
  ticketsPerFriend: number;
  /** What the invited friend gets when they clear verification. */
  inviteeTickets: number;
  /** Lifetime rewarded-friend cap. */
  rewardCap: number;
  /** How many more friends can still earn this referrer a reward. */
  rewardsLeft: number;
}

/** Earned / pending tickets and used reward slots for one referrer. */
async function referrerTotals(
  referrerId: string,
): Promise<{ earnedTickets: number; pendingTickets: number; slotsUsed: number }> {
  const rows = await prisma.referralQualification.groupBy({
    by: ["status"],
    where: { referrerId, status: { in: SLOT_STATUSES } },
    _sum: { referrerTickets: true },
    _count: { _all: true },
  });
  let earnedTickets = 0;
  let pendingTickets = 0;
  let slotsUsed = 0;
  for (const row of rows) {
    const tickets = row._sum.referrerTickets ?? 0;
    if (row.status === "credited") earnedTickets += tickets;
    if (row.status === "held") pendingTickets += tickets;
    slotsUsed += row._count._all;
  }
  return { earnedTickets, pendingTickets, slotsUsed };
}

/**
 * The referral screen state (shared by the Telegram Mini App and the iOS JWT
 * surface). Tickets only — no money and no Premium: the program's value is a
 * date, not a price (decision 2026-09-22).
 */
export async function buildReferralStateView(
  userId: string,
  verifiedCount: number,
  botUsername: string,
): Promise<ReferralStateView> {
  const totals = await referrerTotals(userId);
  const rewardCap = env.REFERRAL_MAX_REWARDED_FRIENDS;
  return {
    inviteLink: buildReferralLink(userId, botUsername),
    verifiedCount,
    earnedTickets: totals.earnedTickets,
    pendingTickets: totals.pendingTickets,
    ticketsPerFriend: env.REFERRAL_TICKETS_PER_FRIEND,
    inviteeTickets: env.REFERRAL_INVITEE_TICKETS,
    rewardCap,
    rewardsLeft: Math.max(0, rewardCap - totals.slotsUsed),
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

export interface ReferralRewardResult {
  referrerId: string;
  qualificationId: string;
  status: ReferralQualificationStatus;
  /** Referrer's lifetime verified-friend tally after this event. */
  verifiedCount: number;
  /** Tickets credited to the referrer in this call (0 if held/capped/duplicate). */
  referrerTicketsApplied: number;
  /** Tickets credited to the invitee in this call. */
  inviteeTicketsApplied: number;
  /** Rewarded slots the referrer still has after this event. */
  rewardsLeft: number;
}

/** Ledger key of one side of one qualification — the exactly-once guard. */
export function referralLedgerKey(qualificationId: string, side: "referrer" | "invitee"): string {
  return `referral:${qualificationId}:${side}`;
}

/**
 * Called when `inviteeUserId` reaches `verified`. Resolves the referrer, and in
 * ONE transaction counts the invitee exactly once (CAS on `referralCountedAt`),
 * records the `ReferralQualification` + identity hashes, decides the referrer
 * side (credited / held / capped / duplicate) and credits the tickets of both
 * sides. Best-effort and fully idempotent — safe to call from every path that
 * can land a user on `verified`.
 *
 * Returns the result (for the notifier) or null when there is nothing to do
 * (feature off, not yet eligible, no/invalid referrer, self-referral, a blocked
 * account on either side, or the invitee was already counted).
 */
export async function grantReferralRewardsForVerifiedInvitee(
  inviteeUserId: string,
): Promise<ReferralRewardResult | null> {
  if (!env.REFERRAL_FEATURE_ENABLED) return null;

  const invitee = await prisma.user.findUnique({
    where: { id: inviteeUserId },
    select: {
      id: true,
      status: true,
      referralSource: true,
      referralCountedAt: true,
      telegramId: true,
      phone: true,
      verificationStatus: true,
      onboardingStep: true,
      registrationTrack: true,
      email: true,
      isEmailVerified: true,
      phoneVerifiedAt: true,
    },
  });
  if (!invitee) return null;

  // An invitee counts only once they are a member matching could actually
  // serve: liveness-verified, onboarding finished, and a verified track contact
  // (audit A13-M18). Liveness alone proves a live face, not a registration — a
  // farm of half-created accounts could otherwise pay a referrer friend by
  // friend while never being matchable. Refused before anything is written, so
  // `referralCountedAt` stays empty and a later verified run can still settle.
  // A blocked invitee is refused the same way (decision 2026-09-22).
  if (
    invitee.verificationStatus !== "verified" ||
    invitee.onboardingStep !== "completed" ||
    !hasTrackVerifiedContact(invitee) ||
    REWARD_BLOCKED_STATUSES.has(invitee.status)
  ) {
    return null;
  }

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

  const identities = keyedIdentitiesOf(invitee, REFERRAL_IDENTITY_LABEL);
  const ticketsPerFriend = env.REFERRAL_TICKETS_PER_FRIEND;
  const inviteeTickets = env.REFERRAL_INVITEE_TICKETS;

  const result = await prisma.$transaction(async (tx) => {
    // Count this invitee exactly once. A concurrent run blocks on this row and
    // then matches nothing.
    const cas = await tx.user.updateMany({
      where: { id: invitee.id, referralCountedAt: null },
      data: { referralCountedAt: new Date() },
    });
    if (cas.count === 0) return null; // already counted → idempotent no-op

    // The same person counted before under an account that no longer exists
    // (delete + re-register): nobody is paid and the friend does not count.
    const seen =
      identities.length > 0
        ? await tx.referralIdentity.count({
            where: { identityHash: { in: identities.map((i) => i.identityHash) } },
          })
        : 0;

    let status: ReferralQualificationStatus;
    let verifiedCount: number;
    let slotsUsed = 0;
    if (seen > 0) {
      status = "duplicate";
      const current = await tx.user.findUniqueOrThrow({
        where: { id: referrerId },
        select: { referralVerifiedCount: true },
      });
      verifiedCount = current.referralVerifiedCount;
    } else {
      // Bumping the tally takes the referrer's row lock, so two friends of the
      // same referrer settling at once decide their slots one after the other
      // and the lifetime cap cannot be overshot.
      const bumped = await tx.user.update({
        where: { id: referrerId },
        data: { referralVerifiedCount: { increment: 1 } },
        select: { referralVerifiedCount: true },
      });
      verifiedCount = bumped.referralVerifiedCount;
      slotsUsed = await tx.referralQualification.count({
        where: { referrerId, status: { in: SLOT_STATUSES } },
      });
      if (slotsUsed >= env.REFERRAL_MAX_REWARDED_FRIENDS) {
        status = "capped";
      } else if ((await countedInVelocityWindow(tx, referrerId)) + 1 > velocityCap()) {
        // Velocity guard: a fraud-burst throttle. The honest tally still moves;
        // the reward waits for `releaseHeldReferralRewards` — delayed, never denied.
        status = "held";
      } else {
        status = "credited";
      }
    }

    const referrerShare = status === "capped" || status === "duplicate" ? 0 : ticketsPerFriend;
    const inviteeShare = status === "duplicate" ? 0 : inviteeTickets;
    const qualification = await tx.referralQualification.create({
      data: {
        inviteeId: invitee.id,
        referrerId,
        status,
        referrerTickets: referrerShare,
        inviteeTickets: inviteeShare,
        creditedAt: status === "credited" ? new Date() : null,
      },
      select: { id: true },
    });
    if (identities.length > 0) {
      await tx.referralIdentity.createMany({
        data: identities.map((identity) => ({
          identityHash: identity.identityHash,
          kind: identity.kind,
          qualificationId: qualification.id,
        })),
        skipDuplicates: true,
      });
    }

    let referrerTicketsApplied = 0;
    if (status === "credited" && referrerShare > 0) {
      await grantTicketsInTx(tx, {
        userId: referrerId,
        count: referrerShare,
        reason: "referral_reward",
        externalPaymentId: referralLedgerKey(qualification.id, "referrer"),
      });
      referrerTicketsApplied = referrerShare;
    }
    let inviteeTicketsApplied = 0;
    if (inviteeShare > 0) {
      await grantTicketsInTx(tx, {
        userId: invitee.id,
        count: inviteeShare,
        reason: "referral_reward",
        externalPaymentId: referralLedgerKey(qualification.id, "invitee"),
      });
      inviteeTicketsApplied = inviteeShare;
    }

    const slotsAfter = slotsUsed + (status === "credited" || status === "held" ? 1 : 0);
    return {
      referrerId,
      qualificationId: qualification.id,
      status,
      verifiedCount,
      referrerTicketsApplied,
      inviteeTicketsApplied,
      rewardsLeft: Math.max(0, env.REFERRAL_MAX_REWARDED_FRIENDS - slotsAfter),
    } satisfies ReferralRewardResult;
  });
  if (!result) return null;

  if (result.status === "held") {
    console.warn(
      `[referral] velocity cap hit: referrer=${referrerId} — holding reward ` +
        `qualification=${result.qualificationId}`,
    );
  }
  if (result.referrerTicketsApplied > 0 || result.inviteeTicketsApplied > 0) {
    console.info("[referral] referral_ticket_earned", {
      qualificationId: result.qualificationId,
      referrerId,
      inviteeId: invitee.id,
      status: result.status,
      referrerTickets: result.referrerTicketsApplied,
      inviteeTickets: result.inviteeTicketsApplied,
    });
  }
  return result;
}

/** `REFERRAL_DAILY_REWARD_CAP`, or Infinity when the cap is switched off (0). */
function velocityCap(): number {
  return env.REFERRAL_DAILY_REWARD_CAP > 0
    ? env.REFERRAL_DAILY_REWARD_CAP
    : Number.POSITIVE_INFINITY;
}

/**
 * How many of `referrerId`'s friends were counted inside the 24h velocity
 * window. One definition for the hold and for the release, so a reward is never
 * released under a looser rule than the one that held it.
 */
async function countedInVelocityWindow(
  db: Prisma.TransactionClient,
  referrerId: string,
): Promise<number> {
  return db.referralQualification.count({
    where: {
      referrerId,
      status: { in: COUNTED_STATUSES },
      createdAt: { gte: new Date(Date.now() - ONE_DAY_MS) },
    },
  });
}

export interface ReferralReleaseResult {
  ticketsApplied: number;
  /** True while the referrer is still over the cap — nothing released yet. */
  stillHeld: boolean;
}

/**
 * Release referrer rewards the velocity cap held back (§Referral). Once the
 * referrer is back under the cap, every `held` qualification is credited
 * through its own exactly-once guard (a CAS on the row's status, plus the unique
 * ledger key). Blocked referrers stay unpaid, as at the hold. Called from the
 * referral screen (both surfaces) and from the hourly sweep.
 */
export async function releaseHeldReferralRewards(
  referrerId: string,
): Promise<ReferralReleaseResult> {
  const nothing: ReferralReleaseResult = { ticketsApplied: 0, stillHeld: false };
  if (!env.REFERRAL_FEATURE_ENABLED) return nothing;

  const referrer = await prisma.user.findUnique({
    where: { id: referrerId },
    select: { id: true, status: true },
  });
  if (!referrer || REWARD_BLOCKED_STATUSES.has(referrer.status)) return nothing;

  const held = await prisma.referralQualification.findMany({
    where: { referrerId, status: "held" },
    orderBy: { createdAt: "asc" },
    select: { id: true, referrerTickets: true },
  });
  if (held.length === 0) return nothing;
  if ((await countedInVelocityWindow(prisma, referrerId)) > velocityCap()) {
    return { ...nothing, stillHeld: true };
  }

  let ticketsApplied = 0;
  for (const row of held) {
    ticketsApplied += await prisma.$transaction(async (tx) => {
      const claimed = await tx.referralQualification.updateMany({
        where: { id: row.id, status: "held" },
        data: { status: "credited", creditedAt: new Date() },
      });
      if (claimed.count === 0 || row.referrerTickets <= 0) return 0; // released concurrently
      await grantTicketsInTx(tx, {
        userId: referrerId,
        count: row.referrerTickets,
        reason: "referral_reward",
        externalPaymentId: referralLedgerKey(row.id, "referrer"),
      });
      return row.referrerTickets;
    });
  }
  if (ticketsApplied > 0) {
    console.info("[referral] referral_ticket_earned (released)", {
      referrerId,
      referrerTickets: ticketsApplied,
    });
  }
  return { ticketsApplied, stillHeld: false };
}

/**
 * Where the hourly sweep resumes. In memory on purpose: a restart only means
 * the next tick starts from the first referrer again, and every release is
 * exactly-once, so re-examining a referrer costs a read, never a double grant.
 */
let releaseSweepCursor: string | null = null;

/**
 * Hourly sweep: release held rewards for referrers who never open their
 * referral screen. Walks every referrer with a `held` qualification, one
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

  const page = await prisma.referralQualification.findMany({
    where: {
      status: "held",
      referrerId: releaseSweepCursor ? { gt: releaseSweepCursor } : { not: null },
    },
    distinct: ["referrerId"],
    orderBy: { referrerId: "asc" },
    take: REFERRAL_RELEASE_SWEEP_BATCH,
    select: { referrerId: true },
  });
  // A short page is the end of the list: start over next tick.
  releaseSweepCursor =
    page.length < REFERRAL_RELEASE_SWEEP_BATCH ? null : (page.at(-1)?.referrerId ?? null);
  result.scanned = page.length;

  for (const { referrerId } of page) {
    if (!referrerId) continue;
    try {
      const released = await releaseHeldReferralRewards(referrerId);
      if (released.stillHeld) result.stillHeld += 1;
      else if (released.ticketsApplied > 0) result.released += 1;
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
 * Mark that the invitee saw the onboarding invite screen (§Referral). The
 * screen only TELLS them about the ticket they will get on verification —
 * nothing is granted here (the Premium welcome gift it used to claim was
 * retired 2026-09-22). Idempotent; returns whether this call set the marker.
 */
export async function markReferralGiftSeen(userId: string): Promise<boolean> {
  const res = await prisma.user.updateMany({
    where: { id: userId, referralGiftSeenAt: null },
    data: { referralGiftSeenAt: new Date() },
  });
  return res.count > 0;
}
