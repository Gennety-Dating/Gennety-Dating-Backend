/**
 * Rematch offer surface (REMATCH_PRODUCT_SPEC.md, D4).
 *
 * There is deliberately NO permanent menu entry. The offer appears only at the
 * two moments it answers something the user just felt: the weekly batch left him
 * unpaired, or his match ended without a date. Anywhere else it would read as a
 * shop rather than a matchmaker.
 *
 * Two taps by design. The DM carries the full terms (what the money buys, and
 * that only "found nobody" is refunded); tapping mints the Stars invoice. That
 * ordering keeps the honest terms on screen immediately before payment, and it
 * means we only mint an invoice for someone who actually wants one.
 */

import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, buildRematchInvoicePayload, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { checkRematchEligibility } from "../../services/rematch.js";

/** Which pain moment produced this offer (selects the copy). */
export type RematchOfferVariant = "famine" | "failed";

/** Callback data for the offer button. */
export const REMATCH_BUY_CALLBACK = "rematch:buy";

/**
 * Send the rematch offer to a buyer, if he may actually buy one right now.
 *
 * Silently does nothing when the feature is off, the user isn't an eligible male
 * buyer, or he's rate-limited — a CTA that fails on tap is worse than no CTA.
 * Returns whether an offer was sent (for logging/tests).
 */
export async function sendRematchOfferIfEligible(
  api: Api<RawApi>,
  userId: string,
  variant: RematchOfferVariant,
  now: Date = new Date(),
): Promise<boolean> {
  if (!env.REMATCH_FEATURE_ENABLED) return false;

  const eligibility = await checkRematchEligibility(userId, now).catch(() => null);
  if (!eligibility?.ok) return false;

  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { telegramId: true, language: true } })
    .catch(() => null);
  // Telegram-only in v1: a mobile-only account carries a synthetic negative id
  // and has no Stars rail here.
  if (!user || user.telegramId <= 0n) return false;

  const lang = (user.language ?? "en") as Language;
  const text = t(
    lang,
    variant === "famine" ? "rematchOfferFamine" : "rematchOfferFailed",
    { price: env.REMATCH_PRICE_USD_DISPLAY },
  );
  const keyboard = new InlineKeyboard().text(
    t(lang, "rematchOfferBtn", { price: env.REMATCH_PRICE_USD_DISPLAY }),
    REMATCH_BUY_CALLBACK,
  );

  try {
    await api.sendMessage(Number(user.telegramId), text, { reply_markup: keyboard });
    return true;
  } catch (err) {
    console.warn(`[rematch] offer send failed user=${userId}:`, (err as Error).message);
    return false;
  }
}

/**
 * Offer button tap → mint the Stars invoice and hand back a pay button.
 *
 * Re-checks eligibility because the card is durable: it can sit in the chat past
 * a cooldown, past the weekly limit, or past the moment he acquired a live
 * match. Refusing here with a real reason is much better than letting him pay
 * and be refunded.
 */
export async function handleRematchBuyCallback(ctx: BotContext): Promise<void> {
  const telegramId = ctx.from?.id;
  if (telegramId == null) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true },
  });
  if (!user) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const lang = (user.language ?? "en") as Language;

  if (!env.REMATCH_FEATURE_ENABLED) {
    await ctx.answerCallbackQuery({ text: t(lang, "rematchUnavailable") }).catch(() => {});
    return;
  }

  const eligibility = await checkRematchEligibility(user.id);
  if (!eligibility.ok) {
    const key =
      eligibility.reason === "weekly_limit" || eligibility.reason === "cooldown"
        ? "rematchLimitReached"
        : "rematchUnavailable";
    await ctx.answerCallbackQuery().catch(() => {});
    // Strip the now-dead button so the stale card can't be tapped again.
    await ctx
      .editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })
      .catch(() => {});
    await ctx.reply(t(lang, key)).catch(() => {});
    return;
  }

  let link: string;
  try {
    link = await ctx.api.createInvoiceLink(
      t(lang, "rematchInvoiceTitle"),
      t(lang, "rematchInvoiceDesc"),
      buildRematchInvoicePayload("v1"),
      "", // provider_token — empty for Telegram Stars (XTR)
      "XTR",
      [{ label: t(lang, "rematchInvoiceLabel"), amount: env.REMATCH_STARS }],
    );
  } catch (err) {
    console.error("[rematch] createInvoiceLink failed:", err);
    await ctx.answerCallbackQuery({ text: t(lang, "rematchUnavailable") }).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  // Replace the offer's button with the pay button on the same card, so the
  // terms the user just read stay directly above what they're paying for.
  const payKeyboard = new InlineKeyboard().url(
    t(lang, "rematchOfferBtn", { price: env.REMATCH_PRICE_USD_DISPLAY }),
    link,
  );
  await ctx.editMessageReplyMarkup({ reply_markup: payKeyboard }).catch(async () => {
    await ctx
      .reply(t(lang, "rematchInvoiceDesc"), { reply_markup: payKeyboard })
      .catch(() => {});
  });
}
