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
 * bonuses (4+ profile photos, adding a profile video, completing identity
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
  | "verification_bonus"
  | "student_bonus"
  | "welcome_gift"
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
  const { userId, count, reason, matchId, amountCents, bundleSize, externalPaymentId } = args;
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
 * Grant the one-time identity-verification bonus.
 *
 * The ledger row is the claim marker, so no Prisma schema change is needed.
 * Serializable isolation makes the read + wallet increment atomic under a
 * webhook/pull race; a serialization loser retries and then sees the winner's
 * `verification_bonus` row.
 */
export async function grantVerificationBonusIfEligible(
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
            where: { userId, reason: "verification_bonus" },
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
            data: { userId, delta: 1, reason: "verification_bonus" },
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
 * Registration v2 student loyalty: grant the one-time student bonus
 * (`STUDENT_BONUS_TICKETS` free Date Tickets) when a university email is
 * verified. The student track's welcome perk — the general/phone track gets
 * none — so registering with a university email is materially rewarded.
 *
 * Same idempotency model as the verification bonus: the `student_bonus`
 * ledger row is the claim marker and Serializable isolation makes the
 * existence check + wallet increment atomic, so the four email-verify call
 * sites (Mini App OTP, agent verify_otp, web handoff, mobile OTP) can all
 * fire it blindly and the wallet is credited exactly once.
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
 * Same idempotency model as the verification bonus: the `welcome_gift` ledger
 * row is the claim marker (no Prisma schema change), and Serializable isolation
 * makes the existence check + wallet increment atomic. Because the grant is
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
