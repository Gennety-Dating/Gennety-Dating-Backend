import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  scoreAttractivenessFromBuffers,
  type AttractivenessAssessment,
  type AttractivenessBreakdown,
  type AttractivenessBatchResult,
  type AttractivenessImageInput,
} from "./vision/score-attractiveness.js";
import { downloadProfileImage } from "./storage.js";
import { UNVERIFIED_ELO_PENALTY } from "../utils/elo-calculator.js";
import { sniffImageMime } from "../utils/image-sniff.js";

/**
 * Cold-start Elo seeding from the AI vision pass.
 *
 * Called by the verification pipeline on the `verified` branch — once Persona
 * has confirmed the user is a real person and their photos match the selfie,
 * we run a SCUT-FBP5500-style scoring pass on every profile photo in one
 * request, average the independent scores, and seed `Profile.eloScore` so the
 * matcher's `V_league` decay has signal from day one.
 *
 * Without this seed, every fresh user starts at 500 and the league multiplier
 * collapses to ~1 across the cohort — which is exactly the bug the user
 * spotted during code review.
 *
 * @see PRODUCT_SPEC.md — Phase 3 (Matching Engine), V_league multiplier
 * @see schema.prisma — `Profile.eloScore`, `eloSeededAt`, `eloSeedDetails`
 */

/** Seed band: vision score 0..100 → Elo 200..800. */
export const ELO_SEED_MIN = 200;
export const ELO_SEED_MAX = 800;

/**
 * Pure mapping: 0..100 vision score → integer Elo in [ELO_SEED_MIN, ELO_SEED_MAX].
 *
 * The band is intentionally narrower than the schema's full [0, 1000] so that
 * accept/decline updates retain headroom on both sides. Population mean (50)
 * maps to the schema default (500) so a disabled seed is indistinguishable
 * from "average user" and downstream math stays sane.
 */
export function mapScoreToElo(score: number): number {
  const clamped = Math.max(0, Math.min(100, score));
  return Math.round(ELO_SEED_MIN + (clamped / 100) * (ELO_SEED_MAX - ELO_SEED_MIN));
}

export type SeedEloResult =
  | { ok: true; elo: number; score: number }
  | { ok: false; error: "download" | "vision" | "photos_changed" };

/**
 * Stored alongside `Profile.eloScore` for ops debugging. Schema column is
 * `Json?` so the shape is enforced by this interface and a JSON-write wrapper.
 */
export interface EloSeedDetails {
  score: number;
  elo: number;
  model: string;
  breakdown: AttractivenessBreakdown;
  rationale: string;
  seededAt: string;
  aggregation: "arithmetic_mean" | "none";
  photoCount: number;
  photos: Array<AttractivenessAssessment & { index: number }>;
}

export interface SeedEloDeps {
  /**
   * Source-aware profile-photo download (Supabase path OR Telegram file_id).
   * Pre-bound to the bot's `Api` by `seedEloFromVisionDefault` so this stays
   * grammY-agnostic and tests can pass a plain stub.
   */
  downloadProfileImage: (pathOrFileId: string) => Promise<Buffer | null>;
  scoreAttractiveness: (
    images: readonly AttractivenessImageInput[],
  ) => Promise<AttractivenessBatchResult>;
  persistSeed: (
    userId: string,
    eloScore: number,
    details: EloSeedDetails,
  ) => Promise<"persisted" | "already_seeded" | "photos_changed">;
}

/**
 * Run the seeding pipeline for one user. Caller has already determined that
 * seeding is wanted (flag enabled, `eloSeededAt` is null, photo exists) — this
 * function is single-purpose and does not gate on those conditions itself.
 *
 * Returns a discriminated result so the pipeline caller can log the outcome
 * but never throws — vision pass failures must not block verification.
 */
export async function seedEloFromVision(
  userId: string,
  photoPaths: readonly string[],
  deps: SeedEloDeps,
  mime: string = "image/jpeg",
): Promise<SeedEloResult> {
  if (photoPaths.length === 0) return { ok: false, error: "download" };

  const buffers = await Promise.all(
    photoPaths.map((photoPath) => deps.downloadProfileImage(photoPath)),
  );
  const images: AttractivenessImageInput[] = [];
  for (const buffer of buffers) {
    if (!buffer) return { ok: false, error: "download" };
    const detectedMime = sniffImageMime(buffer);
    if (detectedMime === "image/heic") {
      return { ok: false, error: "vision" };
    }
    images.push({ buffer, mime: detectedMime ?? mime });
  }
  const vision = await deps.scoreAttractiveness(images);
  if (!vision.ok) return { ok: false, error: "vision" };

  if (vision.assessments.length !== photoPaths.length) {
    return { ok: false, error: "vision" };
  }

  const score = mean(vision.assessments.map((assessment) => assessment.score));
  const breakdown: AttractivenessBreakdown = {
    symmetry: mean(
      vision.assessments.map((assessment) => assessment.breakdown.symmetry),
    ),
    eyeDistance: mean(
      vision.assessments.map((assessment) => assessment.breakdown.eyeDistance),
    ),
    faceShape: mean(
      vision.assessments.map((assessment) => assessment.breakdown.faceShape),
    ),
    featureRegularity: mean(
      vision.assessments.map(
        (assessment) => assessment.breakdown.featureRegularity,
      ),
    ),
  };
  const elo = mapScoreToElo(score);
  const details: EloSeedDetails = {
    score,
    elo,
    model: vision.model,
    breakdown,
    rationale: `Arithmetic mean of ${vision.assessments.length} profile photo scores`,
    seededAt: new Date().toISOString(),
    aggregation: "arithmetic_mean",
    photoCount: vision.assessments.length,
    photos: vision.assessments.map((assessment, index) => ({
      index: index + 1,
      ...assessment,
    })),
  };

  const persisted = await deps.persistSeed(userId, elo, details);
  if (persisted === "photos_changed") {
    return { ok: false, error: "photos_changed" };
  }
  return { ok: true, elo, score };
}

