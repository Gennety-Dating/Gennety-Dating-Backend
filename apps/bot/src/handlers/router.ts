import { Composer } from "grammy";
import type { BotContext } from "../session.js";
import { t } from "@gennety/shared";
import { prisma } from "@gennety/db";
import { sendOnboardingEntry } from "./onboarding/mini-app-entry.js";
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
  sendVerificationGateNotice,
} from "./onboarding/verification.js";
import {
  VERIFY_PHOTOS_CALLBACK,
  VERIFY_PHOTOS_CLEAR_CALLBACK,
} from "../services/verification-keyboard.js";
import {
  handleVerifyPhotosClear,
  handleVerifyPhotosRedo,
} from "./menu/edit-profile.js";
import {
  isVerificationGateAllowed,
  isVerificationGated,
} from "../services/verification-gate.js";
import { RADAR_SKIP_CALLBACK, handleRadarSkip } from "./onboarding/type-radar.js";
import { voicePromptRouter } from "./onboarding/voice-prompt.js";
import {
  ONBOARDING_PHOTO_BACK_CALLBACK,
  ONBOARDING_PHOTO_DELETE_CALLBACK,
  handleOnboardingPhotoBack,
  handleOnboardingPhotoDelete,
} from "./onboarding/photo-editor.js";
import { menuRouter } from "./menu/router.js";
import { DEMO_MODE_ENABLED } from "../demo/config.js";
import { demoRouter } from "../demo/commands.js";

const router = new Composer<BotContext>();

// Demo mode (DEMO_MODE.md): `/restart` and the post-decline "show me that
// profile again" button. Mounted first so they work from any state — a demo
// visitor stuck behind the verification gate or mid-negotiation must always
// have a way out. Not mounted at all in production.
if (DEMO_MODE_ENABLED) {
  router.use(demoRouter);
}

router.use(async (ctx, next) => {
  if (!ctx.from?.id) {
    await next();
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { onboardingStep: true, language: true, status: true },
  });

  if (user) {
    ctx.session.onboardingStep = user.onboardingStep as typeof ctx.session.onboardingStep;
    if (user.language) {
      ctx.session.language = user.language as typeof ctx.session.language;
    }
  }

  // Verification gate. `onboardingStep = completed` with `status` still
  // `onboarding` means the profile is done but Persona liveness is not — and
  // since Registration v2 made verification mandatory, that user is NOT in the
  // app yet. Without this the next middleware happily hands them the full menu
  // (profile, pause, tickets, premium, referral, menu agent) even though the
  // matchmaker has not started for them.
  //
  // Only the two actions that can actually clear the gate pass through:
  // verification itself and re-uploading photos (see verification-gate.ts).
  if (isVerificationGated(user) && !isVerificationGateAllowed(ctx) && ctx.chat) {
    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
    await sendVerificationGateNotice(
      ctx.api,
      ctx.chat.id,
      BigInt(ctx.from.id),
      ctx.session.language,
      { locked: true },
    );
    return;
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
  // The way back to the photo manager from any verification prompt. Routed
  // here (not in the menu router) so it works while the app is gate-locked,
  // and for an already-`active` user whose photo edit landed `rejected`.
  if (ctx.callbackQuery?.data === VERIFY_PHOTOS_CALLBACK) {
    await handleVerifyPhotosRedo(ctx);
    return;
  }
  if (ctx.callbackQuery?.data === VERIFY_PHOTOS_CLEAR_CALLBACK) {
    await handleVerifyPhotosClear(ctx);
    return;
  }
  // Type Radar Skip fires mid-onboarding (onboardingStep is still
  // `conversational`), so it must be caught before the completed-user menu
  // delegation below. No-op unless TYPE_RADAR_ENABLED (the button is never sent).
  if (ctx.callbackQuery?.data === RADAR_SKIP_CALLBACK) {
    await handleRadarSkip(ctx);
    return;
  }
  // Onboarding photo editor (PRODUCT_SPEC §1.3). It carries its OWN `onb:ph:*`
  // prefix rather than reusing the menu manager's `menu:edit:photos:*` — those
  // are refused mid-onboarding by the guard below, and the two surfaces differ
  // (no delete floor, no ➕, back to the upload stage instead of a menu).
  if (ctx.callbackQuery?.data === ONBOARDING_PHOTO_DELETE_CALLBACK) {
    await handleOnboardingPhotoDelete(ctx);
    return;
  }
  if (ctx.callbackQuery?.data === ONBOARDING_PHOTO_BACK_CALLBACK) {
    await handleOnboardingPhotoBack(ctx);
    return;
  }
  await next();
});

// The onboarding voice-prompt step (VOICE_PROMPT_PRODUCT_SPEC.md §4.1).
//
// Mounted here, ahead of the completed-user delegation, for the same reason
// the Type Radar Skip is caught above: it fires while `onboardingStep` is
// still `conversational`. It also has to sit ahead of the step switch at the
// bottom, which would otherwise hand the recording to `handleConversational` —
// and that path reads `ctx.message.text`, which is deliberately absent here
// because `voiceHandler` was told not to transcribe it.
//
// Both of its handlers no-op unless the step is genuinely waiting, so an
// ordinary voice note anywhere else in onboarding falls straight through.
router.use(voicePromptRouter);

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
    // Consent and language are Mini App screens, not chat screens. Whatever
    // the user did to get here — typed a message, tapped a stale button from a
    // previous account — the answer is the one current entry point, so the
    // chat can never start a second, divergent onboarding (PRODUCT_SPEC §1.1).
    case "consent":
    case "language":
      await sendOnboardingEntry(ctx);
      break;
    case "conversational":
      await handleConversational(ctx);
      break;
    default:
      break;
  }
});

export { router };
