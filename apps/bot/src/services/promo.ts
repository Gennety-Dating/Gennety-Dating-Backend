import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { grantComplimentaryPremiumMonths } from "./premium.js";
import { grantTickets, isUniqueViolation } from "./ticket-wallet.js";

/**
 * Independent promo-code program (PROMO_CODES_PRODUCT_SPEC.md).
 *
 * A campaign shares ONE reusable code (`t.me/<bot>?start=promo_<CODE>`, or the
 * iOS deferred-attribution claim). A new user's first-touch
 * `User.referralSource` records it as `promo:<CODE>`. At the onboarding wow
 * screen the user is granted a Date Ticket + Premium months — both per-code
 * configurable, exactly-once.
 *
 * Everything here no-ops when `PROMO_FEATURE_ENABLED` is off. The grant is
 * mutually exclusive with the Referral program: `parsePromoCode` returns null
 * for `referral:*` and `services/referral.ts` `parseReferrer` returns null for
 * `promo:*`, so a user is attributed to exactly one program by first touch.
 */

/** Normalize a raw code to its stored form (uppercase, trimmed). */
export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Extract the promo code from an invitee's `referralSource`, or null when the
 * source is not a promo link. Accepts the canonical `promo:<CODE>` plus the
 * legacy Telegram deep-link / Mini-App forms (`tg:promo_<CODE>`,
 * `tg-mini:promo_<CODE>`) so links attributed before the start.ts parser landed
 * still resolve. Returned code is normalized (uppercase).
 */
export function parsePromoCode(referralSource: string | null | undefined): string | null {
  if (!referralSource) return null;
  const s = referralSource.trim();
  if (s.startsWith("promo:")) {
    const code = s.slice("promo:".length).trim();
    return code.length > 0 ? normalizePromoCode(code) : null;
  }
  const legacy = /^tg(?:-mini)?:promo_(.+)$/i.exec(s);
  if (legacy) {
    const code = legacy[1].trim();
    return code.length > 0 ? normalizePromoCode(code) : null;
  }
  return null;
}

/**
 * Canonical `User.referralSource` for a first-touch Telegram deep-link / Mini-App
 * `start`/`startapp` param. A `promo_<CODE>` payload becomes the resolvable
 * `promo:<CODE>`; anything else keeps its channel `prefix` (`tg` / `tg-mini`) so
 * ordinary campaign attribution (and referral links) are unchanged.
 */
export function promoSourceFromParam(param: string, channelPrefix: string): string | null {
  const m = /^promo_(.+)$/i.exec(param);
  const code = m?.[1].trim();
  if (code) return `promo:${normalizePromoCode(code)}`;
  return `${channelPrefix}:${param}`;
}

export interface ResolvedPromoCode {
  id: string;
  code: string;
  ticketReward: number;
  premiumMonths: number;
}

/**
 * Load a promo code and validate it is currently redeemable: feature on, exists,
 * active, not expired, and under its activation cap. Returns null otherwise
 * (unknown/disabled/expired/exhausted all collapse to "not redeemable" — the
 * caller just shows the ordinary onboarding screen).
 */
export async function resolvePromoCode(code: string | null): Promise<ResolvedPromoCode | null> {
  if (!env.PROMO_FEATURE_ENABLED || !code) return null;
  const normalized = normalizePromoCode(code);
  if (!normalized) return null;

  const row = await prisma.promoCode.findUnique({ where: { code: normalized } });
  if (!row || !row.active) return null;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  if (row.maxRedemptions != null && row.redeemedCount >= row.maxRedemptions) return null;

  return {
    id: row.id,
    code: row.code,
    ticketReward: row.ticketReward,
    premiumMonths: row.premiumMonths,
  };
}

/**
 * First-touch attribution for a native-app user (iOS deferred-deep-link claim).
 * Sets `referralSource = promo:<CODE>` only when the code is currently redeemable
 * AND the user has no prior attribution (never overwrites first touch). The
 * Telegram path attributes at user creation instead; this is the mobile twin.
 * The reward itself is granted later at the wow screen via
 * `grantPromoRewardsForUser`.
 */
