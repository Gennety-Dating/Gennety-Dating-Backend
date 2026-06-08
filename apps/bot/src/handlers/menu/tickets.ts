import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { env } from "../../config.js";
import { getBalance } from "../../services/ticket-wallet.js";

/**
 * Render the "My Tickets" wallet card: current balance + a button into the
 * store Mini App to buy more. Gated by `TICKET_FEATURE_ENABLED` (the menu only
 * shows the entry when the flag is on). When `WEBAPP_URL` isn't a real HTTPS
 * host (dev without a tunnel) the web_app button is omitted — a web_app button
 * with a non-HTTPS URL is rejected by Telegram — so the balance still shows.
 */
export async function handleMyTickets(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  const balance = user ? await getBalance(user.id) : 0;

  const keyboard = new InlineKeyboard();
  if (env.WEBAPP_URL.startsWith("https://")) {
    keyboard.webApp(t(lang, "ticketWalletOpenStore"), `${env.WEBAPP_URL}/tickets.html?lang=${lang}`).row();
  }
  keyboard.text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(t(lang, "ticketWalletText", { balance }), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}