/**
 * Strategy (б) refund for users who previously tapped "Skip" on the
 * verification CTA and are now successfully completing Persona.
 *
 *   - Refund `UNVERIFIED_ELO_PENALTY` to `eloScore` (clamped at ELO_MAX).
 *   - Clear `verificationSkippedAt` so the comment-promised reset actually
 *     happens (the schema docstring on `eloScore` references this).
 *   - Mark `eloSeededAt = now()` with a "refund" reason in `eloSeedDetails`,
 *     so the *vision* seed never runs for this user. Their behavioral Elo
 *     signal accumulated during the unverified period is the truth — we
 *     don't want to overwrite it with a photo score.
 *
 * Atomicity: all three writes happen inside a transaction. Idempotency is
 * enforced by `verificationSkippedAt: { not: null }` on the User update —
 * a duplicate webhook for the same user is a no-op.
 *
 * Returns `{ ok: true, ... }` on a successful refund or `{ ok: false }` on
 * any failure; the caller treats failures the same way as a vision-seed
 * failure (skip-and-log). Never throws.
 */
export async function refundSkipPenalty(userId: string): Promise<SeedEloResult> {
  const reason = "post-skip refund (strategy B): no vision seed";
  try {
    return await prisma.$transaction(async (tx) => {
      const updated = await tx.user.updateMany({
        where: { id: userId, verificationSkippedAt: { not: null } },
        data: { verificationSkippedAt: null },
      });
      if (updated.count === 0) {
        // Already refunded or never skipped — caller should treat this
        // as a no-op success. Reading current eloScore here is just for
        // the return value; nothing else changes.
        const profile = await tx.profile.findUnique({
          where: { userId },
          select: { eloScore: true },
        });
        return {
          ok: true as const,
          elo: profile?.eloScore ?? 0,
          score: 0,
        };
      }

      const now = new Date();
      const profile = await tx.profile.findUnique({
        where: { userId },
        select: { eloScore: true },
      });
      const current = profile?.eloScore ?? 0;
      const refunded = Math.min(1000, current + UNVERIFIED_ELO_PENALTY);

      await tx.profile.update({
        where: { userId },
        data: {
          eloScore: refunded,
          eloSeededAt: now,
          eloSeedDetails: {
            score: 0,
            elo: refunded,
            model: "refund-no-vision",
            breakdown: {
              symmetry: 0,
              eyeDistance: 0,
              faceShape: 0,
              featureRegularity: 0,
            },
            rationale: reason,
            seededAt: now.toISOString(),
            aggregation: "none",
            photoCount: 0,
            photos: [],
          } as unknown as object,
        },
      });

      return { ok: true as const, elo: refunded, score: 0 };
    });
  } catch (err) {
    console.warn("[elo-seed] refundSkipPenalty failed:", err);
    return { ok: false, error: "vision" };
  }
}

/**
 * Production wiring: real Supabase + real OpenAI + real Prisma. The pipeline
 * passes this in via `PipelineDeps.seedEloFromVision`.
 *
 * Branches by user state:
 *   - `verificationSkippedAt !== null` → refund the skip penalty (strategy
 *     (б)) and mark seeded. NO vision call. The user accumulated Elo
 *     during the unverified period; that's the signal of record.
 *   - Otherwise → fresh vision pass on the primary photo and seed normally.
 *
 * Idempotency: the vision branch sets `eloSeededAt = now()` via a conditional
 * `updateMany` so a race between two concurrent webhooks can't double-seed.
 * The refund branch is gated on `verificationSkippedAt: { not: null }` on
 * the User row.
 */
export async function seedEloFromVisionDefault(
  userId: string,
  photoPaths: readonly string[],
  api: Api<RawApi>,
  mime: string = "image/jpeg",
): Promise<SeedEloResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { verificationSkippedAt: true },
  });
  if (user?.verificationSkippedAt) {
    return refundSkipPenalty(userId);
  }
  return runVisionSeed(userId, photoPaths, api, mime);
}

async function runVisionSeed(
  userId: string,
  photoPaths: readonly string[],
  api: Api<RawApi>,
  mime: string,
): Promise<SeedEloResult> {
  return seedEloFromVision(
    userId,
    photoPaths,
    {
      downloadProfileImage: (path) => downloadProfileImage(path, api),
      scoreAttractiveness: (images) => scoreAttractivenessFromBuffers(images),
      persistSeed: (uid, eloScore, details) =>
        persistVisionSeed(uid, photoPaths, eloScore, details),
    },
    mime,
  );
}

export async function persistVisionSeed(
  userId: string,
  photoPaths: readonly string[],
  eloScore: number,
  details: EloSeedDetails,
): Promise<"persisted" | "already_seeded" | "photos_changed"> {
  const now = new Date();
  const result = await prisma.profile.updateMany({
    where: {
      userId,
      eloSeededAt: null,
      photos: { equals: [...photoPaths] },
    },
    data: {
      eloScore,
      eloSeededAt: now,
      eloSeedDetails: details as unknown as object,
    },
  });
  if (result.count > 0) return "persisted";

  const current = await prisma.profile.findUnique({
    where: { userId },
    select: { eloSeededAt: true },
  });
  if (current?.eloSeededAt) {
    console.warn("[elo-seed] race avoided: user already seeded", { userId });
    return "already_seeded";
  }
  console.warn("[elo-seed] photos changed during scoring; seed discarded", {
    userId,
  });
  return "photos_changed";
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
