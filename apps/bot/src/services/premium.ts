import { randomUUID } from "node:crypto";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { isUniqueViolation } from "./ticket-wallet.js";
import { notifyFounderPurchase } from "./founder-notify.js";

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

/**
 * Cleared on every write that advances `premiumUntil`. The expiry reminders are
 * once-per-PAID-PERIOD, not once-per-user: leaving these set would remind a
 * renewing user exactly once, ever, and then let every later period lapse in
 * silence. Kept as one constant so a fourth grant path cannot forget it.
 */
const RESET_EXPIRY_REMINDERS = {
  premiumReminder3dAt: null,
  premiumReminder1dAt: null,
} as const;

export type PremiumProvider = "telegram_stars" | "app_store" | "referral";

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
    select: { premiumSince: true, premiumUntil: true },
  });
  if (!existing) return { applied: false, premiumUntil: null };

  const now = new Date();
  // A paid grant may only ever EXTEND. Telegram/Apple hand us an absolute
  // "paid through" instant, and for a pure subscription each one is later than
  // the last, so this max() is a no-op there — it exists for the mixed case
  // that long packages introduce: a monthly subscriber who buys 6 months has a
  // `premiumUntil` half a year out, and their next ordinary 30-day renewal
  // carries a `subscription_expiration_date` ~30 days out. Writing that
  // through would silently delete five months of paid access on a charge the
  // user just made. `revokePremium` remains the one path that may shorten it.
  const nextUntil =
    existing.premiumUntil && existing.premiumUntil.getTime() > periodEnd.getTime()
      ? existing.premiumUntil
      : periodEnd;
  try {
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          premiumUntil: nextUntil,
          premiumSince: existing.premiumSince ?? now,
          premiumProvider: provider,
          premiumAutoRenew: true,
          premiumExternalId: recurringAnchor ?? externalPaymentId,
          // A fresh paid period earns a fresh pair of expiry reminders.
          ...RESET_EXPIRY_REMINDERS,
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
    // Founder ops feed. Placed on the PAID path only — the complimentary
    // referral/promo grant below has its own function and moves no money — and
    // after the ledger insert, so the duplicate-charge branch (a provider
    // redelivery) never announces the same charge twice. Covers both rails:
    // Telegram Stars settles here, and so does the App Store transaction route.
    void notifyFounderPurchase({
      userId,
      kind: "premium",
      provider: provider === "app_store" ? "app_store" : "telegram_stars",
      amountStars: (currency ?? "").toUpperCase() === "XTR" ? (amount ?? null) : null,
      amountCents: (currency ?? "").toUpperCase() === "XTR" ? null : (amount ?? null),
      currency: currency ?? null,
      detail: event === "renewed" ? "продление подписки" : "первый месяц",
      externalPaymentId,
    });
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

/** Advance `date` by `months` calendar months (clamps end-of-month overflow). */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth);
  return d;
}

/**
 * The shared write behind every **additive** premium grant — the referral/promo
 * comp and the paid 3/6-month package. Both extend an existing period rather
 * than replacing it, and both deliberately leave the RECURRING head alone:
 *
 *  - **Additive**: `premiumUntil` grows from `max(now, premiumUntil)`, so a
 *    grant stacks on top of a live period instead of overwriting it. This is
 *    the "новый срок прибавляется к текущей дате окончания" rule.
 *  - **Non-clobbering**: `premiumAutoRenew` / `premiumProvider` /
 *    `premiumExternalId` are UNTOUCHED. Those three columns describe *the
 *    recurring subscription*, and neither a comp nor a fixed-length package is
 *    one. Two consequences, both wanted: a monthly subscriber who buys a
 *    package keeps the anchor that makes cancellation work, and a user with no
 *    subscription ends up Premium-active with `premiumAutoRenew = false` —
 *    correct, because nothing renews, and it is exactly what makes the expiry
 *    reminder fire for them.
 *  - **Exactly-once**: a duplicate `externalPaymentId` (P2002) is a no-op.
 */
