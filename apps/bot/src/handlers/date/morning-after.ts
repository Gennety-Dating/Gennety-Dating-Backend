/**
 * «The Morning After» + the Date Wishlist offer on Telegram (decision journal
 * 2026-10-08). The rules live in `services/morning-after.ts` and
 * `services/wishlist.ts`; this file is the chat surface:
 *
 *   `ma:g:<matchId>` / `ma:p:<matchId>` — the two buttons of the morning check
 *   `wl:open:<matchId>`                — show an already-open (or Premium) sheet
 *   Stars invoice `wish:<matchId>`     — the paid sheet, settled in payments.ts
 *
 * Plain text everywhere (no parse_mode): names and item titles are user
 * content and must never be read as markup.
 */

import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  afterDateT,
  buildWishInvoicePayload,
  parseWishInvoicePayload,
  type Language,
} from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { announceMutual, recordMorningAfter } from "../../services/morning-after.js";
import {
  mutualOfferFor,
  recordWishlistUnlock,
  wishlistPurchasable,
  type MutualOffer,
  type WishlistItemView,
} from "../../services/wishlist.js";
import { notifyFounderPurchase } from "../../services/founder-notify.js";

export const MORNING_AFTER_CALLBACK = /^ma:(g|p):([0-9a-f-]{36})$/i;
export const WISHLIST_OPEN_CALLBACK = /^wl:open:([0-9a-f-]{36})$/i;

async function viewerByTelegram(
  telegramId: number | undefined,
): Promise<{ id: string; language: Language; telegramId: bigint } | null> {
  if (telegramId == null) return null;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true, telegramId: true },
  });
  return user ? { id: user.id, language: (user.language ?? "en") as Language, telegramId: user.telegramId } : null;
}

/** A tap on 🔥 / 🤷. The buttons come off the message either way. */
export async function handleMorningAfterCallback(ctx: BotContext): Promise<void> {
  const match = MORNING_AFTER_CALLBACK.exec(ctx.callbackQuery?.data ?? "");
  if (!match) return;
  const answer = match[1] === "g" ? "great" : "pass";
  const matchId = match[2]!;
  const viewer = await viewerByTelegram(ctx.from?.id);
  if (!viewer) {
    await ctx.answerCallbackQuery().catch(() => undefined);
    return;
  }
  const lang = viewer.language;
  const result = await recordMorningAfter({ matchId, userId: viewer.id, answer });
  await ctx.answerCallbackQuery().catch(() => undefined);

  const reply = !result.ok
    ? afterDateT(lang, "morningAfterExpired")
    : result.answer === "great"
      ? afterDateT(lang, "morningAfterThanksGreat")
      : afterDateT(lang, "morningAfterThanksPass");
  await ctx.editMessageReplyMarkup().catch(() => undefined);
  await ctx.reply(reply).catch(() => undefined);

  if (result.ok && result.mutualJustNow) {
    await announceMutual(ctx.api, matchId, sendMutualOfferDm);
  }
}

function itemLine(item: WishlistItemView): string {
  const brand = item.brand && !item.title.includes(item.brand) ? ` — ${item.brand}` : "";
  const price = item.priceBand ? ` (${item.priceBand})` : "";
  const note = item.note ? `\n   «${item.note}»` : "";
  const link = item.productUrl ? `\n   ${item.productUrl}` : "";
  return `• ${item.title}${brand}${price}${note}${link}`;
}

function offerText(offer: MutualOffer, lang: Language): string {
  const parts = [offer.title, offer.body, offer.timing];
  if (offer.flowersHint) parts.push(`💐 ${offer.flowersHint}`);
  if (offer.wishlistLine && offer.wishlist) {
    const sheet = offer.wishlist;
    const lines = sheet.items.map(itemLine);
    if (sheet.lockedLabel) lines.push(`🔒 ${sheet.lockedLabel}`);
    // The age line goes under the list, before the buy button: the viewer
    // learns the list is old before paying for it.
    if (sheet.ageNote) lines.push(`\n${sheet.ageNote}`);
    parts.push(`${offer.wishlistLine}\n\n${afterDateT(lang, "wishlistSheetTitle", { name: offer.partner.firstName ?? "" })}\n${lines.join("\n")}`);
    parts.push(offer.gift);
  }
  return parts.join("\n\n");
}

/**
 * The "it's mutual" DM with the offer, for one viewer. The sheet's button is
 * a reusable Stars invoice link (pre-checkout re-validates everything), or
 * "open" when Premium covers it; no button when there is no sheet to offer.
 */
