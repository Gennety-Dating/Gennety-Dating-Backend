import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  PROFILER_MAX_ANSWER_LEN,
  profilerQuestionById,
  profilerQuestionText,
  type ProfilerQuestion,
} from "@gennety/shared";
import { getNextBatchDate } from "./next-batch.js";
import { runStatusSequence } from "./ai-stream.js";
import { profilerBatchSteps } from "./analysis-status.js";
import {
  batchSizeFor,
  isRushMode,
  nextWindowAt,
  resolveZone,
  selectNextProfilerQuestion,
  skipTransition,
  type ProfilerAnswerRow,
} from "./profiler-schedule.js";
import {
  MESSAGE_REACTION,
  reactToMessage,
  type MessageReactionTarget,
} from "./message-reactions.js";

/**
 * Profiler orchestration (PRODUCT_SPEC §Phase 1b) — the IO layer over the pure
 * scheduling/selection logic in `profiler-schedule.ts`. Sends questions in
 * timed batches, persists answers/skips to `ProfilerAnswer`, and advances the
 * `Profile.profiler*` state machine. Telegram-only in v1.
 *
 * The data fuels icebreakers + hints (see `wingman-hint.ts` and
 * `date-lifecycle.ts`); it is NOT consumed by the matching algorithm.
 */

export const PROFILER_SKIP_PREFIX = "profiler:skip:";
const PROFILER_REACTION_QUESTION_IDS = new Set(["f_turnoffs", "m_planner"]);

export function shouldReactToProfilerAnswer(questionId: string): boolean {
  return PROFILER_REACTION_QUESTION_IDS.has(questionId);
}

/** Drop cycle id = ISO date (UTC day) of the next weekly batch. */
export function profilerCycleId(now: Date): string {
  return getNextBatchDate(now).toISOString().slice(0, 10);
}

interface ProfilerUserState {
  userId: string;
  telegramId: bigint;
  gender: "male" | "female" | null;
  language: Language;
  timeZone: string | null;
  profilerBatchRemaining: number;
  answers: ProfilerAnswerRow[];
}

async function loadState(userId: string): Promise<ProfilerUserState | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      telegramId: true,
      gender: true,
      language: true,
      profile: {
        select: {
          timeZone: true,
          profilerBatchRemaining: true,
        },
      },
      profilerAnswers: {
        select: {
          questionId: true,
          answerText: true,
          skipped: true,
          skipReturned: true,
          cycleId: true,
        },
      },
    },
  });
  if (!user || !user.profile) return null;
  return {
    userId: user.id,
    telegramId: user.telegramId,
    gender: user.gender,
    language: (user.language ?? "en") as Language,
    timeZone: user.profile.timeZone,
    profilerBatchRemaining: user.profile.profilerBatchRemaining,
    answers: user.profilerAnswers,
  };
}

