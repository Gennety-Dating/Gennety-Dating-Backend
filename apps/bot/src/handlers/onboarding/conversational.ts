import { InlineKeyboard, type Api } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import type { SessionData } from "@gennety/shared";
import {
  MIN_PHOTOS,
  MAX_PHOTOS,
  PHOTO_BONUS_TICKET_THRESHOLD,
  PROFILE_MEDIA_VALIDATION_VERSION,
  MAX_DUMP_BUFFER_CHARS,
  magicContextPrompt,
  DEFAULT_SESSION,
  normalizeProfileMedia,
  profileMediaHasVideo,
  t,
  type ProfileMedia,
  type ProfileVideoMedia,
} from "@gennety/shared";
import {
  runAgentTurn,
  injectSystemMessage,
  recordOnboardingAssistantReply,
} from "../../services/onboarding-agent.js";
import { validateSingleFace } from "../../services/vision/validate-face.js";
import { downloadTelegramFile } from "../../services/storage.js";
import { validateUserProfilePhoto } from "../../services/profile-media-validation/profile-photo-validation.js";
import {
  commitProfilePhotoCandidate,
  type PhotoConsensusCommitResult,
} from "../../services/profile-media-validation/identity-consensus.js";
import type { MediaValidationReason } from "../../services/profile-media-validation/types.js";
import { validateUserProfileVideo } from "../../services/profile-media-validation/profile-video-validation.js";
import { logMediaValidationRejection } from "../../services/profile-media-validation/rejection-log.js";
import { photoUploadStatePatch } from "../../services/profile-media-validation/photo-state.js";
import { showMainMenu } from "../menu/main.js";
import { withTyping } from "../../utils/with-typing.js";
import { pinStatusBanner } from "../../services/status-banner.js";
import { dispatchToChat } from "../../chat-queue.js";
import { sendVerificationCTA } from "./verification.js";
import {
  getMessageLivePhoto,
  getMessageVideo,
  incomingLivePhotoMedia,
  incomingPhotoMedia,
  incomingVideoMedia,
  type IncomingProfileMedia,
} from "../../services/telegram-profile-media.js";
import { profileMediaToJson } from "../../services/profile-media-json.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import {
  onboardingThinkingSteps,
  profileAnalysisSteps,
  videoCheckSteps,
} from "../../services/analysis-status.js";
import { env } from "../../config.js";
import {
  grantPhotoBonusIfEligible,
  grantVideoBonusIfEligible,
} from "../../services/ticket-wallet.js";
import { sendTicketRewardDM } from "../../services/ticket-reward.js";
import {
  isPhotoStageContinueText,
  onboardingPhotoStageText,
} from "../../services/onboarding-photo-stage.js";
import {
  MESSAGE_REACTION,
  reactToMessage,
} from "../../services/message-reactions.js";

/** Backward compatibility for confirmation buttons sent before auto-flush. */
const DUMP_DONE_CALLBACK = "dump:done";
export const ONBOARDING_PHOTOS_CONTINUE_CALLBACK =
  "onboarding:photos:continue";
const CONTEXT_DUMP_DEBOUNCE_MS = 2_000;

/**
 * Cadence of the periodic "thinking" pause during the profile survey: a short
 * thinking shimmer is held before composing every Nth question's reply.
 */
const ONBOARDING_THINKING_EVERY = 3;

/**
 * Deliberate pad held on the final "last checks" video-status beat AFTER the
 * real validation has settled, so the thinking sequence never flashes away the
 * instant a fast check returns. The video validation runs in parallel with the
 * pacing beats; this only extends the held tail by a couple of seconds.
 */
const VIDEO_CHECK_STATUS_PAD_MS = 1_800;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Heuristic split between a real LLM dump and a clarifying question while
 * awaitingContextDump is true. Real ChatGPT/Claude responses to the Magic
 * Prompt run 2,000–15,000 chars; user questions almost never exceed 400.
 * A long-but-borderline question (> 400) lands in the buffer and is
 * surfaced by execSaveContextDump's 200-char minimum on Done.
 */
const SHORT_MESSAGE_THRESHOLD = 400;

/**
 * Handle all messages during the `conversational` onboarding step.
 *
 * Text messages are forwarded to the LLM agent. Photo messages are
 * validated via the vision service and the result is injected into the
 * conversation history before triggering another agent turn.
 *
 * When the agent has requested the context dump (awaitingContextDump = true),
 * incoming text is accumulated in contextDumpBuffer instead of being sent to
 * the agent immediately. The pasted response is acknowledged, then the full
 * buffer is sent to the agent automatically after a short processing delay.
 */
