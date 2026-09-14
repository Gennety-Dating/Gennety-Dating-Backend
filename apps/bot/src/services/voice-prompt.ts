import type { Api } from "grammy";
import { prisma } from "@gennety/db";
import { PROFILE_MEDIA_VALIDATION_VERSION, type Language } from "@gennety/shared";
import type { MediaValidationReason } from "./profile-media-validation/types.js";
import { validateVoicePrompt } from "./profile-media-validation/voice-prompt-validation.js";
import { env } from "../config.js";
import { deleteStorageObject, downloadTelegramFile } from "./storage.js";
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
    // Both pointers are written every time, null when absent. A re-record
    // REPLACES — and an omitted key in an upsert's `update` keeps the old
    // value, so a Telegram re-record used to leave the previous upload's
    // `storagePath` (and a native one the previous minted `file_id`) on the
    // row: each surface kept playing the old recording, and the old object
    // could not be removed without leaving the row pointing at nothing.
    telegramFileId: input.telegramFileId ?? null,
    storagePath: input.storagePath ?? null,
    validationVersion: PROFILE_MEDIA_VALIDATION_VERSION,
    validatedAt: new Date(),
  };

  const previous = await prisma.voicePrompt.findUnique({
    where: { userId },
    select: { storagePath: true },
  });

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

  if (previous?.storagePath && previous.storagePath !== data.storagePath) {
    await removeReplacedVoiceObject(userId, previous.storagePath);
  }

  await refreshUserEmbedding(userId).catch((err: unknown) => {
    console.warn("[voice-prompt] immediate embedding refresh failed:", err);
  });
}

/** Remove the prompt and re-embed, so a deleted recording stops influencing matching. */
export async function deleteVoicePrompt(userId: string): Promise<void> {
  const previous = await prisma.voicePrompt.findUnique({
    where: { userId },
    select: { storagePath: true },
  });
  const deleted = await prisma.voicePrompt.deleteMany({ where: { userId } });
  if (deleted.count === 0) return;
  if (previous?.storagePath) await removeReplacedVoiceObject(userId, previous.storagePath);

  await prisma.profile.updateMany({
    where: { userId },
    data: { embeddingDirty: true, embeddingDirtyAt: new Date() },
  });
  await refreshUserEmbedding(userId).catch((err: unknown) => {
    console.warn("[voice-prompt] immediate embedding refresh failed:", err);
  });
}

/**
 * Delete the stored audio a re-record or a deletion just orphaned (A13-M12).
 *
 * After the row write, never before: until it commits, the row still points at
 * this object, and a failed write must not leave a prompt with no audio behind
 * it. Best-effort — a voice recording is special-category-adjacent personal
 * data, so a failure is logged rather than silently dropped, and account
 * deletion's `${userId}/` sweep removes anything still left. The previous path
 * is read just before the write, so two re-records racing can each remove only
 * the object they saw; the loser's own upload is then the orphan.
 */
async function removeReplacedVoiceObject(userId: string, path: string): Promise<void> {
  const removed = await deleteStorageObject(env.SUPABASE_VOICE_BUCKET, path).catch(
    () => false,
  );
  if (!removed) {
    console.warn(`[voice-prompt] replaced audio not removed user=${userId} path=${path}`);
  }
}
