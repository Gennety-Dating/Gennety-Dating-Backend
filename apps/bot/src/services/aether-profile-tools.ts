import { Prisma, prisma } from "@gennety/db";
import {
  MAX_AGE,
  MAX_PHOTOS,
  MIN_AGE,
  normalizeProfileMedia,
  profilePhotoMedia,
} from "@gennety/shared";
import { env } from "../config.js";
import { gateProfilePhoto } from "./face-match-gate.js";
import { profileMediaToJson } from "./profile-media-json.js";
import {
  deleteStorageObject,
  downloadChatImage,
  uploadProfilePhoto,
} from "./storage.js";
import { triggerVerificationRerun } from "./verification-pipeline.js";
import { validateSingleFaceFromBuffer } from "./vision/validate-face.js";

export interface AetherToolResult {
  ok: boolean;
  detail?: string;
}

interface AetherProfilePatchDeps {
  findUser: (userId: string) => Promise<{ onboardingStep: string } | null>;
  updateUser: (userId: string, data: Prisma.UserUncheckedUpdateInput) => Promise<unknown>;
  upsertProfile: (
    userId: string,
    data: Prisma.ProfileUncheckedUpdateInput,
  ) => Promise<unknown>;
}

const profilePatchDeps: AetherProfilePatchDeps = {
  findUser: (userId) =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { onboardingStep: true },
    }),
  updateUser: (userId, data) =>
    prisma.user.update({
      where: { id: userId },
      data,
    }),
  upsertProfile: (userId, data) =>
    prisma.profile.upsert({
      where: { userId },
      update: data,
      create: Object.assign({}, data, { userId }) as Prisma.ProfileUncheckedCreateInput,
    }),
};

export async function applyAetherProfilePatch(
  userId: string,
  raw: unknown,
  deps: AetherProfilePatchDeps = profilePatchDeps,
): Promise<AetherToolResult> {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "Bad payload" };
  const args = raw as Record<string, unknown>;
  const user = await deps.findUser(userId);
  if (!user) return { ok: false, detail: "User not found" };

  const profilePatch: Prisma.ProfileUncheckedUpdateInput = {};
  const userPatch: Prisma.UserUncheckedUpdateInput = {};
  let touchedEmbedding = false;

  if (typeof args.age === "number" && Number.isInteger(args.age)) {
    if (args.age < MIN_AGE || args.age > MAX_AGE) {
      return { ok: false, detail: `Age must be ${MIN_AGE}-${MAX_AGE}` };
    }
    if (user.onboardingStep !== "completed") userPatch.age = args.age;
  }
  if (args.gender === "male" || args.gender === "female") {
    userPatch.gender = args.gender;
  }
  if (args.preference === "men" || args.preference === "women" || args.preference === "both") {
    userPatch.preference = args.preference;
  }
  if (typeof args.ethnicity === "string" && args.ethnicity.trim()) {
    profilePatch.ethnicity = args.ethnicity.trim().slice(0, 64);
  }
  if (typeof args.height === "number" && Number.isInteger(args.height)) {
    if (args.height < 120 || args.height > 230) {
      return { ok: false, detail: "Height out of range" };
    }
    profilePatch.height = args.height;
  }
  if (Array.isArray(args.hobbies)) {
    const hobbies = args.hobbies
      .filter((h): h is string => typeof h === "string")
      .map((h) => h.trim().slice(0, 48))
      .filter((h) => h.length > 0)
      .slice(0, 12);
    if (hobbies.length > 0) {
      profilePatch.hobbies = hobbies;
      touchedEmbedding = true;
    }
  }
  if (typeof args.partnerPreferences === "string" && args.partnerPreferences.trim()) {
    profilePatch.partnerPreferences = args.partnerPreferences.trim().slice(0, 280);
    touchedEmbedding = true;
  }

  if (touchedEmbedding) {
    profilePatch.embeddingDirty = true;
    profilePatch.embeddingDirtyAt = new Date();
  }
  if (Object.keys(userPatch).length > 0) {
    await deps.updateUser(userId, userPatch);
  }
  if (Object.keys(profilePatch).length > 0) {
    await deps.upsertProfile(userId, profilePatch);
  }
  return { ok: true };
}