export async function handleConversational(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);

  // ---- Legacy confirmation buttons already present in older chats ----
  if (ctx.callbackQuery?.data === DUMP_DONE_CALLBACK) {
    await ctx.answerCallbackQuery();
    cancelContextDumpFlush(ctx.chat?.id);
    await flushContextDump(ctx, telegramId);
    return;
  }

  // ---- Live Photo message ----
  const livePhoto = getMessageLivePhoto(ctx.message);
  if (livePhoto) {
    if (ctx.session.awaitingContextDump) {
      ctx.session.expectingPhoto = false;
      await ctx.reply(contextDumpPhotoNudge(ctx.session.language));
      return;
    }
    const extracted = incomingLivePhotoMedia(livePhoto);
    if (!extracted.ok) {
      await ctx.reply(livePhotoRejectionMessage(ctx.session.language, extracted.reason));
      return;
    }
    await handleProfileMediaMessage(
      ctx,
      telegramId,
      extracted.media,
      ctx.message?.media_group_id,
    );
    return;
  }

  // ---- Video message (display-only profile media; earns a ticket bonus) ----
  const video = getMessageVideo(ctx.message);
  if (video) {
    if (ctx.session.awaitingContextDump) {
      ctx.session.expectingPhoto = false;
      await ctx.reply(contextDumpPhotoNudge(ctx.session.language));
      return;
    }
    const extracted = incomingVideoMedia(video);
    if (!extracted.ok) {
      void logTelegramMediaRejection(
        telegramId,
        "video",
        extracted.reason === "too_long"
          ? "video_too_long"
          : "video_too_large_to_check",
      );
      await ctx.reply(
        extracted.reason === "too_long"
          ? t(ctx.session.language, "videoTooLong")
          : t(ctx.session.language, "videoTooLarge"),
      );
      return;
    }
    await handleProfileVideoMessage(ctx, telegramId, extracted.media);
    return;
  }

  // ---- Photo message (compressed or sent as document) ----
  const photo = ctx.message?.photo;
  if (photo && photo.length > 0) {
    if (ctx.session.awaitingContextDump) {
      ctx.session.expectingPhoto = false;
      await ctx.reply(contextDumpPhotoNudge(ctx.session.language));
      return;
    }
    const incoming = incomingPhotoMedia(photo);
    if (!incoming) return;
    await handleProfileMediaMessage(
      ctx,
      telegramId,
      incoming,
      ctx.message?.media_group_id,
    );
    return;
  }

  const doc = ctx.message?.document;
  if (doc && doc.mime_type?.startsWith("image/")) {
    if (ctx.session.awaitingContextDump) {
      ctx.session.expectingPhoto = false;
      await ctx.reply(contextDumpPhotoNudge(ctx.session.language));
      return;
    }
    // Telegram sends uncompressed photos as documents — treat them the same
    const incoming = incomingPhotoMedia([
      { file_id: doc.file_id, file_unique_id: doc.file_unique_id, width: 0, height: 0 },
    ]);
    if (!incoming) return;
    await handleProfileMediaMessage(
      ctx,
      telegramId,
      incoming,
      ctx.message?.media_group_id,
    );
    return;
  }

  // ---- Text message ----
  const text = ctx.message?.text ?? ctx.callbackQuery?.data;
  if (!text) return;

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery();
  }

  const photoStageActive =
    ctx.session.expectingPhoto &&
    ctx.session.pendingPhotos.length >= MIN_PHOTOS;
  const continuePhotoStage =
    ctx.callbackQuery?.data === ONBOARDING_PHOTOS_CONTINUE_CALLBACK ||
    (photoStageActive &&
      Boolean(ctx.message?.text) &&
      isPhotoStageContinueText(text));

  if (
    ctx.callbackQuery?.data === ONBOARDING_PHOTOS_CONTINUE_CALLBACK &&
    !photoStageActive
  ) {
    if (ctx.chat) {
      await sendPhotoStagePrompt(
        ctx.api,
        ctx.chat.id,
        telegramId,
        ctx.session.language,
        ctx.session.pendingPhotos.length,
        sessionHasProfileVideo(ctx.session),
      );
    }
    return;
  }

  if (photoStageActive && !continuePhotoStage) {
    if (ctx.chat) {
      await sendPhotoStagePrompt(
        ctx.api,
        ctx.chat.id,
        telegramId,
        ctx.session.language,
        ctx.session.pendingPhotos.length,
        sessionHasProfileVideo(ctx.session),
      );
    }
    return;
  }

  // ---- Context dump buffering mode ----
  // When awaitingContextDump is true the Magic Prompt has already been shown.
  // Substantial pasted responses are forwarded after a short idle pause.
  //
  // Routing: a short message arriving while the buffer is still empty is
  // almost certainly a question ("why do I need to do this?"), not the LLM
  // dump — real ChatGPT/Claude responses to the Magic Prompt run thousands
  // of chars. Threshold lets the LLM answer the question without trapping
  // the user in buffer mode.
  if (ctx.session.awaitingContextDump) {
    const bufferEmpty = ctx.session.contextDumpBuffer.length === 0;
    const looksLikeQuestion =
      bufferEmpty && text.length < SHORT_MESSAGE_THRESHOLD;
    if (looksLikeQuestion) {
      // Fall through to the normal runAgentTurn call below — buffer stays
      // empty, awaitingContextDump stays true, the user can paste afterwards.
    } else {
      await handleContextDumpChunk(ctx, telegramId, text);
      return;
    }
  }

  // ---- Periodic "thinking" pause during the profile survey ----
  // Every ONBOARDING_THINKING_EVERY answered questions, hold a short "thinking"
  // shimmer BEFORE the next question is composed. This must run before any
  // typing indicator: the typing action only starts inside withTyping below,
  // strictly after this status is torn down, and question generation does not
  // start until the pause completes. Only real typed survey answers count —
  // not photo-stage continues, photo uploads, or context-dump pastes.
  const isSurveyAnswer =
    Boolean(ctx.message?.text) &&
    !continuePhotoStage &&
    !ctx.session.expectingPhoto &&
    !ctx.session.awaitingContextDump;
  if (isSurveyAnswer) {
    const answered = (ctx.session.onboardingAnswerCount ?? 0) + 1;
    ctx.session.onboardingAnswerCount = answered;
    if (answered % ONBOARDING_THINKING_EVERY === 0 && ctx.chat?.id !== undefined) {
      await runStatusSequence(
        ctx.api,
        ctx.chat.id,
        onboardingThinkingSteps(ctx.session.language),
        { rich: true },
      );
    }
  }

  // ---- Normal conversational turn ----
  const result = await withTyping(ctx, () =>
    runAgentTurn(
      telegramId,
      continuePhotoStage ? { kind: "photos_continue" } : text,
    ),
  );

  if (
    ctx.message?.text &&
    result.acceptedOnboardingFields?.includes("hobbies")
  ) {
    await reactToMessage(
      ctx.api,
      { chatId: ctx.chat?.id, messageId: ctx.message.message_id },
      MESSAGE_REACTION.like,
    );
  }

  if (result.contextDumpStarted) {
    ctx.session.awaitingContextDump = true;
    ctx.session.contextDumpBuffer = "";
    ctx.session.expectingPhoto = false;
  } else {
    ctx.session.expectingPhoto = result.expectingPhoto;
  }

  if (result.onboardingComplete) {
    ctx.session.onboardingStep = "completed";
    ctx.session.menuState = "idle";
    ctx.session.expectingPhoto = false;
    ctx.session.pendingPhotos = [];
    ctx.session.pendingProfileMedia = [];
    ctx.session.pendingPhotoUniqueIds = [];
    ctx.session.pendingPhotoHashes = [];
    ctx.session.pendingPhotoScores = [];
  }

  // Send the Magic Prompt BEFORE the agent reply so it appears above
  // the instructions in the chat — user sees prompt first, then explanation.
  if (result.contextPromptRequested) {
    const prompt = magicContextPrompt(ctx.session.language);
    try {
      await ctx.reply(`<pre>${escapeHtml(prompt)}</pre>`, {
        parse_mode: "HTML",
      });
    } catch (err) {
      console.error("Failed to send Magic Prompt as HTML <pre>, falling back to plain text:", err);
      try {
        await ctx.reply(prompt);
      } catch (err2) {
        console.error("Failed to send Magic Prompt as plain text:", err2);
        await ctx.reply("⚠️ Couldn't send the prompt. Please try again — type anything and I'll resend it.");
      }
    }
  }

  if (result.contextDumpSaved && ctx.chat?.id !== undefined) {
    await runStatusSequence(ctx.api, ctx.chat.id, profileAnalysisSteps(ctx.session.language));
  }

  await sendAgentReply(ctx, result.reply);

  if (result.onboardingComplete) {
    // When verification is required (Sumsub configured), send the liveness
    // CTA instead of the main menu — the user is not yet `active` and
    // showing the "next match" banner would be misleading. The webhook
    // flips them to active + pins the banner on GREEN.
    if (result.verificationRequired) {
      const sent = await sendVerificationCTA(ctx);
      if (sent) return;
      // Fall through to the normal flow if CTA couldn't be sent (misconfig,
      // Sumsub outage) — better to let the user into the app than to stall.
    }
    await showMainMenu(ctx);
    await pinStatusBanner(ctx.api, telegramId, ctx.session.language);
  }
}

