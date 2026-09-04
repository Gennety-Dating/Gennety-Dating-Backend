import { prisma } from "@gennety/db";
import {
  PHOTO_BONUS_TICKET_THRESHOLD,
  STUDENT_BONUS_TICKETS,
  normalizeProfileMedia,
  profileMediaHasVideo,
} from "@gennety/shared";
import { env } from "../config.js";

/**
 * Ticket wallet — the user-owned balance of Date Tickets (PRODUCT_SPEC §3.5b).
 *
 * A ticket is spent at the date gate (one per person, per date). The balance is
 * topped up by bundle purchases (store Mini App) and one-time onboarding
 * bonuses (6+ profile photos, adding a profile video, completing identity
 * verification). Everything here is gated by `TICKET_FEATURE_ENABLED`; when
 * the flag is off, grants are no-ops so production behavior is unchanged.
 *
 * `User.ticketBalance` is the materialized running sum of `TicketLedger.delta`.
 * Both are written in the SAME transaction so the ledger stays the append-only
 * source of truth and the counter never drifts.
 */

export type TicketReason =
  | "photo_bonus"
  | "video_bonus"
  // Legacy: the identity-verification bonus was retired. No new rows are
  // written with this reason; it stays in the union so historical ledger rows
  // (and their balances) remain valid.
  | "verification_bonus"
  | "student_bonus"
  | "welcome_gift"
  // Referral ladder reward (PRODUCT_SPEC §Referral). Written for the referrer
  // each time an invited friend clears verification and a ladder rung is
  // reached; idempotent via a synthetic unique `externalPaymentId`
  // (`referral-rung:<referrerId>:<rung>`).
  | "referral_milestone"
  // Independent promo-code welcome gift (PROMO_CODES_PRODUCT_SPEC.md). Granted
  // once to a promo-attributed new user at the onboarding wow screen; idempotent
  // via a unique `externalPaymentId` (`promo:<codeId>:<userId>`).
  | "promo"
  // Date Bump reward (PRODUCT_SPEC §6.2). One free ticket to each side when a
  // bump verifies at the venue; idempotent via a synthetic unique
  // `externalPaymentId` (`bump:<matchId>:<userId>`).
  | "bump_bonus"
  | "store_purchase"
  | "spend_match"
  | "refund";

export async function getBalance(userId: string): Promise<number> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { ticketBalance: true },
  });
  return user?.ticketBalance ?? 0;
}

export interface TicketHistoryEntry {
  id: string;
  delta: number;
  reason: TicketReason;
  bundleSize: number | null;
  createdAt: Date;
}

export type TicketHistoryPage =
  | { status: "ok"; entries: TicketHistoryEntry[]; hasMore: boolean }
  | { status: "bad_cursor" };

/**
 * One page of the wallet's movements, newest first (native Tickets tab, TH1).
 *
 * **Money is deliberately not returned.** `TicketLedger.amountCents` carries
 * what Apple charged in the buyer's STOREFRONT currency, and the column has no
 * currency beside it — an App Store row bought in euro is indistinguishable
 * from a dollar row. Rendering it would put a wrong currency symbol in front of
 * a right number, which is worse than showing no price at all; the product's
 * standing rule is that the only place a price appears is StoreKit's own
 * `displayPrice`. What a wallet history actually has to answer is "where did my
 * tickets go", and that is `delta` + `reason` + the date.
 *
 * `amountStars` is left out for the same reason from the other side: Stars are
 * a Telegram rail, and a number of them means nothing on a screen that cannot
 * spend or buy them.
 */
export async function listTicketHistory(args: {
  userId: string;
  limit: number;
  /** Ledger row id to page from, exclusive. */
  before?: string | undefined;
}): Promise<TicketHistoryPage> {
  const { userId, limit, before } = args;

  if (before) {
    // The cursor must be one of THIS user's rows: a foreign id would otherwise
    // page through somebody else's wallet.
    const owner = await prisma.ticketLedger.findUnique({
      where: { id: before },
      select: { userId: true },
    });
    if (!owner || owner.userId !== userId) return { status: "bad_cursor" };
  }

  // `id` breaks `createdAt` ties, which are real: settling both slots of a gate
  // writes two rows inside one transaction. Ordering by the timestamp alone
  // would let a page boundary fall between them and either repeat a row or
  // drop one.
  const rows = await prisma.ticketLedger.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, delta: true, reason: true, bundleSize: true, createdAt: true },
    take: limit + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });

  const hasMore = rows.length > limit;
  return {
    status: "ok",
    entries: rows.slice(0, limit).map((row) => ({
      ...row,
      reason: row.reason as TicketReason,
    })),
    hasMore,
  };
}

/**
 * Credit `count` tickets and append the matching ledger row atomically.
 * Returns the new balance.
 */
