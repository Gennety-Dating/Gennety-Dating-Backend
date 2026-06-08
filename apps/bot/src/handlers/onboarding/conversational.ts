import type { Api } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import type { SessionData } from "@gennety/shared";
import {
  MIN_PHOTOS,
  MAX_PHOTOS,
  PHOTO_BONUS_TICKET_THRESHOLD,
  MAX_DUMP_BUFFER_CHARS,
  magicContextPrompt,
  DEFAULT_SESSION,
  normalizeProfileMedia,
  t,
  type ProfileMedia,
  type ProfileVideoMedia,
} from "@gennety/shared";
import {
  runAgentTurn,
  injectSystemMessage,
} from "../../services/onboarding-agent.js";
import { validateSingleFace } from "../../services/vision/validate-face.js";
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
import { profileAnalysisSteps } from "../../services/analysis-status.js";
import { env } from "../../config.js";
import {
  grantPhotoBonusIfEligible,
  grantVideoBonusIfEligible,
} from "../../services/ticket-wallet.js";
import { sendTicketRewardDM } from "../../services/ticket-reward.js";

/** Backward compatibility for confirmation buttons sent before auto-flush. */
const DUMP_DONE_CALLBACK = "dump:done";
const CONTEXT_DUMP_DEBOUNCE_MS = 2_000;

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
 * the agent immediately. This handles Telegram's automatic splitting of long
 * pastes (> 4096 chars) into multiple messages. The full buffer is sent to the
 * agent automatically after a short pause between incoming chunks.
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

  // ---- Context dump buffering mode ----
  // When awaitingContextDump is true the Magic Prompt has already been shown.
  // Telegram may split a long paste into multiple messages, so we accumulate
  // all chunks and forward the full buffer after a short idle pause.
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

  // ---- Normal conversational turn ----
  const result = await withTyping(ctx, () => runAgentTurn(telegramId, text));

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

  // Acknowledge only the first chunk. Subsequent parts silently extend the
  // debounce window so Telegram-split responses arrive as one agent turn.
  if (separator === "") {
    await ctx.reply(
      "Got it ✅ If Telegram split the response, send the remaining parts now — I'll process everything automatically.",
    );
  }

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
 * batcher so we can fire exactly ONE agent turn per "burst" of uploads.
 * Why: vision validation takes several seconds per photo, and under
 * `sequentializeByChat` frames are processed serially. If we fired an
 * agent turn per frame, the user would see "got 1, need one more" long
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
 * Persist a profile video (display-only — no face validation, not counted
 * toward MIN_PHOTOS) and grant the one-time "added a video" ticket bonus.
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
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;

  ctx.session.pendingProfileMedia = [
    ...normalizeProfileMedia(ctx.session.pendingProfileMedia, ctx.session.pendingPhotos),
    media,
  ];
  await persistPhotos(
    telegramId,
    ctx.session.pendingPhotos,
    ctx.session.pendingProfileMedia,
  );

  const res = await grantVideoBonusIfEligible(user.id);
  if (res.granted) {
    await sendTicketRewardDM(ctx.api, ctx.chat.id, ctx.session.language, "video", res.balance);
  } else {
    await ctx.reply(videoSavedAck(ctx.session.language));
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
 * flush so the whole burst is acknowledged in ONE agent turn.
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

    if (ctx.session.pendingPhotoUniqueIds?.includes(fileUniqueId)) return;

    if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
      acc.extraIgnoredCount++;
      return;
    }

    // `withTyping` keeps the "typing…" indicator alive in the Telegram
    // header while vision validation is in flight (2–8s per photo).
    // Without it the user sees nothing between their upload and the
    // debounced reply, and starts re-sending photos.
    const validation = await withTyping(ctx, () =>
      validateSingleFace(ctx, fileId),
    );

    if (!validation.ok) {
      acc.hadInfraError = true;
      return;
    }

    if (!validation.valid) {
      acc.rejectedCount++;
      return;
    }

    // Re-check room — another frame in the same batch may have filled
    // us to MAX while this one's validation was in flight.
    if (ctx.session.pendingPhotos.length >= MAX_PHOTOS) {
      acc.extraIgnoredCount++;
      return;
    }

    ctx.session.pendingPhotos.push(fileId);
    ctx.session.pendingProfileMedia = [
      ...normalizeProfileMedia(ctx.session.pendingProfileMedia, ctx.session.pendingPhotos.slice(0, -1)),
      media.profileMedia,
    ];
    ctx.session.pendingPhotoUniqueIds = [
      ...(ctx.session.pendingPhotoUniqueIds ?? []),
      fileUniqueId,
    ];
    ctx.session.expectingPhoto = true;
    acc.validatedCount++;

    await persistPhotos(
      telegramId,
      ctx.session.pendingPhotos,
      ctx.session.pendingProfileMedia,
    );
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
 * Fire exactly one agent turn for the completed photo batch. Runs inside
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
        await acc.api.sendMessage(
          acc.chatId,
          "Couldn't process those photos. Try sending them again.",
        );
        return;
      }
      if (acc.rejectedCount > 0) {
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
      // Nothing to report (all frames were duplicates). Silent no-op.
      return;
    }

    const count = session.pendingPhotos.length;
    const unsolicitedNote = acc.unsolicited
      ? "User sent photos BEFORE you called request_photos. They were auto-accepted and validated. Call request_photos NOW to formalize the photo step, briefly acknowledge the upload, and continue. "
      : "";
    await injectSystemMessage(
      acc.telegramId,
      unsolicitedNote +
        `User uploaded a batch of ${acc.validatedCount} verified photo(s). ${photoProgressMessage(count)}` +
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

function markOnboardingComplete(session: SessionData): void {
  session.onboardingStep = "completed";
  session.menuState = "idle";
  session.expectingPhoto = false;
  session.pendingPhotos = [];
  session.pendingProfileMedia = [];
  session.pendingPhotoUniqueIds = [];
  session.pendingPhotoScores = [];
}

async function persistPhotos(
  telegramId: bigint,
  photos: string[],
  profileMedia: readonly ProfileMedia[] = [],
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return;
  const normalizedMedia = normalizeProfileMedia(profileMedia, photos);
  await prisma.profile.upsert({
    where: { userId: user.id },
    create: { userId: user.id, photos, profileMedia: profileMediaToJson(normalizedMedia) },
    update: { photos, profileMedia: profileMediaToJson(normalizedMedia) },
  });
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
