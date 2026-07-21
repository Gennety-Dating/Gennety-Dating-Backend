import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { isUniqueViolation } from "./ticket-wallet.js";

const PREMIUM_LOCALE_TAGS: Record<Language, string> = {
  en: "en-GB",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  pl: "pl-PL",
};

/** Localized "active until" date for premium DMs / menu / hub (day month year). */
export function formatPremiumUntil(date: Date | null | undefined, lang: Language): string {
  if (!date) return "";
  return new Intl.DateTimeFormat(PREMIUM_LOCALE_TAGS[lang] ?? "en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

/**
 * Gennety Premium — the channel-agnostic per-user subscription entitlement
 * (PRODUCT_SPEC §Premium). This service is the ONLY writer of the premium head
 * columns on `User` and the append-only `subscription_ledger`; every surface
 * (venue-change, the menu, the Mini App, the Telegram Stars rail, the iOS
 * StoreKit rail) only asks `isPremiumActive(...)` or calls
 * `activateOrExtendPremium(...)` — none of them learn HOW premium was bought.
 *
 * A subscription is "active" purely by `premiumUntil > now`, so a lapsed or
 * cancelled sub needs no sweep: it simply stops being active when the paid
 * period ends. Exactly-once application is guaranteed by the unique
 * `SubscriptionLedger.externalPaymentId` (the provider charge / notification id),
 * exactly like the ticket wallet — a redelivered Stars `successful_payment` or a
 * re-sent App Store notification throws P2002 and the whole transaction rolls
 * back, so a renewal is applied at most once.
 *
 * NOTE: `isPremiumActive` deliberately does NOT consult `PREMIUM_FEATURE_ENABLED`
 * — an entitlement a user already paid for stays valid regardless of the flag.
 * The flag gates NEW purchase surfaces / premium UI at the call sites.
 */

export type PremiumProvider = "telegram_stars" | "app_store";

export type SubscriptionEvent =
  | "started"
  | "renewed"
  | "cancelled"
  | "expired"
  | "refunded";

/** Minimal shape needed to decide active-ness without a DB round-trip. */
export interface PremiumHead {
  premiumUntil: Date | null;
}

/** Active ⇔ a paid period is still in the future. */
export function isPremiumHeadActive(
  head: PremiumHead | null | undefined,
  now: Date = new Date(),
): boolean {
  return head?.premiumUntil != null && head.premiumUntil.getTime() > now.getTime();
}

/**
 * Whether the user currently has an active Premium subscription. Accepts either
 * a loaded head (no query) or a userId (one query). Returns false for unknown
 * users.
 */
export async function isPremiumActive(
  userOrId: PremiumHead | string,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof userOrId !== "string") return isPremiumHeadActive(userOrId, now);
  const user = await prisma.user.findUnique({
    where: { id: userOrId },
    select: { premiumUntil: true },
  });
  return isPremiumHeadActive(user, now);
}

export interface PremiumState {
  active: boolean;
  premiumUntil: Date | null;
  premiumSince: Date | null;
  provider: string | null;
  autoRenew: boolean;
}

/** Full premium state for the menu / Mini App / `/v1/premium/state`. */
export async function getPremiumState(
  userId: string,
  now: Date = new Date(),
): Promise<PremiumState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      premiumUntil: true,
      premiumSince: true,
      premiumProvider: true,
      premiumAutoRenew: true,
    },
  });
  return {
    active: isPremiumHeadActive(user, now),
    premiumUntil: user?.premiumUntil ?? null,
    premiumSince: user?.premiumSince ?? null,
    provider: user?.premiumProvider ?? null,
    autoRenew: user?.premiumAutoRenew ?? false,
  };
}

export interface ActivatePremiumInput {
  userId: string;
  provider: PremiumProvider;
  /** New paid-through instant (the provider's authoritative expiry). */
  periodEnd: Date;
  /** Period start (informational/audit); defaults to now. */
  periodStart?: Date;
  /**
   * Unique provider charge / notification id → exactly-once. A redelivered
   * event with the same id is a no-op. Telegram Stars: the recurring
   * `telegram_payment_charge_id`. App Store: the transaction/notification id.
   */
  externalPaymentId: string;
  /**
   * The stable recurring anchor stored on `User.premiumExternalId` for later
   * cancel/refund (Telegram: the charge id used with `editUserStarSubscription`;
   * App Store: the `originalTransactionId`). Defaults to `externalPaymentId`.
   */
  recurringAnchor?: string;
  /** `started` (first period) vs `renewed` (auto-renewal). */
  event?: Extract<SubscriptionEvent, "started" | "renewed">;
  amount?: number;
  currency?: string;
}

export interface ActivatePremiumResult {
  applied: boolean;
  premiumUntil: Date | null;
}

/**
 * Grant or extend Premium and append the matching ledger row atomically.
 * Idempotent: a duplicate `externalPaymentId` (P2002) is a no-op and returns
 * the current head. `premiumSince` is preserved across renewals; `premiumUntil`
 * advances to the provider's authoritative `periodEnd`.
 */
export async function activateOrExtendPremium(
  input: ActivatePremiumInput,
): Promise<ActivatePremiumResult> {
  const {
    userId,
    provider,
    periodEnd,
    periodStart,
    externalPaymentId,
    recurringAnchor,
    event = "started",
    amount,
    currency,
  } = input;

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumSince: true },
  });
  if (!existing) return { applied: false, premiumUntil: null };

  const now = new Date();
  try {
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          premiumUntil: periodEnd,
          premiumSince: existing.premiumSince ?? now,
          premiumProvider: provider,
          premiumAutoRenew: true,
          premiumExternalId: recurringAnchor ?? externalPaymentId,
        },
        select: { premiumUntil: true },
      }),
      prisma.subscriptionLedger.create({
        data: {
          userId,
          provider,
          event,
          externalPaymentId,
          periodStart: periodStart ?? now,
          periodEnd,
          amount: amount ?? null,
          currency: currency ?? null,
        },
      }),
    ]);
    return { applied: true, premiumUntil: updated.premiumUntil };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const head = await prisma.user.findUnique({
        where: { id: userId },
        select: { premiumUntil: true },
      });
      return { applied: false, premiumUntil: head?.premiumUntil ?? null };
    }
    throw err;
  }
}

/**
 * Mark auto-renew off (the user cancelled at the provider). The paid period
 * still stands — `premiumUntil` is untouched, so the user keeps Premium until it
 * lapses. Idempotent; records a `cancelled` audit row keyed by a synthetic id.
 */
export async function cancelAutoRenew(
  userId: string,
  externalPaymentId: string,
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { premiumAutoRenew: false },
      }),
      prisma.subscriptionLedger.create({
        data: { userId, provider: "unknown", event: "cancelled", externalPaymentId },
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}

/**
 * Immediately end Premium (a refund/revoke, e.g. an App Store REFUND/REVOKE or a
 * Stars refund): clear the paid period so the entitlement is gone now. Records a
 * `refunded` (or `expired`) audit row. Idempotent via `externalPaymentId`.
 */
export async function revokePremium(
  userId: string,
  externalPaymentId: string,
  event: Extract<SubscriptionEvent, "refunded" | "expired"> = "refunded",
): Promise<void> {
  try {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: { premiumUntil: null, premiumAutoRenew: false },
      }),
      prisma.subscriptionLedger.create({
        data: { userId, provider: "unknown", event, externalPaymentId },
      }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) return;
    throw err;
  }
}
