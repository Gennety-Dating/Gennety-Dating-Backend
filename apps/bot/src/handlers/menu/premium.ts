import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { env } from "../../config.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";
import { getPremiumState, formatPremiumUntil } from "../../services/premium.js";

/**
 * Render the Gennety Premium hub (PRODUCT_SPEC §Premium): benefits + price when
 * inactive, or an "active until …" note when subscribed, with a `web_app` button
 * into the Premium Mini App (which mints the recurring Telegram Stars invoice via
 * `WebApp.openInvoice`). Gated by `PREMIUM_FEATURE_ENABLED` — the menu only shows
 * the entry when the flag is on, and this handler double-checks. As with the
 * other hubs, the `web_app` button is omitted when `WEBAPP_URL` isn't a real
 * HTTPS host (dev without a tunnel), so the copy still renders.
 */
export async function handlePremiumHub(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  if (!env.PREMIUM_FEATURE_ENABLED) return;
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, theme: true },
  });
  const theme = user?.theme ?? "dark";
  const state = user
    ? await getPremiumState(user.id)
    : { active: false, premiumUntil: null, premiumSince: null, provider: null, autoRenew: false };

  const keyboard = new InlineKeyboard();
  const url = buildMiniAppUrl("premium", { lang, theme });
  if (url.startsWith("https://")) {
    keyboard.webApp(t(lang, "premiumSubscribeCta", { price: env.PREMIUM_PRICE_USD_DISPLAY }), url).row();
  }
  keyboard.text(t(lang, "menuBack"), "menu:back");

  const body = state.active
    ? `${t(lang, "premiumHubActiveNote", { date: formatPremiumUntil(state.premiumUntil, lang) })}\n\n${t(lang, "premiumManageNote")}`
    : `${t(lang, "premiumHubBody", { price: env.PREMIUM_PRICE_USD_DISPLAY })}\n\n${t(lang, "premiumManageNote")}`;

  await ctx.reply(body, { parse_mode: "Markdown", reply_markup: keyboard });
}
