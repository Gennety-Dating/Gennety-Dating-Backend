import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import { PROFILE_MEDIA_VALIDATION_VERSION, type Language } from "@gennety/shared";
import type { MediaValidationReason } from "./profile-media-validation/types.js";
import { validateVoicePrompt } from "./profile-media-validation/voice-prompt-validation.js";
import { downloadTelegramFile } from "./storage.js";
import { logMediaValidationRejection } from "./profile-media-validation/rejection-log.js";
import { refreshUserEmbedding } from "../workers/embedding-refresh.js";

export type VoicePromptIngestResult =
  | { kind: "accepted"; durationSec: number }
  | { kind: "rejected"; reason: MediaValidationReason };

/**
 * Take a Telegram voice note and turn it into this user's voice prompt.
 *
 * Persists nothing the caller has to reconcile: on success the row is upserted
 * and the profile is marked dirty + refreshed in one place, so every surface
 * that ever ingests a recording (the onboarding step today, the `/v1/*` rail)
 * shares one definition of what "saved" means.
 */
export async function ingestTelegramVoicePrompt(args: {
  api: Api;
  userId: string;
  fileId: string;
  durationSeconds: number;
  fileSizeBytes?: number | undefined;
  mimeType?: string | undefined;
  language: Language;
}): Promise<VoicePromptIngestResult> {
  const audio = await downloadTelegramFile(args.api, args.fileId);
  if (!audio) {
    return { kind: "rejected", reason: "processing_unavailable" };
  }

  const validation = await validateVoicePrompt({
    audio,
    durationSeconds: args.durationSeconds,
    fileSizeBytes: args.fileSizeBytes,
  });

  if (!validation.ok) {
    // Logged as `video` because that is the coarse bucket the table already
    // has for non-photo media; the reason column is what identifies it.
    await logMediaValidationRejection({
      userId: args.userId,
      mediaType: "video",
      reason: validation.reason,
    }).catch((err: unknown) => {
      console.warn("[voice-prompt] rejection log failed:", err);
    });
    return { kind: "rejected", reason: validation.reason };
  }

  await saveVoicePrompt({
    userId: args.userId,
    telegramFileId: args.fileId,
    durationSec: args.durationSeconds,
    ...(args.mimeType === undefined ? {} : { mimeType: args.mimeType }),
    ...(args.fileSizeBytes === undefined ? {} : { fileSize: args.fileSizeBytes }),
    waveform: validation.value.waveform,
    transcript: validation.value.transcript,
  });

  return { kind: "accepted", durationSec: args.durationSeconds };
}

/**
 * Upsert the row and re-embed.
 *
 * The refresh is not an optimisation and must not be dropped as one.
 * `embeddingDirty` is fail-closed — `findCandidatesFor` withholds a dirty
 * seeker from matching entirely — so marking dirty and walking away takes the
 * user OUT of the pool until the 5-minute cron catches up. That is exactly the
 * `appendNegativeConstraint` bug (DECISIONS 2026-08-08), where a man who
 * explained a decline and immediately bought a paid Rematch was told nobody was
 * found, and refunded, when the engine had refused to look.
 *
 * Best-effort in the same shape `negative-constraints.ts` uses: a failed
 * refresh leaves the row dirty for the worker rather than failing the save,
 * because the recording itself is good either way.
 */
export async function saveVoicePrompt(input: {
  userId: string;
  telegramFileId?: string;
  storagePath?: string;
  durationSec: number;
  mimeType?: string;
  fileSize?: number;
  waveform: number[];
  transcript: string;
}): Promise<void> {
  const { userId, ...rest } = input;
  const data = {
    ...rest,
    validationVersion: PROFILE_MEDIA_VALIDATION_VERSION,
    validatedAt: new Date(),
  };

  await prisma.$transaction([
    prisma.voicePrompt.upsert({
      where: { userId },
      create: { userId, ...data },
      // A re-record REPLACES. There is no history and nothing to reconcile —
      // which is only true because the transcript lives here rather than being
      // folded into `psychologicalSummary`, where a changing value would append
      // instead of replace and multiply its own weight in the vector.
      update: data,
    }),
    prisma.profile.updateMany({
      where: { userId },
      data: { embeddingDirty: true, embeddingDirtyAt: new Date() },
    }),
  ]);

  await refreshUserEmbedding(userId).catch((err: unknown) => {
    console.warn("[voice-prompt] immediate embedding refresh failed:", err);
  });
}

/** Remove the prompt and re-embed, so a deleted recording stops influencing matching. */
export async function deleteVoicePrompt(userId: string): Promise<void> {
  const deleted = await prisma.voicePrompt.deleteMany({ where: { userId } });
  if (deleted.count === 0) return;

  await prisma.profile.updateMany({
    where: { userId },
    data: { embeddingDirty: true, embeddingDirtyAt: new Date() },
  });
  await refreshUserEmbedding(userId).catch((err: unknown) => {
    console.warn("[voice-prompt] immediate embedding refresh failed:", err);
  });
}