// ---------------------------------------------------------------------------
// Context dump buffer accumulation
// ---------------------------------------------------------------------------

/**
 * Append a text chunk to `contextDumpBuffer` while awaitingContextDump=true.
 * Caller has already decided this message is a paste, not a question.
 */
async function handleContextDumpChunk(
  ctx: BotContext,
  telegramId: bigint,
  text: string,
): Promise<void> {
  const current = ctx.session.contextDumpBuffer;

  // Hard cap: if the paste is already at/over the cap, stop accepting new
  // chunks and auto-flush what we have. Prevents an abusive/looped paste
  // from growing the session row without bound.
  if (current.length >= MAX_DUMP_BUFFER_CHARS) {
    await ctx.reply(
      "That's more than I can store — let me work with what you've pasted so far.",
    );
    cancelContextDumpFlush(ctx.chat?.id);
    await flushContextDump(ctx, telegramId);
    return;
  }

  const separator = current.length > 0 ? "\n" : "";
  const room = MAX_DUMP_BUFFER_CHARS - current.length - separator.length;
  const truncated = text.length > room;
  const chunk = truncated ? text.slice(0, Math.max(0, room)) : text;
  ctx.session.contextDumpBuffer = current + separator + chunk;

  // No "received" ack here — the paste is acknowledged by the analysing
  // status sequence (profileAnalysisSteps) that plays after the debounce
  // flush, so an extra "processing…" line would just be chat noise.
  // Additional text arriving before the flush silently extends the debounce.

  // If this chunk filled the buffer, auto-flush so we don't silently drop
  // the rest of the user's paste into the void.
  if (truncated) {
    await ctx.reply(
      "That's all I can store — processing what we have now.",
    );
    cancelContextDumpFlush(ctx.chat?.id);
    await flushContextDump(ctx, telegramId);
    return;
  }

  scheduleContextDumpFlush(ctx, telegramId);
}

// ---------------------------------------------------------------------------
// Context dump flush
// ---------------------------------------------------------------------------

interface ContextDumpAccumulator {
  chatId: number;
  telegramId: bigint;
  api: Api;
  timer: NodeJS.Timeout;
}

const contextDumpAccumulators = new Map<number, ContextDumpAccumulator>();

function scheduleContextDumpFlush(ctx: BotContext, telegramId: bigint): void {
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  cancelContextDumpFlush(chatId);
  const acc: ContextDumpAccumulator = {
    chatId,
    telegramId,
    api: ctx.api,
    timer: setTimeout(() => {
      if (contextDumpAccumulators.get(chatId) !== acc) return;
      contextDumpAccumulators.delete(chatId);
      dispatchToChat(chatId, () => flushPersistedContextDump(acc)).catch((err) =>
        console.error("Context dump auto-flush failed:", err),
      );
    }, CONTEXT_DUMP_DEBOUNCE_MS),
  };
  contextDumpAccumulators.set(chatId, acc);
}

function cancelContextDumpFlush(chatId: number | undefined): void {
  if (!chatId) return;
  const acc = contextDumpAccumulators.get(chatId);
  if (!acc) return;
  clearTimeout(acc.timer);
  contextDumpAccumulators.delete(chatId);
}

/**
 * Flush the current update's accumulated contextDumpBuffer as a single turn.
 * Used for the size cap and backward-compatible clicks on old Done buttons.
 */
async function flushContextDump(ctx: BotContext, telegramId: bigint): Promise<void> {
  const buffer = ctx.session.contextDumpBuffer.trim();

  if (!buffer) {
    await ctx.reply("Hmm, I don't have anything buffered yet. Paste the AI response first.");
    return;
  }

  // Clear buffering mode before the agent call so any re-entry is clean
  ctx.session.awaitingContextDump = false;
  ctx.session.contextDumpBuffer = "";

  const result = await withTyping(ctx, () =>
    runAgentTurn(telegramId, { kind: "context_dump", text: buffer }),
  );

  if (result.contextDumpStarted) {
    ctx.session.awaitingContextDump = true;
    ctx.session.contextDumpBuffer = "";
    ctx.session.expectingPhoto = false;
  } else {
    ctx.session.expectingPhoto = result.expectingPhoto;
  }

  if (result.onboardingComplete) {
    ctx.session.onboardingStep = "completed";
    ctx.session.menuState = "idle";
    ctx.session.expectingPhoto = false;
    ctx.session.pendingPhotos = [];
    ctx.session.pendingProfileMedia = [];
    ctx.session.pendingPhotoUniqueIds = [];
    ctx.session.pendingPhotoHashes = [];
    ctx.session.pendingPhotoScores = [];
  }

  if (result.contextDumpSaved && ctx.chat?.id !== undefined) {
    await runStatusSequence(ctx.api, ctx.chat.id, profileAnalysisSteps(ctx.session.language));
  }

  await sendAgentReply(ctx, result.reply);

  if (result.onboardingComplete) {
    // When verification is required (Sumsub configured), send the liveness
    // CTA instead of the main menu — the user is not yet `active` and
    // showing the "next match" banner would be misleading. The webhook
    // flips them to active + pins the banner on GREEN.
    if (result.verificationRequired) {
      const sent = await sendVerificationCTA(ctx);
      if (sent) return;
      // Fall through to the normal flow if CTA couldn't be sent (misconfig,
      // Sumsub outage) — better to let the user into the app than to stall.
    }
    await showMainMenu(ctx);
    await pinStatusBanner(ctx.api, telegramId, ctx.session.language);
  }
}

/**
 * Auto-flush runs outside the Telegram update lifecycle, so it reloads and
 * persists the Prisma-backed session instead of mutating a stale ctx.session.
 */
