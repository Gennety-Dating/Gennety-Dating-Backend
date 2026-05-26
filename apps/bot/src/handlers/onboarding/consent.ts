import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { onboardingActivityPatch } from "../../workers/re-engagement-schedule.js";
import { buildLanguageKeyboard } from "../language-keyboard.js";

const PRIVACY_POLICY_URL = "https://gennety.com/privacy";

/** Send the consent prompt with a policy link and "I Agree" button. */
export async function sendConsentPrompt(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;

  const keyboard = new InlineKeyboard()
    .url(
      "Privacy Policy",
      PRIVACY_POLICY_URL,
    )
    .row()
    .text(t(lang, "consentAgree"), "consent:agree");

  await ctx.reply(t(lang, "consentMessage"), {
    reply_markup: keyboard,
  });
}

/** Handle all updates while the user is on the consent step. */
export async function handleConsent(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;

  if (data !== "consent:agree") {
    // Any other input — re-show the consent prompt
    await sendConsentPrompt(ctx);
    return;
  }

  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);

  // Record consent and advance to language step
  ctx.session.onboardingStep = "language";

  await prisma.user.update({
    where: { telegramId },
    data: {
      hasConsented: true,
      consentedAt: new Date(),
      termsAccepted: true,
      termsAcceptedAt: new Date(),
      onboardingStep: "language",
      ...onboardingActivityPatch(),
    },
  });

  // Immediately show the language picker
  await ctx.reply(t(ctx.session.language, "chooseLanguage"), {
    reply_markup: buildLanguageKeyboard("lang"),
  });
}