async function sendQuestion(
  api: Api<RawApi>,
  telegramId: bigint,
  question: ProfilerQuestion,
  lang: Language,
): Promise<boolean> {
  if (telegramId <= 0n) return false;
  const keyboard = new InlineKeyboard().text(
    t(lang, "profilerSkip"),
    `${PROFILER_SKIP_PREFIX}${question.id}`,
  );
  try {
    await api.sendMessage(Number(telegramId), profilerQuestionText(question, lang), {
      reply_markup: keyboard,
    });
    return true;
  } catch (err) {
    console.warn(
      `[profiler] question send failed for ${telegramId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Send one question from the current batch, or pause/finish when the batch is
 * exhausted or nothing's pending. Shared by batch start and post-reply advance.
 */
async function sendOneFromBatch(
  api: Api<RawApi>,
  state: ProfilerUserState,
  now: Date,
): Promise<"sent" | "paused" | "done"> {
  const cycleId = profilerCycleId(now);
  if (state.profilerBatchRemaining <= 0) {
    return pauseOrFinish(api, state, now, cycleId);
  }
  const question = selectNextProfilerQuestion(state.gender, state.answers, cycleId);
  if (!question) {
    await finish(state.userId);
    return "done";
  }
  const ok = await sendQuestion(api, state.telegramId, question, state.language);
  if (!ok) {
    // Couldn't deliver (e.g. blocked) — retry at the next window rather than
    // burning the active slot. Leaves active=null so the worker re-picks it up.
    await prisma.profile.update({
      where: { userId: state.userId },
      data: {
        profilerActiveQuestionId: null,
        profilerNextAt: nextWindowAt(now, resolveZone(state.timeZone)),
      },
    });
    return "paused";
  }
  await prisma.profile.update({
    where: { userId: state.userId },
    data: {
      profilerActiveQuestionId: question.id,
      profilerBatchRemaining: state.profilerBatchRemaining - 1,
      profilerNextAt: null,
    },
  });
  return "sent";
}

async function pauseOrFinish(
  api: Api<RawApi>,
  state: ProfilerUserState,
  now: Date,
  cycleId: string,
): Promise<"paused" | "done"> {
  const pending = selectNextProfilerQuestion(state.gender, state.answers, cycleId);
  if (!pending) {
    // All questions exhausted — completion is SILENT per spec §Phase 1b
    // (no "profile complete" ping). Do NOT play a status here.
    await finish(state.userId);
    return "done";
  }
  await prisma.profile.update({
    where: { userId: state.userId },
    data: {
      profilerActiveQuestionId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: nextWindowAt(now, resolveZone(state.timeZone)),
    },
  });
  // Batch boundary (not completion): narrate that the answers were folded into
  // the profile so the user feels the agent is actively learning between drops.
  // Persisted final line (no delete) — it IS the between-batch message.
  if (state.telegramId > 0n) {
    await runStatusSequence(api, Number(state.telegramId), profilerBatchSteps(state.language), {
      deleteAtEnd: false,
    });
  }
  return "paused";
}

/** Quiesce the Profiler for a user with no pending questions. Silent (spec §2.5). */
async function finish(userId: string): Promise<void> {
  await prisma.profile.update({
    where: { userId },
    data: {
      profilerActiveQuestionId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: null,
    },
  });
}

/**
 * Open a new batch: size it for the current mode and send the first question.
 * Called by the worker when `profilerNextAt` is due. No-op when nothing's
 * pending (silently finishes).
 */
export async function startProfilerBatch(
  api: Api<RawApi>,
  userId: string,
  now: Date = new Date(),
): Promise<"sent" | "paused" | "done"> {
  const state = await loadState(userId);
  if (!state) return "done";
  const rush = isRushMode(now, getNextBatchDate(now));
  state.profilerBatchRemaining = batchSizeFor(rush);
  await prisma.profile.update({
    where: { userId },
    data: { profilerBatchRemaining: state.profilerBatchRemaining, profilerNextAt: null },
  });
  return sendOneFromBatch(api, state, now);
}

/**
 * Record a free-text answer to the user's active question and immediately send
 * the next question in the batch (or pause/finish). Returns false when the user
 * has no active question (stale/duplicate input).
 */
export async function recordProfilerAnswer(
  api: Api<RawApi>,
  userId: string,
  questionId: string,
  text: string,
  options: { now?: Date; reactionTarget?: MessageReactionTarget } = {},
): Promise<boolean> {
  const question = profilerQuestionById(questionId);
  if (!question) return false;
  const answerText = text.trim().slice(0, PROFILER_MAX_ANSWER_LEN);
  if (!answerText) return false;
  const now = options.now ?? new Date();
  const cycleId = profilerCycleId(now);

  await prisma.profilerAnswer.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: {
      userId,
      questionId,
      priority: question.priority,
      answerText,
      answeredAt: now,
      skipped: false,
      skipReturned: false,
      cycleId,
    },
    update: {
      answerText,
      answeredAt: now,
      skipped: false,
      skipReturned: false,
      cycleId,
    },
  });

  if (shouldReactToProfilerAnswer(questionId) && options.reactionTarget) {
    await reactToMessage(api, options.reactionTarget, MESSAGE_REACTION.like);
  }

  return advanceAfterReply(api, userId, now);
}

/**
 * Record a skip on the user's active question (one-time return semantics in
 * `skipTransition`) and advance the batch.
 */
export async function recordProfilerSkip(
  api: Api<RawApi>,
  userId: string,
  questionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const question = profilerQuestionById(questionId);
  if (!question) return false;
  const cycleId = profilerCycleId(now);

  const existing = await prisma.profilerAnswer.findUnique({
    where: { userId_questionId: { userId, questionId } },
    select: {
      questionId: true,
      answerText: true,
      skipped: true,
      skipReturned: true,
      cycleId: true,
    },
  });
  const { skipped, skipReturned } = skipTransition(existing ?? undefined, cycleId);

  await prisma.profilerAnswer.upsert({
    where: { userId_questionId: { userId, questionId } },
    create: {
      userId,
      questionId,
      priority: question.priority,
      answerText: null,
      skipped,
      skipReturned,
      cycleId,
    },
    update: { skipped, skipReturned, cycleId },
  });

  return advanceAfterReply(api, userId, now);
}

/** Clear the active question and send the next one (or pause/finish). */
async function advanceAfterReply(
  api: Api<RawApi>,
  userId: string,
  now: Date,
): Promise<boolean> {
  // Re-read state AFTER the upsert so selection sees the just-recorded row.
  const state = await loadState(userId);
  if (!state) return false;
  await sendOneFromBatch(api, state, now);
  return true;
}
