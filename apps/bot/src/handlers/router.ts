import { Composer } from "grammy";
import type { BotContext } from "../session.js";
import { t } from "@gennety/shared";
import { prisma } from "@gennety/db";
import { handleConsent } from "./onboarding/consent.js";
import { handleLanguageSelection } from "./onboarding/language.js";
import { handleConversational } from "./onboarding/conversational.js";
import { handlePhoneContact } from "./onboarding/phone.js";
import { env } from "../config.js";
import {
  VERIFY_CHECK_CALLBACK,
  VERIFY_SKIP_CALLBACK,
  VERIFY_SKIP_CONFIRM_CALLBACK,
  handleVerificationCheck,
  handleVerificationSkip,
  handleVerificationSkipConfirm,
} from "./onboarding/verification.js";
import { menuRouter } from "./menu/router.js";

const router = new Composer<BotContext>();

router.use(async (ctx, next) => {
  if (!ctx.from?.id) {
    await next();
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { onboardingStep: true, language: true },
  });

  if (user) {
    ctx.session.onboardingStep = user.onboardingStep as typeof ctx.session.onboardingStep;
    if (user.language) {
      ctx.session.language = user.language as typeof ctx.session.language;
    }
  }

  await next();
});

// Verification "Skip" button must be caught before the menu delegation:
// `finalize_onboarding` sets `onboardingStep='completed'` before the CTA is
// sent, so without this branch the callback would route to the menu and the
// Elo penalty would never apply.
router.use(async (ctx, next) => {
  if (ctx.callbackQuery?.data === VERIFY_SKIP_CALLBACK) {
    await handleVerificationSkip(ctx);
    return;
  }
  if (ctx.callbackQuery?.data === VERIFY_SKIP_CONFIRM_CALLBACK) {
    await handleVerificationSkipConfirm(ctx);
    return;
  }
  if (ctx.callbackQuery?.data === VERIFY_CHECK_CALLBACK) {
    await handleVerificationCheck(ctx);
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

// Registration v2 (general track): phone verification via Telegram contact
// share. A trusted `message.contact` (the user's OWN number) is intercepted
// here, before the step switch, so it isn't treated as onboarding text input.
// The handler does not call next(), so it stops propagation. With
// PHONE_AUTH_ENABLED off the update falls through untouched (pre-fork
// behavior). See handlers/onboarding/phone.ts.
router.on("message:contact", async (ctx, next) => {
  if (!env.PHONE_AUTH_ENABLED) {
    await next();
    return;
  }
  await handlePhoneContact(ctx);
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
