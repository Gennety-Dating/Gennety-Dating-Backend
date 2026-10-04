import { prisma } from "@gennety/db";
import {
  PROFILER_MAX_ANSWER_LEN,
  profilerQuestionById,
  profilerQuestionText,
  type Language,
  type ProfilerQuestion,
} from "@gennety/shared";
import { getMainBotApi } from "./main-bot-api.js";
import { getNextBatchDate } from "./next-batch.js";
import { isProfilerRefusal } from "./profiler-intent.js";
import {
  batchSizeFor,
  isRushMode,
  nextProfilerBatchStep,
  nextWindowAt,
  profilerActiveQuestionPatch,
  resolveZone,
  selectNextProfilerQuestion,
} from "./profiler-schedule.js";
import {
  awaitNextProfilerWindow,
  claimActiveQuestion,
  contextualQuestionFor,
  hasActiveDatePlanning,
  loadProfilerState,
  pauseBatchUntilNextWindow,
  profilerCycleId,
  stripQuestionKeyboard,
  upsertProfilerAnswer,
  upsertProfilerSkip,
  type ProfilerUserState,
} from "./profiler.js";
import {
  resolveProfilerQuestionContext,
  type ProfilerContextCard,
} from "./profiler-context.js";

/**
 * The Profiler (PRODUCT_SPEC §Phase 1b) for the NATIVE app —
 * `GET /v1/me/profiler` and `POST /v1/me/profiler/answer`.
 *
 * Telegram PUSHES a batch: the worker opens it in a local morning/evening
 * window and the bot sends each question. The app cannot be pushed into, so it
 * PULLS: whenever it asks, a due batch is opened on the spot, and a question
 * already live — whichever surface opened it — is handed back as is. That
 * second rule is the whole "resume": close the app mid-batch, open it tomorrow,
 * and the same question is waiting. A mobile-only user is never touched by the
 * worker (it filters on `platform in (telegram, both)`), so nothing expires
 * their live question; a `both` user's question still falls to the worker's
 * stall sweep after `PROFILER_STALL_TIMEOUT_MS`, exactly like a Telegram one.
 *
 * Everything that is not delivery is shared with `services/profiler.ts`: the
 * atomic claim on `profilerActiveQuestionId`, the answer and skip upserts, the
 * batch-step decision (`nextProfilerBatchStep`), the active-question patch, and
 * the pause / finish scheduling. So an answer given in the app is the same row
 * an answer given in Telegram is, and the icebreaker / wingman generators that
 * read those rows cannot tell the two apart — which is the parity. Nothing new
 * is triggered by an answer, here or there.
 *
 * Never sends a Telegram message. The one Telegram call is cosmetic: when the
 * app resolves a question the bot had SENT (a `both` user), its now-dead Skip
 * button is stripped, the same courtesy the chat path extends.
 */

export interface NativeProfilerQuestion {
  id: string;
  text: string;
  /**
   * What a contextual question refers to — the app draws it as a card above
   * the question (the date and the venue, or the person's own earlier answer).
   * Absent on bank questions and on rechecks.
   */
  context?: ProfilerContextCard;
}

/** `GET /v1/me/profiler`. Empty = nothing to ask right now. */
export interface NativeProfilerBatch {
  question?: NativeProfilerQuestion;
  /** Questions left in the batch INCLUDING `question` (1 = the last one). */
  remaining?: number;
}

export type NativeProfilerReply = { kind: "skip" } | { kind: "text"; text: string };

export type NativeProfilerAnswerResult =
  | { ok: true; outcome: "next"; question: NativeProfilerQuestion; remaining: number }
  | { ok: true; outcome: "done" | "paused" }
  | { ok: false; error: "question_not_active" };

/**
 * The question as the app sees it, with its context card when it has one.
 * `null` when the question's moment is gone (`stale` — its date was cancelled
 * or has passed): it must not be shown any more.
 */
async function view(
  userId: string,
  question: ProfilerQuestion,
  language: Language,
  now: Date,
): Promise<NativeProfilerQuestion | null> {
  const base = { id: question.id, text: profilerQuestionText(question, language) };
  const resolution = await resolveProfilerQuestionContext(userId, question, language, now);
  if (resolution.kind === "stale") return null;
  return resolution.kind === "card" ? { ...base, context: resolution.card } : base;
}

/**
 * The live batch from a question already viewed. `Profile.profilerBatchRemaining`
 * does NOT count the live question (a batch of 3 stores 2 while its first
 * question is out — that is how the Telegram path has always kept it), while
 * the API's `remaining` does, so a client can say "last one" when it reads 1.
 */
function liveBatch(question: NativeProfilerQuestion, storedRemaining: number): NativeProfilerBatch {
  return { question, remaining: Math.max(storedRemaining, 0) + 1 };
}

