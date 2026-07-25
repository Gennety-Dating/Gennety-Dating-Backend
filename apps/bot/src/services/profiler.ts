import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma, type MatchStatus } from "@gennety/db";
import {
  t,
  type Language,
  PROFILER_MAX_ANSWER_LEN,
  PROFILER_STALL_TIMEOUT_MS,
  profilerQuestionById,
  profilerQuestionText,
  type ProfilerQuestion,
} from "@gennety/shared";
import { dispatchToChat } from "../chat-queue.js";
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

/**
 * Match statuses that represent an **in-progress date negotiation** — the pitch
 * decision (`proposed`), calendar scheduling (`negotiating`), and venue
 * selection (`negotiating_venue`). While the user is in any of these, the
 * Profiler stays silent so its icebreaker questions never land mid-planning
 * (PRODUCT_SPEC §Phase 1b). `scheduled` is intentionally **excluded**: once the
 * date is locked in, the wait before it is a fine moment to gather icebreaker
 * fuel. Terminal states (cancelled/completed/expired) never block.
 */
export const PROFILER_BLOCKING_MATCH_STATUSES: readonly MatchStatus[] = [
  "proposed",
  "negotiating",
  "negotiating_venue",
];

/**
 * True when the user is mid date-negotiation (see
 * `PROFILER_BLOCKING_MATCH_STATUSES`), as either side of the pair — the signal
 * the scheduler/advance paths use to hold Profiler questions until the user is
 * idle again or simply waiting on a `scheduled` date.
 */
export async function hasActiveDatePlanning(userId: string): Promise<boolean> {
  const match = await prisma.match.findFirst({
    where: {
      status: { in: [...PROFILER_BLOCKING_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true },
  });
  return match !== null;
}

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
  activeQuestionId: string | null;
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
          profilerActiveQuestionId: true,
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
    activeQuestionId: user.profile.profilerActiveQuestionId ?? null,
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
      // NOT null: while a question is active, `profilerNextAt` carries its
      // stall deadline so `expireStalledProfilerQuestion` can reclaim a user
      // who simply never replied. The dispatch sweep is unaffected — it also
      // requires `profilerActiveQuestionId: null`.
      profilerNextAt: new Date(now.getTime() + PROFILER_STALL_TIMEOUT_MS),
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

/**
 * Atomically claim the user's active question so exactly ONE reply can ever
 * resolve it. Returns false when `questionId` is not the currently active
 * question — a stale/replayed tap, a double tap, or a reply that raced another.
 *
 * This is the single guard behind the "questions duplicate / arrive several at
 * a time" class of bugs. The Skip keyboard is never removed from older question
 * messages, so any of them can be tapped at any time; before this claim, each
 * such tap ran the full record→advance pipeline and pushed out another
 * question. Worse, because a *sent* question has no `ProfilerAnswer` row until
 * it is answered or skipped, `selectNextProfilerQuestion` would hand back the
 * very question still sitting unanswered on screen — sending it twice.
 */
async function claimActiveQuestion(userId: string, questionId: string): Promise<boolean> {
  const { count } = await prisma.profile.updateMany({
    where: { userId, profilerActiveQuestionId: questionId },
    data: { profilerActiveQuestionId: null },
  });
  return count === 1;
}

/**
 * Reclaim a question the user simply never replied to: record the silence as an
 * implicit skip (so it returns once, then steps aside for the rest of the drop
 * cycle — the same courtesy an explicit Skip gets) and re-arm the schedule at
 * the user's next local window.
 *
 * Called by the worker sweep for users whose active question passed its
 * `PROFILER_STALL_TIMEOUT_MS` deadline. Sends nothing: the point is to stop
 * being stuck, not to nag.
 */
export async function expireStalledProfilerQuestion(
  userId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { profilerActiveQuestionId: true, timeZone: true },
  });
  const questionId = profile?.profilerActiveQuestionId;
  if (!questionId) return false;
  // Claim it first — if the user answered in the same instant, they win.
  if (!(await claimActiveQuestion(userId, questionId))) return false;

  const question = profilerQuestionById(questionId);
  if (question) {
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
    // Never overwrite a real answer (defensive: a racing reply that landed
    // between the claim and here).
    if (!existing?.answerText) {
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
    }
  }

  await prisma.profile.update({
    where: { userId },
    data: {
      profilerActiveQuestionId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: nextWindowAt(now, resolveZone(profile?.timeZone ?? null)),
    },
  });
  return true;
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
 *
 * The send runs on the chat's serial queue (`dispatchToChat`) so a cron-opened
 * batch can't interleave with an update the user is sending at that exact
 * moment (e.g. a Skip tap that also advances the batch) and emit two questions
 * at once. Safe from deadlock: this is a cron entry point only — the reply path
 * (`advanceAfterReply`) is already inside the queue and never calls it.
 */
export async function startProfilerBatch(
  api: Api<RawApi>,
  userId: string,
  now: Date = new Date(),
  wait?: Wait,
): Promise<"sent" | "paused" | "done"> {
  const state = await loadState(userId);
  if (!state) return "done";
  if (state.telegramId <= 0n) return "done";
  return dispatchToChat(Number(state.telegramId), async () => {
    // Re-read inside the queue: a reply may have landed while we waited, which
    // would have opened its own question (active != null) or finished the run.
    const fresh = await loadState(userId);
    if (!fresh) return "done";
    if (fresh.activeQuestionId) return "paused";
    const rush = isRushMode(now, getNextBatchDate(now));
    fresh.profilerBatchRemaining = batchSizeFor(rush);
    await prisma.profile.update({
      where: { userId },
      data: { profilerBatchRemaining: fresh.profilerBatchRemaining, profilerNextAt: null },
    });
    return sendOneFromBatch(api, fresh, now, "open", wait);
  });
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

  // Only the reply that actually owns the active question may record + advance.
  if (!(await claimActiveQuestion(userId, questionId))) return false;

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

  // A stale Skip button (they are never stripped from older question messages)
  // must not record a second skip or push out another question.
  if (!(await claimActiveQuestion(userId, questionId))) return false;

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
  // If a date negotiation started while this batch was mid-flight, don't fire
  // the next question into the planning flow — the answer just given is saved,
  // and the rest of the batch pauses to the next local window.
  if (await hasActiveDatePlanning(userId)) {
    await prisma.profile.update({
      where: { userId },
      data: {
        profilerActiveQuestionId: null,
        profilerBatchRemaining: 0,
        profilerNextAt: nextWindowAt(now, resolveZone(state.timeZone)),
      },
    });
    return true;
  }
  await sendOneFromBatch(api, state, now, "advance", wait);
  return true;
}
