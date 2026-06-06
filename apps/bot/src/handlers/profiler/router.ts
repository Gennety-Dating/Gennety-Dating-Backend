import { Composer } from "grammy";
import { prisma } from "@gennety/db";
import type { BotContext } from "../../session.js";
import {
  PROFILER_SKIP_PREFIX,
  recordProfilerAnswer,
  recordProfilerSkip,
} from "../../services/profiler.js";

/**
 * Profiler router (PRODUCT_SPEC §Phase 1b) — captures answers/skips to the
 * proactive Profiler questions sent by the cron.
 *
 * Registered AFTER the matching + date routers (so active match/date flows —
 * emergency reason, feedback, proxy chat — always win) and BEFORE the menu
 * router (so a pending question's answer is captured instead of being sent to
 * the menu agent).
 *
 * The cron, which has no grammY session, is the source of truth via
 * `Profile.profilerActiveQuestionId`; this router reads it lazily and only for
 * plain-text / skip-callback updates from completed users not in another flow.
 */
export const profilerRouter = new Composer<BotContext>();

profilerRouter.use(async (ctx, next) => {
  if (ctx.session.onboardingStep !== "completed" || !ctx.from?.id) {
    await next();
    return;
  }

  const data = ctx.callbackQuery?.data;

  // Skip button — resolve the user and skip the named question.
  if (data?.startsWith(PROFILER_SKIP_PREFIX)) {
    const questionId = data.slice(PROFILER_SKIP_PREFIX.length);
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    });
    await ctx.answerCallbackQuery().catch(() => {});
    if (user) {
      await recordProfilerSkip(ctx.api, user.id, questionId);
    }
    return;
  }

  // Free-text answer — only when idle in every other flow, and not a command.
  const text = ctx.message?.text;
  const isCommand = text?.startsWith("/");
  const idle =
    ctx.session.matchFlow === "idle" &&
    ctx.session.menuState === "idle" &&
    !ctx.session.awaitingContextDump &&
    !ctx.session.expectingPhoto;

  if (text && !isCommand && idle) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true, profile: { select: { profilerActiveQuestionId: true } } },
    });
    const activeQuestionId = user?.profile?.profilerActiveQuestionId;
    if (user && activeQuestionId) {
      await recordProfilerAnswer(ctx.api, user.id, activeQuestionId, text);
      return;
    }
  }

  await next();
});