async function flushPersistedContextDump(
  acc: ContextDumpAccumulator,
): Promise<void> {
  const key = acc.chatId.toString();

  try {
    const row = await prisma.botSession.findUnique({ where: { key } });
    const session: SessionData = {
      ...DEFAULT_SESSION,
      ...((row?.data ?? {}) as Partial<SessionData>),
    };
    const buffer = session.contextDumpBuffer.trim();
    if (!session.awaitingContextDump || !buffer) return;

    session.awaitingContextDump = false;
    session.contextDumpBuffer = "";

    const result = await runAgentTurn(acc.telegramId, {
      kind: "context_dump",
      text: buffer,
    });

    if (result.contextDumpStarted) {
      session.awaitingContextDump = true;
      session.contextDumpBuffer = "";
      session.expectingPhoto = false;
    } else {
      session.expectingPhoto = result.expectingPhoto;
    }

    if (result.onboardingComplete) {
      markOnboardingComplete(session);
    }

    await prisma.botSession.upsert({
      where: { key },
      create: { key, data: session as unknown as object },
      update: { data: session as unknown as object },
    });

    if (result.contextDumpSaved) {
      await runStatusSequence(acc.api, acc.chatId, profileAnalysisSteps(session.language));
    }

    await replyText(acc.api, acc.chatId, result.reply);

    if (result.onboardingComplete) {
      const language = session.language;
      if (result.verificationRequired) {
        const { sendVerificationCTABare } = await import("./verification.js");
        const sent = await sendVerificationCTABare(
          acc.api,
          acc.chatId,
          acc.telegramId,
          language,
        );
        if (sent) return;
      }
      const { sendMainMenu } = await import("../menu/main.js");
      await sendMainMenu(acc.api, acc.chatId, language, acc.telegramId);
      await pinStatusBanner(acc.api, acc.telegramId, language);
    }
  } catch (err) {
    console.error("Context dump auto-flush failed:", err);
    try {
      await acc.api.sendMessage(
        acc.chatId,
        "I couldn't process that response. Please send it again.",
      );
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send the agent's reply with Markdown formatting.
 * Falls back to plain text if the LLM included malformed Markdown that
 * Telegram's parser rejects (e.g. unmatched asterisks or underscores).
 */
async function sendAgentReply(ctx: BotContext, reply: string): Promise<void> {
  try {
    await ctx.reply(reply, { parse_mode: "Markdown" });
  } catch {
    // Strip Markdown markers and send as plain text
    await ctx.reply(reply.replace(/[*_`[\]]/g, ""));
  }
}

/** Escape HTML special characters for Telegram HTML parse mode */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function contextDumpPhotoNudge(language: string): string {
  switch (language) {
    case "ru":
      return "Сначала скинь ответ из AI-чата на промпт выше. Фото будут следующим шагом.";
    case "uk":
      return "Спочатку надішли відповідь з AI-чату на промпт вище. Фото будуть наступним кроком.";
    case "de":
      return "Schick zuerst die Antwort aus dem AI-Chat zum Prompt oben. Fotos kommen danach.";
    case "pl":
      return "Najpierw wyślij odpowiedź z czatu AI na prompt powyżej. Zdjęcia będą następnym krokiem.";
    default:
      return "Send the AI-chat response to the prompt above first. Photos come after that.";
  }
}

// ---------------------------------------------------------------------------
// Photo handling
// ---------------------------------------------------------------------------

/**
 * Per-chat accumulator for incoming photos.
 *
 * All photos (album frames AND standalone photo messages) flow through this
 * batcher so we can send exactly ONE progress response per upload burst.
 * Why: vision validation takes several seconds per photo, and under
 * `sequentializeByChat` frames are processed serially. If we fired an
 * response per frame, the user would see "got 1, need one more" long
 * before the last frame finished processing — then a second "got all"
 * message seconds later. That's the classic "bot is confused" UX.
 *
 * Keyed by chat id. `mediaGroupId` is:
 *   - the Telegram album id when the user sent a true album;
 *   - `null` for standalone photo messages, which still coalesce as long
 *     as they arrive within the debounce window.
 * If a new frame arrives with a different group id, the current batch
 * is flushed first and a new one is started.
 *
 * The debounce timer is (re)armed AFTER each frame's validation
 * completes — not before — so the window measures "time since the last
 * frame was fully processed", not "time since the first frame arrived".
 * Without this, slow vision calls made the 700ms window elapse before
 * frame 2 could join the batch, producing one agent turn per frame.
 */
interface PhotoBatchAccumulator {
  mediaGroupId: string | null;
  chatId: number;
  telegramId: bigint;
  api: Api;
  /** How many frames were accepted by vision validation */
  validatedCount: number;
  /** How many frames were rejected (no clear face) */
  rejectedCount: number;
  /** How many frames were ignored because MAX_PHOTOS was already reached */
  extraIgnoredCount: number;
  /** How many frames were already present in the current profile */
  duplicateCount: number;
  /** Latest unverified-photo consensus status within this burst. */
  consensusStatus: PhotoConsensusCommitResult["status"] | null;
  /** How many candidate photos are waiting for a matching peer. */
  consensusPendingCount: number;
  /** How many pending outliers were rejected when a cluster formed. */
  consensusRejectedCount: number;
  /** Structured rejection counts for the unified validation pipeline. */
  rejectionReasons: Partial<Record<MediaValidationReason, number>>;
  /** True if any frame hit an infra error (getFile / OpenAI failure) */
  hadInfraError: boolean;
  /** True when the batch arrived before `request_photos` was called */
  unsolicited: boolean;
  timer: NodeJS.Timeout | null;
}

const photoBatchAccumulators = new Map<number, PhotoBatchAccumulator>();
const PHOTO_BATCH_DEBOUNCE_MS = 700;

async function handleProfileMediaMessage(
  ctx: BotContext,
  telegramId: bigint,
  media: IncomingProfileMedia,
  mediaGroupId: string | undefined,
): Promise<void> {
  if (!ctx.chat) return;
  await handlePhotoFrame(ctx, telegramId, media, mediaGroupId ?? null);
}

/**
 * Outcome of the parallel download+validation work covered by the video-check
 * thinking shimmer. `unavailable` folds download failures and unexpected errors
 * into the "processing unavailable" path.
 */
type VideoCheckOutcome =
  | { kind: "unavailable" }
  | { kind: "validated"; validation: Awaited<ReturnType<typeof validateUserProfileVideo>> };

/**
 * Validate and persist a profile video (display-only, not counted toward
 * MIN_PHOTOS), then grant the one-time "added a video" ticket bonus.
 * The video is appended to `pendingProfileMedia` so a later photo upload's
 * `persistPhotos` keeps it (the static-photo alignment with `photos[]` is
 * preserved because video items are excluded from `staticPhotosFromProfileMedia`).
 */
async function handleProfileVideoMessage(
  ctx: BotContext,
  telegramId: bigint,
  media: ProfileVideoMedia,
): Promise<void> {
  if (!ctx.chat) return;
  const photoStageActive = ctx.session.expectingPhoto;
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  const existingMedia = normalizeProfileMedia(
    ctx.session.pendingProfileMedia,
    ctx.session.pendingPhotos,
  );
  const existingVideo = existingMedia.find((item) => item.type === "video");
  if (existingVideo?.video === media.video) {
    await ctx.reply(videoSavedAck(ctx.session.language));
    return;
  }

  let acceptedMedia = media;
  let statusAcknowledged = false;
  if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
    // Download + validate runs as one work-promise so the thinking shimmer can
    // cover it; any download/processing failure collapses to "unavailable".
    const work: Promise<VideoCheckOutcome> = (async () => {
      try {
        const videoBytes = await downloadTelegramFile(ctx.api, media.video);
        if (!videoBytes) return { kind: "unavailable" as const };
        const validation = await validateUserProfileVideo({
          userId: user.id,
          video: videoBytes,
          profilePhotoRefs: ctx.session.pendingPhotos,
          api: ctx.api,
        });
        return { kind: "validated" as const, validation };
      } catch (err) {
        console.warn("profile video validation failed:", err);
        return { kind: "unavailable" as const };
      }
    })();

    // Stream the "reviewing your video" thinking beats while `work` runs. The
    // first two beats always play (untilFromStepIndex: 2); the final beat is
    // held until validation settles plus a short deliberate pad, then the status
    // is torn down before the verdict lands in its place.
    await runStatusSequence(
      ctx.api,
      ctx.chat.id,
      videoCheckSteps(ctx.session.language),
      {
        until: work.then(() => delay(VIDEO_CHECK_STATUS_PAD_MS)),
        untilFromStepIndex: 2,
      },
    ).catch(() => undefined);

    const outcome = await work;
    if (outcome.kind === "unavailable") {
      await ctx.reply(t(ctx.session.language, "videoProcessingUnavailable"));
      return;
    }
    if (!outcome.validation.ok) {
      await ctx.reply(
        videoValidationMessage(ctx.session.language, outcome.validation.reason),
      );
      if (photoStageActive) {
        await sendPhotoStagePrompt(
          ctx.api,
          ctx.chat.id,
          telegramId,
          ctx.session.language,
          ctx.session.pendingPhotos.length,
          Boolean(existingVideo),
        );
      }
      return;
    }
    acceptedMedia = {
      ...media,
      validationVersion: PROFILE_MEDIA_VALIDATION_VERSION,
      validatedAt: new Date().toISOString(),
    };
    await ctx.reply(videoSavedAck(ctx.session.language));
    statusAcknowledged = true;
  }

  ctx.session.pendingProfileMedia = [
    ...existingMedia.filter((item) => item.type !== "video"),
    acceptedMedia,
  ];
  await persistPhotos(
    telegramId,
    ctx.session.pendingPhotos,
    ctx.session.pendingProfileMedia,
    ctx.session.pendingPhotoScores,
  );

  const res = await grantVideoBonusIfEligible(user.id);
  if (res.granted) {
    await sendTicketRewardDM(ctx.api, ctx.chat.id, ctx.session.language, "video", res.balance);
  } else if (!statusAcknowledged) {
    await ctx.reply(videoSavedAck(ctx.session.language));
  }

  if (photoStageActive) {
    await sendPhotoStagePrompt(
      ctx.api,
      ctx.chat.id,
      telegramId,
      ctx.session.language,
      ctx.session.pendingPhotos.length,
      true,
    );
  }
}

function videoValidationMessage(
  language: SessionData["language"],
  reason: MediaValidationReason,
): string {
  switch (reason) {
    case "unsafe_content":
      return t(language, "videoUnsafeContent");
    case "video_owner_missing":
      return t(language, "videoOwnerMissing");
    case "video_owner_too_brief":
      return t(language, "videoOwnerTooBrief");
    case "identity_mismatch":
      return t(language, "videoIdentityMismatch");
    case "video_mostly_other_person":
      return t(language, "videoMostlyOtherPerson");
    case "video_identity_reference_missing":
      return t(language, "videoNeedsPhotoFirst");
    case "video_too_large_to_check":
      return t(language, "videoTooLarge");
    case "video_too_long":
      return t(language, "videoTooLong");
    default:
      return t(language, "videoProcessingUnavailable");
  }
}

/**
 * Grant the one-time "4+ photos" ticket bonus if the persisted photo count now
 * qualifies, and DM the celebratory reward. No-op when the feature flag is off
 * or the bonus was already granted (idempotent in `ticket-wallet`).
 */
async function maybeGrantPhotoBonus(
  api: Api,
  chatId: number,
  telegramId: bigint,
  lang: SessionData["language"],
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;
  const res = await grantPhotoBonusIfEligible(user.id);
  if (res.granted) {
    await sendTicketRewardDM(api, chatId, lang, "photo", res.balance);
  }
}

function videoSavedAck(language: SessionData["language"]): string {
  switch (language) {
    case "ru":
      return "Видео добавлено в профиль ✅";
    case "uk":
      return "Відео додано до профілю ✅";
    case "de":
      return "Video zum Profil hinzugefügt ✅";
    case "pl":
      return "Wideo dodane do profilu ✅";
    default:
      return "Video added to your profile ✅";
  }
}

/**
 * Handle one photo frame — either a single message or one frame of a
 * Telegram album. Validates + persists inline so session state stays
 * consistent under `sequentializeByChat`, then (re)arms the debounced
 * flush so the whole burst is acknowledged in one progress response.
 */
async function handlePhotoFrame(
  ctx: BotContext,
  telegramId: bigint,
  media: IncomingProfileMedia,
  mediaGroupId: string | null,
): Promise<void> {
  const chatId = ctx.chat!.id;

  // If a frame from a different batch (different album, or album vs.
  // standalone) is already buffered, flush it first so we don't mix
  // groups under one agent turn.
  const existing = photoBatchAccumulators.get(chatId);
  if (existing && existing.mediaGroupId !== mediaGroupId) {
    if (existing.timer) clearTimeout(existing.timer);
    photoBatchAccumulators.delete(chatId);
    dispatchToChat(chatId, () => flushPhotoBatch(existing)).catch((err) =>
      console.error("Stale photo batch flush failed:", err),
    );
  }

  let acc = photoBatchAccumulators.get(chatId);
  if (!acc) {
    acc = {
      mediaGroupId,
      chatId,
      telegramId,
      api: ctx.api,
      validatedCount: 0,
      rejectedCount: 0,
      extraIgnoredCount: 0,
      duplicateCount: 0,
      consensusStatus: null,
      consensusPendingCount: 0,
      consensusRejectedCount: 0,
      rejectionReasons: {},
      hadInfraError: false,
      unsolicited: !ctx.session.expectingPhoto,
      timer: null,
    };
    photoBatchAccumulators.set(chatId, acc);
  }

  // Cancel any pending flush while we process this frame — we'll
  // re-arm it in `finally` once this frame (and its slow vision call)
  // is done. This is the key fix: the window now measures idle time
  // after validation, not after arrival.
  if (acc.timer) {
    clearTimeout(acc.timer);
    acc.timer = null;
  }

  try {
    const fileId = media.staticPhoto.file_id;
    const fileUniqueId = media.uniqueId;
    const user = await prisma.user.findUnique({
      where: { telegramId },
      select: { id: true },
    });
    if (!user) {
      acc.hadInfraError = true;
      incrementRejectionReason(acc, "processing_unavailable");
      return;
    }

    if (ctx.session.pendingPhotoUniqueIds?.includes(fileUniqueId)) {
      await logMediaValidationRejection({
        userId: user.id,
        mediaType: "photo",
        reason: "duplicate_exact",
      });
      acc.duplicateCount++;
      incrementRejectionReason(acc, "duplicate_exact");
      return;
    }

    if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
      acc.extraIgnoredCount++;
      return;
    }

    // `withTyping` keeps the "typing…" indicator alive in the Telegram
    // header while vision validation is in flight (2–8s per photo).
    // Without it the user sees nothing between their upload and the
    // debounced reply, and starts re-sending photos.
    let identityScore = 0;
    let photoHash: string | null = null;
    if (env.PROFILE_MEDIA_VALIDATION_ENABLED) {
      const photoBytes = await downloadTelegramFile(ctx.api, fileId);
      if (!photoBytes) {
        acc.hadInfraError = true;
        incrementRejectionReason(acc, "processing_unavailable");
        return;
      }

      const validation = await withTyping(ctx, () =>
        validateUserProfilePhoto({
          userId: user.id,
          candidate: photoBytes,
          mime: "image/jpeg",
          existingPhotoRefs: ctx.session.pendingPhotos,
          existingPhotoHashes: ctx.session.pendingPhotoHashes,
          api: ctx.api,
        }),
      );
      if (!validation.ok) {
        incrementRejectionReason(acc, validation.reason);
        if (
          validation.reason === "duplicate_exact" ||
          validation.reason === "duplicate_near"
        ) {
          acc.duplicateCount++;
        } else if (validation.reason === "processing_unavailable") {
          acc.hadInfraError = true;
        } else {
          acc.rejectedCount++;
        }
        return;
      } else {
        identityScore = validation.value.identitySimilarity ?? 0;
        photoHash = validation.value.fingerprint.differenceHash;
      }

      // Re-check room — another frame in the same batch may have filled
      // us to MAX while this one's validation was in flight.
      if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
        acc.extraIgnoredCount++;
        return;
      }

      const acceptedBefore = ctx.session.pendingPhotos.length;
      const consensus = await commitProfilePhotoCandidate({
        userId: user.id,
        photoRef: fileId,
        profileMedia: media.profileMedia,
        perceptualHash: photoHash,
        faceScore: identityScore,
        source: "telegram_onboarding",
        candidateBuffer: photoBytes,
        api: ctx.api,
      });
      syncSessionFromConsensus(ctx.session, consensus);
      ctx.session.pendingPhotoUniqueIds = [
        ...(ctx.session.pendingPhotoUniqueIds ?? []),
        fileUniqueId,
      ];
      ctx.session.expectingPhoto = true;
      acc.validatedCount++;
      recordConsensusOutcome(acc, consensus);

      if (acceptedBefore === 0 && consensus.photos.length > 0) {
        await reactToMessage(
          ctx.api,
          { chatId, messageId: ctx.message?.message_id },
          MESSAGE_REACTION.fire,
        );
      }
      return;
    } else {
      const validation = await withTyping(ctx, () =>
        validateSingleFace(ctx, fileId),
      );

      if (!validation.ok) {
        acc.hadInfraError = true;
        return;
      }

      if (!validation.valid) {
        acc.rejectedCount++;
        incrementRejectionReason(acc, "no_face");
        return;
      }
    }

    // Re-check room — another frame in the same batch may have filled
    // us to MAX while this one's validation was in flight.
    if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
      acc.extraIgnoredCount++;
      return;
    }

    const isFirstValidPhoto = ctx.session.pendingPhotos.length === 0;
    ctx.session.pendingPhotos.push(fileId);
    ctx.session.pendingProfileMedia = [
      ...normalizeProfileMedia(ctx.session.pendingProfileMedia, ctx.session.pendingPhotos.slice(0, -1)),
      media.profileMedia,
    ];
    ctx.session.pendingPhotoUniqueIds = [
      ...(ctx.session.pendingPhotoUniqueIds ?? []),
      fileUniqueId,
    ];
    ctx.session.pendingPhotoHashes = [
      ...(ctx.session.pendingPhotoHashes ?? []),
      ...(photoHash ? [photoHash] : []),
    ];
    ctx.session.pendingPhotoScores = [
      ...(ctx.session.pendingPhotoScores ?? []),
      identityScore,
    ];
    ctx.session.expectingPhoto = true;
    acc.validatedCount++;

    await persistPhotos(
      telegramId,
      ctx.session.pendingPhotos,
      ctx.session.pendingProfileMedia,
      ctx.session.pendingPhotoScores,
      ctx.session.pendingPhotoHashes,
    );
    if (isFirstValidPhoto) {
      await reactToMessage(
        ctx.api,
        { chatId, messageId: ctx.message?.message_id },
        MESSAGE_REACTION.fire,
      );
    }
  } catch (err) {
    console.error("Photo frame handling failed:", err);
    acc.hadInfraError = true;
  } finally {
    // Arm the debounce only if we're still the active accumulator —
    // another handler may have evicted us (e.g. different media group).
    if (photoBatchAccumulators.get(chatId) === acc) {
      acc.timer = schedulePhotoBatchFlush(chatId);
    }
  }
}

function schedulePhotoBatchFlush(chatId: number): NodeJS.Timeout {
  return setTimeout(() => {
    const acc = photoBatchAccumulators.get(chatId);
    if (!acc) return;
    photoBatchAccumulators.delete(chatId);
    dispatchToChat(chatId, () => flushPhotoBatch(acc)).catch((err) =>
      console.error("Photo batch flush failed:", err),
    );
  }, PHOTO_BATCH_DEBOUNCE_MS);
}

/**
 * Send exactly one response for the completed photo batch. Runs inside
 * `dispatchToChat` so it serializes with any concurrent Telegram updates
 * for the same chat (we cannot rely on the middleware's ctx.session here
 * because we're outside any update).
 */
async function flushPhotoBatch(acc: PhotoBatchAccumulator): Promise<void> {
  try {
    const key = acc.chatId.toString();
    const row = await prisma.botSession.findUnique({ where: { key } });
    const session: SessionData = {
      ...DEFAULT_SESSION,
      ...((row?.data ?? {}) as Partial<SessionData>),
    };

    if (acc.validatedCount === 0) {
      // Every frame was rejected, errored, or was an extra past MAX.
      if (acc.hadInfraError) {
        await replyText(
          acc.api,
          acc.chatId,
          t(session.language, "photoVisionError"),
        );
        if (!acc.unsolicited) {
          await sendPhotoStagePrompt(
            acc.api,
            acc.chatId,
            acc.telegramId,
            session.language,
            session.pendingPhotos.length,
            sessionHasProfileVideo(session),
          );
        }
        return;
      }
      if (acc.rejectedCount > 0) {
        if (!acc.unsolicited) {
          await replyText(
            acc.api,
            acc.chatId,
            photoBatchRejectionText(session.language, acc),
          );
          await sendPhotoStagePrompt(
            acc.api,
            acc.chatId,
            acc.telegramId,
            session.language,
            session.pendingPhotos.length,
            sessionHasProfileVideo(session),
          );
          return;
        }
        await injectSystemMessage(
          acc.telegramId,
          `Photo batch rejected: ${acc.rejectedCount} frame(s) had no clear single human face.`,
        );
        const result = await runAgentTurn(
          acc.telegramId,
          { kind: "photos_updated" },
        );
        await replyText(acc.api, acc.chatId, result.reply);
        return;
      }
      if (acc.extraIgnoredCount > 0) {
        if (!acc.unsolicited) {
          session.expectingPhoto = true;
          await prisma.botSession.upsert({
            where: { key },
            create: { key, data: session as unknown as object },
            update: { data: session as unknown as object },
          });
          await sendPhotoStagePrompt(
            acc.api,
            acc.chatId,
            acc.telegramId,
            session.language,
            session.pendingPhotos.length,
            sessionHasProfileVideo(session),
          );
          return;
        }
        // User sent extras on top of an already-complete set. Nudge the
        // agent to acknowledge and move on rather than asking for more.
        session.expectingPhoto = false;
        await injectSystemMessage(
          acc.telegramId,
          `User sent ${acc.extraIgnoredCount} extra photo(s), but ${MAX_PHOTOS} (MAX) are already uploaded. Ignore the extras and proceed with finalize_onboarding if all other data is collected.`,
        );
        const result = await runAgentTurn(
          acc.telegramId,
          { kind: "photos_updated", count: MAX_PHOTOS },
        );
        await prisma.botSession.upsert({
          where: { key },
          create: { key, data: session as unknown as object },
          update: { data: session as unknown as object },
        });
        await replyText(acc.api, acc.chatId, result.reply);
        return;
      }
      if (acc.duplicateCount > 0 && !acc.unsolicited) {
        await replyText(
          acc.api,
          acc.chatId,
          photoBatchRejectionText(session.language, acc),
        );
        await sendPhotoStagePrompt(
          acc.api,
          acc.chatId,
          acc.telegramId,
          session.language,
          session.pendingPhotos.length,
          sessionHasProfileVideo(session),
        );
      }
      return;
    }

    const count = session.pendingPhotos.length;
    if (!acc.unsolicited) {
      session.expectingPhoto = true;
      await prisma.botSession.upsert({
        where: { key },
        create: { key, data: session as unknown as object },
        update: { data: session as unknown as object },
      });

      if (acc.rejectedCount > 0) {
        await replyText(
          acc.api,
          acc.chatId,
          photoBatchRejectionText(session.language, acc),
        );
      }
      const consensusText = photoConsensusBatchText(session.language, acc);
      if (consensusText) {
        await replyText(acc.api, acc.chatId, consensusText);
      }
      await maybeGrantPhotoBonus(
        acc.api,
        acc.chatId,
        acc.telegramId,
        session.language,
      );
      await sendPhotoStagePrompt(
        acc.api,
        acc.chatId,
        acc.telegramId,
        session.language,
        count,
        sessionHasProfileVideo(session),
      );
      return;
    }

    const unsolicitedNote = acc.unsolicited
      ? "User sent photos BEFORE you called request_photos. They were auto-accepted and validated. Call request_photos NOW to formalize the photo step, briefly acknowledge the upload, and continue. "
      : "";
    await injectSystemMessage(
      acc.telegramId,
      unsolicitedNote +
        `User uploaded a batch of ${acc.validatedCount} photo candidate(s). ${photoConsensusSystemNote(acc)} ${photoProgressMessage(count)}` +
        (acc.rejectedCount > 0
          ? ` ${acc.rejectedCount} frame(s) in the batch were rejected (no clear face).`
          : ""),
    );

    if (count >= MAX_PHOTOS) {
      session.expectingPhoto = false;
    }

    const result = await runAgentTurn(
      acc.telegramId,
      { kind: "photos_updated", count },
    );
    session.expectingPhoto = result.expectingPhoto;

    if (result.onboardingComplete) {
      markOnboardingComplete(session);
    }

    await prisma.botSession.upsert({
      where: { key },
      create: { key, data: session as unknown as object },
      update: { data: session as unknown as object },
    });

    await replyText(acc.api, acc.chatId, result.reply);

    // One-time "4+ photos" ticket bonus (idempotent, flag-gated).
    await maybeGrantPhotoBonus(acc.api, acc.chatId, acc.telegramId, session.language);

    if (result.onboardingComplete) {
      // Re-fetch freshly to show the menu in the user's language
      const language = session.language;
      // Mirror the text-message path (line ~179): if the agent's
      // `finalize_onboarding` set verificationRequired=true, the user is
      // still in `status='onboarding'` and must see the Persona CTA before
      // the main menu — otherwise they're stranded with no way to verify.
      // Pre-fix this branch jumped straight to the menu and silently
      // swallowed the CTA when onboarding was completed by a photo upload.
      if (result.verificationRequired) {
        const { sendVerificationCTABare } = await import("./verification.js");
        const sent = await sendVerificationCTABare(
          acc.api,
          acc.chatId,
          acc.telegramId,
          language,
        );
        if (sent) return;
        // Persona disabled or misconfigured — fall through to the menu.
      }
      const { sendMainMenu } = await import("../menu/main.js");
      await sendMainMenu(acc.api, acc.chatId, language, acc.telegramId);
      await pinStatusBanner(acc.api, acc.telegramId, language);
    }
  } catch (err) {
    console.error("Photo batch flush failed:", err);
    try {
      await acc.api.sendMessage(
        acc.chatId,
        "Something went wrong with those photos. Try again.",
      );
    } catch {
      // ignore
    }
  }
}

async function replyText(api: Api, chatId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    await api.sendMessage(chatId, text.replace(/[*_`[\]]/g, ""));
  }
}

function syncSessionFromConsensus(
  session: SessionData,
  consensus: PhotoConsensusCommitResult,
): void {
  session.pendingPhotos = [...consensus.photos];
  session.pendingProfileMedia = [...consensus.profileMedia];
  session.pendingPhotoHashes = [...consensus.uploadedPhotoHashes];
  session.pendingPhotoScores = [...consensus.photoFaceScores];
}

function recordConsensusOutcome(
  acc: PhotoBatchAccumulator,
  consensus: PhotoConsensusCommitResult,
): void {
  acc.consensusStatus = consensus.status;
  acc.consensusPendingCount = consensus.pendingCount;
  acc.consensusRejectedCount += consensus.rejectedCount;
}

function photoConsensusBatchText(
  language: SessionData["language"],
  acc: PhotoBatchAccumulator,
): string | null {
  if (acc.consensusStatus === "pending") return t(language, "photoConsensusPending");
  if (acc.consensusStatus === "capped") return t(language, "photoConsensusNoPairCap");
  if (acc.consensusStatus === "confirmed") {
    return [
      t(language, "photoConsensusConfirmed"),
      acc.consensusRejectedCount > 0
        ? t(language, "photoConsensusOutlierRejected")
        : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n\n");
  }
  return null;
}

function photoConsensusSystemNote(acc: PhotoBatchAccumulator): string {
  if (acc.consensusStatus === "pending" || acc.consensusStatus === "capped") {
    return `No identity anchor is fixed yet; ${acc.consensusPendingCount} candidate photo(s) are pending until two different photos show the same person.`;
  }
  if (acc.consensusStatus === "confirmed") {
    return `Identity consensus is confirmed; ${acc.consensusRejectedCount} pending outlier photo(s) were rejected.`;
  }
  return "";
}

function photoProgressMessage(count: number): string {
  if (count < MIN_PHOTOS) {
    const remaining = MIN_PHOTOS - count;
    return `Total verified: ${count}/${MIN_PHOTOS} minimum. Need ${remaining} more to hit the minimum — ask for ${remaining} more photo(s).`;
  }

  // Past the minimum: make ONE warm, optional offer — never chain "one more".
  if (env.TICKET_FEATURE_ENABLED) {
    if (count < PHOTO_BONUS_TICKET_THRESHOLD) {
      const toBonus = PHOTO_BONUS_TICKET_THRESHOLD - count;
      return `Total verified: ${count}. Minimum of ${MIN_PHOTOS} is met. Make ONE warm, low-pressure offer (don't repeat it on later batches): with ${toBonus} more photo(s) — ${PHOTO_BONUS_TICKET_THRESHOLD} total — they earn a FREE date ticket (each date costs 1 ticket, normally paid). They can also add a short profile VIDEO for another free ticket. Make clear it's optional — if they'd rather continue, move on. Do NOT chain repeated "one more" requests.`;
    }
    return `Total verified: ${count}. The ${PHOTO_BONUS_TICKET_THRESHOLD}+ photo ticket bonus is already earned. Briefly acknowledge, mention they may add up to ${MAX_PHOTOS} photos or a profile VIDEO (another free ticket) if they like, then default to moving on. Do NOT chain repeated "one more" requests.`;
  }

  return `Total verified: ${count}. Minimum of ${MIN_PHOTOS} is met. STOP asking for more photos. Briefly mention the user may send one more if they want (up to ${MAX_PHOTOS}), then default to moving on — do NOT chain repeated "one more" requests.`;
}

function sessionHasProfileVideo(session: SessionData): boolean {
  return profileMediaHasVideo(
    normalizeProfileMedia(session.pendingProfileMedia, session.pendingPhotos),
  );
}

async function sendPhotoStagePrompt(
  api: Api,
  chatId: number,
  telegramId: bigint,
  language: SessionData["language"],
  photoCount: number,
  hasVideo: boolean,
): Promise<void> {
  const text = onboardingPhotoStageText({
    language,
    photoCount,
    ticketFeatureEnabled: env.TICKET_FEATURE_ENABLED,
    hasVideo,
  });
  await recordOnboardingAssistantReply(telegramId, text);

  if (photoCount < MIN_PHOTOS) {
    await api.sendMessage(chatId, text);
    return;
  }

  const keyboard = new InlineKeyboard().text(
    t(language, "btnContinuePhotos"),
    ONBOARDING_PHOTOS_CONTINUE_CALLBACK,
  );
  await api.sendMessage(chatId, text, { reply_markup: keyboard });
}

function markOnboardingComplete(session: SessionData): void {
  session.onboardingStep = "completed";
  session.menuState = "idle";
  session.expectingPhoto = false;
  session.pendingPhotos = [];
  session.pendingProfileMedia = [];
  session.pendingPhotoUniqueIds = [];
  session.pendingPhotoHashes = [];
  session.pendingPhotoScores = [];
}

async function persistPhotos(
  telegramId: bigint,
  photos: string[],
  profileMedia: readonly ProfileMedia[] = [],
  photoFaceScores: readonly number[] = [],
  uploadedPhotoHashes: readonly string[] = [],
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      profile: {
        select: {
          referenceFaceEmbedding: true,
          uploadedPhotoHashes: true,
        },
      },
    },
  });
  if (!user) return;
  const normalizedMedia = normalizeProfileMedia(profileMedia, photos);
  const normalizedScores = photos.map((_, index) => photoFaceScores[index] ?? 0);
  const photoState = photoUploadStatePatch({
    photos,
    uploadedPhotoHashes:
      uploadedPhotoHashes.length > 0
        ? uploadedPhotoHashes
        : user.profile?.uploadedPhotoHashes ?? [],
    referenceFaceEmbedding: user.profile?.referenceFaceEmbedding ?? null,
  });
  await prisma.profile.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      photos,
      profileMedia: profileMediaToJson(normalizedMedia),
      photoFaceScores: normalizedScores,
      ...photoState,
    },
    update: {
      photos,
      profileMedia: profileMediaToJson(normalizedMedia),
      photoFaceScores: normalizedScores,
      ...photoState,
    },
  });
}