export async function grantTickets(args: {
  userId: string;
  count: number;
  reason: TicketReason;
  matchId?: string;
  amountCents?: number;
  /**
   * Telegram Stars actually charged, frozen on the row. Star prices are
   * env-tunable, so a reader must never re-derive them from `bundleSize`
   * later — the admin purchase list and the founder feed both read this.
   */
  amountStars?: number;
  bundleSize?: number;
  /**
   * Provider charge id for a paid top-up (Telegram Stars
   * `telegram_payment_charge_id`). When set it is written to the unique
   * `TicketLedger.externalPaymentId`, so a redelivered `successful_payment`
   * makes the ledger insert throw P2002 and the whole credit transaction rolls
   * back. Callers that need exactly-once semantics catch that via
   * `isUniqueViolation`. Omitted for free bonuses/spends/refunds and the mock
   * fallback.
   */
  externalPaymentId?: string;
}): Promise<number> {
  const { userId, count, reason, matchId, amountCents, amountStars, bundleSize, externalPaymentId } =
    args;
  if (count <= 0) return getBalance(userId);

  const [updated] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { ticketBalance: { increment: count } },
      select: { ticketBalance: true },
    }),
    prisma.ticketLedger.create({
      data: {
        userId,
        delta: count,
        reason,
        matchId: matchId ?? null,
        amountCents: amountCents ?? null,
        amountStars: amountStars ?? null,
        bundleSize: bundleSize ?? null,
        externalPaymentId: externalPaymentId ?? null,
      },
    }),
  ]);
  return updated.ticketBalance;
}

/**
 * Prisma P2002 = unique-constraint violation. Used by paid-top-up callers to
 * detect a redelivered `successful_payment` (the duplicate charge id hits the
 * unique `TicketLedger.externalPaymentId`) and treat it as an idempotent no-op
 * rather than a hard failure.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Atomically spend `count` tickets, guarded so the balance can never go
 * negative (no double-spend under concurrent gate taps). Returns `ok=false`
 * with the unchanged balance when there aren't enough tickets.
 */
export async function spendTickets(args: {
  userId: string;
  count: number;
  reason: Extract<TicketReason, "spend_match">;
  matchId?: string;
}): Promise<{ ok: boolean; balance: number }> {
  const { userId, count, reason, matchId } = args;
  if (count <= 0) return { ok: true, balance: await getBalance(userId) };

  return prisma.$transaction(async (tx) => {
    const res = await tx.user.updateMany({
      where: { id: userId, ticketBalance: { gte: count } },
      data: { ticketBalance: { decrement: count } },
    });
    if (res.count === 0) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
      });
      return { ok: false, balance: user?.ticketBalance ?? 0 };
    }
    await tx.ticketLedger.create({
      data: { userId, delta: -count, reason, matchId: matchId ?? null },
    });
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { ticketBalance: true },
    });
    return { ok: true, balance: user?.ticketBalance ?? 0 };
  });
}

interface BonusResult {
  granted: boolean;
  balance: number;
}

function isSerializationConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2034"
  );
}

/**
 * Registration v2 student loyalty: grant the one-time student bonus
 * (`STUDENT_BONUS_TICKETS` free Date Tickets) when a university email is
 * verified. The student track's welcome perk — the general/phone track gets
 * none — so registering with a university email is materially rewarded.
 *
 * The `student_bonus` ledger row is the claim marker and Serializable
 * isolation makes the existence check + wallet increment atomic, so the four
 * email-verify call sites (Mini App OTP, agent verify_otp, web handoff, mobile
 * OTP) can all fire it blindly and the wallet is credited exactly once.
 */
export async function grantStudentBonusIfEligible(
  userId: string,
): Promise<BonusResult> {
  if (!env.TICKET_FEATURE_ENABLED) {
    return { granted: false, balance: await getBalance(userId) };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.ticketLedger.findFirst({
            where: { userId, reason: "student_bonus" },
            select: { id: true },
          });
          if (existing) {
            const user = await tx.user.findUnique({
              where: { id: userId },
              select: { ticketBalance: true },
            });
            return { granted: false, balance: user?.ticketBalance ?? 0 };
          }

          const user = await tx.user.update({
            where: { id: userId },
            data: { ticketBalance: { increment: STUDENT_BONUS_TICKETS } },
            select: { ticketBalance: true },
          });
          await tx.ticketLedger.create({
            data: { userId, delta: STUDENT_BONUS_TICKETS, reason: "student_bonus" },
          });
          return { granted: true, balance: user.ticketBalance };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error;
    }
  }

  return { granted: false, balance: await getBalance(userId) };
}

/**
 * Grant the one-time welcome gift — a single free Date Ticket handed to every
 * new user as a personal "your first date is on me" gesture. Delivered as a
 * pre-roll on the user's first-ever match pitch (see `services/welcome-gift.ts`
 * + `handlers/matching/pitch.ts`).
 *
 * The `welcome_gift` ledger row is the claim marker (no Prisma schema change),
 * and Serializable isolation makes the existence check + wallet increment
 * atomic. Because the grant is
 * idempotent, the first qualifying pitch becomes the gift moment automatically
 * — no separate "first match" detection is needed. Returns `granted:true` only
 * on the call that actually credits the ticket, so the caller can gate the
 * cosmetic video-note/DM pre-roll on it.
 */
