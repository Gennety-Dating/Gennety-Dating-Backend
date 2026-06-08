import { prisma } from "@gennety/db";
import {
  PHOTO_BONUS_TICKET_THRESHOLD,
  normalizeProfileMedia,
  profileMediaHasVideo,
} from "@gennety/shared";
import { env } from "../config.js";

/**
 * Ticket wallet — the user-owned balance of Date Tickets (PRODUCT_SPEC §3.5b).
 *
 * A ticket is spent at the date gate (one per person, per date). The balance is
 * topped up by bundle purchases (store Mini App) and one-time onboarding
 * bonuses (4+ profile photos, adding a profile video). Everything here is
 * gated by `TICKET_FEATURE_ENABLED`; when the flag is off, grants are no-ops so
 * production behavior is unchanged.
 *
 * `User.ticketBalance` is the materialized running sum of `TicketLedger.delta`.
 * Both are written in the SAME transaction so the ledger stays the append-only
 * source of truth and the counter never drifts.
 */

export type TicketReason =
  | "photo_bonus"
  | "video_bonus"
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
}): Promise<number> {
  const { userId, count, reason, matchId, amountCents, bundleSize } = args;
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
      },
    }),
  ]);
  return updated.ticketBalance;
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

/**
 * Grant the one-time "4+ photos" ticket bonus if the profile now qualifies and
 * hasn't been granted before. Idempotent via the `photoBonusTicketAt` CAS:
 * concurrent callers race to flip the timestamp, and only the winner credits a
 * ticket.
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

  const claim = await prisma.profile.updateMany({
    where: { userId, photoBonusTicketAt: null },
    data: { photoBonusTicketAt: new Date() },
  });
  if (claim.count === 0) {
    return { granted: false, balance: await getBalance(userId) };
  }

  const balance = await grantTickets({ userId, count: 1, reason: "photo_bonus" });
  return { granted: true, balance };
}

/**
 * Grant the one-time "added a profile video" ticket bonus. Idempotent via the
 * `videoBonusTicketAt` CAS.
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

  const claim = await prisma.profile.updateMany({
    where: { userId, videoBonusTicketAt: null },
    data: { videoBonusTicketAt: new Date() },
  });
  if (claim.count === 0) {
    return { granted: false, balance: await getBalance(userId) };
  }

  const balance = await grantTickets({ userId, count: 1, reason: "video_bonus" });
  return { granted: true, balance };
}
