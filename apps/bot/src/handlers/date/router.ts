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
  handleAttendanceAnswer,
  handleAttendanceOutcome,
  handleAttendanceText,
} from "./attendance.js";
import {
  handleCoordMethod,
  handleCoordConsent,
  handleCoordEnter,
  handleCoordExit,
  handleProxyRelay,
} from "./coordination.js";
import { handleDateCardShare } from "./date-card.js";
import {
  matchFlowClaimIsLive,
  releaseMatchFlowClaim,
} from "../../services/match-flow-claim.js";

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

  // "Did you actually meet?" — asked at T+24h before the feedback form.
  if (data?.startsWith("attend:yes:") || data?.startsWith("attend:no:")) {
    await handleAttendanceAnswer(ctx);
    return;
  }
  if (data?.startsWith("attend:out:")) {
    await handleAttendanceOutcome(ctx);
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

  // Free-text: emergency reason. Gated on the claim still being live — this is
  // the one text state that DESTROYS something (a `scheduled` date, quoted
  // verbatim to the partner, irreversible). An abandoned "yes, cancel" used to
  // leave the claim open indefinitely, so the user's next unrelated message
  // cancelled their date for them. Past the deadline it falls through to the
  // agent, which can still offer the real cancel card.
  if (ctx.session.matchFlow === "awaiting_emergency_reason" && ctx.message?.text) {
    if (matchFlowClaimIsLive(ctx.session, "awaiting_emergency_reason")) {
      await handleEmergencyReason(ctx);
      return;
    }
    releaseMatchFlowClaim(ctx.session);
  }

  // Free-text: the attendance question. Buttons are the primary path, but the
  // question is asked in ordinary prose and prose invites a typed reply — so a
  // short "да, встретились" is captured here rather than falling through to
  // the concierge, which would lose the one fact the question exists for.
  // Only an UNAMBIGUOUS short answer is consumed; anything else falls through
  // deliberately, and the agent can see the open question in the timeline.
  if (ctx.session.matchFlow === "awaiting_attendance" && ctx.message?.text) {
    if (matchFlowClaimIsLive(ctx.session, "awaiting_attendance")) {
      if (await handleAttendanceText(ctx)) return;
    } else {
      releaseMatchFlowClaim(ctx.session);
    }
  }

  // Free-text or transcribed voice: feedback (shared with the form pipeline).
  // Same bound, generous window — the prompt lands a day after the date and
  // invites a later reply.
  if (ctx.session.matchFlow === "awaiting_feedback" && ctx.message?.text) {
    if (matchFlowClaimIsLive(ctx.session, "awaiting_feedback")) {
      await handleFeedbackVoiceText(ctx);
      return;
    }
    releaseMatchFlowClaim(ctx.session);
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