export async function claimPromoCodeForUser(
  userId: string,
  code: string,
): Promise<{ applied: boolean; reason?: string; resolved?: ResolvedPromoCode }> {
  if (!env.PROMO_FEATURE_ENABLED) return { applied: false, reason: "disabled" };
  const resolved = await resolvePromoCode(code);
  if (!resolved) return { applied: false, reason: "invalid" };

  // First-touch only: never overwrite an existing attribution (referral or promo).
  const cas = await prisma.user.updateMany({
    where: { id: userId, referralSource: null },
    data: { referralSource: `promo:${resolved.code}` },
  });
  return cas.count > 0
    ? { applied: true, resolved }
    : { applied: false, reason: "already-attributed", resolved };
}

export interface PromoRewardResult {
  code: string;
  /** Tickets actually credited in this invocation (0 if already granted). */
  ticketsApplied: number;
  /** Premium months actually credited in this invocation. */
  monthsApplied: number;
}

/**
 * Grant a promo-attributed new user their one-time welcome gift (Date Ticket +
 * Premium months), shown on the onboarding wow screen. Best-effort and fully
 * idempotent — safe to call from every path that reaches the wow screen
 * (Telegram `/promo-gift`, iOS `/v1/me/promo/claim`).
 *
 * Returns the applied deltas, or null when there is nothing to do (feature off,
 * not a valid promo attribution, code no longer redeemable, or the user was
 * already redeemed).
 *
 * Exactly-once + cap-safe: the `PromoRedemption` insert (unique `userId`) and
 * the `redeemedCount++` (guarded on capacity) commit in ONE transaction, so a
 * replayed tap is a no-op and two concurrent redemptions can never overrun the
 * cap. The ticket / Premium grants are each additionally idempotent via a unique
 * ledger `externalPaymentId`.
 */
export async function grantPromoRewardsForUser(
  userId: string,
): Promise<PromoRewardResult | null> {
  if (!env.PROMO_FEATURE_ENABLED) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, referralSource: true, promoRedeemedAt: true },
  });
  if (!user) return null;
  if (user.promoRedeemedAt) return null; // already redeemed → idempotent no-op

  const resolved = await resolvePromoCode(parsePromoCode(user.referralSource));
  if (!resolved) return null;

  // Claim the redemption slot exactly-once and cap-safely: create the unique
  // per-user redemption row AND bump the code counter under a capacity guard,
  // in one transaction. A duplicate (replay) throws P2002; a full code makes the
  // guarded update touch 0 rows and we abort the transaction.
  let claimed: boolean;
  try {
    claimed = await prisma.$transaction(async (tx) => {
      // Atomic capacity guard: bump the counter only while the code is still
      // active, unexpired, and under its cap. Prisma can't compare two columns
      // in `where`, so this one guard is raw SQL. `$executeRaw` returns the
      // affected-row count (a scalar Int — no void-deserialization pitfall).
      const bumped = await tx.$executeRaw`
        UPDATE promo_codes
        SET redeemed_count = redeemed_count + 1
        WHERE id = ${resolved.id}::uuid
          AND active = true
          AND (expires_at IS NULL OR expires_at > now())
          AND (max_redemptions IS NULL OR redeemed_count < max_redemptions)
      `;
      if (bumped === 0) return false; // code exhausted / disabled between resolve and claim
      await tx.promoRedemption.create({
        data: {
          promoCodeId: resolved.id,
          userId: user.id,
          ticketsApplied: resolved.ticketReward,
          monthsApplied: resolved.premiumMonths,
        },
      });
      return true;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already redeemed by a racing call
    throw err;
  }
  if (!claimed) return null;

  const idBase = `promo:${resolved.id}:${user.id}`;

  let ticketsApplied = 0;
  if (resolved.ticketReward > 0) {
    try {
      await grantTickets({
        userId: user.id,
        count: resolved.ticketReward,
        reason: "promo",
        externalPaymentId: `${idBase}:tickets`,
      });
      ticketsApplied = resolved.ticketReward;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // already granted → no-op
    }
  }

  let monthsApplied = 0;
  if (resolved.premiumMonths > 0) {
    const res = await grantComplimentaryPremiumMonths({
      userId: user.id,
      months: resolved.premiumMonths,
      externalPaymentId: `${idBase}:premium`,
      note: `promo code ${resolved.code}`,
      provider: "promo",
    });
    if (res.applied) monthsApplied = resolved.premiumMonths;
  }

  // Stamp the once-marker (the ledger ids already guarantee exactly-once
  // rewards; this only drives the "show the wow screen once" flag + fast guard).
  await prisma.user.updateMany({
    where: { id: user.id, promoRedeemedAt: null },
    data: { promoRedeemedAt: new Date() },
  });

  return { code: resolved.code, ticketsApplied, monthsApplied };
}
