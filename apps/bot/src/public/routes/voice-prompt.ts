import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  VOICE_PROMPT_MAX_DURATION_SECONDS,
  VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
  VOICE_PROMPT_MIN_DURATION_SECONDS,
} from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { voicePromptUploadLimiter, voicePromptUploadUrlLimiter } from "../rate-limit.js";
import { env } from "../../config.js";
import { validateVoicePrompt } from "../../services/profile-media-validation/voice-prompt-validation.js";
import { logMediaValidationRejection } from "../../services/profile-media-validation/rejection-log.js";
import { deleteVoicePrompt, saveVoicePrompt } from "../../services/voice-prompt.js";
import {
  createVoicePromptSignedUpload,
  createVoicePromptSignedUrl,
  deleteStorageObject,
  downloadVoicePrompt,
  downloadVoicePromptUpload,
  isOwnVoicePromptUploadPath,
  uploadVoicePrompt,
} from "../../services/storage.js";

/**
 * Voice prompts for the NATIVE client (JWT) — VOICE_PROMPT_PRODUCT_SPEC.md §4.2.
 *
 * The Telegram rail needs no HTTP surface at all: `sendVoice` is the recorder,
 * the player and the store. Everything here exists because iOS has none of
 * that, which is also the whole cost of shipping both platforms together.
 *
 *   POST   /v1/me/voice-prompt/upload-url  — signed Supabase PUT + the bounds
 *   POST   /v1/me/voice-prompt             — commit the uploaded object (or a base64 body)
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
   * Direct-to-Supabase upload rather than a backend proxy (voice-prompts.md
   * §4.2).
   *
   * A 30-second AAC clip is ~120 KB, so proxying would be affordable — the
   * reason not to is that the same single Node process runs the bot, every
   * cron and both APIs, and audio bodies have no business passing through it.
   * The commit still downloads the object once, for moderation; what this
   * process no longer does is hold a request open while a phone on a bad
   * network trickles the body in.
   *
   * `uploadUrl: null` is a live answer, not a legacy one: storage that is not
   * configured (a local install) or a Supabase that refuses to sign sends the
   * client down the base64 body instead — the only transport before this.
   */
  router.post(
    "/upload-url",
    voicePromptUploadUrlLimiter,
    async (req: Request, res: Response): Promise<void> => {
      const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "";
      if (!contentType.startsWith("audio/")) {
        res.status(400).json({ error: "bad-content-type" });
        return;
      }
      const signed = await createVoicePromptSignedUpload(req.userId as string, contentType);
      res.json({
        uploadUrl: signed?.uploadUrl ?? null,
        uploadPath: signed?.path ?? null,
        maxBytes: VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
        minDurationSec: VOICE_PROMPT_MIN_DURATION_SECONDS,
        maxDurationSec: VOICE_PROMPT_MAX_DURATION_SECONDS,
      });
    },
  );

  router.post("/", voicePromptUploadLimiter, async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId as string;
    // A claim, used only to refuse an obvious misfire before any provider is
    // paid. What is stored comes back from validation (audit A13-L14).
    const durationSec = Number(req.body?.durationSec);
    const uploadPath = typeof req.body?.uploadPath === "string" ? req.body.uploadPath : "";
    const audioBase64 = typeof req.body?.audio === "string" ? req.body.audio : "";

    if (!Number.isFinite(durationSec) || durationSec <= 0 || (!uploadPath && !audioBase64)) {
      res.status(400).json({ error: "bad-request" });
      return;
    }

    // Two transports, one pipeline: a signed upload is already in the bucket
    // under a key this server minted; a base64 body still has to be written.
    let audio: Buffer;
    let mimeType: string;
    if (uploadPath) {
      // Ownership is the prefix the mint wrote, checked on the exact key: a
      // commit naming someone else's object must not get it transcribed,
      // published as the caller's voice, or deleted on refusal.
      if (!isOwnVoicePromptUploadPath(uploadPath, userId)) {
        res.status(403).json({ error: "upload-not-owned" });
        return;
      }
      const downloaded = await downloadVoicePromptUpload(
        uploadPath,
        VOICE_PROMPT_MAX_FILE_SIZE_BYTES,
      );
      if (!downloaded.ok) {
        if (downloaded.reason === "too_large") {
          await discardRefusedUpload(userId, uploadPath);
          res.status(400).json({ error: "voice_too_long" });
        } else {
          // Nothing arrived under the key — the PUT failed or never ran. The
          // phone still holds the file, so this is a retry, not a re-record.
          res.status(409).json({ error: "upload-missing" });
        }
        return;
      }
      audio = downloaded.audio;
      mimeType = uploadPath.endsWith(".ogg") ? "audio/ogg" : "audio/mp4";
    } else {
      audio = Buffer.from(audioBase64, "base64");
      mimeType = typeof req.body?.mimeType === "string" ? req.body.mimeType : "audio/mp4";
      if (audio.byteLength === 0 || audio.byteLength > VOICE_PROMPT_MAX_FILE_SIZE_BYTES) {
        res.status(400).json({ error: "voice_too_long" });
        return;
      }
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
      // A refused recording must not stay in the bucket as the caller's voice
      // data. `processing_unavailable` is the one refusal that is not about the
      // clip: the client is told to send the SAME recording again, and on this
      // transport it does that by naming the same key.
      if (uploadPath && validation.reason !== "processing_unavailable") {
        await discardRefusedUpload(userId, uploadPath);
      }
      // 422 rather than 400: the request is well-formed, the CONTENT is
      // refused — and `retryable` is what tells the client whether re-recording
      // is the fix or whether it should simply try the same clip again.
      res.status(422).json({ error: validation.reason, retryable: validation.retryable });
      return;
    }

    let storagePath: string;
    if (uploadPath) {
      storagePath = uploadPath;
    } else {
      try {
        const uploaded = await uploadVoicePrompt(userId, audio, mimeType);
        storagePath = uploaded.path;
      } catch (err) {
        console.error("[voice-prompt] upload failed:", err);
        res.status(503).json({ error: "storage-unavailable" });
        return;
      }
    }

    await saveVoicePrompt({
      userId,
      storagePath,
      durationSec: validation.value.durationSeconds,
      mimeType,
      fileSize: audio.byteLength,
      waveform: validation.value.waveform,
      transcript: validation.value.transcript,
    });

    res.json({
      voicePrompt: {
        durationSec: validation.value.durationSeconds,
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
 * Remove an uploaded object the commit refused, best-effort. Only ever called
 * with a key `isOwnVoicePromptUploadPath` accepted for this caller. The live
 * row is checked first: a client re-committing the key of the prompt it
 * already has (after a moderation-policy change, say) gets the refusal, but
 * must not also lose the recording the row still points at. A failed delete
 * leaves an orphan under `${userId}/`, which account deletion's prefix sweep
 * still erases; it is logged rather than dropped, because it is voice data.
 */
async function discardRefusedUpload(userId: string, path: string): Promise<void> {
  const live = await prisma.voicePrompt.findUnique({
    where: { userId },
    select: { storagePath: true },
  });
  if (live?.storagePath === path) return;
  const removed = await deleteStorageObject(env.SUPABASE_VOICE_BUCKET, path).catch(() => false);
  if (!removed) console.warn(`[voice-prompt] refused upload not removed path=${path}`);
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
