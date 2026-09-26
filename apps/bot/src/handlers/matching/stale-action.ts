import { t, type TranslationKey } from "@gennety/shared";
import type { BotContext } from "../../session.js";

/** A stale button needs both an immediate answer and a visibly retired card. */
export async function retireStaleCallback(
  ctx: BotContext,
  key: TranslationKey,
): Promise<void> {
  const notice = t(ctx.session.language, key);
  await ctx.answerCallbackQuery({ text: notice, show_alert: true }).catch(() => {});

  const message = ctx.callbackQuery?.message;
  try {
    if (message && "text" in message && typeof message.text === "string") {
      await ctx.editMessageText(`${message.text}\n\n${notice}`, {
        reply_markup: { inline_keyboard: [] },
      });
      return;
    }
    if (message && "caption" in message && typeof message.caption === "string") {
      await ctx.editMessageCaption({
        caption: `${message.caption}\n\n${notice}`.slice(0, 1024),
        reply_markup: { inline_keyboard: [] },
      });
      return;
    }
  } catch {
    // Telegram can refuse edits on old messages. Removing the buttons is still useful.
  }
  await ctx.editMessageReplyMarkup().catch(() => {});
}