async function logTelegramMediaRejection(
  telegramId: bigint,
  mediaType: "photo" | "video",
  reason: MediaValidationReason,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;
  await logMediaValidationRejection({
    userId: user.id,
    mediaType,
    reason,
  });
}

function incrementRejectionReason(
  acc: PhotoBatchAccumulator,
  reason: MediaValidationReason,
): void {
  acc.rejectionReasons[reason] = (acc.rejectionReasons[reason] ?? 0) + 1;
}

function photoBatchRejectionText(
  language: SessionData["language"],
  acc: PhotoBatchAccumulator,
): string {
  const priority: Array<[MediaValidationReason, Parameters<typeof t>[1]]> = [
    ["invalid_media", "photoInvalidMedia"],
    ["identity_mismatch", "photoIdentityMismatch"],
    ["identity_uncertain", "photoIdentityMismatch"],
    ["unsafe_content", "photoRejected"],
    ["multiple_faces_photo", "photoRejected"],
    ["no_face", "photoRejected"],
    ["duplicate_near", "photoDuplicateNear"],
    ["duplicate_exact", "photoDuplicate"],
    ["processing_unavailable", "photoVisionError"],
  ];
  const selected = priority.find(([reason]) => acc.rejectionReasons[reason]);
  return t(language, selected?.[1] ?? "photoRejected");
}

type LivePhotoRejectReason = "missing_static" | "too_long" | "too_large";

function livePhotoRejectionMessage(
  language: SessionData["language"],
  reason: LivePhotoRejectReason,
): string {
  switch (reason) {
    case "missing_static":
      return t(language, "livePhotoMissingStatic");
    case "too_long":
      return t(language, "livePhotoTooLong");
    case "too_large":
      return t(language, "livePhotoTooLarge");
  }
}