export async function grantWelcomeGiftIfEligible(
  userId: string,
): Promise<BonusResult> {
  if (!env.TICKET_FEATURE_ENABLED) {
    return { granted: false, balance: await getBalance(userId) };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const existing = await tx.ticketLedger.findFirst({
            where: { userId, reason: "welcome_gift" },
            select: { id: true },
          });
          if (existing) {
            const user = await tx.user.findUnique({
              where: { id: userId },
              select: { ticketBalance: true },
            });
            return { granted: false, balance: user?.ticketBalance ?? 0 };
          }

          const user = await tx.user.update({
            where: { id: userId },
            data: { ticketBalance: { increment: 1 } },
            select: { ticketBalance: true },
          });
          await tx.ticketLedger.create({
            data: { userId, delta: 1, reason: "welcome_gift" },
          });
          return { granted: true, balance: user.ticketBalance };
        },
        { isolationLevel: "Serializable" },
      );
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === 2) throw error;
    }
  }

  return { granted: false, balance: await getBalance(userId) };
}

/**
 * Grant the one-time "4+ photos" ticket bonus if the profile now qualifies and
 * hasn't been granted before. Idempotent via the `photoBonusTicketAt` CAS:
 * concurrent callers race to flip the timestamp, and only the winner credits a
 * ticket.
 *
 * The CAS claim and the wallet credit run in ONE transaction (audit L1) so a
 * crash between them can't leave the marker set with no ticket granted — which
 * would permanently forfeit the bonus, since the flipped marker blocks any retry.
 */
export async function grantPhotoBonusIfEligible(userId: string): Promise<BonusResult> {
  if (!env.TICKET_FEATURE_ENABLED) return { granted: false, balance: await getBalance(userId) };

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { photos: true, photoBonusTicketAt: true },
  });
  if (!profile || profile.photoBonusTicketAt) {
    return { granted: false, balance: await getBalance(userId) };
  }
  if (profile.photos.length < PHOTO_BONUS_TICKET_THRESHOLD) {
    return { granted: false, balance: await getBalance(userId) };
  }

  return prisma.$transaction(async (tx) => {
    // Re-read the photo count inside the transaction. The check above races a
    // concurrent delete, and Prisma cannot express "array length >= N" in a
    // `where`, so the eligibility condition has to be re-asserted here rather
    // than folded into the CAS below.
    const fresh = await tx.profile.findUnique({
      where: { userId },
      select: { photos: true },
    });
    if (!fresh || fresh.photos.length < PHOTO_BONUS_TICKET_THRESHOLD) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
      });
      return { granted: false, balance: user?.ticketBalance ?? 0 };
    }
    const claim = await tx.profile.updateMany({
      where: { userId, photoBonusTicketAt: null },
      data: { photoBonusTicketAt: new Date() },
    });
    if (claim.count === 0) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
      });
      return { granted: false, balance: user?.ticketBalance ?? 0 };
    }
    const user = await tx.user.update({
      where: { id: userId },
      data: { ticketBalance: { increment: 1 } },
      select: { ticketBalance: true },
    });
    await tx.ticketLedger.create({ data: { userId, delta: 1, reason: "photo_bonus" } });
    return { granted: true, balance: user.ticketBalance };
  });
}

/**
 * Grant the one-time "added a profile video" ticket bonus. Idempotent via the
 * `videoBonusTicketAt` CAS. Claim + credit run in one transaction (audit L1),
 * same as the photo bonus above, so a mid-grant crash can't forfeit the ticket.
 */
export async function grantVideoBonusIfEligible(userId: string): Promise<BonusResult> {
  if (!env.TICKET_FEATURE_ENABLED) return { granted: false, balance: await getBalance(userId) };

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { photos: true, profileMedia: true, videoBonusTicketAt: true },
  });
  if (!profile || profile.videoBonusTicketAt) {
    return { granted: false, balance: await getBalance(userId) };
  }
  const media = normalizeProfileMedia(profile.profileMedia, profile.photos);
  if (!profileMediaHasVideo(media)) {
    return { granted: false, balance: await getBalance(userId) };
  }

  return prisma.$transaction(async (tx) => {
    // Same reasoning as the photo bonus: re-assert eligibility inside the
    // transaction, since a concurrent video removal can land between the read
    // above and the claim below.
    const fresh = await tx.profile.findUnique({
      where: { userId },
      select: { photos: true, profileMedia: true },
    });
    if (
      !fresh ||
      !profileMediaHasVideo(normalizeProfileMedia(fresh.profileMedia, fresh.photos))
    ) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
      });
      return { granted: false, balance: user?.ticketBalance ?? 0 };
    }
    const claim = await tx.profile.updateMany({
      where: { userId, videoBonusTicketAt: null },
      data: { videoBonusTicketAt: new Date() },
    });
    if (claim.count === 0) {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { ticketBalance: true },
      });
      return { granted: false, balance: user?.ticketBalance ?? 0 };
    }
    const user = await tx.user.update({
      where: { id: userId },
      data: { ticketBalance: { increment: 1 } },
      select: { ticketBalance: true },
    });
    await tx.ticketLedger.create({ data: { userId, delta: 1, reason: "video_bonus" } });
    return { granted: true, balance: user.ticketBalance };
  });
}
