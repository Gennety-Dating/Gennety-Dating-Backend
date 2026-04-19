import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";

/** Send the appropriate prompt for the current onboarding step */
export async function sendStepPrompt(ctx: BotContext): Promise<void> {
  const step = ctx.session.onboardingStep;

  switch (step) {
    case "language": {
      const keyboard = new InlineKeyboard()
        .text("English", "lang:en")
        .text("Русский", "lang:ru")
        .text("Українська", "lang:uk");
      await ctx.reply("👋 Pick your language / Выбери язык / Обери мову:", {
        reply_markup: keyboard,
      });
      break;
    }
    default:
      break;
  }
}
