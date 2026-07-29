import { Composer } from "grammy";
import type { BotContext } from "../../session.js";
import {
  handleMatchDecision,
  promptDeclineConfirm,
  handleDeclineBack,
  handleCountdownTap,
} from "./decision.js";
import { handleProposalTextReply } from "./decision-text.js";
import { handleDeclineReasonCallback } from "./decline-feedback.js";
import { handleSchedulePick, handleCalendarWebAppData } from "./scheduler.js";
import {
  handleReportOpen,
  handleReportCancel,
  handleReportCategory,
  handleReportSkip,
  handleReportText,
} from "./report.js";
import {
  handleVenueLocation,
  handleVenueVibe,
  resolveVenueRoutingState,
} from "./venue-negotiation.js";
import { handleVenuePayDecline } from "./venue-change.js";
import {
  handleStallAskCancel,
  handleStallCancelBack,
  handleStallCancelConfirm,
  handleStallStillOn,
} from "./stall-checkin.js";
import {
  STALL_ASK_CANCEL_PREFIX,
  STALL_CANCEL_BACK_PREFIX,
  STALL_CANCEL_CONFIRM_PREFIX,
  STALL_OK_PREFIX,
} from "../../services/match-stall.js";
import { handleRematchBuyCallback, REMATCH_BUY_CALLBACK } from "./rematch.js";

/**
 * Matching router — activates only for users who have already completed
 * onboarding. Dispatches callbacks that belong to the matching flow and
 * consumes specific message types (free-form rejection reasons and
 * `web_app_data` from the Calendar Mini App).
 *
 * Registered AFTER the onboarding router in `bot.ts` but BEFORE the menu
 * router so match callbacks are resolved first; anything the matching
 * router doesn't claim falls through to the menu.
 */
export const matchingRouter = new Composer<BotContext>();

matchingRouter.use(async (ctx, next) => {
  if (ctx.session.onboardingStep !== "completed") {
    await next();
    return;
  }

  const data = ctx.callbackQuery?.data;

  // Decline feedback quick-reason callbacks.
  if (data?.startsWith("mdr:") || data?.startsWith("match:decline_reason:")) {
    await handleDeclineReasonCallback(ctx);
    return;
  }

  // Match Accept commits immediately.
  if (data?.startsWith("match:accept:")) {
    await handleMatchDecision(ctx);
    return;
  }
  // Match Pass is guarded — the first tap opens a confirmation card (a pass is
  // irreversible: the pair is never shown again), it does NOT commit.
  if (data?.startsWith("match:decline:")) {
    await promptDeclineConfirm(ctx);
    return;
  }
  // Confirmed Pass commit (red "Yes, pass" on the confirmation card).
  if (data?.startsWith("match:do:decline:")) {
    await handleMatchDecision(ctx);
    return;
  }
  // Backed out of the Pass confirmation card — no state change.
  if (data?.startsWith("match:keep:")) {
    await handleDeclineBack(ctx);
    return;
  }
  // Tap on the live reply-deadline countdown button — informational toast.
  if (data?.startsWith("match:countdown:")) {
    await handleCountdownTap(ctx);
    return;
  }

  // Scheduling callbacks: iteration 1/2 slot picks
  if (data?.startsWith("sched:pick:")) {
    await handleSchedulePick(ctx);
    return;
  }

  // Rematch offer tap → mint the Stars invoice (REMATCH_PRODUCT_SPEC.md). The
  // purchase itself settles in the `successful_payment` trust boundary.
  if (data === REMATCH_BUY_CALLBACK) {
    await handleRematchBuyCallback(ctx);
    return;
  }

  // Venue-change v2: his single, final "not this time" on covering the change
  // (wish-card inline button). Payment itself rides Stars invoice links.
  if (data?.startsWith("vchg:paydecline:")) {
    await handleVenuePayDecline(ctx);
    return;
  }

  // Planning-stage stall check-in (§3.5c). The four prefixes don't nest, so
  // dispatch order here carries no hidden meaning.
  if (data?.startsWith(STALL_OK_PREFIX)) {
    await handleStallStillOn(ctx);
    return;
  }
  if (data?.startsWith(STALL_ASK_CANCEL_PREFIX)) {
    await handleStallAskCancel(ctx);
    return;
  }
  if (data?.startsWith(STALL_CANCEL_CONFIRM_PREFIX)) {
    await handleStallCancelConfirm(ctx);
    return;
  }
  if (data?.startsWith(STALL_CANCEL_BACK_PREFIX)) {
    await handleStallCancelBack(ctx);
    return;
  }

  // Report callbacks: open the report dialogue from the post-match card
  if (data?.startsWith("report:open:")) {
    await handleReportOpen(ctx);
    return;
  }
  if (data?.startsWith("rc:") || data?.startsWith("report:category:")) {
    await handleReportCategory(ctx);
    return;
  }
  if (data?.startsWith("rs:") || data?.startsWith("report:skip:")) {
    await handleReportSkip(ctx);
    return;
  }
  // Backed out of the report category menu (accidental Report tap) — no report filed.
  if (data?.startsWith("rb:")) {
    await handleReportCancel(ctx);
    return;
  }

  // Mini App data (iteration 3 calendar submission)
  if (ctx.message?.web_app_data) {
    await handleCalendarWebAppData(ctx);
    return;
  }

  // Concierge venue flow: `message:location` always goes through the
  // venue handler when the sender has an in-flight `negotiating_venue`
  // match. Same for plain text when in that state. We check the DB
  // directly (rather than a session flag) because matches are shared
  // state across devices and sessions aren't.
  //
  // The text branch is scoped to a side that still OWES an answer. The venue
  // stage used to claim every plain message for as long as the match sat in
  // `negotiating_venue` — including from someone who had already confirmed
  // their departure point and vibe and was only waiting on their partner. For
  // them the venue handler has nothing to collect, so it answered the fixed
  // "mark where you're setting off from" card with the Mini App button; a
  // question ("а что дальше?") got a prompt they had already completed, which
  // reads as the flow having reset, and the question itself never reached the
  // concierge agent. A submitted side now falls through to the agent, which
  // sees the venue stage and who is still pending (`describeActiveMatch`).
  // Nothing was ever actually lost — the branch only replied, it wrote no
  // state — but the chat said otherwise.
  if (ctx.message?.location || ctx.message?.text) {
    const fromId = ctx.from?.id;
    if (fromId) {
      const venue = await resolveVenueRoutingState(BigInt(fromId));
      if (venue) {
        if (ctx.message.location) {
          await handleVenueLocation(ctx);
          return;
        }
        if (ctx.message.text && !ctx.message.text.startsWith("/") && !venue.submitted) {
          await handleVenueVibe(ctx);
          return;
        }
        // A submitted side's text can only be a question → fall through.
      }
    }
  }

  // Rejection reasons are now collected conversationally by the menu agent
  // (it sees a pending-rejection hint in the system prompt and calls
  // `record_rejection_feedback`). No router branch needed.

  // Free-form report body after tapping 🚨 Report on the match card
  if (
    ctx.session.matchFlow === "awaiting_report_details" &&
    ctx.message?.text
  ) {
    await handleReportText(ctx);
    return;
  }

  // Conversational proposal reply: plain text while a pitch awaits this
  // user's decision → classify yes/no/unsure and surface the mechanical
  // confirmation card. Unrelated messages fall through to the menu agent.
  if (ctx.message?.text && !ctx.callbackQuery) {
    if (await handleProposalTextReply(ctx)) return;
  }

  await next();
});
