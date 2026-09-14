import type { BotError } from "grammy";
import type { BotContext } from "./session.js";
import { notifyFounderHandlerError } from "./services/founder-notify.js";

/**
 * The one error handler for Telegram update work.
 *
 * Its own module rather than an inline `bot.catch` callback because it now has
 * two callers: grammY's `bot.catch` (update work that still runs inside the
 * polling loop) and the chat queue's detached work (A13-H9), which nobody
 * awaits and which would otherwise fail into nothing. Both must end in the same
 * log line, the same founder alert and the same reply.
 */
export async function handleBotError(err: BotError<BotContext>): Promise<void> {
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
}
