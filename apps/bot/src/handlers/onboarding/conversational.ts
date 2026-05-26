import { InlineKeyboard, type Api } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import type { SessionData } from "@gennety/shared";
import {
  MIN_PHOTOS,
  MAX_PHOTOS,
  MAX_DUMP_BUFFER_CHARS,
  magicContextPrompt,
  DEFAULT_SESSION,
  normalizeProfileMedia,
  t,
  type ProfileMedia,
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
  incomingLivePhotoMedia,
  incomingPhotoMedia,
  type IncomingProfileMedia,
} from "../../services/telegram-profile-media.js";
import { profileMediaToJson } from "../../services/profile-media-json.js";

/** Callback data for the "I've pasted everything" confirmation button */
const DUMP_DONE_CALLBACK = "dump:done";

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
 * pastes (> 4096 chars) into multiple messages. The user taps "Done" to flush
 * the full buffer to the agent in one shot.
 */
export async function handleConversational(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);

  // ---- "Done pasting" confirmation button ----
  if (ctx.callbackQuery?.data === DUMP_DONE_CALLBACK) {
    await ctx.answerCallbackQuery();
    await handleDumpDone(ctx, telegramId);
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
  // all chunks and only forward the full buffer to the agent when the user
  // taps the "Done" button.
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
  } else if (result.expectingPhoto) {
    ctx.session.expectingPhoto = true;
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
    await handleDumpDone(ctx, telegramId);
    return;
  }

  const separator = current.length > 0 ? "\n" : "";
  const room = MAX_DUMP_BUFFER_CHARS - current.length - separator.length;
  const truncated = text.length > room;
  const chunk = truncated ? text.slice(0, Math.max(0, room)) : text;
  ctx.session.contextDumpBuffer = current + separator + chunk;

  // Only show the confirmation prompt on the first chunk (buffer was empty
  // before we appended). For subsequent chunks just silently accumulate.
  if (separator === "") {
    const doneKeyboard = new InlineKeyboard().text(
      "Done, I've pasted everything ✅",
      DUMP_DONE_CALLBACK,
    );
    await ctx.reply(
      "Got a piece ✅ — if there's more, keep pasting. Tap Done when you're finished.",
      { reply_markup: doneKeyboard },
    );
  }

  // If this chunk filled the buffer, auto-flush so we don't silently drop
  // the rest of the user's paste into the void.
  if (truncated) {
    await ctx.reply(
      "That's all I can store — processing what we have now.",
    );
    await handleDumpDone(ctx, telegramId);
  }
}

// ---------------------------------------------------------------------------
// Context dump flush
// ---------------------------------------------------------------------------

/**
 * Called when the user taps "Done, I've pasted everything ✅".
 * Flushes the accumulated contextDumpBuffer to the LLM agent as a single turn.
 */
async function handleDumpDone(ctx: BotContext, telegramId: bigint): Promise<void> {
  const buffer = ctx.session.contextDumpBuffer.trim();

  if (!buffer) {
    await ctx.reply("Hmm, I don't have anything buffered yet. Paste your result first, then tap Done.");
    return;
  }

  // Clear buffering mode before the agent call so any re-entry is clean
  ctx.session.awaitingContextDump = false;
  ctx.session.contextDumpBuffer = "";

  const result = await withTyping(ctx, () => runAgentTurn(telegramId, buffer));

  if (result.contextDumpStarted) {
    ctx.session.awaitingContextDump = true;
    ctx.session.contextDumpBuffer = "";
    ctx.session.expectingPhoto = false;
  } else if (result.expectingPhoto) {
    ctx.session.expectingPhoto = true;
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
          "[Photos rejected by vision validation — no clear faces]",
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
          `[Extra photos ignored — already at ${MAX_PHOTOS}/${MAX_PHOTOS}]`,
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
      `[Album uploaded: ${acc.validatedCount} verified photo(s), total ${count}/${MAX_PHOTOS}]`,
    );

    if (result.onboardingComplete) {
      markOnboardingComplete(session);
    }

    await prisma.botSession.upsert({
      where: { key },
      create: { key, data: session as unknown as object },
      update: { data: session as unknown as object },
    });

    await replyText(acc.api, acc.chatId, result.reply);

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
  return `Total verified: ${count}. Minimum of ${MIN_PHOTOS} is met. STOP asking for more photos. Briefly mention the user may send one more if they want, then default to moving on — do NOT chain repeated "one more" requests.`;
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
