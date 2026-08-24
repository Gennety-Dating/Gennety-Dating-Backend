import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { buildMiniAppUrl } from "../services/mini-app-url.js";
import {
  formatPremiumUntil,
  recurringChargeStarsByAnchor,
} from "../services/premium.js";
import { telegramReachable } from "../services/telegram-reach.js";
import { isQuietHours } from "./quiet-hours.js";

/**
 * Gennety Premium expiry reminders (PRODUCT_SPEC §3.8).
 *
 * The monthly plan renews itself, so for most of this product's life nothing
 * ever ended and there was nothing to warn about. The 3- and 6-month packages
 * change that: they are ONE-TIME purchases, so access has a real last day, and
 * a fixed-length product whose end is not announced is access that simply
 * vanishes. This worker is the other half of those plans, not a nicety.
 *
 * Two touches per paid period — 3 days out, then 24 hours out — each carrying a
 * button into the Premium Mini App, where all three plans now live so the user
 * picks the next stretch rather than being sold one specific thing.
 *
 * ## Who is reminded, and why the gate is `premiumAutoRenew`
 *
 * ONLY a non-auto-renewing entitlement. While Telegram (or Apple) is still
 * charging, nothing is ending, and "your access runs out on the 3rd" is then
 * simply false — it would read as a bug to the one cohort that is paying us
 * every month. Read the other way round, the gate is exactly right for
 * everyone it does include: a package buyer (never renews by construction) and
 * a subscriber who has already cancelled (whose access really does end on that
 * date) both need the warning, and both get it from the same condition.
 *
 * ## Once per PERIOD, not once per user
 *
 * The two markers are cleared by every path that advances `premiumUntil`
 * (`RESET_EXPIRY_REMINDERS` in `services/premium.ts`), so buying again earns a
 * fresh pair of warnings. Without that reset a renewing user would be reminded
 * once in their life and every later period would lapse in silence.
 *
 * ## Quiet hours cannot swallow a reminder
 *
 * The Kyiv quiet window is 10 hours and the narrower bucket is 24 hours wide,
 * so every eligible user has waking hours inside their own window — the guard
 * can delay a reminder, never cancel it. That is what makes it safe to apply a
 * promotional-grade guard to a message the user genuinely needs.
 *
 * ## Telegram-only, deliberately
 *
 * No push leg. The only way to buy Premium today is Telegram Stars — the App
 * Store subscription group has never been submitted (deploy.md), so
 * `premium_monthly` cannot be purchased on iOS at all. A lock-screen banner
 * telling an app-only user their access is ending, with no purchase path
 * behind it, points at a product they cannot buy; the same reasoning §3.5b
 * uses to withhold the Premium counterfactual from `/v1/*`. A `both`-platform
 * user is Telegram-reachable and is covered by the DM.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Lead times for the two touches. */
export const PREMIUM_REMINDER_EARLY_MS = 3 * DAY_MS;
export const PREMIUM_REMINDER_LATE_MS = 1 * DAY_MS;

/** One tick's worth of work — bounded so a backlog drains over several ticks. */
const BATCH = 200;

export type PremiumReminderStage = "early" | "late";

export interface PremiumReminderResult {
  sent3d: number;
  sent1d: number;
  /** Eligible, claimed, but the DM failed (blocked bot, deleted chat, …). */
  failed: number;
}

/** The row shape the decision below needs — nothing more. */
export interface PremiumReminderCandidate {
  id: string;
  telegramId: bigint;
  platform: string | null;
  language: string | null;
  theme: "light" | "dark";
  premiumUntil: Date | null;
  premiumAutoRenew: boolean;
  premiumProvider: string | null;
  premiumExternalId: string | null;
  premiumReminder3dAt: Date | null;
  premiumReminder1dAt: Date | null;
}

/**
 * Which of the two situations this user is in — the thing that decides what the
 * message may truthfully say.
 *
 *  • `lapse`  — nothing renews. A package buyer, or a subscriber who already
 *               cancelled. Their access has a real last day.
 *  • `topup`  — a live recurring Stars subscription. Nothing is ending; a
 *               CHARGE is coming, and Telegram takes it from the Star balance
 *               with no card to fall back on, so an empty balance ends the
 *               subscription on the spot.
 *
 * App Store recurring subscriptions return `null` and are silent: Apple runs
 * its own billing retry and grace periods, and there is no Star balance to top
 * up, so "top up your Stars" would be flatly wrong and "your access is ending"
 * would be false.
 */
export function premiumReminderKind(
  user: Pick<PremiumReminderCandidate, "premiumAutoRenew" | "premiumProvider">,
): "lapse" | "topup" | null {
  if (!user.premiumAutoRenew) return "lapse";
  return user.premiumProvider === "telegram_stars" ? "topup" : null;
}

/**
 * Which reminder (if any) this user is owed right now. Pure, so the buckets are
 * testable without a database or a clock.
 *
 * The late bucket is checked FIRST and the two are mutually exclusive: a user
 * inside 24 hours is past the point where "three days left" is true, so they
 * get the accurate message rather than both. That also means a package bought
 * with under three days of runway (topping up an almost-lapsed period) yields
 * exactly one honest warning instead of two contradictory ones.
 */
