import type { BotContext } from "../../session.js";
import { buildLanguageKeyboard } from "../language-keyboard.js";

/** Send the appropriate prompt for the current onboarding step */
export async function sendStepPrompt(ctx: BotContext): Promise<void> {
  const step = ctx.session.onboardingStep;

  switch (step) {
    case "language": {
      await ctx.reply("👋 Pick your language / Выбери язык / Обери мову / Sprache wählen / Wybierz język:", {
        reply_markup: buildLanguageKeyboard("lang"),
      });
      break;
    }
    default:
      break;
  }
}
