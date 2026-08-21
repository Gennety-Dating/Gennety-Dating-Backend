import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  VOICE_PROMPT_MAX_DURATION_SECONDS,
  VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
  VOICE_PROMPT_MIN_DURATION_SECONDS,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { validateVoicePrompt } from "../../services/profile-media-validation/voice-prompt-validation.js";
import { logMediaValidationRejection } from "../../services/profile-media-validation/rejection-log.js";
import { deleteVoicePrompt, saveVoicePrompt } from "../../services/voice-prompt.js";
import {
  createVoicePromptSignedUrl,
  downloadVoicePrompt,
  uploadVoicePrompt,
} from "../../services/storage.js";

/**
 * Voice prompts for the NATIVE client (JWT) — VOICE_PROMPT_PRODUCT_SPEC.md §4.2.
 *
 * The Telegram rail needs no HTTP surface at all: `sendVoice` is the recorder,
 * the player and the store. Everything here exists because iOS has none of
 * that, which is also the whole cost of shipping both platforms together.
 *
 *   POST   /v1/me/voice-prompt/upload-url  — presigned Supabase PUT
 *   POST   /v1/me/voice-prompt             — commit a stored object
 *   DELETE /v1/me/voice-prompt             — remove it
 *   GET    /v1/me/voice-prompt             — what the client already has
 *
 * There is deliberately NO catalog endpoint: the recommendations are copy on
 * the recording screen, not data (§3.1).
 */
export function createVoicePromptRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId as string;
    const prompt = await prisma.voicePrompt.findUnique({
      where: { userId },
      select: { durationSec: true, waveform: true, storagePath: true, createdAt: true },
    });
    if (!prompt) {
      res.json({ voicePrompt: null });
      return;
    }
    res.json({
      voicePrompt: {
        durationSec: prompt.durationSec,
        waveform: prompt.waveform,
        createdAt: prompt.createdAt.toISOString(),
        audioUrl: prompt.storagePath
          ? await createVoicePromptSignedUrl(prompt.storagePath)
          : null,
      },
    });
  });

  /**
   * Direct-to-Supabase upload rather than a backend proxy.
   *
   * A 30-second Opus clip is ~120 KB, so proxying would be affordable — the
   * reason not to is that the same single Node process runs the bot, every
   * cron and both APIs, and audio bodies have no business passing through it.
   */
  router.post("/upload-url", async (req: Request, res: Response): Promise<void> => {
    const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "";
    if (!contentType.startsWith("audio/")) {
      res.status(400).json({ error: "bad-content-type" });
      return;
    }
    res.json({
      // The client PUTs bytes to us and we forward; a true presigned URL needs
      // a Supabase signed-upload token, which is the next step here if the
      // proxy ever shows up in latency. Keeping the shape stable now means
      // that change is server-only.
      uploadUrl: null,
      maxBytes: VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
      minDurationSec: VOICE_PROMPT_MIN_DURATION_SECONDS,
      maxDurationSec: VOICE_PROMPT_MAX_DURATION_SECONDS,
    });
  });

  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId as string;
    const durationSec = Number(req.body?.durationSec);
    const audioBase64 = typeof req.body?.audio === "string" ? req.body.audio : "";
    const mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType : "audio/mp4";

    if (!Number.isFinite(durationSec) || durationSec <= 0 || !audioBase64) {
      res.status(400).json({ error: "bad-request" });
      return;
    }

    const audio = Buffer.from(audioBase64, "base64");
    if (audio.byteLength === 0 || audio.byteLength > VOICE_PROMPT_MAX_FILE_SIZE_BYTES) {
      res.status(400).json({ error: "voice_too_long" });
      return;
    }

    const validation = await validateVoicePrompt({
      audio,
      durationSeconds: Math.round(durationSec),
      fileSizeBytes: audio.byteLength,
    });
    if (!validation.ok) {
      await logMediaValidationRejection({
        userId,
        mediaType: "video",
        reason: validation.reason,
      }).catch(() => {});
      // 422 rather than 400: the request is well-formed, the CONTENT is
      // refused — and `retryable` is what tells the client whether re-recording
      // is the fix or whether it should simply try the same clip again.
      res.status(422).json({ error: validation.reason, retryable: validation.retryable });
      return;
    }

    let storagePath: string;
    try {
      const uploaded = await uploadVoicePrompt(userId, audio, mimeType);
      storagePath = uploaded.path;
    } catch (err) {
      console.error("[voice-prompt] upload failed:", err);
      res.status(503).json({ error: "storage-unavailable" });
      return;
    }

    await saveVoicePrompt({
      userId,
      storagePath,
      durationSec: Math.round(durationSec),
      mimeType,
      fileSize: audio.byteLength,
      waveform: validation.value.waveform,
      transcript: validation.value.transcript,
    });

    res.json({
      voicePrompt: {
        durationSec: Math.round(durationSec),
        waveform: validation.value.waveform,
        audioUrl: await createVoicePromptSignedUrl(storagePath),
      },
    });
  });

  router.delete("/", async (req: Request, res: Response): Promise<void> => {
    await deleteVoicePrompt(req.userId as string);
    res.json({ ok: true });
  });

  return router;
}

/**
 * Lazily mint a Telegram `file_id` for a prompt recorded on the native rail.
 *
 * Without this a Telegram user could not HEAR an iOS partner's recording:
 * `sendVoice` takes a `file_id` or an upload, and an iOS prompt has neither
 * until something sends it once. The id is cached on the row, so this costs one
 * upload per prompt rather than one per pitch.
 */
export async function ensureTelegramFileIdForVoicePrompt(
  api: { sendVoice: (chatId: number, voice: unknown) => Promise<{ voice?: { file_id: string } }> },
  scratchChatId: number,
  userId: string,
): Promise<string | null> {
  const prompt = await prisma.voicePrompt.findUnique({
    where: { userId },
    select: { telegramFileId: true, storagePath: true },
  });
  if (!prompt) return null;
  if (prompt.telegramFileId) return prompt.telegramFileId;
  if (!prompt.storagePath) return null;

  const audio = await downloadVoicePrompt(prompt.storagePath);
  if (!audio) return null;

  try {
    const sent = await api.sendVoice(scratchChatId, audio);
    const fileId = sent.voice?.file_id;
    if (!fileId) return null;
    await prisma.voicePrompt.update({ where: { userId }, data: { telegramFileId: fileId } });
    return fileId;
  } catch (err) {
    console.warn("[voice-prompt] file_id mint failed:", err);
    return null;
  }
}
