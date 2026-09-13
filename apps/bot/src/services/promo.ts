import { prisma, type OnboardingStep } from "@gennety/db";
import { PROMO_DEFERRED_CLAIM_WINDOW_MS } from "@gennety/shared";
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
 * Promo codes are for NEW accounts (PROMO_CODES_PRODUCT_SPEC: "never existing
 * users"). The Telegram rail gets that for free — the code is recorded on the
 * creating touch — but the iOS deferred claim writes attribution onto an account
 * that already exists, and every native account starts with
 * `referralSource = null`, so "no attribution yet" alone let any account of any
 * age redeem a public code for a ticket and months of Premium. New means both:
 * created within `PROMO_DEFERRED_CLAIM_WINDOW_MS`, and not through onboarding.
 */
export function isNewPromoAccount(
  account: { createdAt: Date; onboardingStep: OnboardingStep },
  now: Date = new Date(),
): boolean {
  return (
    account.onboardingStep !== "completed" &&
    account.createdAt.getTime() >= now.getTime() - PROMO_DEFERRED_CLAIM_WINDOW_MS
  );
}

/**
 * First-touch attribution for a native-app user (iOS deferred-deep-link claim).
 * Sets `referralSource = promo:<CODE>` only when the code is currently redeemable,
 * the user has no prior attribution (never overwrites first touch), AND the
 * account is new (`isNewPromoAccount`) — the last two inside one compare-and-set,
 * so no caller can attribute an existing account whatever it checked first.
 * The Telegram path attributes at user creation instead; this is the mobile twin.
 * The reward itself is granted later at the wow screen via
 * `grantPromoRewardsForUser`.
 */
export async function claimPromoCodeForUser(
  userId: string,
  code: string,
  now: Date = new Date(),
): Promise<{ applied: boolean; reason?: string; resolved?: ResolvedPromoCode }> {
  if (!env.PROMO_FEATURE_ENABLED) return { applied: false, reason: "disabled" };
  const resolved = await resolvePromoCode(code);
  if (!resolved) return { applied: false, reason: "invalid" };

  const cas = await prisma.user.updateMany({
    where: {
      id: userId,
      // First-touch only: never overwrite an existing attribution (referral or promo).
      referralSource: null,
      onboardingStep: { not: "completed" },
      createdAt: { gte: new Date(now.getTime() - PROMO_DEFERRED_CLAIM_WINDOW_MS) },
    },
    data: { referralSource: `promo:${resolved.code}` },
  });
  if (cas.count > 0) return { applied: true, resolved };

  // Tell the two refusals apart for the caller: an attribution that already
  // exists is not the same answer as an account too old to take one.
  const current = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralSource: true },
  });
  return current && current.referralSource === null
    ? { applied: false, reason: "not-eligible" }
    : { applied: false, reason: "already-attributed", resolved };
}

export type DeferredPromoClaim =
  | { status: "not-eligible" }
  | { status: "no-code" }
  | { status: "claimed"; result: Awaited<ReturnType<typeof claimPromoCodeForUser>> };

/**
 * The iOS first-launch claim (`POST /v1/me/promo/claim-deferred`), decided here
 * rather than in the route so every rule sits next to the one it depends on:
 *
 *  1. **New accounts only**, checked BEFORE the fingerprint is looked up —
 *     a fingerprint match is one-shot, so an ineligible account must not burn
 *     the code a real newcomer on the same network is about to claim.
 *  2. **An explicit code is honoured only behind `PROMO_MANUAL_ENTRY_ENABLED`.**
 *     The spec ships auto attribution only (the native client sends no code);
 *     a code in the body is manual entry, which is the emergency seam.
 *  3. The fingerprint path stays as it is.
 */