async function extendPremiumAdditive(input: {
  userId: string;
  months: number;
  externalPaymentId: string;
  provider: string;
  event: Extract<SubscriptionEvent, "started" | "renewed">;
  amount?: number;
  currency?: string;
  note?: string;
}): Promise<ActivatePremiumResult & { periodStart: Date | null }> {
  const { userId, months, externalPaymentId, provider, event, amount, currency, note } =
    input;
  if (months <= 0) return { applied: false, premiumUntil: null, periodStart: null };

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { premiumSince: true, premiumUntil: true },
  });
  if (!existing) return { applied: false, premiumUntil: null, periodStart: null };

  const now = new Date();
  const base =
    existing.premiumUntil && existing.premiumUntil.getTime() > now.getTime()
      ? existing.premiumUntil
      : now;
  const periodEnd = addMonths(base, months);

  try {
    const [updated] = await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          premiumUntil: periodEnd,
          premiumSince: existing.premiumSince ?? now,
          // NOTE: autoRenew / provider / externalId intentionally NOT set.
          ...RESET_EXPIRY_REMINDERS,
        },
        select: { premiumUntil: true },
      }),
      prisma.subscriptionLedger.create({
        data: {
          userId,
          provider,
          event,
          externalPaymentId,
          periodStart: base,
          periodEnd,
          amount: amount ?? null,
          currency: currency ?? null,
          note: note ?? null,
        },
      }),
    ]);
    return { applied: true, premiumUntil: updated.premiumUntil, periodStart: base };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const head = await prisma.user.findUnique({
        where: { id: userId },
        select: { premiumUntil: true },
      });
      return { applied: false, premiumUntil: head?.premiumUntil ?? null, periodStart: null };
    }
    throw err;
  }
}

/**
 * Grant `months` of **complimentary** Premium (PRODUCT_SPEC §Referral) — the
 * referral / promo reward path. Additive and non-clobbering; see
 * `extendPremiumAdditive` for why. Distinct from the paid paths in that it
 * moves no money: no amount, no currency, and no founder-feed announcement.
 */
export async function grantComplimentaryPremiumMonths(input: {
  userId: string;
  months: number;
  externalPaymentId: string;
  note?: string;
  /// `subscription_ledger.provider` for the audit row. Complimentary grants are
  /// not a paid rail; defaults to `referral`, promo passes `promo`.
  provider?: string;
}): Promise<ActivatePremiumResult> {
  const { userId, months, externalPaymentId, note, provider = "referral" } = input;
  const { applied, premiumUntil } = await extendPremiumAdditive({
    userId,
    months,
    externalPaymentId,
    provider,
    event: "started",
    ...(note !== undefined ? { note } : {}),
  });
  return { applied, premiumUntil };
}

/**
 * Settle a **paid, fixed-length Premium package** — the 3- and 6-month
 * one-time Telegram Stars purchases (PRODUCT_SPEC §3.8).
 *
 * A package is deliberately NOT a subscription, and that shows up in three
 * places rather than one:
 *
 *  1. **Telegram never renews it** — the invoice is minted without a
 *     `subscription_period`, so there is no recurring charge to anchor.
 *  2. **It stacks** rather than replaces (`extendPremiumAdditive`), which is
 *     what makes "buy 6 months while a month is still running" add up instead
 *     of throwing the remainder away.
 *  3. **Its ending is announced** — the reminder markers are cleared here, so
 *     the expiry sweep gives this period its own 3-day and 24-hour warning.
 *     A package with no reminder is access that disappears without notice,
 *     which is the one failure mode a non-renewing product must not have.
 *
 * It IS a paid rail, so unlike the comp above it records the charged amount and
 * announces to the founder ops feed — after the ledger insert, so a redelivered
 * `successful_payment` (the duplicate branch) never announces the same charge
 * twice.
 */
export async function activatePremiumPackage(input: {
  userId: string;
  months: number;
  /** Provider charge id → exactly-once. Telegram: `telegram_payment_charge_id`. */
  externalPaymentId: string;
  provider?: PremiumProvider;
  amount?: number;
  currency?: string;
  /** Short human label for the ops feed, e.g. "пакет 6 мес.". */
  detail?: string;
}): Promise<ActivatePremiumResult> {
  const {
    userId,
    months,
    externalPaymentId,
    provider = "telegram_stars",
    amount,
    currency,
    detail,
  } = input;

  const result = await extendPremiumAdditive({
    userId,
    months,
    externalPaymentId,
    provider,
    event: "started",
    ...(amount !== undefined ? { amount } : {}),
    ...(currency !== undefined ? { currency } : {}),
  });
  if (!result.applied) return { applied: false, premiumUntil: result.premiumUntil };

  void notifyFounderPurchase({
    userId,
    kind: "premium",
    provider: provider === "app_store" ? "app_store" : "telegram_stars",
    amountStars: (currency ?? "").toUpperCase() === "XTR" ? (amount ?? null) : null,
    amountCents: (currency ?? "").toUpperCase() === "XTR" ? null : (amount ?? null),
    currency: currency ?? null,
    detail: detail ?? `пакет ${months} мес.`,
    externalPaymentId,
  });

  return { applied: true, premiumUntil: result.premiumUntil };
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

// ---------------------------------------------------------------------------
// In-chat cancellation (the menu agent's cancel flow — PRODUCT_SPEC §Premium)
// ---------------------------------------------------------------------------

export interface PremiumCancelContext {
  active: boolean;
  /** `telegram_stars` | `app_store` | null (never subscribed). */
  provider: string | null;
  premiumUntil: Date | null;
  /**
   * The recurring anchor needed to cancel at the provider: the Telegram Stars
   * `telegram_payment_charge_id` (for `editUserStarSubscription`) or the App
   * Store `originalTransactionId`. Null if never recorded.
   */
  recurringAnchor: string | null;
  autoRenew: boolean;
}

/**
 * Everything the in-chat cancel flow needs to decide what to do: whether the
 * user is active, which rail they're on (Stars → cancel in-chat; App Store →
 * guide to iOS Settings), when access lapses, and the recurring anchor for the
 * Stars API call. One query, no writes.
 */
export async function getPremiumCancelContext(
  userId: string,
  now: Date = new Date(),
): Promise<PremiumCancelContext> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      premiumUntil: true,
      premiumProvider: true,
      premiumExternalId: true,
      premiumAutoRenew: true,
    },
  });
  return {
    active: isPremiumHeadActive(user, now),
    provider: user?.premiumProvider ?? null,
    premiumUntil: user?.premiumUntil ?? null,
    recurringAnchor: user?.premiumExternalId ?? null,
    autoRenew: user?.premiumAutoRenew ?? false,
  };
}

