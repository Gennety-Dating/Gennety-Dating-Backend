import { Composer } from "grammy";
import type { BotContext } from "../session.js";
import { t } from "@gennety/shared";
import { handleConsent } from "./onboarding/consent.js";
import { handleLanguageSelection } from "./onboarding/language.js";
import { handleConversational } from "./onboarding/conversational.js";
import { menuRouter } from "./menu/router.js";

const router = new Composer<BotContext>();

// Completed users → delegate to the post-onboarding menu router.
router.use(async (ctx, next) => {
  if (ctx.session.onboardingStep === "completed") {
    await menuRouter.middleware()(ctx, next);
    return;
  }

  // Non-completed user tapped a menu/match/date callback → polite rejection.
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith("menu:")) {
    await ctx.answerCallbackQuery();
    await ctx.reply(t(ctx.session.language, "finishOnboardingFirst"));
    return;
  }

  await next();
});

router.on(["message", "callback_query:data"], async (ctx) => {
  const step = ctx.session.onboardingStep;

  switch (step) {
    case "consent":
      await handleConsent(ctx);
      break;
    case "language":
      await handleLanguageSelection(ctx);
      break;
    case "conversational":
      await handleConversational(ctx);
      break;
    default:
      break;
  }
});

export { router };
