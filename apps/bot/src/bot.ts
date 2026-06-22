import { Bot } from "grammy";
import type { BotContext } from "./session.js";
import { sessionMiddleware } from "./session.js";
import { sequentializeByChat } from "./chat-queue.js";
import { botRateLimit } from "./bot-rate-limit.js";
import { start } from "./handlers/start.js";
import { router } from "./handlers/router.js";
import { matchingRouter } from "./handlers/matching/router.js";
import { dateRouter } from "./handlers/date/router.js";
import { profilerRouter } from "./handlers/profiler/router.js";
import { voiceHandler } from "./handlers/voice.js";

export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  // Middleware chain
  bot.use(sequentializeByChat());
  bot.use(sessionMiddleware());

  // Anti-spam guard — meters text/voice per user (flood + daily token budget)
  // before any handler runs. Needs `ctx.session.language`; never throttles
  // inline-button callbacks. See bot-rate-limit.ts.
  bot.use(botRateLimit);

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
    try {
      await err.ctx.reply("Something went wrong. Please try again or type /menu.");
    } catch {
      // Reply itself failed — nothing more we can do.
    }
  });

  return bot;
}
