import { Composer } from "grammy";
import type { BotContext } from "../../session.js";
import { handleEmergencyStart, handleEmergencyReason } from "./emergency.js";
import { handleFeedbackVoiceStart, handleFeedbackVoiceText } from "./feedback.js";

/**
 * Date-lifecycle router (Phase 4) — handles:
 *   - `emerg:start:*`  callback → emergency cancellation
 *   - `feedback:voice:*` callback → opt into the voice-note feedback path
 *   - Free-text in `awaiting_emergency_reason` or `awaiting_feedback` state
 *
 * The post-date feedback Mini App posts directly to `/v1/feedback/post-date`
 * (signed by Telegram initData) and never enters this router; only the voice
 * fallback flows through Telegram updates.
 *
 * Registered AFTER the matching router in `bot.ts` but BEFORE the menu
 * router so date callbacks are resolved first.
 */
export const dateRouter = new Composer<BotContext>();

dateRouter.use(async (ctx, next) => {
  // Only active for completed-onboarding users.
  if (ctx.session.onboardingStep !== "completed") {
    await next();
    return;
  }

  const data = ctx.callbackQuery?.data;

  // Emergency cancellation button
  if (data?.startsWith("emerg:start:")) {
    await handleEmergencyStart(ctx);
    return;
  }

  // Voice-feedback opt-in
  if (data?.startsWith("feedback:voice:")) {
    await handleFeedbackVoiceStart(ctx);
    return;
  }

  // Free-text: emergency reason
  if (ctx.session.matchFlow === "awaiting_emergency_reason" && ctx.message?.text) {
    await handleEmergencyReason(ctx);
    return;
  }

  // Free-text or transcribed voice: feedback (shared with the form pipeline)
  if (ctx.session.matchFlow === "awaiting_feedback" && ctx.message?.text) {
    await handleFeedbackVoiceText(ctx);
    return;
  }

  await next();
});