interface AetherPhotoDeps {
  findOwnedMessageImage: (
    userId: string,
    imageUrl: string,
  ) => Promise<{ imageUrl: string | null } | null>;
  downloadChatImage: (path: string) => Promise<Buffer | null>;
  validateSingleFace: typeof validateSingleFaceFromBuffer;
  gateProfilePhoto: typeof gateProfilePhoto;
  findProfile: (userId: string) => Promise<{
    photos: string[];
    profileMedia: Prisma.JsonValue;
    photoFaceScores: number[];
  } | null>;
  uploadProfilePhoto: typeof uploadProfilePhoto;
  upsertProfile: (args: {
    userId: string;
    photos: string[];
    profileMedia: Prisma.InputJsonValue[];
    photoFaceScores: number[];
  }) => Promise<unknown>;
  deleteStorageObject: typeof deleteStorageObject;
  queueVerificationRerun: (userId: string) => void;
}

const photoDeps: AetherPhotoDeps = {
  findOwnedMessageImage: (userId, imageUrl) =>
    prisma.message.findFirst({
      where: { userId, imageUrl },
      select: { imageUrl: true },
    }),
  downloadChatImage,
  validateSingleFace: validateSingleFaceFromBuffer,
  gateProfilePhoto,
  findProfile: (userId) =>
    prisma.profile.findUnique({
      where: { userId },
      select: { photos: true, profileMedia: true, photoFaceScores: true },
    }),
  uploadProfilePhoto,
  upsertProfile: ({ userId, photos, profileMedia, photoFaceScores }) =>
    prisma.profile.upsert({
      where: { userId },
      update: { photos, profileMedia, photoFaceScores },
      create: { userId, photos, profileMedia, photoFaceScores },
    }),
  deleteStorageObject,
  queueVerificationRerun: (userId) => {
    void import("../public/server.js").then(({ getBotApi }) => {
      const api = getBotApi();
      if (!api) return;
      void triggerVerificationRerun(userId, api).catch((err) => {
        console.error("[aether] verification rerun failed:", err);
      });
    });
  },
};

export async function attachAetherProfilePhoto(
  userId: string,
  raw: unknown,
  deps: AetherPhotoDeps = photoDeps,
): Promise<AetherToolResult> {
  if (!raw || typeof raw !== "object") return { ok: false, detail: "Bad payload" };
  const path = (raw as { imageUrl?: unknown }).imageUrl;
  if (typeof path !== "string" || !path.startsWith(`${userId}/`)) {
    return { ok: false, detail: "Image not owned by user" };
  }

  const owned = await deps.findOwnedMessageImage(userId, path);
  if (!owned?.imageUrl) return { ok: false, detail: "Image not found" };
  const buffer = await deps.downloadChatImage(path);
  if (!buffer) return { ok: false, detail: "Image unavailable" };

  const mime = path.toLowerCase().endsWith(".png")
    ? "image/png"
    : path.toLowerCase().endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";
  const vision = await deps.validateSingleFace(buffer, mime);
  if (!vision.ok) return { ok: false, detail: "Vision service unavailable" };
  if (!vision.valid) {
    return { ok: false, detail: "Photo must contain exactly one clear face" };
  }

  const gate = await deps.gateProfilePhoto(userId, buffer);
  if (gate.kind === "blocked") {
    return { ok: false, detail: "Photo does not match verification selfie" };
  }

  const profile = await deps.findProfile(userId);
  const existing = profile?.photos ?? [];
  if (existing.length >= MAX_PHOTOS) {
    return { ok: false, detail: `Max ${MAX_PHOTOS} photos` };
  }

  const uploaded = await deps.uploadProfilePhoto(userId, buffer, mime);
  const media = normalizeProfileMedia(profile?.profileMedia ?? [], existing);
  const scores = [...(profile?.photoFaceScores ?? [])];
  while (scores.length < existing.length) scores.push(0);

  try {
    await deps.upsertProfile({
      userId,
      photos: [...existing, uploaded.path],
      profileMedia: profileMediaToJson([...media, profilePhotoMedia(uploaded.path)]),
      photoFaceScores: [...scores, gate.score ?? 0],
    });
  } catch (err) {
    await deps.deleteStorageObject(env.SUPABASE_PHOTO_BUCKET, uploaded.path).catch(() => false);
    throw err;
  }

  deps.queueVerificationRerun(userId);
  return { ok: true };
}
