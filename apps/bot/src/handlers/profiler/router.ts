import { Composer } from "grammy";
import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import { PROFILER_ANSWER_DEBOUNCE_MS } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { dispatchToChat } from "../../chat-queue.js";
import {
  PROFILER_SKIP_PREFIX,
  closeProfilerAnswerWindow,
  recordProfilerAnswer,
  recordProfilerSkip,
  resolveProfilerCapture,
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
 * Recording itself is guarded by an atomic claim on that column, so a stale or
 * replayed tap can never record twice or push out an extra question.
 *
 * An active question does NOT own the chat indefinitely. Free text is recorded
 * as its answer only while the question still owns the conversation — a short
 * implicit window, closed early by any other interaction — or when the user
 * replies to the question message directly (`resolveProfilerCapture`).
 * Everything else falls through to the menu agent.
 */
export const profilerRouter = new Composer<BotContext>();

// ---------------------------------------------------------------------------
// Free-text answer coalescing
// ---------------------------------------------------------------------------

/**
 * Per-chat accumulator for a free-text Profiler answer.
 *
 * People routinely split one answer across several messages. Because updates
 * for a chat are processed serially and the reply to an answer is a *new*
 * question, handling each message immediately meant message 2 was recorded as
 * the answer to the question that message 1 had just triggered — burning
 * several questions in seconds and mis-attributing the text. Buffering for a
 * short window and flushing once fixes both. Mirrors the onboarding photo /
 * context-dump batchers.
 */
interface AnswerAccumulator {
  chatId: number;
  userId: string;
  questionId: string;
  api: Api;
  lines: string[];
  /** Message id of the LAST buffered line — the reaction target. */
  messageId: number | undefined;
  timer: NodeJS.Timeout;
}

const answerAccumulators = new Map<number, AnswerAccumulator>();

function cancelAnswerFlush(chatId: number | undefined): void {
  if (chatId === undefined) return;
  const acc = answerAccumulators.get(chatId);
  if (!acc) return;
  clearTimeout(acc.timer);
  answerAccumulators.delete(chatId);
}

async function flushAnswer(acc: AnswerAccumulator): Promise<void> {
  const text = acc.lines.join("\n").trim();
  if (!text) return;
  await recordProfilerAnswer(acc.api, acc.userId, acc.questionId, text, {
    reactionTarget: { chatId: acc.chatId, messageId: acc.messageId },
  });
}

/**
 * Buffer one line of an answer and (re)arm the flush timer. The window measures
 * time since the LAST message, so a user typing three quick lines produces one
 * answer and one follow-up question.
 */
function bufferAnswerLine(
  chatId: number,
  userId: string,
  questionId: string,
  api: Api,
  text: string,
  messageId: number | undefined,
): void {
  const existing = answerAccumulators.get(chatId);
  // A different active question means the previous buffer belongs to a run that
  // has already moved on — drop it rather than mixing two answers.
  const lines = existing && existing.questionId === questionId ? existing.lines : [];
  if (existing) clearTimeout(existing.timer);

  const acc: AnswerAccumulator = {
    chatId,
    userId,
    questionId,
    api,
    lines: [...lines, text],
    messageId,
    timer: setTimeout(() => {
      if (answerAccumulators.get(chatId) !== acc) return;
      answerAccumulators.delete(chatId);
      dispatchToChat(chatId, () => flushAnswer(acc)).catch((err) =>
        console.error("[profiler] answer auto-flush failed:", err),
      );
    }, PROFILER_ANSWER_DEBOUNCE_MS),
  };
  answerAccumulators.set(chatId, acc);
}

profilerRouter.use(async (ctx, next) => {
  if (ctx.session.onboardingStep !== "completed" || !ctx.from?.id) {
    await next();
    return;
  }

  const data = ctx.callbackQuery?.data;

  // Skip button — resolve the user and skip the named question.
  if (data?.startsWith(PROFILER_SKIP_PREFIX)) {
    const questionId = data.slice(PROFILER_SKIP_PREFIX.length);
    // A skip supersedes anything half-typed for this chat.
    cancelAnswerFlush(ctx.chat?.id);
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true },
    });
    await ctx.answerCallbackQuery().catch(() => {});
    // Strip the keyboard from the tapped question so the button cannot be
    // pressed a second time. `recordProfilerSkip` is authoritative regardless
    // (it claims the active question atomically); this is the visible half of
    // the same guarantee.
    // No `reply_markup` = Telegram drops the keyboard from the message.
    await ctx.editMessageReplyMarkup().catch(() => {});
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
    // An active question is NOT enough to claim the text: it must still own the
    // conversation (fresh implicit window) or be replied to directly. Anything
    // else is a message to the assistant — "when is my date?" typed hours after
    // a question must reach the menu agent, not be recorded as its answer.
    const capture = await resolveProfilerCapture(BigInt(ctx.from.id), {
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
    });
    if (capture && ctx.chat) {
      bufferAnswerLine(
        ctx.chat.id,
        capture.userId,
        capture.questionId,
        ctx.api,
        text,
        ctx.message?.message_id,
      );
      return;
    }
  }

  // Anything else (a command, a menu tap, another flow) means the conversation
  // has moved on: abandon a half-typed answer, and close the implicit capture
  // window so the NEXT message isn't mis-read as an answer either. The question
  // itself stays active — Skip and reply-to still resolve it.
  if (!text || isCommand || !idle) {
    cancelAnswerFlush(ctx.chat?.id);
    await closeProfilerAnswerWindow(BigInt(ctx.from.id)).catch((err) =>
      console.error("[profiler] closing answer window failed:", err),
    );
  }

  await next();
});
