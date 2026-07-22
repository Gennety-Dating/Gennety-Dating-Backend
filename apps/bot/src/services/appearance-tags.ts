import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import { setForGender, type PhotoAttrs } from "@gennety/shared";
import { downloadProfileImage } from "./storage.js";
import { sniffImageMime } from "../utils/image-sniff.js";
import { env } from "../config.js";
import {
  tagAppearanceFromBuffers,
  type AppearanceTagResult,
} from "./vision/tag-appearance.js";
import type { AttractivenessImageInput } from "./vision/score-attractiveness.js";

/**
 * Type Radar step 6: tag a user's own appearance (`Profile.appearanceTags`) from
 * their profile photos so the match engine can score it against a partner's
 * radar preferences (`V_type`). Runs best-effort alongside the Elo vision seed
 * in the verification pipeline; a failure only means `V_type` stays neutral for
 * this candidate — it never blocks verification. Gated by `TYPE_RADAR_ENABLED`,
 * so no OpenAI call happens while the feature is dark.
 *
 * @see PRODUCT_SPEC.md §Type Radar
 * @see services/vision/tag-appearance.ts (the isolated vision pass)
 */

export type TagAppearanceOutcome =
  | "persisted"
  | "disabled"
  | "no_gender"
  | "no_photos"
  | "download_failed"
  | "vision_failed"
  | "photos_changed";

export interface TagAppearanceDeps {
  downloadProfileImage: (pathOrFileId: string) => Promise<Buffer | null>;
  tagAppearance: (
    images: readonly AttractivenessImageInput[],
    set: "female" | "male",
  ) => Promise<AppearanceTagResult>;
  persist: (userId: string, photoPaths: readonly string[], tags: PhotoAttrs) => Promise<boolean>;
}

/**
 * Core, dependency-injected so tests can drive it without the network. Caller
 * has already decided the feature is on. Never throws.
 */
export async function tagAndPersistAppearance(
  userId: string,
  photoPaths: readonly string[],
  gender: string | null,
  deps: TagAppearanceDeps,
  mime = "image/jpeg",
): Promise<TagAppearanceOutcome> {
  if (gender !== "male" && gender !== "female") return "no_gender";
  if (photoPaths.length === 0) return "no_photos";
  const set = setForGender(gender);

  const buffers = await Promise.all(
    photoPaths.map((path) => deps.downloadProfileImage(path)),
  );
  const images: AttractivenessImageInput[] = [];
  for (const buffer of buffers) {
    if (!buffer) return "download_failed";
    const detected = sniffImageMime(buffer);
    if (detected === "image/heic") return "vision_failed";
    images.push({ buffer, mime: detected ?? mime });
  }

  const result = await deps.tagAppearance(images, set);
  if (!result.ok) return "vision_failed";

  const persisted = await deps.persist(userId, photoPaths, result.tags);
  return persisted ? "persisted" : "photos_changed";
}

/** Persist tags only if the photo array still matches the snapshot taken at the
 *  start of tagging — a concurrent photo edit invalidates the classification. */
export async function persistAppearanceTags(
  userId: string,
  photoPaths: readonly string[],
  tags: PhotoAttrs,
): Promise<boolean> {
  const result = await prisma.profile.updateMany({
    where: { userId, photos: { equals: [...photoPaths] } },
    data: { appearanceTags: tags as unknown as Prisma.InputJsonValue },
  });
  return result.count > 0;
}

/**
 * Production wiring: real Supabase/Telegram download + isolated vision pass +
 * Prisma. Best-effort and env-gated; safe to call unconditionally from the
 * verification pipeline. Logs and swallows every failure.
 */
export async function tagAndPersistAppearanceDefault(
  userId: string,
  photoPaths: readonly string[],
  gender: string | null,
  api: Api<RawApi>,
): Promise<TagAppearanceOutcome> {
  if (!env.TYPE_RADAR_ENABLED) return "disabled";
  try {
    const outcome = await tagAndPersistAppearance(
      userId,
      photoPaths,
      gender,
      {
        downloadProfileImage: (path) => downloadProfileImage(path, api),
        tagAppearance: (images, set) => tagAppearanceFromBuffers(images, set),
        persist: persistAppearanceTags,
      },
    );
    if (outcome !== "persisted" && outcome !== "disabled") {
      console.warn("[appearance-tags] not persisted", { userId, outcome });
    }
    return outcome;
  } catch (err) {
    console.warn("[appearance-tags] failed", { userId, err });
    return "vision_failed";
  }
}
