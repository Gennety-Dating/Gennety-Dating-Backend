import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { DEFAULT_MARKET, isSupportedCityKey, t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  homeLocationForMarket,
  saveHomeLocationForUser,
} from "../../public/home-location.js";

/**
 * "Switch my city to a launched market" (`menu:city`).
 *
 * Gennety is live in Kyiv only, and matching is strictly same-city
 * (`buildCandidateSql` joins on an exact `Profile.homeCityKey`), so an account
 * registered elsewhere sits in a pool of one. Registration now refuses those
 * cities outright (PRODUCT_SPEC §1.1), but accounts created before that gate
 * still exist — this is their way out, and the only city change the product
 * offers: a one-tap move to the launched market, nothing else.
 *
 * Deliberately non-destructive: only `Profile.home*`/coordinates/`timeZone`
 * change. Status, profile, photos, verification, tickets and Premium are all
 * untouched, so the user lands in the next Thursday drop as they are.
 */

/** True when this account's dating city is one Gennety has not launched. */
export function isMarketPending(homeCityKey: string | null | undefined): boolean {
  return Boolean(homeCityKey) && !isSupportedCityKey(homeCityKey);
}

/** The label for the conditional main-menu row. */
export function citySwitchLabel(lang: Language): string {
  return t(lang, "menuCitySwitch");
}

/** Card explaining why the city has to change, plus the one-tap confirm. */
export async function handleCitySwitchOpen(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const userId = await requireUserId(ctx);
  if (!userId) return;
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { homeCity: true, homeCityKey: true },
  });

  // Already in a launched market (e.g. a stale keyboard from before a switch):
  // nothing to offer — send them back to the menu rather than a dead card.
  if (!isMarketPending(profile?.homeCityKey)) {
    await ctx.reply(t(lang, "citySwitchDone"));
    return;
  }

  const city = profile?.homeCity ?? profile?.homeCityKey ?? "";
  await ctx.reply(t(lang, "citySwitchCard", { city }), {
    parse_mode: "Markdown",
    reply_markup: buildCitySwitchKeyboard(lang),
  });
}

/** The confirm tap: move the dating city to the launched market. */
export async function handleCitySwitchConfirm(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const userId = await requireUserId(ctx);
  if (!userId) {
    await ctx.answerCallbackQuery();
    return;
  }

  try {
    await saveHomeLocationForUser(userId, homeLocationForMarket(DEFAULT_MARKET));
  } catch (err) {
    console.warn("[city-switch] save failed:", (err as Error).message);
    await ctx.answerCallbackQuery();
    await ctx.reply(t(lang, "citySwitchFailed"));
    return;
  }

  await ctx.answerCallbackQuery();
  // Drop the confirm keyboard so the card can't be tapped a second time.
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply(t(lang, "citySwitchDone"));
}

/** Inline keyboard used by both the menu card and the weekly no-match DM. */
export function buildCitySwitchKeyboard(lang: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "citySwitchConfirm"), "menu:city:switch")
    .primary()
    .row()
    .text(t(lang, "menuBack"), "menu:back");
}

async function requireUserId(ctx: BotContext): Promise<string | null> {
  const from = ctx.from;
  if (!from) return null;
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from.id) },
    select: { id: true },
  });
  return user?.id ?? null;
}
