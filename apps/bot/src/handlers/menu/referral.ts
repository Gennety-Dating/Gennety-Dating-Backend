import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";

/**
 * Referral hub ("Give a date, get a date", §Referral). Opens the referral Mini
 * App (the milestone ladder + one-tap share). Gated by
 * `REFERRAL_FEATURE_ENABLED` (the menu only shows the entry when the flag is
 * on). When `WEBAPP_URL` isn't a real HTTPS host (dev without a tunnel) the
 * web_app button is omitted — a web_app button with a non-HTTPS URL is rejected
 * by Telegram — so the hub copy still shows.
 */
export async function handleReferralHub(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { theme: true },
  });
  const theme = user?.theme ?? "dark";

  const keyboard = new InlineKeyboard();
  const url = buildMiniAppUrl("referral", { lang, theme });
  if (url.startsWith("https://")) {
    keyboard.webApp(t(lang, "referralShareButton"), url).row();
  }
  keyboard.text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(`${t(lang, "referralHubTitle")}\n\n${t(lang, "referralHubTagline")}`, {
    reply_markup: keyboard,
  });
}
