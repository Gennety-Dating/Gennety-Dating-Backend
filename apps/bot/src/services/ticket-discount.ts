import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { emitTicketEvent } from "./ticket-analytics.js";

/**
 * Famine single-ticket discount — the one-time loyalty perk handed to a user who
 * was eligible-but-unpaired for a 2nd consecutive weekly batch (no-match tier >=
 * `FAMINE_DISCOUNT_MIN_TIER`). See PRODUCT_SPEC.md §3.5b.
 *
 * This module is the ONLY owner of the discount math + lifecycle (parallels
 * `ticket-wallet.ts` for the balance). It discounts a SINGLE ticket purchase —
 * the date gate's `self` scope and the store's "1 ticket" bundle — and is
 * consumed on the first such purchase in either surface. Everything is gated by
 * `TICKET_FEATURE_ENABLED`; when the flag is off, grants are no-ops and
 * `getActiveDiscount` always returns null, so production behavior is unchanged.
 *
 * The entitlement lives on four additive `User` columns:
 *   ticketDiscountPct        — the granted percent (0 = none)
 *   ticketDiscountGrantedAt  — when it was granted
 *   ticketDiscountExpiresAt  — fixed TTL deadline
 *   ticketDiscountConsumedAt — set when redeemed (one-way flip)
 * Active ⇔ pct > 0 AND consumedAt IS NULL AND expiresAt > now.
 */

export interface ActiveDiscount {
  pct: number;
  expiresAt: Date;
}

/**
 * Price in cents after applying a whole-percent discount, rounded to the nearest
 * cent. `pct` is clamped to [0, 100] so a bad value can never produce a negative
 * or inflated charge.
 */
export function discountedCents(priceCents: number, pct: number): number {
  const clamped = Math.min(100, Math.max(0, pct));
  return Math.round((priceCents * (100 - clamped)) / 100);
}

/** Raw discount columns as selected from `User`. */
export interface DiscountColumns {
  ticketDiscountPct: number;
  ticketDiscountExpiresAt: Date | null;
  ticketDiscountConsumedAt: Date | null;
}

/**
 * Pure "is this discount active right now" predicate over the raw columns —
 * shared by `getActiveDiscount` (DB read) and the synchronous date-gate state
 * builder (which already has the columns in hand). Does NOT check the feature
 * flag; callers that can be reached with the flag off must gate separately.
 */
export function activeDiscountFromColumns(
  cols: DiscountColumns,
  now: Date = new Date(),
): ActiveDiscount | null {
  if (cols.ticketDiscountPct <= 0) return null;
  if (cols.ticketDiscountConsumedAt !== null) return null;
  if (!cols.ticketDiscountExpiresAt || cols.ticketDiscountExpiresAt <= now) return null;
  return { pct: cols.ticketDiscountPct, expiresAt: cols.ticketDiscountExpiresAt };
}

/**
 * Read the user's currently-active discount, or null when the feature is off,
 * none was granted, it was already consumed, or it has expired. Pure read.
 */
export async function getActiveDiscount(
  userId: string,
  now: Date = new Date(),
): Promise<ActiveDiscount | null> {
  if (!env.TICKET_FEATURE_ENABLED) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ticketDiscountPct: true,
      ticketDiscountExpiresAt: true,
      ticketDiscountConsumedAt: true,
    },
  });
  if (!user) return null;
  return activeDiscountFromColumns(user, now);
}

export interface GrantResult {
  granted: boolean;
  pct?: number;
  expiresAt?: Date;
}

/**
 * Grant (or refresh) the famine single-ticket discount. Gated on
 * `TICKET_FEATURE_ENABLED`; the CALLER gates eligibility (no-match tier >=
 * `FAMINE_DISCOUNT_MIN_TIER`). Re-granting just slides the TTL and clears any
 * previous `consumedAt`, so a still-starved user who already used one gets a
 * fresh one. Returns the granted percent + deadline.
 */
export async function grantFamineDiscountIfEligible(
  userId: string,
  now: Date = new Date(),
): Promise<GrantResult> {
  if (!env.TICKET_FEATURE_ENABLED) return { granted: false };

  const pct = env.FAMINE_DISCOUNT_PCT;
  const expiresAt = new Date(now.getTime() + env.FAMINE_DISCOUNT_TTL_DAYS * 24 * 60 * 60 * 1000);

  const updated = await prisma.user.updateMany({
    where: { id: userId },
    data: {
      ticketDiscountPct: pct,
      ticketDiscountGrantedAt: now,
      ticketDiscountExpiresAt: expiresAt,
      ticketDiscountConsumedAt: null,
    },
  });
  if (updated.count === 0) return { granted: false };

  emitTicketEvent("famine_discount_granted", { userId });
  return { granted: true, pct, expiresAt };
}

/**
 * Redeem the active discount: an atomic CAS flip of `consumedAt`, guarded so a
 * double-confirm (or a concurrent store + gate tap) consumes exactly once.
 * Returns whether THIS call performed the consumption.
 */
export async function consumeActiveDiscount(
  userId: string,
  now: Date = new Date(),
): Promise<{ consumed: boolean }> {
  if (!env.TICKET_FEATURE_ENABLED) return { consumed: false };
  const res = await prisma.user.updateMany({
    where: {
      id: userId,
      ticketDiscountPct: { gt: 0 },
      ticketDiscountConsumedAt: null,
      ticketDiscountExpiresAt: { gt: now },
    },
    data: { ticketDiscountConsumedAt: now },
  });
  const consumed = res.count > 0;
  if (consumed) emitTicketEvent("famine_discount_redeemed", { userId });
  return { consumed };
}
