import { Bot } from "grammy";
import type { BotContext } from "./session.js";
import { sessionMiddleware } from "./session.js";
import { installApiLimits } from "./api-limits.js";
import { installBotBlockedObserver, clearBotBlocked } from "./services/bot-blocked.js";
import { notifyFounderHandlerError } from "./services/founder-notify.js";
import { installStaleCallbackAnswers } from "./services/callback-answers.js";
import { sequentializeByChat } from "./chat-queue.js";
import { botRateLimit } from "./bot-rate-limit.js";
import { start } from "./handlers/start.js";
import { handlePreCheckout, handleSuccessfulPayment } from "./handlers/payments.js";
import { router } from "./handlers/router.js";
import { matchingRouter } from "./handlers/matching/router.js";
import { dateRouter } from "./handlers/date/router.js";
import { profilerRouter } from "./handlers/profiler/router.js";
import { voiceHandler } from "./handlers/voice.js";
import { interactionRecorder } from "./handlers/interaction-recorder.js";
import { outboundRecorder } from "./services/outbound-recorder.js";
import { invalidatePendingAccountAction } from "./handlers/menu/account-action.js";
import { closeAbandonedMediaManager } from "./handlers/menu/edit-profile.js";
import {
  releaseMatchFlowClaim,
  updateReleasesMatchFlowClaim,
} from "./services/match-flow-claim.js";
import { releaseStaleMenuClaim } from "./services/menu-text-claim.js";