/**
 * Release a live question nobody can answer any more — a bank id that no
 * longer exists, or a contextual question whose moment is gone — without
 * stranding a mobile-only user, whom nothing else ever expires. A contextual
 * one is recorded as a skip, so it is never chosen again. Its stall deadline
 * stays, so the next batch opens once that passes.
 */
async function releaseDeadQuestion(
  userId: string,
  questionId: string,
  question: ProfilerQuestion | undefined,
  now: Date,
): Promise<void> {
  const claim = await claimActiveQuestion(userId, questionId);
  if (claim.claimed && question) {
    await upsertProfilerSkip(userId, question, profilerCycleId(now));
  }
}

/**
 * The question the app should show now, opening a batch when one is due.
 *
 * Order matters and mirrors the worker: eligibility (active, onboarded, known
 * gender) → a question already live is returned untouched → otherwise a batch
 * is due when `profilerNextAt` has passed OR was never armed (null). The
 * onboarding agent's finalize arms it on both surfaces (the ~10 min entry
 * delay); the null arm covers legacy rows and completion paths that bypass it,
 * which the worker's lazy seed re-arms only for Telegram-reachable users — so
 * an app-only account on such a path is asked right away rather than never →
 * the date-negotiation gate → open.
 *
 * Deliberately NOT applied here, unlike the worker: local quiet hours. They
 * exist so a push never lands at 3 am; a person who opened the app at 3 am is
 * already looking at it. And a held (gated) batch is not re-armed to the next
 * window — the next pull after the negotiation ends simply opens it.
 */
export async function getNativeProfilerBatch(
  userId: string,
  now: Date = new Date(),
): Promise<NativeProfilerBatch> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      onboardingStep: true,
      gender: true,
      language: true,
      profile: {
        select: {
          timeZone: true,
          profilerStartedAt: true,
          profilerNextAt: true,
          profilerActiveQuestionId: true,
          profilerBatchRemaining: true,
        },
      },
    },
  });
  const profile = user?.profile;
  if (
    !user ||
    !profile ||
    user.status !== "active" ||
    user.onboardingStep !== "completed" ||
    !user.gender
  ) {
    return {};
  }
  const language = (user.language ?? "en") as Language;

  // Resume: a live question is the answer, whoever opened it.
  const activeId = profile.profilerActiveQuestionId;
  if (activeId) {
    const active = profilerQuestionById(activeId);
    const shown = active ? await view(userId, active, language, now) : null;
    if (shown) return liveBatch(shown, profile.profilerBatchRemaining);
    // An id the bank no longer has (a question retired while it was live), or a
    // contextual question about a date that was cancelled or has passed.
    await releaseDeadQuestion(userId, activeId, active, now);
    return {};
  }

  const nextAt = profile.profilerNextAt;
  if (nextAt && nextAt.getTime() > now.getTime()) return {};
  if (await hasActiveDatePlanning(userId)) return {};

  const answers = await prisma.profilerAnswer.findMany({
    where: { userId },
    select: {
      questionId: true,
      answerText: true,
      answeredAt: true,
      skipped: true,
      skipReturned: true,
      cycleId: true,
    },
  });
  // A batch's opening question may be contextual — the same "lazy check" the
  // Telegram path runs when it opens a batch (`contextualQuestionFor`).
  const cycleId = profilerCycleId(now);
  const contextual = await contextualQuestionFor({ userId, gender: user.gender, answers }, now);
  let question = selectNextProfilerQuestion(user.gender, answers, cycleId, contextual);
  let shown = question ? await view(userId, question, language, now) : null;
  if (question && !shown) {
    question = selectNextProfilerQuestion(user.gender, answers, cycleId);
    shown = question ? await view(userId, question, language, now) : null;
  }

  // Compare-and-set on exactly what was read: no live question AND the same
  // `profilerNextAt`. The worker (for a `both` user) or a parallel request that
  // got there first changes one of the two, so exactly one opener wins and the
  // other falls through to reporting what is live.
  const guard = { userId, profilerActiveQuestionId: null, profilerNextAt: nextAt };
  const startedAt = profile.profilerStartedAt ?? now;

  if (!question || !shown) {
    // Nothing pending right now: re-check at the next window, the same place
    // `awaitNextProfilerWindow` parks a Telegram user.
    await prisma.profile.updateMany({
      where: guard,
      data: {
        profilerStartedAt: startedAt,
        profilerBatchRemaining: 0,
        profilerNextAt: nextWindowAt(now, resolveZone(profile.timeZone)),
      },
    });
    return {};
  }

  // Same sizing as the worker's `startProfilerBatch`: rush mode shrinks the
  // batch when a drop is imminent.
  const batchSize = batchSizeFor(isRushMode(now, getNextBatchDate(now)));
  const { count } = await prisma.profile.updateMany({
    where: guard,
    data: {
      profilerStartedAt: startedAt,
      ...profilerActiveQuestionPatch(question.id, batchSize - 1, now, null),
    },
  });
  if (count === 1) return liveBatch(shown, batchSize - 1);
  return currentLiveBatch(userId, language, now);
}

