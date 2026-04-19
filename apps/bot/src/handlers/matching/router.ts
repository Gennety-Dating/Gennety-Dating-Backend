import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import type { BotContext } from "../../session.js";
import { handleMatchDecision } from "./decision.js";
import { handleSchedulePick, handleCalendarWebAppData } from "./scheduler.js";
import { handleReportOpen, handleReportText } from "./report.js";
import { handleVenueLocation, handleVenueVibe } from "./venue-negotiation.js";

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

  // Match callbacks: Accept / Decline
  if (data?.startsWith("match:accept:") || data?.startsWith("match:decline:")) {
    await handleMatchDecision(ctx);
    return;
  }

  // Scheduling callbacks: iteration 1/2 slot picks
  if (data?.startsWith("sched:pick:")) {
    await handleSchedulePick(ctx);
    return;
  }

  // Report callbacks: open the report dialogue from the post-match card
  if (data?.startsWith("report:open:")) {
    await handleReportOpen(ctx);
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
  if (ctx.message?.location || ctx.message?.text) {
    const fromId = ctx.from?.id;
    if (fromId) {
      const user = await prisma.user.findUnique({
        where: { telegramId: BigInt(fromId) },
        select: { id: true },
      });
      if (user) {
        const activeVenueMatch = await prisma.match.findFirst({
          where: {
            status: "negotiating_venue",
            OR: [{ userAId: user.id }, { userBId: user.id }],
          },
          select: { id: true },
        });
        if (activeVenueMatch) {
          if (ctx.message.location) {
            await handleVenueLocation(ctx);
            return;
          }
          if (ctx.message.text && !ctx.message.text.startsWith("/")) {
            await handleVenueVibe(ctx);
            return;
          }
        }
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

  await next();
});