export async function sendMutualOfferDm(
  api: Api<RawApi>,
  matchId: string,
  viewerId: string,
): Promise<void> {
  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { telegramId: true, language: true },
  });
  if (!viewer) return;
  const lang = (viewer.language ?? "en") as Language;
  const result = await mutualOfferFor(matchId, viewerId, lang);
  if (!result.ok) return;
  const { offer } = result;

  type Button = { text: string; callback_data: string } | { text: string; url: string };
  let keyboard: { inline_keyboard: Button[][] } | undefined;
  const sheet = offer.wishlist;
  if (sheet && sheet.lockedCount > 0 && !sheet.unlocked) {
    if (sheet.premiumIncluded) {
      keyboard = {
        inline_keyboard: [[{ text: afterDateT(lang, "wishlistUnlockPremium"), callback_data: `wl:open:${matchId}` }]],
      };
    } else {
      const link = await api
        .createInvoiceLink(
          afterDateT(lang, "wishlistInvoiceTitle"),
          afterDateT(lang, "wishlistInvoiceDescription", { name: offer.partner.firstName ?? "" }),
          buildWishInvoicePayload(matchId),
          "",
          "XTR",
          [{ label: afterDateT(lang, "wishlistInvoiceTitle"), amount: env.WISHLIST_UNLOCK_STARS }],
        )
        .catch(() => null);
      if (link) {
        keyboard = {
          inline_keyboard: [[{ text: afterDateT(lang, "wishlistUnlockStars", { stars: env.WISHLIST_UNLOCK_STARS }), url: link }]],
        };
      }
    }
  }
  const text = offerText(offer, lang);
  if (keyboard) {
    await api.sendMessage(Number(viewer.telegramId), text, {
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } else {
    await api.sendMessage(Number(viewer.telegramId), text, {
      link_preview_options: { is_disabled: true },
    });
  }
}

/** The whole sheet as one message, after a purchase or with Premium. */
export async function sendWishlistSheetDm(
  api: Api<RawApi>,
  telegramId: bigint,
  offer: MutualOffer,
  lang: Language,
): Promise<void> {
  const sheet = offer.wishlist;
  const title = afterDateT(lang, "wishlistSheetTitle", { name: offer.partner.firstName ?? "" });
  const body =
    sheet && sheet.items.length > 0
      ? sheet.items.map(itemLine).join("\n")
      : afterDateT(lang, "wishlistSheetEmpty");
  const age = sheet?.ageNote ? `\n\n${sheet.ageNote}` : "";
  const flowers = offer.flowersHint ? `\n\n💐 ${offer.flowersHint}` : "";
  await api.sendMessage(Number(telegramId), `${title}\n\n${body}${age}${flowers}`, {
    link_preview_options: { is_disabled: true },
  });
}

/** `wl:open:<matchId>` — Premium (or an earlier purchase) opens the sheet. */
export async function handleWishlistOpenCallback(ctx: BotContext): Promise<void> {
  const match = WISHLIST_OPEN_CALLBACK.exec(ctx.callbackQuery?.data ?? "");
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (!match) return;
  const viewer = await viewerByTelegram(ctx.from?.id);
  if (!viewer) return;
  const result = await mutualOfferFor(match[1]!, viewer.id, viewer.language);
  if (!result.ok || !result.offer.wishlist?.unlocked) {
    await ctx.reply(afterDateT(viewer.language, "wishlistUnavailable")).catch(() => undefined);
    return;
  }
  await sendWishlistSheetDm(ctx.api, viewer.telegramId, result.offer, viewer.language);
}

/** Pre-checkout for `wish:<matchId>` — links are reusable, so re-check all of it. */
export async function wishlistPreCheckoutOk(
  payload: string,
  telegramId: number | undefined,
  currency: string,
  amount: number,
): Promise<boolean> {
  const wish = parseWishInvoicePayload(payload);
  if (!wish || currency !== "XTR" || amount !== env.WISHLIST_UNLOCK_STARS) return false;
  const viewer = await viewerByTelegram(telegramId).catch(() => null);
  if (!viewer) return false;
  const purchasable = await wishlistPurchasable(wish.matchId, viewer.id).catch(() => null);
  return purchasable?.ok === true;
}

/**
 * Settle a confirmed `wish:` charge: record the unlock and send the sheet. If
 * the sheet can no longer be honoured (it stopped being mutual, the owner
 * withdrew it, it was opened in the meantime) the Stars go straight back.
 */
export async function settleWishlistStarsPayment(
  api: Api<RawApi>,
  telegramId: number,
  payload: string,
  chargeId: string,
  amountStars: number,
): Promise<{ ok: true } | { ok: false; reason: string; compensated?: boolean }> {
  const wish = parseWishInvoicePayload(payload);
  if (!wish) return { ok: false, reason: "wishlist-bad-payload" };
  const viewer = await viewerByTelegram(telegramId);
  if (!viewer) return { ok: false, reason: "user-not-found" };

  const purchasable = await wishlistPurchasable(wish.matchId, viewer.id);
  if (!purchasable.ok) {
    const refunded = await api
      .refundStarPayment(telegramId, chargeId)
      .then(() => true)
      .catch(() => false);
    if (refunded) {
      await api.sendMessage(telegramId, afterDateT(viewer.language, "wishlistUnavailable")).catch(() => undefined);
    }
    return { ok: false, reason: `wishlist:${purchasable.error}`, compensated: refunded };
  }

  const recorded = await recordWishlistUnlock({
    matchId: wish.matchId,
    viewerId: viewer.id,
    ownerId: purchasable.ownerId,
    provider: "telegram_stars",
    externalPaymentId: chargeId,
    amountStars,
  });
  if (recorded === "created") {
    void notifyFounderPurchase({
      userId: viewer.id,
      kind: "wishlist",
      provider: "telegram_stars",
      amountStars,
      detail: "Date Wishlist",
      matchId: wish.matchId,
      externalPaymentId: chargeId,
    }).catch(() => undefined);
  }
  const offer = await mutualOfferFor(wish.matchId, viewer.id, viewer.language);
  if (offer.ok) {
    await sendWishlistSheetDm(api, viewer.telegramId, offer.offer, viewer.language).catch(() => undefined);
  }
  return { ok: true };
}
