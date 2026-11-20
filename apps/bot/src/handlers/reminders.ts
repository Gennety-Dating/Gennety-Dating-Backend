import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { answerReminder } from "../services/agent-reminders.js";

/**
 * «Сделано» / «Напомни завтра» under a reminder the bot sent (decision
 * 2026-11-20). The buttons go away with the answer; the line it earns is sent
 * once — a second tap only gets the toast.
 */
export const remindersHandler = new Composer<BotContext>();

remindersHandler.callbackQuery(/^rem:(done|tmr):([0-9a-f-]{36})$/, async (ctx) => {
  const [, kind, reminderId] = ctx.match as RegExpMatchArray;
  const language = (ctx.session.language ?? "en") as Language;
  const user = await prisma.user.findUnique({ where: { telegramId: BigInt(ctx.from.id) }, select: { id: true } });
  if (!user) {
    await ctx.answerCallbackQuery();
    return;
  }
  const answer = await answerReminder(user.id, reminderId!, kind === "done" ? "done" : "tomorrow", language);
  if (!answer.ok) {
    await ctx.answerCallbackQuery(answer.error === "snooze-limit" ? { text: t(language, "remindersSnoozeLimit") } : {});
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup().catch(() => undefined);
  if (answer.changed) await ctx.reply(answer.line);
});
