import { Composer } from "grammy";
import { t } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { env } from "../config.js";
import { transcribeVoice } from "../services/whisper.js";
import { recordChatEventForChat } from "../services/chat-events.js";
import { readResponseBuffer } from "../utils/bounded-response.js";
import { isAwaitingVoicePrompt } from "../services/voice-prompt-claim.js";

const MAX_VOICE_DURATION_SEC = 300;
const MAX_VOICE_BYTES = 20 * 1024 * 1024;
const VOICE_DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * Intercept Telegram voice notes, transcribe them via Whisper, and feed the
 * resulting text into the downstream text-message pipeline by mutating
 * `ctx.message.text` before calling `next()`.
 *
 * Placed before the FSM router so both onboarding (`router.ts`) and the
 * post-onboarding menu (`menu/router.ts`) — both of which read
 * `ctx.message?.text` — handle the transcript as if the user had typed it.
 *
 * A `record_voice` chat action is sent up front so the user sees that the bot
 * is "listening" while the OGG is downloaded and the Whisper call runs.
 */
export const voiceHandler = new Composer<BotContext>();

voiceHandler.on("message:voice", async (ctx, next) => {
  const voice = ctx.message.voice;
  const language = ctx.session.language;

  // The onboarding voice-prompt step owns this recording, so hand it through
  // untouched (VOICE_PROMPT_PRODUCT_SPEC.md §1.4).
  //
  // The early return sits BEFORE this handler's own bounds on purpose. Those
  // bounds describe a TRANSCRIPTION REQUEST — 300 seconds, 20 MB, and error
  // copy that says the transcription failed — while a voice prompt is a profile
  // element with its own, much tighter product bounds and its own wording. One
  // owner per concern: letting this handler reject first would mean two
  // rejection points disagreeing about the same recording, and letting it
  // transcribe first would couple a perfectly good clip to Whisper being up.
  //
  // `ctx.message.voice` survives either way — this handler only ever mutates
  // `text` — so the downstream handler still has the file_id. What it must not
  // inherit is a `text` that the fact collector will mine for profile facts.
  if (isAwaitingVoicePrompt(ctx.session)) {
    await next();
    return;
  }

  if (voice.duration > MAX_VOICE_DURATION_SEC) {
    await ctx.reply(t(language, "voiceTooLong"));
    return;
  }
  if (voice.file_size && voice.file_size > MAX_VOICE_BYTES) {
    await ctx.reply(t(language, "voiceTooLong"));
    return;
  }

  try {
    await ctx.replyWithChatAction("record_voice");
  } catch {
    // Chat action is best-effort — never fail the turn on it.
  }

  let buffer: Buffer;
  try {
    const file = await ctx.api.getFile(voice.file_id);
    if (!file.file_path) {
      await ctx.reply(t(language, "voiceTranscriptionFailed"));
      return;
    }
    const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(VOICE_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      await ctx.reply(t(language, "voiceTranscriptionFailed"));
      return;
    }
    buffer = await readResponseBuffer(res, MAX_VOICE_BYTES);
  } catch (err) {
    console.warn("Voice download failed:", err);
    await ctx.reply(t(language, "voiceTranscriptionFailed"));
    return;
  }

  // Keep the "listening" indicator alive through the Whisper round-trip.
  try {
    await ctx.replyWithChatAction("typing");
  } catch {
    // Best effort.
  }

  const transcript = await transcribeVoice(buffer, {
    mime: voice.mime_type ?? "audio/ogg",
    language,
  });

  if (!transcript) {
    await ctx.reply(t(language, "voiceTranscriptionFailed"));
    return;
  }

  // Chat timeline: the inbound recorder skips voice on purpose and defers to
  // here, so the agent reads what was SAID rather than "(voice note)".
  if (ctx.chat?.id !== undefined && ctx.chat.id > 0) {
    void recordChatEventForChat(ctx.chat.id, {
      direction: "in",
      kind: "user_voice",
      summary: transcript,
    });
  }

  // Inject the transcript into the text pipeline. Downstream handlers read
  // `ctx.message?.text`, so mutating the existing message object is the
  // least invasive way to reuse both routers without branching.
  (ctx.message as { text?: string }).text = transcript;

  await next();
});
