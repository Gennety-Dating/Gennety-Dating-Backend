import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import { DEFAULT_SESSION, type Language } from "@gennety/shared";

import type { BotContext } from "../session.js";
import { deleteUserAccount } from "../services/account-deletion.js";
import { DEMO_MODE_ENABLED } from "./config.js";
import {
  chooseDemoProxy,
  clearDemoMatches,
  explainDemoCoordChoice,
  forgetDemoVisitor,
  restartDemoPitch,
  runDemoAfterDate,
  runDemoPredate,
} from "./driver.js";
import {
  DEMO_AFTER_DATE_CALLBACK,
  DEMO_CONTINUE_CALLBACK,
  DEMO_COORD_PREFIX,
  DEMO_PREDATE_CALLBACK,
  demoText,
  parseDemoCoordChoice,
} from "./script.js";

/**
 * The affordances that exist only in demo mode.
 *
 * Registered ahead of every other handler so they work from any state — a demo
 * visitor who has wandered into a Mini App flow, a stalled negotiation or the
 * verification gate must always be able to get out. All are inert when
 * `DEMO_MODE_ENABLED` is false: the composer below is only mounted by
 * `handlers/router.ts` under that flag, and each handler re-checks it, so a
 * stray callback in production can never reach this code.
 */

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

  // `deleteUserAccount` drops the persisted `bot_sessions` row, but grammY
  // holds this chat's session in memory for the rest of the update and writes
  // it back when the handler returns — so without resetting it here the delete
  // is immediately undone and the brand-new account inherits the old one's
  // state. That is not theoretical: a surviving `expectingPhoto: true` put a
  // fresh visitor into the photo stage while the collector was still asking
  // profile questions, and tapping Continue there dead-ended onboarding.
  // The Telegram Settings → Delete path has always done this (settings.ts);
  // `/restart` is the same deletion and owes the same reset.
  Object.assign(ctx.session, { ...DEFAULT_SESSION });
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

/**
 * "Show me what happens next" — the visitor is done with the date card.
 *
 * The scheduled date is the one place in the demo where the interesting things
 * are on a card rather than in the next message: the venue-change board, Open
 * in Maps, the blurred share copy. The driver hands the card over and then
 * waits, and this is how a visitor says they are finished looking. Tapping it
 * is strictly a way to skip the wait — the pre-date content arrives either way
 * (`DEMO_EXPLORE_WAIT_MS`), so a demo can never stall on a button nobody
 * presses.
 */
demoRouter.callbackQuery(DEMO_PREDATE_CALLBACK, async (ctx) => {
  if (!DEMO_MODE_ENABLED) return;
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true },
  });
  if (!user) return;

  // The replay needs the agreed time to shift its clock to; read it from the
  // live scheduled row rather than trusting anything in the callback.
  const match = await prisma.match.findFirst({
    where: {
      status: "scheduled",
      OR: [{ userAId: user.id }, { userBId: user.id }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, agreedTime: true },
  });
  if (!match) return;

  await ctx.editMessageReplyMarkup().catch(() => undefined);
  await runDemoPredate(
    ctx.api,
    user.id,
    BigInt(telegramId),
    user.language,
    match.id,
    match.agreedTime,
  );
});

/**
 * The coordination fork (§Phase 4), owned by the demo.
 *
 * Two of the three variants exchange `t.me/` handles and the puppet has none, so
 * they are ANSWERED rather than performed: the visitor is told what the button
 * would do in production and handed the choice back. Only the anonymous chat is
 * carried out. See `script.ts` → `DEMO_COORD_PREFIX` for why this cannot route
 * through production's own `handleCoordMethod`.
 */
demoRouter.callbackQuery(new RegExp(`^${DEMO_COORD_PREFIX}`), async (ctx) => {
  if (!DEMO_MODE_ENABLED) return;
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from?.id;
  const choice = parseDemoCoordChoice(ctx.callbackQuery.data ?? "");
  if (telegramId === undefined || !choice) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true },
  });
  if (!user) return;

  // One live keyboard per decision: the explanation below carries its own, with
  // whatever is still worth pressing.
  await ctx.editMessageReplyMarkup().catch(() => undefined);

  if (choice !== "proxy") {
    await explainDemoCoordChoice(ctx.api, user.id, BigInt(telegramId), user.language, choice);
    return;
  }

  // Read the live row rather than trusting the callback for the agreed time.
  const match = await prisma.match.findFirst({
    where: { status: "scheduled", OR: [{ userAId: user.id }, { userBId: user.id }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, agreedTime: true },
  });
  if (!match) return;

  await chooseDemoProxy(
    ctx.api,
    user.id,
    BigInt(telegramId),
    user.language,
    match.id,
    match.agreedTime,
  );
});

/**
 * "Next" under the anonymous-chat beat — the visitor is done with the relay.
 *
 * Like the pre-date button above, strictly a way to skip the wait: the day-after
 * feedback arrives either way (`DEMO_CHAT_WAIT_MS`).
 */
demoRouter.callbackQuery(DEMO_AFTER_DATE_CALLBACK, async (ctx) => {
  if (!DEMO_MODE_ENABLED) return;
  await ctx.answerCallbackQuery();
  const telegramId = ctx.from?.id;
  if (telegramId === undefined) return;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, language: true },
  });
  if (!user) return;

  const match = await prisma.match.findFirst({
    where: { status: "scheduled", OR: [{ userAId: user.id }, { userBId: user.id }] },
    orderBy: { createdAt: "desc" },
    select: { id: true, agreedTime: true },
  });
  if (!match) return;

  await ctx.editMessageReplyMarkup().catch(() => undefined);
  await runDemoAfterDate(
    ctx.api,
    user.id,
    BigInt(telegramId),
    user.language,
    match.id,
    match.agreedTime,
  );
});
