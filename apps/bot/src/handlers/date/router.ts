import { Composer } from "grammy";
import type { BotContext } from "../../session.js";
import { handleEmergencyStart, handleEmergencyReason } from "./emergency.js";
import { handleFeedbackStart, handleFeedbackText } from "./feedback.js";

/**
 * Date-lifecycle router (Phase 4) — handles:
 *   - `emerg:start:*`  callback → emergency cancellation
 *   - `feedback:start:*` callback → post-date feedback
 *   - Free-text when session is in `awaiting_emergency_reason` or `awaiting_feedback`
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

  // Feedback button
  if (data?.startsWith("feedback:start:")) {
    await handleFeedbackStart(ctx);
    return;
  }

  // Free-text: emergency reason
  if (ctx.session.matchFlow === "awaiting_emergency_reason" && ctx.message?.text) {
    await handleEmergencyReason(ctx);
    return;
  }

  // Free-text: feedback
  if (ctx.session.matchFlow === "awaiting_feedback" && ctx.message?.text) {
    await handleFeedbackText(ctx);
    return;
  }

  await next();
});
