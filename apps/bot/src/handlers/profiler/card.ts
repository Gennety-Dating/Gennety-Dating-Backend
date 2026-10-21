import { profilerActiveQuestionPatch } from "../../services/profiler-schedule.js";
import { prisma } from "@gennety/db";
import { profilerQuestionById, profilerTelegramQuestionInput, profilerQuestionText, t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import {
  closeProfilerCard, deliverProfilerCard, parseProfilerCardCallback, profilerCardToken,
} from "../../services/profiler-card.js";
import { recordProfilerCardAnswer, recordProfilerSkip } from "../../services/profiler.js";
import { profilerContextMarkdown, resolveProfilerQuestionContext } from "../../services/profiler-context.js";

/** Returns true for every pc: callback, including retired cards after a flag rollback. */
export async function handleProfilerCard(ctx: BotContext): Promise<void> {
  const callback = parseProfilerCardCallback(ctx.callbackQuery?.data ?? "");
  const messageId = ctx.callbackQuery?.message?.message_id;
  const lang = ctx.session.language ?? "en";
  if (!callback || !messageId || !ctx.from || ctx.chat?.id !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: t(lang, "profilerCardStale") }).catch(() => {});
    return;
  }
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { id: true, language: true, status: true, profile: { select: {
      profilerActiveQuestionId: true, profilerQuestionMessageId: true, timeZone: true,
    } } },
  });
  const language = (user?.language ?? lang) as Language;
  const questionId = user?.profile?.profilerActiveQuestionId;
  const question = questionId ? profilerQuestionById(questionId) : undefined;
  const current = env.PROFILER_CARDS_ENABLED && user?.status === "active" && question &&
    user.profile?.profilerQuestionMessageId === messageId;
  if (!current) {
    await ctx.answerCallbackQuery({ text: t(language, "profilerCardStale") }).catch(() => {});
    // Only retire a genuinely stale message. A temporarily interrupted active question stays usable.
    if (!env.PROFILER_CARDS_ENABLED || user?.profile?.profilerQuestionMessageId !== messageId || !question) {
      const text = !env.PROFILER_CARDS_ENABLED && question && user?.profile?.profilerQuestionMessageId === messageId
        ? `${profilerQuestionText(question, language)}\n\n${t(language, "profilerCardOwn")}`
        : t(language, "profilerCardInactive");
      await closeProfilerCard(ctx.api, ctx.from.id, messageId, language, text).catch(() => {});
    }
    return;
  }
  // Retire cards issued before this question became free text; typing still answers it.
  if (!profilerTelegramQuestionInput(question)) {
    await ctx.answerCallbackQuery({ text: t(language, "profilerCardStale") }).catch(() => {});
    await closeProfilerCard(ctx.api, ctx.from.id, messageId, language, profilerQuestionText(question, language)).catch(() => {});
    delete ctx.session.profilerCardDraft;
    return;
  }
  if (ctx.session.matchFlow !== "idle" || ctx.session.menuState !== "idle" || ctx.session.expectingPhoto) {
    await ctx.answerCallbackQuery({ text: t(language, "profilerCardStale") }).catch(() => {});
    return;
  }
  const stored = ctx.session.profilerCardDraft;
  const draft = stored?.questionId === question.id && stored.messageId === messageId
    ? stored : { questionId: question.id, messageId, revision: 0, optionIds: [] as string[] };
  const resolution = await resolveProfilerQuestionContext(user.id, question, language, new Date());
  const context = resolution.kind === "card"
    ? profilerContextMarkdown(resolution.card, language, user.profile?.timeZone ?? null) : null;
  const refresh = async () => {
    const patch = profilerActiveQuestionPatch(question.id, 0, new Date(), messageId);
    const guard = { userId: user.id, profilerActiveQuestionId: question.id, profilerQuestionMessageId: messageId };
    const renewed = await prisma.profile.updateMany({ where: guard,
      data: { profilerAnswerWindowUntil: patch.profilerAnswerWindowUntil } });
    if (renewed.count !== 1) {
      delete ctx.session.profilerCardDraft;
      await closeProfilerCard(ctx.api, ctx.from!.id, messageId, language).catch(() => {});
      return;
    }
    const delivered = await deliverProfilerCard(ctx.api, ctx.from!.id, question, language, messageId, draft, context);
    const attached = await prisma.profile.updateMany({ where: guard, data: { profilerQuestionMessageId: delivered } });
    if (attached.count !== 1) {
      delete ctx.session.profilerCardDraft;
      await closeProfilerCard(ctx.api, ctx.from!.id, delivered, language).catch(() => {});
      return;
    }
    draft.messageId = delivered;
    ctx.session.profilerCardDraft = draft;
  };
  if (callback.token !== profilerCardToken(question.id) || callback.revision !== draft.revision) {
    await ctx.answerCallbackQuery({ text: t(language, "profilerCardStale") }).catch(() => {});
    try { await refresh(); } catch { await ctx.reply(t(language, "profilerCardRetry")).catch(() => {}); }
    return;
  }
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    if (callback.action === "skip") {
      await recordProfilerSkip(ctx.api, user.id, question.id, { expectedMessageId: messageId });
      delete ctx.session.profilerCardDraft;
      return;
    }
    if (callback.action === "send") {
      if (await recordProfilerCardAnswer(ctx.api, user.id, question.id, language, draft.optionIds, "", messageId)) {
        delete ctx.session.profilerCardDraft;
      }
      return;
    }
    const input = profilerTelegramQuestionInput(question);
    if (callback.action === "own") {
      draft.writing = true;
    } else {
      const option = input?.options[Number(callback.action)];
      if (!option) return;
      if (input?.closed) {
        await recordProfilerCardAnswer(ctx.api, user.id, question.id, language, [option.id], "", messageId);
        delete ctx.session.profilerCardDraft;
        return;
      }
      draft.optionIds = input?.multiple
        ? draft.optionIds.includes(option.id) ? draft.optionIds.filter((id) => id !== option.id) : [...draft.optionIds, option.id]
        : [option.id];
      draft.writing = false;
    }
    draft.revision++;
    ctx.session.profilerCardDraft = draft;
    // Explicit interaction reopens the answer window without bypassing another flow.
    await refresh();
  } catch {
    await ctx.reply(t(language, "profilerCardRetry")).catch(() => {});
  }
}
