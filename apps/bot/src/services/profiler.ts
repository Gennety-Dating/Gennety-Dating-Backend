import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
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
import { runStatusSequence, streamComposedRich } from "./ai-stream.js";
import {
  profilerBatchSteps,
  profilerNextQuestionSteps,
  profilerOpenQuestionSteps,
} from "./analysis-status.js";
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

/** Injectable delay — production omits it (real timers); tests pass a no-op. */
type Wait = (ms: number) => Promise<void>;

/** Raw Skip keyboard (matches how `pitch.ts` builds markup for the streamer). */
function profilerSkipKeyboard(questionId: string, lang: Language): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: t(lang, "profilerSkip"), callback_data: `${PROFILER_SKIP_PREFIX}${questionId}` }],
    ],
  };
}

/**
 * Cumulative typewriter reveal of a question: up to two partials (≈⅓, ≈⅔ of the
 * words, suffixed "…") then the full text. Very short questions (<3 words) are
 * sent in one go — a one-word partial reads worse than no reveal.
 */
function buildQuestionReveal(text: string): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return [text];
  const cuts = [Math.ceil(words.length / 3), Math.ceil((2 * words.length) / 3)];
  const chunks: string[] = [];
  for (const cut of cuts) {
    const partial = `${words.slice(0, cut).join(" ")} …`;
    if (!chunks.includes(partial)) chunks.push(partial);
  }
  chunks.push(text);
  return chunks;
}

/**
 * Deliver one question through the **native Telegram AI compose** surface (Bot
 * API 10.1 rich messages) — used for EVERY question so the experience is uniform
 * (PRODUCT_SPEC §Phase 1b). A single rich-message draft carries:
 *   1. the `<tg-thinking>` **shimmer** status (animated AI Actions `<tg-emoji>`
 *      leading glyph) — `"advance"` shows acknowledge → "thinking"
 *      (`profilerNextQuestionSteps`); `"open"` (a batch's first question, after a
 *      window pause, nothing to acknowledge) shows just "thinking"
 *      (`profilerOpenQuestionSteps`);
 *   2. the question streamed in as growing rich-message drafts;
 *   3. the final question persisted as a real message carrying the Skip keyboard.
 *
 * Everything shares ONE draft id (`streamComposedRich`), so the AI-answer scroll
 * space is reserved/collapsed exactly once per question — no mid-stream jump from
 * a separate status draft, and no question is delivered as a plain (non-streamed)
 * message. Degrades to the classic edited-message stream when the client can't
 * render rich drafts. Returns false on delivery failure so the caller can
 * reschedule at the next window.
 */
async function sendQuestionStreamed(
  api: Api<RawApi>,
  telegramId: bigint,
  question: ProfilerQuestion,
  lang: Language,
  mode: "open" | "advance",
  wait?: Wait,
): Promise<boolean> {
  if (telegramId <= 0n) return false;
  const beats = mode === "advance" ? profilerNextQuestionSteps(lang) : profilerOpenQuestionSteps(lang);
  try {
    const message = await streamComposedRich(
      api,
      Number(telegramId),
      beats,
      buildQuestionReveal(profilerQuestionText(question, lang)),
      { replyMarkup: profilerSkipKeyboard(question.id, lang), ...(wait ? { wait } : {}) },
    );
    return message !== undefined;
  } catch (err) {
    console.warn(
      `[profiler] streamed question send failed for ${telegramId}:`,
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
  mode: "open" | "advance" = "open",
  wait?: Wait,
): Promise<"sent" | "paused" | "done"> {
  const cycleId = profilerCycleId(now);
  if (state.profilerBatchRemaining <= 0) {
    return pauseOrFinish(api, state, now, cycleId, wait);
  }
  const question = selectNextProfilerQuestion(state.gender, state.answers, cycleId);
  if (!question) {
    await finish(state.userId);
    return "done";
  }
  // Every question — first of a batch ("open") or a follow-up ("advance") —
  // goes through the same native AI-compose stream; only the status beats differ.
  const ok = await sendQuestionStreamed(api, state.telegramId, question, state.language, mode, wait);
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
  wait?: Wait,
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
      rich: true,
      ...(wait ? { wait } : {}),
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
  wait?: Wait,
): Promise<"sent" | "paused" | "done"> {
  const state = await loadState(userId);
  if (!state) return "done";
  const rush = isRushMode(now, getNextBatchDate(now));
  state.profilerBatchRemaining = batchSizeFor(rush);
  await prisma.profile.update({
    where: { userId },
    data: { profilerBatchRemaining: state.profilerBatchRemaining, profilerNextAt: null },
  });
  return sendOneFromBatch(api, state, now, "open", wait);
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
  options: { now?: Date; reactionTarget?: MessageReactionTarget; wait?: Wait } = {},
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

  return advanceAfterReply(api, userId, now, options.wait);
}

/**
 * Record a skip on the user's active question (one-time return semantics in
 * `skipTransition`) and advance the batch.
 */
export async function recordProfilerSkip(
  api: Api<RawApi>,
  userId: string,
  questionId: string,
  options: { now?: Date; wait?: Wait } = {},
): Promise<boolean> {
  const question = profilerQuestionById(questionId);
  if (!question) return false;
  const now = options.now ?? new Date();
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

  return advanceAfterReply(api, userId, now, options.wait);
}

/** Clear the active question and send the next one (or pause/finish). */
async function advanceAfterReply(
  api: Api<RawApi>,
  userId: string,
  now: Date,
  wait?: Wait,
): Promise<boolean> {
  // Re-read state AFTER the upsert so selection sees the just-recorded row.
  const state = await loadState(userId);
  if (!state) return false;
  await sendOneFromBatch(api, state, now, "advance", wait);
  return true;
}