export async function claimDeferredPromoForUser(input: {
  userId: string;
  explicitCode: string | null;
  matchFingerprint: () => string | null;
  now?: Date;
}): Promise<DeferredPromoClaim> {
  const now = input.now ?? new Date();
  const account = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { createdAt: true, onboardingStep: true },
  });
  if (!account || !isNewPromoAccount(account, now)) return { status: "not-eligible" };

  const manual = env.PROMO_MANUAL_ENTRY_ENABLED ? (input.explicitCode ?? "").trim() : "";
  const code = manual || input.matchFingerprint();
  if (!code) return { status: "no-code" };

  const result = await claimPromoCodeForUser(input.userId, code, now);
  return result.reason === "not-eligible" ? { status: "not-eligible" } : { status: "claimed", result };
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
 * not a valid promo attribution, code no longer redeemable, the account already
 * finished onboarding, or the user was already redeemed).
 *
 * Exactly-once + cap-safe: the `PromoRedemption` insert (unique `userId`) and
 * the `redeemedCount++` (guarded on capacity) commit in ONE transaction, so a
 * replayed tap is a no-op and two concurrent redemptions can never overrun the
 * cap. The ticket / Premium grants are each additionally idempotent via a unique
 * ledger `externalPaymentId`.
 *
 * The grants cannot join that transaction (the Premium grant runs its own, under
 * the user row lock), so a failure between the claim and the grants used to
 * strand the claim: the retry resolved the code again, hit the redemption row's
 * unique index and returned null — the slot was spent and the gift never came.
 * A redemption row with `promoRedeemedAt` still unset is therefore RESUMED: its
 * frozen amounts are granted again through the same idempotent keys, which
 * credits exactly what is missing and nothing twice.
 */
export async function grantPromoRewardsForUser(
  userId: string,
): Promise<PromoRewardResult | null> {
  if (!env.PROMO_FEATURE_ENABLED) return null;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, referralSource: true, promoRedeemedAt: true, onboardingStep: true },
  });
  if (!user) return null;
  if (user.promoRedeemedAt) return null; // already redeemed → idempotent no-op
  // The gift belongs to the onboarding wow screen, which both clients show
  // before completion. An account past onboarding is an existing account, and
  // the spec keeps promo codes away from those whatever attribution it carries.
  if (user.onboardingStep === "completed") return null;

  const claim = await claimRedemption(user.id, user.referralSource);
  if (!claim) return null;

  const idBase = `promo:${claim.promoCodeId}:${user.id}`;

  let ticketsApplied = 0;
  if (claim.tickets > 0) {
    try {
      await grantTickets({
        userId: user.id,
        count: claim.tickets,
        reason: "promo",
        externalPaymentId: `${idBase}:tickets`,
      });
      ticketsApplied = claim.tickets;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // already granted → no-op
    }
  }

  let monthsApplied = 0;
  if (claim.months > 0) {
    const res = await grantComplimentaryPremiumMonths({
      userId: user.id,
      months: claim.months,
      externalPaymentId: `${idBase}:premium`,
      note: `promo code ${claim.code}`,
      provider: "promo",
    });
    if (res.applied) monthsApplied = claim.months;
  }

  // Stamp the once-marker only after both grants went through, so a failure
  // above leaves the claim resumable (the ledger ids already guarantee
  // exactly-once rewards; this drives the "show the wow screen once" flag).
  await prisma.user.updateMany({
    where: { id: user.id, promoRedeemedAt: null },
    data: { promoRedeemedAt: new Date() },
  });

  return { code: claim.code, ticketsApplied, monthsApplied };
}

interface PromoClaim {
  promoCodeId: string;
  code: string;
  tickets: number;
  months: number;
}

/**
 * The redemption this call should honour: an earlier claim whose grants never
 * finished, or a fresh one taken now. Null when there is none to take.
 */
async function claimRedemption(
  userId: string,
  referralSource: string | null,
): Promise<PromoClaim | null> {
  const unfinished = await prisma.promoRedemption.findUnique({
    where: { userId },
    select: {
      promoCodeId: true,
      ticketsApplied: true,
      monthsApplied: true,
      promoCode: { select: { code: true } },
    },
  });
  if (unfinished) {
    // Honoured from the row, not re-resolved: the slot was taken when the code
    // was valid, and the code may since have filled up with this very claim.
    return {
      promoCodeId: unfinished.promoCodeId,
      code: unfinished.promoCode.code,
      tickets: unfinished.ticketsApplied,
      months: unfinished.monthsApplied,
    };
  }

  const resolved = await resolvePromoCode(parsePromoCode(referralSource));
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
          userId,
          ticketsApplied: resolved.ticketReward,
          monthsApplied: resolved.premiumMonths,
        },
      });
      return true;
    });
  } catch (err) {
    // A racing call took the slot first and is granting it now; a later retry
    // resumes it if that call fails.
    if (isUniqueViolation(err)) return null;
    throw err;
  }
  if (!claimed) return null;
  return {
    promoCodeId: resolved.id,
    code: resolved.code,
    tickets: resolved.ticketReward,
    months: resolved.premiumMonths,
  };
}
