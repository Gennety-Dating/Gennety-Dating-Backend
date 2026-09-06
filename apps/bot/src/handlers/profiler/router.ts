import { Composer } from "grammy";
import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import {
  PROFILER_ANSWER_DEBOUNCE_MS,
  profilerQuestionAcceptsImage,
  profilerQuestionById,
  t,
} from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { dispatchToChat } from "../../chat-queue.js";
import {
  PROFILER_SKIP_PREFIX,
  closeProfilerAnswerWindow,
  recordProfilerAnswer,
  recordProfilerRefusal,
  recordProfilerSkip,
  resolveProfilerCapture,
} from "../../services/profiler.js";
import {
  answerProfilerQuestionWithImage,
  profilerImageFromMessage,
} from "../../services/profiler-image-answer.js";
import { answerProfilerQuestionWithLink } from "../../services/profiler-link-answer.js";
import {
  commentaryAroundLink,
  describeShortVideoLink,
  findShortVideoLink,
} from "../../services/short-video/index.js";
import { readMemeImage } from "../../services/vision/read-meme.js";
import { env } from "../../config.js";
import { downloadTelegramFile } from "../../services/storage.js";
import { isProfilerRefusal } from "../../services/profiler-intent.js";
import { isLikelyMetaQuestion } from "../../services/onboarding-collector.js";

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
 * plain-text / image / skip-callback updates from completed users not in
 * another flow.
 * Recording itself is guarded by an atomic claim on that column, so a stale or
 * replayed tap can never record twice or push out an extra question.
 *
 * An active question does NOT own the chat indefinitely. Free text is recorded
 * as its answer only while the question still owns the conversation — nothing
 * else has happened since it was sent, and past the implicit window the message
 * is not itself a question — or when the user replies to the question message
 * directly (`resolveProfilerCapture`). Everything else falls through to the
 * menu agent.
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

  // A refusal is not an answer. Classified on the COALESCED text rather than
  // per line, so "не хочу" split across two messages is still read once and as
  // a whole — the same reason the buffer exists at all.
  if (isProfilerRefusal(text)) {
    await recordProfilerRefusal(acc.api, acc.userId, acc.questionId);
    return;
  }

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
    // A TikTok / Reels link is an answer attempt, never a meta question, so it
    // suppresses the question-shaped test outright.
    const link = env.SHORT_VIDEO_LINKS_ENABLED ? findShortVideoLink(text) : null;
    // An active question is NOT enough to claim the text: it must still own the
    // conversation — nothing else has happened since it was sent — or be
    // replied to directly. Once the user has done anything at all the question
    // stops being the default addressee, and "when is my date?" reaches the
    // menu agent. Past the implicit window the question-shaped test is what
    // separates a late answer from a new topic (`shouldCaptureProfilerAnswer`).
    const capture = await resolveProfilerCapture(BigInt(ctx.from.id), {
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
      looksLikeQuestion: link ? false : isLikelyMetaQuestion(text),
    });
    if (capture && ctx.chat) {
      // A link, on a question that asked for a picture. Same gate as an image:
      // the question itself must accept one, so a reel sent while "early bird
      // or night owl" is live is still just text. Without this branch the URL
      // would be stored verbatim as the answer — which is what used to happen,
      // and what the icebreaker generator then had to read.
      const question = link ? profilerQuestionById(capture.questionId) : undefined;
      if (link && question && profilerQuestionAcceptsImage(question)) {
        cancelAnswerFlush(ctx.chat.id);
        const chatId = ctx.chat.id;
        // Fetching the post and describing its cover frame is seconds, and the
        // chat has said nothing since their link landed.
        await ctx.replyWithChatAction("typing").catch(() => {});
        const outcome = await answerProfilerQuestionWithLink(
          link,
          commentaryAroundLink(text),
          capture.language,
          {
            analyze: (ref, language) =>
              describeShortVideoLink(ctx.api, chatId, ref, language),
            record: (answer, media) =>
              recordProfilerAnswer(ctx.api, capture.userId, capture.questionId, answer, {
                reactionTarget: { chatId, messageId: ctx.message?.message_id },
                ...(media ? { media } : {}),
              }),
          },
        );
        if (outcome === "unavailable") {
          await ctx
            .reply(t(capture.language, "profilerLinkUnreadable"))
            .catch(() => {});
        }
        return;
      }

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

  // A picture, when the live question asked for one ("send your favourite
  // meme"). Same ownership rule as text — the question must still own the
  // conversation — plus the question itself has to accept images, so a photo
  // sent while "are you an early bird or a night owl" is live still falls
  // through to the menu agent instead of burning that question.
  const image = !text && idle ? profilerImageFromMessage(ctx.message) : null;
  if (image && ctx.chat) {
    const capture = await resolveProfilerCapture(BigInt(ctx.from.id), {
      replyToMessageId: ctx.message?.reply_to_message?.message_id,
    });
    const question = capture ? profilerQuestionById(capture.questionId) : undefined;
    if (capture && question && profilerQuestionAcceptsImage(question)) {
      cancelAnswerFlush(ctx.chat.id);
      const chatId = ctx.chat.id;
      // The vision round-trip is seconds, not milliseconds, and the user is
      // looking at a chat that has said nothing since their meme landed.
      await ctx.replyWithChatAction("typing").catch(() => {});
      const outcome = await answerProfilerQuestionWithImage(image, capture.language, {
        download: (fileId) => downloadTelegramFile(ctx.api, fileId),
        read: (img, caption) =>
          readMemeImage(img, { language: capture.language, caption }),
        record: (answer, media) =>
          recordProfilerAnswer(ctx.api, capture.userId, capture.questionId, answer, {
            reactionTarget: { chatId, messageId: ctx.message?.message_id },
            ...(media ? { media } : {}),
          }),
      });
      // Nothing usable and nothing to fall back on: say so once and leave the
      // question live, so answering in words still works.
      if (outcome !== "recorded" && outcome !== "recorded_caption") {
        await ctx
          .reply(t(capture.language, "profilerImageUnreadable"))
          .catch(() => {});
      }
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
