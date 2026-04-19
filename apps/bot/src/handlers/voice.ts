import { Composer } from "grammy";
import { t } from "@gennety/shared";
import type { BotContext } from "../session.js";
import { env } from "../config.js";
import { transcribeVoice } from "../services/whisper.js";

const MAX_VOICE_DURATION_SEC = 300;
const MAX_VOICE_BYTES = 20 * 1024 * 1024;

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
    const res = await fetch(url);
    if (!res.ok) {
      await ctx.reply(t(language, "voiceTranscriptionFailed"));
      return;
    }
    buffer = Buffer.from(await res.arrayBuffer());
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

  // Inject the transcript into the text pipeline. Downstream handlers read
  // `ctx.message?.text`, so mutating the existing message object is the
  // least invasive way to reuse both routers without branching.
  (ctx.message as { text?: string }).text = transcript;

  await next();
});
