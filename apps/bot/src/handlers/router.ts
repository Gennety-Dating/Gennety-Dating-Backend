import { Composer } from "grammy";
import type { BotContext } from "../session.js";
import { t } from "@gennety/shared";
import { handleConsent } from "./onboarding/consent.js";
import { handleLanguageSelection } from "./onboarding/language.js";
import { handleConversational } from "./onboarding/conversational.js";
import {
  VERIFY_SKIP_CALLBACK,
  handleVerificationSkip,
} from "./onboarding/verification.js";
import { menuRouter } from "./menu/router.js";

const router = new Composer<BotContext>();

// Verification "Skip" button must be caught before the menu delegation:
// `finalize_onboarding` sets `onboardingStep='completed'` before the CTA is
// sent, so without this branch the callback would route to the menu and the
// Elo penalty would never apply.
router.use(async (ctx, next) => {
  if (ctx.callbackQuery?.data === VERIFY_SKIP_CALLBACK) {
    await handleVerificationSkip(ctx);
    return;
  }
  await next();
});

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
