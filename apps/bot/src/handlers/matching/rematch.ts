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

import { InlineKeyboard, InputFile, type Api, type RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, buildRematchInvoicePayload, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { checkRematchEligibility } from "../../services/rematch.js";
import { renderRematchCard, type RematchCardTheme } from "../../services/rematch-card.js";

/** Bot API caps a photo caption at 1024 chars; a plain text message gets 4096. */
const CAPTION_LIMIT = 1024;

/** Which pain moment produced this offer (selects the copy). */
export type RematchOfferVariant = "famine" | "failed" | "neutral";

/** Callback data for the offer button. */
export const REMATCH_BUY_CALLBACK = "rematch:buy";

/**
 * Callback data for a PULL entry into the offer (pinned banner, concierge).
 *
 * Deliberately distinct from `REMATCH_BUY_CALLBACK`, which mints the Stars
 * invoice. A pull surface is reached by someone who came looking rather than by
 * someone answering a DM they just received, so it must land on the card that
 * states the terms and the price — not on a payment sheet. The banner label
 * therefore carries no number and this callback is the step that introduces one.
 */
export const REMATCH_OPEN_CALLBACK = "rematch:open";

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
    .findUnique({
      where: { id: userId },
      select: { telegramId: true, language: true, theme: true },
    })
    .catch(() => null);
  // Telegram-only in v1: a mobile-only account carries a synthetic negative id
  // and has no Stars rail here.
  if (!user || user.telegramId <= 0n) return false;

  const lang = (user.language ?? "en") as Language;
  const theme: RematchCardTheme = user.theme === "light" ? "light" : "dark";
  const OFFER_COPY = {
    famine: "rematchOfferFamine",
    failed: "rematchOfferFailed",
    neutral: "rematchOfferNeutral",
  } as const;
  const text = t(lang, OFFER_COPY[variant], {
    price: env.REMATCH_PRICE_USD_DISPLAY,
  });
  const keyboard = new InlineKeyboard().text(
    t(lang, "rematchOfferBtn", { price: env.REMATCH_PRICE_USD_DISPLAY }),
    REMATCH_BUY_CALLBACK,
  );

  const chatId = Number(user.telegramId);
  const extra = { reply_markup: keyboard };

  const sendText = async (): Promise<boolean> => {
    try {
      await api.sendMessage(chatId, text, extra);
      return true;
    } catch (err) {
      console.warn(`[rematch] offer send failed user=${userId}:`, (err as Error).message);
      return false;
    }
  };

  // Since 2026-08-20 the offer leads with a rendered card (PRODUCT_SPEC §3.11).
  // Everything below is fail-open by construction, and the return value keeps
  // meaning "an offer reached him" rather than "a picture did": this DM is the
  // only way a paid feature is reached at all, so it degrades to exactly the
  // plain text that shipped before the card existed rather than failing.
  //
  // A caption Telegram would truncate is worse than no card: the caption
  // carries the terms and the price, and the card deliberately carries neither.
  if (text.length > CAPTION_LIMIT) return sendText();

  const png = await renderRematchCard({
    overline: t(lang, "rematchCardOverline"),
    headline: t(lang, "rematchCardHeadline"),
    subline: t(lang, "rematchCardSubline"),
    theme,
  });
  if (!png) return sendText();

  try {
    // No `protect_content`, unlike every other card send in the product: those
    // all render a partner's face (§3.7a) and this one renders an abstract
    // motif, because at offer time nobody has been picked yet. Protecting it
    // would only black it out of a screen recording for nothing.
    await api.sendPhoto(chatId, new InputFile(png, "rematch-offer.png"), {
      caption: text,
      ...extra,
    });
    return true;
  } catch (err) {
    console.warn(
      `[rematch] offer photo failed user=${userId}, falling back to text:`,
      (err as Error).message,
    );
    return sendText();
  }
}

/**
 * Both participants are free again after a match was terminally cancelled —
 * offer each of them a paid rematch.
 *
 * This is THE primary rematch moment: an explicit decline (his, hers, or both)
 * is far more common than the 24h silence `expiry-notify` covers, and it is the
 * exact frustration the feature answers — "this one didn't work, I don't want to
 * wait another week".
 *
 * Call ONLY after winning the `proposed → cancelled` CAS, so the match is
 * genuinely terminal and the single-live-match eligibility check can pass, and
 * only AFTER the outcome reveals have been sent, so the user learns what
 * happened before being offered a next step.
 *
 * Sent to both sides because either may be the eligible buyer;
 * `sendRematchOfferIfEligible` self-gates on male-only + D3 limits, so a woman
 * (or an ineligible/rate-limited man) simply receives nothing. The copy is
 * static and identical for both sides, so it discloses nothing about who decided
 * what — the blind-decision invariant is untouched.
 */
export async function offerRematchAfterCancellation(
  // Nullable because the public API's `getBotApi()` is: an API-only process (or
  // a test harness) has no bot to send through, and that must be a silent no-op
  // rather than an exception thrown out of a decision commit.
  api: Api<RawApi> | null,
  userAId: string,
  userBId: string,
  now: Date = new Date(),
): Promise<void> {
  if (!api) return;
  await Promise.all([
    sendRematchOfferIfEligible(api, userAId, "failed", now).catch(() => {}),
    sendRematchOfferIfEligible(api, userBId, "failed", now).catch(() => {}),
  ]);
}

/**
 * Pull entry (pinned banner / concierge) → post the offer card.
 *
 * The banner is the only rematch surface a user sees without being written to,
 * so this is what makes daily availability possible without a daily DM: the
 * offer stops being a message we push and becomes a screen he opens.
 *
 * Sends rather than edits, because the banner is a PINNED message reconciled
 * every minute by `status-timer` — editing it here would be overwritten within
 * 60s and would also destroy the countdown for everyone else's stage.
 *
 * A refusal answers as a toast and leaves the banner alone: the next worker tick
 * re-resolves eligibility and drops the button on its own, so there is nothing
 * to strip and no stale card to kill (unlike the durable DM the buy handler
 * below has to defuse).
 */
export async function handleRematchOpenCallback(ctx: BotContext): Promise<void> {
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

  // `sendRematchOfferIfEligible` re-checks everything and stays silent when he
  // may not buy — but silence is wrong for a tap he just made, so the refusal
  // is surfaced as a toast here.
  const sent = await sendRematchOfferIfEligible(ctx.api, user.id, "neutral");
  if (!sent) {
    await ctx
      .answerCallbackQuery({ text: t(lang, "rematchUnavailable") })
      .catch(() => {});
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
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