export interface InChatCancellationResult {
  ledgerId: string;
  premiumUntil: Date | null;
}

/**
 * Record an in-chat cancellation: turn auto-renew off (the paid period still
 * stands — `premiumUntil` is untouched, so the user keeps Premium until it
 * lapses) and append a `cancelled` audit row that the churn reason is later
 * attached to. The Telegram Stars API cancel (`editUserStarSubscription`) is a
 * separate side-effect owned by the handler; this is only the DB side.
 *
 * Returns the created ledger row id so the follow-up reason can annotate it.
 */
export async function recordInChatCancellation(
  userId: string,
  provider: string | null,
): Promise<InChatCancellationResult> {
  const externalPaymentId = `cancel:${userId}:${Date.now()}:${randomUUID()}`;
  const [updated, ledgerRow] = await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { premiumAutoRenew: false },
      select: { premiumUntil: true },
    }),
    prisma.subscriptionLedger.create({
      data: {
        userId,
        provider: provider ?? "unknown",
        event: "cancelled",
        externalPaymentId,
      },
      select: { id: true },
    }),
  ]);
  return { ledgerId: ledgerRow.id, premiumUntil: updated.premiumUntil };
}

/**
 * Attach the free-text churn reason to a `cancelled` ledger row (best-effort;
 * a vanished row or a race is swallowed — the cancellation already happened).
 */
export async function attachCancellationReason(
  ledgerId: string,
  note: string,
): Promise<void> {
  const trimmed = note.trim().slice(0, 2000);
  if (!trimmed) return;
  await prisma.subscriptionLedger
    .update({ where: { id: ledgerId }, data: { note: trimmed } })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Recurring charge amount (the Stars top-up reminder — PRODUCT_SPEC §3.8)
// ---------------------------------------------------------------------------

/**
 * What Telegram will actually charge at the next auto-renewal, per user, keyed
 * by the recurring anchor (`User.premiumExternalId`).
 *
 * Two things make this a lookup rather than a constant, and both are traps:
 *
 *  1. **`PREMIUM_STARS` is the price of a NEW invoice, not of an existing
 *     subscription.** A recurring Stars subscription's amount is frozen at the
 *     invoice that created it — deploy.md records a live 500⭐ subscription
 *     still renewing at 500⭐ after the env moved to 750⭐. Quoting today's env
 *     price to such a user would misstate what leaves their balance, on the one
 *     message whose entire job is to name that number.
 *
 *  2. **The anchor, not the newest ledger row, identifies the charge.** A
 *     3/6-month package also writes a priced `started` row on the same
 *     `telegram_stars` provider, so "latest XTR row" would quote 3150⭐ to a
 *     monthly subscriber who once bought a package. `premiumExternalId` is set
 *     only by the recurring path (`activateOrExtendPremium`) and deliberately
 *     left alone by `extendPremiumAdditive`, so it points at exactly the last
 *     recurring charge — and that row carries its amount.
 *
 * An anchor with no priced row simply maps to nothing; the caller then omits
 * the figure. An absent number is a weaker message; a wrong one is a lie about
 * someone's money.
 */
export async function recurringChargeStarsByAnchor(
  anchors: string[],
): Promise<Map<string, number>> {
  const unique = [...new Set(anchors.filter((a): a is string => Boolean(a)))];
  if (unique.length === 0) return new Map();

  const rows = await prisma.subscriptionLedger.findMany({
    where: { externalPaymentId: { in: unique }, currency: "XTR", amount: { gt: 0 } },
    select: { externalPaymentId: true, amount: true },
  });

  const out = new Map<string, number>();
  for (const row of rows) {
    if (row.externalPaymentId && row.amount != null) {
      out.set(row.externalPaymentId, row.amount);
    }
  }
  return out;
}
