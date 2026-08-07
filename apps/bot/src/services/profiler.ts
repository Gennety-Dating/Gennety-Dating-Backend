import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma, type MatchStatus } from "@gennety/db";
import {
  t,
  type Language,
  PROFILER_ANSWER_WINDOW_MS,
  PROFILER_MAX_ANSWER_LEN,
  PROFILER_STALL_TIMEOUT_MS,
  isRefreshableProfilerQuestion,
  profilerQuestionBank,
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
  isoWeekKey,
  nextWindowAt,
  resolveZone,
  selectNextProfilerQuestion,
  shouldCaptureProfilerAnswer,
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

/**
 * Drop cycle id for `refresh: "cycle"` situational Profiler questions —
 * calendar week (`isoWeekKey`), deliberately independent of the matching
 * batch's own cadence. Used to be `getNextBatchDate(now)` (the next batch
 * date), which was fine under `weekly` (the batch date already changes
 * exactly once a week) but broke under `daily`: the next-batch date changes
 * every single day, which would make every situational question ("what are
 * you watching this week") eligible to re-ask daily instead of weekly,
 * regardless of what the matching cadence actually is.
 */
export function profilerCycleId(now: Date): string {
  return isoWeekKey(now);
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
 * Deliver one question: a short `<tg-thinking>` **shimmer** beat, then the
 * question as an ordinary message carrying the Skip keyboard.
 *
 * The beats differ only by context — `"advance"` acknowledges the answer just
 * given (`profilerNextQuestionSteps`), `"open"` follows a long window pause and
 * has nothing to acknowledge (`profilerOpenQuestionSteps`). Both are bare
 * (no emoji) and deliberately short.
 *
 * The question text itself is passed as a SINGLE chunk, so it lands whole
 * instead of typing itself out word by word: the reveal read as latency rather
 * than craft, and a question the user must actually think about is better shown
 * at once. Everything still shares one draft id (`streamComposedRich`), so the
 * client reserves and collapses the compose space exactly once. Degrades to the
 * classic edited-message stream when the client can't render rich drafts.
 *
 * Returns the sent message id (needed to recognise a later reply and to strip
 * the Skip keyboard), or null on delivery failure so the caller can reschedule.
 */
async function sendQuestion(
  api: Api<RawApi>,
  telegramId: bigint,
  question: ProfilerQuestion,
  lang: Language,
  mode: "open" | "advance",
  wait?: Wait,
): Promise<number | null> {
  if (telegramId <= 0n) return null;
  const beats = mode === "advance" ? profilerNextQuestionSteps(lang) : profilerOpenQuestionSteps(lang);
  try {
    const message = await streamComposedRich(
      api,
      Number(telegramId),
      beats,
      [profilerQuestionText(question, lang)],
      { replyMarkup: profilerSkipKeyboard(question.id, lang), ...(wait ? { wait } : {}) },
    );
    return message?.message_id ?? null;
  } catch (err) {
    console.warn(
      `[profiler] question send failed for ${telegramId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Best-effort removal of the Skip keyboard from a question that was **resolved**
 * (answered, or explicitly skipped). Leaves the question text in place — it is
 * the context for the answer sitting right below it, and the user knows they
 * dealt with it. Never throws.
 */
async function stripQuestionKeyboard(
  api: Api<RawApi>,
  telegramId: bigint,
  messageId: number | null,
): Promise<void> {
  if (!messageId || telegramId <= 0n) return;
  try {
    await api.editMessageReplyMarkup(Number(telegramId), messageId);
  } catch {
    // Message deleted, too old to edit, or already without a keyboard.
  }
}

/**
 * Delete a question that expired **unresolved** — the user never replied and the
 * stall sweep reclaimed it.
 *
 * Stripping the keyboard is not enough here. The question text stays in the chat
 * looking like an open question the bot is waiting on, but nothing on our side
 * still points at it: the active-question claim is gone, so a reply to it falls
 * through to the menu agent, which answers with no idea what the user is talking
 * about. The absence of a Skip button is the only visible difference, and it is
 * not something a user reads as "this is dead". Removing the message is what
 * actually makes the chat state and the server state agree.
 *
 * Falls back to stripping the keyboard when the delete is refused — Telegram
 * only lets a bot delete its own message for 48 h, which the 6 h stall deadline
 * clears comfortably, but the worker's legacy `profilerNextAt: null` backlog arm
 * can reclaim questions far older than that. Never throws.
 */
async function retireExpiredQuestion(
  api: Api<RawApi>,
  telegramId: bigint,
  messageId: number | null,
): Promise<void> {
  if (!messageId || telegramId <= 0n) return;
  try {
    await api.deleteMessage(Number(telegramId), messageId);
  } catch {
    await stripQuestionKeyboard(api, telegramId, messageId);
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
    await finishOrAwaitNextCycle(state.userId, state.gender, now, state.timeZone);
    return "done";
  }
  // Every question — first of a batch ("open") or a follow-up ("advance") —
  // goes through the same native AI-compose beat; only the status differs.
  const messageId = await sendQuestion(api, state.telegramId, question, state.language, mode, wait);
  if (messageId === null) {
    // Couldn't deliver (e.g. blocked) — retry at the next window rather than
    // burning the active slot. Leaves active=null so the worker re-picks it up.
    await prisma.profile.update({
      where: { userId: state.userId },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
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
      // The question owns free text only for this short window; after it (or
      // after the user does anything else) plain text belongs to the menu
      // agent again. See `shouldCaptureProfilerAnswer`.
      profilerAnswerWindowUntil: new Date(now.getTime() + PROFILER_ANSWER_WINDOW_MS),
      profilerQuestionMessageId: messageId,
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
    await finishOrAwaitNextCycle(state.userId, state.gender, now, state.timeZone);
    return "done";
  }
  await prisma.profile.update({
    where: { userId: state.userId },
    data: {
      profilerActiveQuestionId: null,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
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
async function claimActiveQuestion(
  userId: string,
  questionId: string,
): Promise<{ claimed: boolean; messageId: number | null }> {
  // Read the message id BEFORE the claim nulls it — the winner uses it to strip
  // the now-dead Skip keyboard. A lost race simply skips that cosmetic step.
  const before = await prisma.profile.findUnique({
    where: { userId },
    select: { profilerQuestionMessageId: true },
  });
  const { count } = await prisma.profile.updateMany({
    where: { userId, profilerActiveQuestionId: questionId },
    data: {
      profilerActiveQuestionId: null,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
    },
  });
  return { claimed: count === 1, messageId: before?.profilerQuestionMessageId ?? null };
}

/**
 * Resolve whether an incoming plain-text message belongs to the user's active
 * Profiler question (see `shouldCaptureProfilerAnswer` for the rule). Returns
 * the ids the router needs to buffer the answer, or null when the text is not
 * an answer and should fall through to the menu agent.
 */
export async function resolveProfilerCapture(
  telegramId: bigint,
  options: { now?: Date; replyToMessageId?: number | undefined } = {},
): Promise<{ userId: string; questionId: string } | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      profile: {
        select: {
          profilerActiveQuestionId: true,
          profilerAnswerWindowUntil: true,
          profilerQuestionMessageId: true,
        },
      },
    },
  });
  const profile = user?.profile;
  if (!user || !profile?.profilerActiveQuestionId) return null;
  const capture = shouldCaptureProfilerAnswer(
    {
      activeQuestionId: profile.profilerActiveQuestionId,
      answerWindowUntil: profile.profilerAnswerWindowUntil,
      questionMessageId: profile.profilerQuestionMessageId,
    },
    {
      now: options.now ?? new Date(),
      replyToMessageId: options.replyToMessageId,
    },
  );
  if (!capture) return null;
  return { userId: user.id, questionId: profile.profilerActiveQuestionId };
}

/**
 * The conversation moved on — the user ran a command, tapped a menu button, or
 * was busy in another flow — so the question on screen stops being the default
 * addressee of whatever they type next.
 *
 * Only the implicit window is closed. The question stays *active* (the stall
 * sweep still owns it) and keeps its Skip button and its message id, so the two
 * explicit ways to resolve it — tapping Skip, or replying directly to the
 * question — keep working. Cheap by design: one indexed read that finds nothing
 * in the common case where no window is open.
 */
export async function closeProfilerAnswerWindow(telegramId: bigint): Promise<boolean> {
  if (telegramId <= 0n) return false;
  const open = await prisma.profile.findFirst({
    where: { user: { telegramId }, profilerAnswerWindowUntil: { not: null } },
    select: { userId: true },
  });
  if (!open) return false;
  await prisma.profile.update({
    where: { userId: open.userId },
    data: { profilerAnswerWindowUntil: null },
  });
  return true;
}

/**
 * Reclaim a question the user simply never replied to: record the silence as an
 * implicit skip (so it returns once, then steps aside for the rest of the drop
 * cycle — the same courtesy an explicit Skip gets), delete the question message
 * so a dead question stops inviting an answer nothing can route, and re-arm the
 * schedule at the user's next local window.
 *
 * Called by the worker sweep for users whose active question passed its
 * `PROFILER_STALL_TIMEOUT_MS` deadline. Sends nothing: the point is to stop
 * being stuck, not to nag.
 */
export async function expireStalledProfilerQuestion(
  userId: string,
  now: Date = new Date(),
  api?: Api<RawApi>,
): Promise<boolean> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: {
      profilerActiveQuestionId: true,
      timeZone: true,
      user: { select: { telegramId: true } },
    },
  });
  const questionId = profile?.profilerActiveQuestionId;
  if (!questionId) return false;
  // Claim it first — if the user answered in the same instant, they win.
  const claim = await claimActiveQuestion(userId, questionId);
  if (!claim.claimed) return false;
  // Nothing points at this question any more, so it must not keep sitting in the
  // chat inviting an answer the bot can no longer route (see `retireExpiredQuestion`).
  if (api && profile.user) {
    await retireExpiredQuestion(api, profile.user.telegramId, claim.messageId);
  }

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
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
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
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: null,
    },
  });
}

/**
 * Nothing is pending in the CURRENT drop cycle. If the bank has no
 * **refreshable** ("cycle") question at all, this really is the end — quiesce
 * forever via `finish()`.
 *
 * Otherwise it only LOOKS finished: a refreshable question becomes eligible
 * again once the cycle rolls over (`profilerCycleId` advances at the next
 * weekly batch), so a true `finish()` here would be a bug — its null
 * `profilerNextAt` means the dispatch sweep (`profilerNextAt: { lte: now }`)
 * never looks at this user again, EVER, so the "situational questions repeat
 * weekly" mechanic would silently never fire in production. Instead this
 * schedules a silent re-check at the next window, same as an ordinary pause;
 * `selectNextProfilerQuestion` keeps returning null on each check until the
 * cycle actually changes, at which point the refreshable questions become due
 * and the batch fires for real. Cheap: 2 no-op checks a day, capped by the
 * worker's existing per-tick limits, and every current gender bank guarantees
 * at least one refreshable question (see profiler-questions.test.ts).
 */
async function finishOrAwaitNextCycle(
  userId: string,
  gender: "male" | "female" | null,
  now: Date,
  timeZone: string | null,
): Promise<void> {
  const hasRefreshable = profilerQuestionBank(gender).some(isRefreshableProfilerQuestion);
  if (!hasRefreshable) {
    await finish(userId);
    return;
  }
  await prisma.profile.update({
    where: { userId },
    data: {
      profilerActiveQuestionId: null,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: nextWindowAt(now, resolveZone(timeZone)),
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
  const claim = await claimActiveQuestion(userId, questionId);
  if (!claim.claimed) return false;

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

  // The answered question keeps its text but loses its Skip button — a live
  // button on a question already answered is only confusing (a later tap is a
  // silent no-op, since the claim above is authoritative).
  if (options.reactionTarget?.chatId !== undefined && claim.messageId) {
    await stripQuestionKeyboard(api, BigInt(options.reactionTarget.chatId), claim.messageId);
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

  // A stale Skip button must not record a second skip or push out another
  // question (the router strips the tapped message's keyboard, but an older
  // question's button may still be sitting in the chat).
  if (!(await claimActiveQuestion(userId, questionId)).claimed) return false;

  await upsertProfilerSkip(userId, question, cycleId);

  return advanceAfterReply(api, userId, now, options.wait);
}

/**
 * Record the user declining to answer the live question in free text.
 *
 * Two deliberate differences from an ordinary Skip tap:
 *
 * 1. **It is recorded as a skip, not as an answer.** Before this, the router
 *    handed refusal text straight to `recordProfilerAnswer`, which stored it
 *    verbatim with `skipped: false` — burning the question for good (answered
 *    questions are never re-asked) and feeding "не хочу отвечать" to the
 *    ice-breaker and wingman generators as though it were an interest. Going
 *    through `skipTransition` instead means the question returns once, exactly
 *    like a tapped Skip.
 * 2. **It ends the batch** rather than firing the next question. Someone who
 *    just said they don't want to answer is the last person to ask two more
 *    questions of; the rest of the batch pauses to their next local window,
 *    reusing the same release the date-negotiation gate performs. Deliberately
 *    a pause, not an opt-out: it self-heals on the next window, so a one-word
 *    "потом" can never silently retire the Profiler for an account.
 */
export async function recordProfilerRefusal(
  api: Api<RawApi>,
  userId: string,
  questionId: string,
  options: { now?: Date } = {},
): Promise<boolean> {
  const question = profilerQuestionById(questionId);
  if (!question) return false;
  const now = options.now ?? new Date();
  const cycleId = profilerCycleId(now);

  const claim = await claimActiveQuestion(userId, questionId);
  if (!claim.claimed) return false;

  await upsertProfilerSkip(userId, question, cycleId);

  const state = await loadState(userId);
  if (!state) return false;

  // The question is resolved, so its Skip button must go — the same rule an
  // answer follows. It is not deleted: unlike a question reclaimed by the stall
  // sweep, the user dealt with this one and their reply sits under it.
  await stripQuestionKeyboard(api, state.telegramId, claim.messageId);

  await pauseBatchUntilNextWindow(userId, now, state.timeZone);

  if (state.telegramId > 0n) {
    try {
      await api.sendMessage(
        Number(state.telegramId),
        t(state.language, "profilerRefusalAck"),
      );
    } catch {
      // The pause above already landed; a failed ack must not undo it.
    }
  }
  return true;
}

/** Write the one-time-return skip state for a question (`skipTransition`). */
async function upsertProfilerSkip(
  userId: string,
  question: ProfilerQuestion,
  cycleId: string,
): Promise<void> {
  const existing = await prisma.profilerAnswer.findUnique({
    where: { userId_questionId: { userId, questionId: question.id } },
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
    where: { userId_questionId: { userId, questionId: question.id } },
    create: {
      userId,
      questionId: question.id,
      priority: question.priority,
      answerText: null,
      skipped,
      skipReturned,
      cycleId,
    },
    update: { skipped, skipReturned, cycleId },
  });
}

/**
 * Release the active question and pause the rest of the batch to the user's
 * next local window. Shared by the date-negotiation gate and the refusal path.
 */
async function pauseBatchUntilNextWindow(
  userId: string,
  now: Date,
  timeZone: string | null,
): Promise<void> {
  await prisma.profile.update({
    where: { userId },
    data: {
      profilerActiveQuestionId: null,
      profilerAnswerWindowUntil: null,
      profilerQuestionMessageId: null,
      profilerBatchRemaining: 0,
      profilerNextAt: nextWindowAt(now, resolveZone(timeZone)),
    },
  });
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
    await pauseBatchUntilNextWindow(userId, now, state.timeZone);
    return true;
  }
  await sendOneFromBatch(api, state, now, "advance", wait);
  return true;
}
