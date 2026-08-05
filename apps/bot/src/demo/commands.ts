import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";

import type { BotContext } from "../session.js";
import { deleteUserAccount } from "../services/account-deletion.js";
import { DEMO_MODE_ENABLED } from "./config.js";
import { clearDemoMatches, forgetDemoVisitor, restartDemoPitch } from "./driver.js";
import { demoText } from "./script.js";

/**
 * The two affordances that exist only in demo mode.
 *
 * Registered ahead of every other handler so they work from any state — a demo
 * visitor who has wandered into a Mini App flow, a stalled negotiation or the
 * verification gate must always be able to get out. Both are inert when
 * `DEMO_MODE_ENABLED` is false: the composer below is only mounted by
 * `handlers/router.ts` under that flag, and each handler re-checks it, so a
 * stray callback in production can never reach this code.
 */

export const DEMO_CONTINUE_CALLBACK = "demo:continue";

export const demoRouter = new Composer<BotContext>();

/**
 * `/restart` — wipe the demo account and start over.
 *
 * Deliberately the real GDPR deletion (`deleteUserAccount`), not a bespoke
 * reset: it is the only code that knows every table, storage object and
 * founder-report snapshot a user touches, and a demo-specific "reset" would
 * drift from it the first time a column is added. The visitor's next `/start`
 * creates a fresh row exactly as a new user's would.
 */
demoRouter.command("restart", async (ctx) => {
  if (!DEMO_MODE_ENABLED) return;
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true },
  });

  // Tell them BEFORE the row disappears — the copy needs their language, and
  // after deletion there is nothing to read it from.
  const language: Language | null = user?.language ?? null;
  await ctx.reply(demoText("restarted", language));

  if (!user) return;
  forgetDemoVisitor(user.id);
  // Matches with the puppet are deleted rather than cancelled: the visitor is
  // about to be a brand-new person, and a terminal row would make the lifetime
  // pair ban refuse to pair them with the same puppet again.
  await clearDemoMatches(user.id);
  await deleteUserAccount(user.id, ctx.api);
});

/**
 * "Show me that profile again" after the visitor passed on the match.
 *
 * A pass is irreversible in the product and the demo shows that honestly — the
 * real decline card, the real reason prompt, the real "this pair will never be
 * shown again" consequence. Only then does the demo offer its own way back.
 */
demoRouter.callbackQuery(DEMO_CONTINUE_CALLBACK, async (ctx) => {
  if (!DEMO_MODE_ENABLED) return;
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true, status: true },
  });
  if (!user || user.status !== "active") return;

  // Retire the button so a second tap can't queue a second pitch.
  await ctx.editMessageReplyMarkup().catch(() => undefined);

  await restartDemoPitch(ctx.api, user.id, BigInt(telegramId), user.language);
});
