import { Composer } from "grammy";
import type { BotContext } from "../../session.js";
import {
  handleEmergencyStart,
  handleEmergencyConfirm,
  handleEmergencyAbort,
  handleEmergencyReason,
} from "./emergency.js";
import { handleFeedbackVoiceStart, handleFeedbackVoiceText } from "./feedback.js";
import {
  handleCoordMethod,
  handleCoordConsent,
  handleCoordEnter,
  handleCoordExit,
  handleProxyRelay,
} from "./coordination.js";
import { handleDateCardShare } from "./date-card.js";

/**
 * Date-lifecycle router (Phase 4) — handles:
 *   - `emerg:start:*` / `emerg:confirm:*` / `emerg:abort:*` callbacks →
 *     emergency cancellation (tap → confirm guard → reason)
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

  // Emergency cancellation button → confirmation guard → reason
  if (data?.startsWith("emerg:start:")) {
    await handleEmergencyStart(ctx);
    return;
  }
  if (data?.startsWith("emerg:confirm:")) {
    await handleEmergencyConfirm(ctx);
    return;
  }
  if (data?.startsWith("emerg:abort:")) {
    await handleEmergencyAbort(ctx);
    return;
  }

  // Voice-feedback opt-in
  if (data?.startsWith("feedback:voice:")) {
    await handleFeedbackVoiceStart(ctx);
    return;
  }

  // Share a (face-blurred) copy of the scheduled date card.
  if (data?.startsWith("datecard:share:")) {
    await handleDateCardShare(ctx);
    return;
  }

  // Pre-date coordination callbacks (feature-flagged; inert rows never produce
  // these buttons, so no flag check is needed on the handler side).
  if (data?.startsWith("coord:m:")) {
    await handleCoordMethod(ctx);
    return;
  }
  if (data?.startsWith("coord:approve:") || data?.startsWith("coord:decline:")) {
    await handleCoordConsent(ctx);
    return;
  }
  if (data?.startsWith("coord:enter:")) {
    await handleCoordEnter(ctx);
    return;
  }
  if (data === "coord:exit") {
    await handleCoordExit(ctx);
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

  // Anonymous proxy chat relay (Variant C). Commands (/menu, /start, …) are
  // never relayed — they fall through to normal routing so the user can still
  // operate the bot while a chat window is open. Everything else (text +
  // media) goes to the relay leg, which forwards text and rejects media.
  if (ctx.session.matchFlow === "coordination_chat" && ctx.message) {
    if (ctx.message.text?.startsWith("/")) {
      await next();
      return;
    }
    await handleProxyRelay(ctx);
    return;
  }

  await next();
});
