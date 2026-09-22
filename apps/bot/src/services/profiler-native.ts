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
  claimActiveQuestion,
  finishOrAwaitNextCycle,
  hasActiveDatePlanning,
  loadProfilerState,
  pauseBatchUntilNextWindow,
  profilerCycleId,
  stripQuestionKeyboard,
  upsertProfilerAnswer,
  upsertProfilerSkip,
  type ProfilerUserState,
} from "./profiler.js";

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

function view(question: ProfilerQuestion, language: Language): NativeProfilerQuestion {
  return { id: question.id, text: profilerQuestionText(question, language) };
}

/**
 * The live question as the app sees it. `Profile.profilerBatchRemaining` does
 * NOT count the live question (a batch of 3 stores 2 while its first question
 * is out — that is how the Telegram path has always kept it), while the API's
 * `remaining` does, so a client can say "last one" when it reads 1.
 */
function liveBatch(
  question: ProfilerQuestion,
  language: Language,
  storedRemaining: number,
): NativeProfilerBatch {
  return { question: view(question, language), remaining: Math.max(storedRemaining, 0) + 1 };
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
    if (active) return liveBatch(active, language, profile.profilerBatchRemaining);
    // An id the bank no longer has (a question retired while it was live) can
    // never be answered, and nothing expires it for a mobile-only user — so
    // release it instead of stranding them. Its stall deadline stays, so the
    // next batch opens once that passes.
    await prisma.profile.updateMany({
      where: { userId, profilerActiveQuestionId: activeId },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
      },
    });
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
      skipped: true,
      skipReturned: true,
      cycleId: true,
    },
  });
  const question = selectNextProfilerQuestion(user.gender, answers, profilerCycleId(now));

  // Compare-and-set on exactly what was read: no live question AND the same
  // `profilerNextAt`. The worker (for a `both` user) or a parallel request that
  // got there first changes one of the two, so exactly one opener wins and the
  // other falls through to reporting what is live.
  const guard = { userId, profilerActiveQuestionId: null, profilerNextAt: nextAt };
  const startedAt = profile.profilerStartedAt ?? now;

  if (!question) {
    // Nothing pending this cycle: re-check at the next window, the same place
    // `finishOrAwaitNextCycle` parks a Telegram user.
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
  if (count === 1) return liveBatch(question, language, batchSize - 1);
  return currentLiveBatch(userId, language);
}

/** Whatever is live after a lost race — possibly nothing (the winner is still sending). */
async function currentLiveBatch(userId: string, language: Language): Promise<NativeProfilerBatch> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { profilerActiveQuestionId: true, profilerBatchRemaining: true },
  });
  const active = profile?.profilerActiveQuestionId
    ? profilerQuestionById(profile.profilerActiveQuestionId)
    : undefined;
  if (!profile || !active) return {};
  return liveBatch(active, language, profile.profilerBatchRemaining);
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
  if (step.kind === "exhausted") {
    await finishOrAwaitNextCycle(state.userId, state.gender, now, state.timeZone);
    return { ok: true, outcome: "done" };
  }
  if (step.kind === "boundary") {
    await pauseBatchUntilNextWindow(state.userId, now, state.timeZone);
    return { ok: true, outcome: "done" };
  }
  await prisma.profile.update({
    where: { userId: state.userId },
    data: profilerActiveQuestionPatch(step.question.id, state.profilerBatchRemaining - 1, now, null),
  });
  return {
    ok: true,
    outcome: "next",
    question: view(step.question, state.language),
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
