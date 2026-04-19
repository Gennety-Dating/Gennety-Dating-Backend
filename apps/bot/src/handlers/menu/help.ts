import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { t } from "@gennety/shared";

/**
 * Render the static Help / Report card.
 * Per PRODUCT_SPEC: no in-app chat — Help is a static pointer to support channels.
 */
export async function handleHelp(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard().text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(t(lang, "helpBody"), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}
