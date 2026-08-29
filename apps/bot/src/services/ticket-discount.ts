import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { emitTicketEvent } from "./ticket-analytics.js";

/**
 * The single-ticket discount — ONE slot per user, now shared by two mechanisms.
 *
 * 1. **Famine** (PRODUCT_SPEC §3.5b) — the loyalty perk handed to a user who
 *    was eligible-but-unpaired for `CADENCE.famineDiscountMinTier` consecutive
 *    batch intervals. The threshold check lives in `no-match-notifier.ts`;
 *    this module only owns the grant.
 * 2. **Event feedback** (LAUNCH_EVENTS §11) — the incentive for answering the
 *    T+18h post-event form. Same mechanism, different source, deliberately:
 *    a SECOND discount system would double the wallet code's own №1 lesson.
 *
 * This module is the ONLY owner of the discount math + lifecycle (parallels
 * `ticket-wallet.ts` for the balance). It discounts a SINGLE ticket purchase —
 * the date gate's `self` scope and the store's "1 ticket" bundle — and is
 * consumed on the first such purchase in either surface. Everything is gated by
 * `TICKET_FEATURE_ENABLED`; when the flag is off, grants are no-ops and
 * `getActiveDiscount` always returns null, so production behavior is unchanged.
 *
 * **The two mechanisms collide on purpose, and the collision rule is
 * asymmetric.** Famine REPLACES whatever is in the slot (unchanged behaviour:
 * a still-starved user who already redeemed one gets a fresh one, TTL slid,
 * `consumedAt` cleared). Event feedback only ever fills an EMPTY slot, because
 * it is the smaller perk and overwriting a live 77% famine discount with it
 * would take something away from a user as a reward for helping us. There is
 * deliberately no "keep the better one" arithmetic — comparing a percent
 * against a deadline is a judgement two call sites would eventually make
 * differently, and "never take anything away" needs no comparison at all.
 *
 * The entitlement lives on five additive `User` columns:
 *   ticketDiscountPct        — the granted percent (0 = none)
 *   ticketDiscountGrantedAt  — when it was granted
 *   ticketDiscountExpiresAt  — fixed TTL deadline
 *   ticketDiscountConsumedAt — set when redeemed (one-way flip)
 *   ticketDiscountSource     — which mechanism granted it (audit only)
 * Active ⇔ pct > 0 AND consumedAt IS NULL AND expiresAt > now.
 */

/**
 * Which mechanism put the current discount in the slot. Persisted for the
 * admin/audit question "how many discounts did event feedback actually buy" —
 * deliberately NOT read by any pricing path, which cares only about `pct`.
 */
export type DiscountSource = "famine" | "event_feedback";

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
 * Write the slot. The one place any mechanism's grant lands.
 *
 * `mode` is the collision rule stated at the top of this file:
 *   - `replace`   — unconditional (famine).
 *   - `onlyIfFree` — the CAS refuses when an active discount is already there,
 *     so the grant can never take something away. Expressed as a `where` on
 *     the same row rather than as read-then-write, because two surfaces can
 *     grant at once and a read-then-write would let the loser clobber.
 */
async function writeDiscount(
  userId: string,
  opts: { pct: number; ttlDays: number; source: DiscountSource; mode: "replace" | "onlyIfFree" },
  now: Date,
): Promise<GrantResult> {
  if (!env.TICKET_FEATURE_ENABLED) return { granted: false };
  // A zero or negative percent is not a discount; writing one would occupy the
  // slot with something that discounts nothing and block the next real grant.
  if (opts.pct <= 0) return { granted: false };

  const expiresAt = new Date(now.getTime() + opts.ttlDays * 24 * 60 * 60 * 1000);

  const updated = await prisma.user.updateMany({
    where:
      opts.mode === "replace"
        ? { id: userId }
        : {
            id: userId,
            // "No ACTIVE discount" — the negation of `activeDiscountFromColumns`,
            // so a consumed or expired one counts as free rather than as a
            // permanent block.
            OR: [
              { ticketDiscountPct: { lte: 0 } },
              { ticketDiscountConsumedAt: { not: null } },
              { ticketDiscountExpiresAt: null },
              { ticketDiscountExpiresAt: { lte: now } },
            ],
          },
    data: {
      ticketDiscountPct: opts.pct,
      ticketDiscountGrantedAt: now,
      ticketDiscountExpiresAt: expiresAt,
      ticketDiscountConsumedAt: null,
      ticketDiscountSource: opts.source,
    },
  });
  if (updated.count === 0) return { granted: false };

  return { granted: true, pct: opts.pct, expiresAt };
}

/**
 * Grant (or refresh) the famine single-ticket discount. Gated on
 * `TICKET_FEATURE_ENABLED`; the CALLER gates eligibility (no-match tier >=
 * `CADENCE.famineDiscountMinTier`). Re-granting just slides the TTL and
 * clears any previous `consumedAt`, so a still-starved user who already used
 * one gets a fresh one. Returns the granted percent + deadline.
 */
export async function grantFamineDiscountIfEligible(
  userId: string,
  now: Date = new Date(),
): Promise<GrantResult> {
  const result = await writeDiscount(
    userId,
    {
      pct: env.FAMINE_DISCOUNT_PCT,
      ttlDays: env.FAMINE_DISCOUNT_TTL_DAYS,
      source: "famine",
      mode: "replace",
    },
    now,
  );
  if (result.granted) emitTicketEvent("famine_discount_granted", { userId });
  return result;
}

/**
 * The post-event feedback incentive (LAUNCH_EVENTS §11).
 *
 * `onlyIfFree`, so answering the form can never cost someone a live famine
 * discount. A user who already holds one gets nothing new — and the caller
 * still returns them their existing discount, so the screen says something
 * true rather than reading as a reward that failed to arrive.
 */
export async function grantEventFeedbackDiscount(
  userId: string,
  now: Date = new Date(),
): Promise<GrantResult> {
  const result = await writeDiscount(
    userId,
    {
      pct: env.EVENT_FEEDBACK_DISCOUNT_PCT,
      ttlDays: env.EVENT_FEEDBACK_DISCOUNT_TTL_DAYS,
      source: "event_feedback",
      mode: "onlyIfFree",
    },
    now,
  );
  if (result.granted) emitTicketEvent("event_feedback_discount_granted", { userId });
  return result;
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