export function premiumReminderDue(
  user: PremiumReminderCandidate,
  now: Date = new Date(),
): PremiumReminderStage | null {
  if (!user.premiumUntil) return null;
  // An auto-renewing subscriber is NOT silent any more — they are the top-up
  // cohort (`premiumReminderKind`). What is still silent is a rail we have
  // nothing true to say about: an App Store subscription.
  if (premiumReminderKind(user) === null) return null;
  if (!telegramReachable(user)) return null;

  const remaining = user.premiumUntil.getTime() - now.getTime();
  // Already lapsed — too late to warn, and the product says nothing at expiry.
  if (remaining <= 0) return null;

  if (remaining <= PREMIUM_REMINDER_LATE_MS) {
    return user.premiumReminder1dAt ? null : "late";
  }
  if (remaining <= PREMIUM_REMINDER_EARLY_MS) {
    return user.premiumReminder3dAt ? null : "early";
  }
  return null;
}

/**
 * Send the due expiry reminders.
 *
 * Claims the marker BEFORE sending, with a compare-and-set on the marker still
 * being null. The two failure modes are not symmetric: claiming after a send
 * means a DB blip re-sends the same DM on every hourly tick indefinitely, while
 * claiming first costs at most ONE missed touch — and the user still has the
 * other one, since the 3-day and 24-hour reminders are independent.
 */
export async function premiumExpiryReminderTick(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<PremiumReminderResult> {
  const result: PremiumReminderResult = { sent3d: 0, sent1d: 0, failed: 0 };
  if (isQuietHours(now)) return result;

  const horizon = new Date(now.getTime() + PREMIUM_REMINDER_EARLY_MS);
  const candidates = await prisma.user.findMany({
    where: {
      // Deliberately NOT filtered by `premiumAutoRenew`: both cohorts live in
      // this window now, and which one a row belongs to is decided per user by
      // `premiumReminderKind`. Narrowing here again would silently re-exclude
      // the top-up cohort the way this worker originally did.
      premiumUntil: { gt: now, lte: horizon },
      // At least one touch still owed — a period with both markers set is done.
      OR: [{ premiumReminder3dAt: null }, { premiumReminder1dAt: null }],
    },
    select: {
      id: true,
      telegramId: true,
      platform: true,
      language: true,
      theme: true,
      premiumUntil: true,
      premiumAutoRenew: true,
      premiumProvider: true,
      premiumExternalId: true,
      premiumReminder3dAt: true,
      premiumReminder1dAt: true,
    },
    take: BATCH,
  });

  // One query for the whole batch rather than one per user. Only the top-up
  // cohort needs a figure, so anchors are collected from those rows alone.
  const anchors = candidates
    .filter((u) => premiumReminderKind(u as PremiumReminderCandidate) === "topup")
    .map((u) => u.premiumExternalId)
    .filter((a): a is string => Boolean(a));
  const chargeStars = await recurringChargeStarsByAnchor(anchors);

  for (const user of candidates) {
    const stage = premiumReminderDue(user as PremiumReminderCandidate, now);
    if (!stage) continue;

    const field = stage === "late" ? "premiumReminder1dAt" : "premiumReminder3dAt";
    // CAS: only the tick that flips null → now owns the send.
    const claimed = await prisma.user
      .updateMany({
        where: { id: user.id, [field]: null },
        data: { [field]: now },
      })
      .catch(() => ({ count: 0 }));
    if (claimed.count === 0) continue;

    const lang = (user.language ?? "en") as Language;
    const date = formatPremiumUntil(user.premiumUntil, lang);
    const kind = premiumReminderKind(user as PremiumReminderCandidate);

    let text: string;
    // Only ever assigned once a real button has been added. A pre-created
    // `InlineKeyboard` cannot express "no buttons": grammY starts it at `[[]]`,
    // so the obvious `inline_keyboard.length > 0` guard is ALWAYS true and ships
    // a malformed empty row — which is what the lapse branch below silently did
    // whenever WEBAPP_URL was not an HTTPS host. Undefined-until-populated makes
    // the omission structural instead of a condition to get right.
    let keyboard: InlineKeyboard | undefined;

    if (kind === "topup") {
      // The amount is the whole point of this message, so it is read from the
      // user's own last recurring charge — never from `PREMIUM_STARS`, which
      // prices a NEW invoice and can differ from what an existing subscription
      // still charges. Unknown → the sentence simply omits the figure; the
      // warning and the top-up path stand on their own.
      const stars = user.premiumExternalId
        ? chargeStars.get(user.premiumExternalId)
        : undefined;
      const amount =
        stars === undefined ? "" : t(lang, "premiumRenewalAmount", { stars: String(stars) });
      text = t(lang, stage === "late" ? "premiumRenewal1d" : "premiumRenewal3d", {
        date,
        amount,
      });
      // No button, deliberately. This user already has Premium, so the plans
      // screen is the wrong destination — and Telegram exposes no deep link a
      // bot can use to open the Stars top-up screen, so the path is named in
      // the text rather than rendered as a button that goes somewhere else.
    } else {
      text = t(lang, stage === "late" ? "premiumExpiring1d" : "premiumExpiring3d", {
        date,
      });
      // Same rule as the §3.8 hub: the button opens the plans, it does not quote
      // a price. The price belongs one tap later, next to what it buys — and the
      // button is omitted rather than rendered dead when WEBAPP_URL is not a real
      // HTTPS host (dev without a tunnel).
      const url = buildMiniAppUrl("premium", { lang, theme: user.theme });
      if (env.PREMIUM_FEATURE_ENABLED && url.startsWith("https://")) {
        keyboard = new InlineKeyboard().webApp(t(lang, "premiumExpiringCta"), url);
      }
    }

    try {
      await api.sendMessage(Number(user.telegramId), text, {
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      if (stage === "late") result.sent1d += 1;
      else result.sent3d += 1;
    } catch (err) {
      result.failed += 1;
      console.warn(`[premium-reminder] DM failed for ${user.id}:`, err);
    }
  }

  return result;
}