/** Whatever is live after a lost race — possibly nothing (the winner is still sending). */
async function currentLiveBatch(
  userId: string,
  language: Language,
  now: Date,
): Promise<NativeProfilerBatch> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { profilerActiveQuestionId: true, profilerBatchRemaining: true },
  });
  const active = profile?.profilerActiveQuestionId
    ? profilerQuestionById(profile.profilerActiveQuestionId)
    : undefined;
  if (!profile || !active) return {};
  const shown = await view(userId, active, language, now);
  return shown ? liveBatch(shown, profile.profilerBatchRemaining) : {};
}

/**
 * Resolve the live question from the app — an answer, the Skip button, or a
 * refusal typed as an answer — then advance the batch.
 *
 * Telegram parity, step for step:
 *   - the question is claimed with the same compare-and-set as the chat, so a
 *     question already answered in Telegram (or expired, or answered by a
 *     double tap) is refused with `question_not_active`;
 *   - Skip → `skipTransition` via `upsertProfilerSkip` (returns once per cycle);
 *   - a refusal ("later", "не хочу"…, `isProfilerRefusal`) is recorded as a skip
 *     and PAUSES the rest of the batch to the next local window — `paused`;
 *   - anything else is stored exactly as `recordProfilerAnswer` stores it.
 */
export async function answerNativeProfilerQuestion(
  userId: string,
  questionId: string,
  reply: NativeProfilerReply,
  now: Date = new Date(),
): Promise<NativeProfilerAnswerResult> {
  const question = profilerQuestionById(questionId);
  if (!question) return { ok: false, error: "question_not_active" };

  const claim = await claimActiveQuestion(userId, questionId);
  if (!claim.claimed) return { ok: false, error: "question_not_active" };

  const cycleId = profilerCycleId(now);
  const refusal = reply.kind === "text" && isProfilerRefusal(reply.text);
  if (reply.kind === "skip" || refusal) {
    await upsertProfilerSkip(userId, question, cycleId);
  } else {
    const answerText = reply.text.trim().slice(0, PROFILER_MAX_ANSWER_LEN);
    await upsertProfilerAnswer(userId, question, answerText, now, cycleId);
  }

  // Re-read AFTER the write, so selection sees the row just recorded.
  const state = await loadProfilerState(userId);
  if (!state) return { ok: true, outcome: "done" };
  await retireTelegramCopy(state, claim.messageId);

  if (refusal) {
    await pauseBatchUntilNextWindow(userId, now, state.timeZone);
    return { ok: true, outcome: "paused" };
  }
  return advance(state, now);
}

/**
 * `advanceAfterReply` without a chat: the same gate and the same batch step,
 * but the next question goes back in the response instead of into a message.
 * No batch-boundary narration either — the app draws its own ending.
 */
async function advance(
  state: ProfilerUserState,
  now: Date,
): Promise<NativeProfilerAnswerResult> {
  // A negotiation that started mid-batch: the answer is kept, the rest waits.
  if (await hasActiveDatePlanning(state.userId)) {
    await pauseBatchUntilNextWindow(state.userId, now, state.timeZone);
    return { ok: true, outcome: "done" };
  }
  const step = nextProfilerBatchStep(
    state.gender,
    state.answers,
    state.profilerBatchRemaining,
    profilerCycleId(now),
  );
  if (step.kind === "boundary") {
    await pauseBatchUntilNextWindow(state.userId, now, state.timeZone);
    return { ok: true, outcome: "done" };
  }
  // Mid-batch steps are bank questions (only an opening question is ever
  // contextual), which never go stale — `shown` is null only for an exhausted step.
  const shown =
    step.kind === "ask" ? await view(state.userId, step.question, state.language, now) : null;
  if (step.kind === "exhausted" || !shown) {
    await awaitNextProfilerWindow(state.userId, state.gender, now, state.timeZone);
    return { ok: true, outcome: "done" };
  }
  await prisma.profile.update({
    where: { userId: state.userId },
    data: profilerActiveQuestionPatch(step.question.id, state.profilerBatchRemaining - 1, now, null),
  });
  return {
    ok: true,
    outcome: "next",
    question: shown,
    remaining: state.profilerBatchRemaining,
  };
}

/**
 * The question was resolved in the app, but the bot had sent it to Telegram
 * too (a `both` user): its Skip button would keep looking live there. Strip it,
 * best effort — `stripQuestionKeyboard` never throws, and no bot handle (tests,
 * early boot) simply skips the cosmetic step. A question the app opened has no
 * message id and costs nothing here.
 */
async function retireTelegramCopy(
  state: ProfilerUserState,
  messageId: number | null,
): Promise<void> {
  if (!messageId) return;
  const api = getMainBotApi();
  if (!api) return;
  await stripQuestionKeyboard(api, state.telegramId, messageId);
}
