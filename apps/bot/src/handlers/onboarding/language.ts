import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { runAgentTurn } from "../../services/onboarding-agent.js";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";

const VALID_LANGUAGES = new Set<Language>(["en", "ru", "uk"]);

export async function handleLanguageSelection(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("lang:")) return;

  const lang = data.slice(5) as Language;
  if (!VALID_LANGUAGES.has(lang)) return;

  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);

  // Update session and DB — transition to conversational agent
  ctx.session.language = lang;
  ctx.session.onboardingStep = "conversational";

  await prisma.user.update({
    where: { telegramId },
    data: {
      language: lang,
      onboardingStep: "conversational",
      ...onboardingActivityPatch(),
    },
  });

  // Kick off the conversational agent with an intro turn
  const result = await runAgentTurn(
    telegramId,
    `[User selected language: ${lang}. Begin onboarding conversation.]`,
  );

  await ctx.reply(result.reply, { parse_mode: "Markdown" });
}