function isPendingAccountActionCallback(data: string | undefined): boolean {
  return Boolean(
    data?.startsWith("menu:settings:freeze:") ||
      data?.startsWith("menu:settings:delete:proceed:") ||
      data?.startsWith("menu:settings:delete:yes:"),
  );
}

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Bot API limits — rate throttling and 429 replay. See api-limits.ts.
  //
  // Installed BEFORE the recorder because grammY composes transformers back to
  // front: whatever is installed last ends up outermost. The recorder has to be
  // the outer one, or a replayed 429 would write the same message into the chat
  // timeline twice — one send the user made would read as two.
  installApiLimits(bot.api);

  // Remember terminal 403s. Installed here rather than at the ~40 send sites
  // because that is where the refusal actually arrives, and almost all of them
  // swallow their own errors on purpose. See services/bot-blocked.ts.
  installBotBlockedObserver(bot.api);

  // A callback answer that arrived too late is not an error worth telling
  // anyone about — see services/callback-answers.ts.
  installStaleCallbackAnswers(bot.api);

  // Chat timeline — outbound half. Installed on the Api itself rather than as
  // middleware, because most of what a user sees is sent OUTSIDE a handler
  // (cron workers, the date lifecycle, Mini App routes) and all of it goes
  // through this one `Api`. See services/outbound-recorder.ts.
  bot.api.config.use(outboundRecorder);

  // An update FROM a chat is proof the door is open — better proof than a
  // successful send, because it came from the person. Placed at the very top so
  // it also covers the payment handlers below, which terminate the update.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== undefined) void clearBotBlocked(BigInt(ctx.from.id));
    await next();
  });

  // Middleware chain
  bot.use(sequentializeByChat());

  // Telegram Stars (XTR) payments — registered BEFORE session + rate-limit so
  // the chat-less `pre_checkout_query` never hits the session middleware (which
  // throws "session key is undefined" for an update with no chat) and so the
  // pre-checkout is answered inside Telegram's 10s window ahead of any heavy
  // middleware. Both handlers are self-contained (no `ctx.session`), settle via
  // `successful_payment` (the trust boundary), and terminate the update.
  bot.on("pre_checkout_query", handlePreCheckout);
  bot.on("message:successful_payment", handleSuccessfulPayment);

  bot.use(sessionMiddleware());

  // Destructive confirmations are intentionally single-use and bound to the
  // exact menu message. Any navigation, free text, command, or unrelated
  // callback abandons the confirmation before another router can consume the
  // update. Keeping this at the top of the post-session chain closes paths
  // such as /start, matching callbacks, date actions, and profiler answers.
  bot.use(async (ctx, next) => {
    if (
      ctx.session.pendingAccountAction &&
      !isPendingAccountActionCallback(ctx.callbackQuery?.data)
    ) {
      await invalidatePendingAccountAction(ctx);
    }
    // Same rule, applied to the three flows that read the next plain message as
    // an answer (report details, emergency reason, post-date feedback): a tap on
    // anything that isn't one of that question's own buttons — or a command —
    // means the user moved on, so the question stops owning the chat. Plain text
    // is deliberately not a release; that IS the answer, and its deadline bounds
    // it. See services/match-flow-claim.ts.
    if (
      updateReleasesMatchFlowClaim(ctx.session, {
        callbackData: ctx.callbackQuery?.data,
        text: ctx.message?.text,
      })
    ) {
      releaseMatchFlowClaim(ctx.session);
    }
    // The menu twin, released here for a reason the match-flow one does not
    // need: the menu router is mounted AFTER the Profiler router, and the
    // Profiler reads `menuState` to decide whether the chat is idle enough to
    // record an answer. Releasing downstream meant an expired `edit_bio` claim
    // was still set when the Profiler looked — it refused the answer AND closed
    // the answer window, then the menu router released the claim and gave the
    // text to the agent. See services/menu-text-claim.ts.
    releaseStaleMenuClaim(ctx.session, {
      callbackData: ctx.callbackQuery?.data,
      text: ctx.message?.text,
    });
    // The photo / video managers claim the chat too, and theirs was unbounded:
    // an open manager both starved the Profiler (it reads `menuState`) and ate
    // every plain message as "send me photos", so tapping "My photos" once and
    // walking away left a bot that never answered again. Closing runs here for
    // the same ordering reason, and does the full close — cards retired — so it
    // leaves no dead 🗑 buttons behind.
    await closeAbandonedMediaManager(ctx);
    await next();
  });

  // Anti-spam guard — meters text/voice per user (flood + daily token budget)
  // before any handler runs. Needs `ctx.session.language`; never throttles
  // inline-button callbacks. See bot-rate-limit.ts.
  bot.use(botRateLimit);

  // Chat timeline — inbound half. Records what the user did (typed, tapped,
  // sent) before any handler consumes it, so a button tap is remembered by its
  // own visible label rather than only as raw callback data. Placed after the
  // rate limiter so throttled floods are not recorded, and before `start` so
  // /start is. See handlers/interaction-recorder.ts.
  bot.use(interactionRecorder);

  // /start command — entry point & resume
  bot.use(start);

  // Voice notes → Whisper → transcript injected as text, then fall through.
  // Must run before the FSM/menu routers, both of which read `ctx.message.text`.
  bot.use(voiceHandler);

  // Matching / scheduling flow (only active for completed users)
  bot.use(matchingRouter);

  // Date lifecycle flow — emergency cancellation & feedback (Phase 4)
  bot.use(dateRouter);

  // Profiler — capture answers/skips to proactive Profiler questions (Phase 1b).
  // After date flows (they win) but before the menu agent (so a pending
  // question's answer isn't swallowed by free-text menu handling).
  bot.use(profilerRouter);

  // FSM router — dispatches to onboarding step handlers + menu
  bot.use(router);

  // Error handler
  bot.catch(async (err) => {
    console.error("Bot error:", err);
    // Not only the log. One bad update is noise; the same exception firing for
    // everybody after a deploy is an outage, and the two are indistinguishable
    // from inside a `console.error` on a droplet nobody is watching. The
    // notifier folds a storm into one message per quarter hour.
    const detail = err.error instanceof Error ? err.error.message : String(err.error);
    void notifyFounderHandlerError(`${err.ctx.update.update_id}: ${detail}`);
    try {
      await err.ctx.reply("Something went wrong. Please try again or type /menu.");
    } catch {
      // Reply itself failed — nothing more we can do.
    }
  });

  return bot;
}
