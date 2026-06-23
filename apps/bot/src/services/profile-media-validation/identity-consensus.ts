import type { Api, RawApi } from "grammy";
import { Prisma, prisma } from "@gennety/db";
import {
  FACE_SIMILARITY_THRESHOLD,
  normalizeProfileMedia,
  profilePhotoMedia,
  type ProfileMedia,
} from "@gennety/shared";
import type { FaceMatchResult } from "../face-match.js";
import { profileMediaToJson } from "../profile-media-json.js";
import { photoUploadStatePatch } from "./photo-state.js";

const PENDING_PHOTO_CANDIDATE_VERSION = 1;

export type PendingPhotoCandidateSource =
  | "telegram_onboarding"
  | "telegram_edit"
  | "mobile"
  | "aether";

export interface PendingPhotoCandidate {
  version: typeof PENDING_PHOTO_CANDIDATE_VERSION;
  photoRef: string;
  profileMedia: ProfileMedia;
  perceptualHash?: string;
  faceScore: number;
  uploadedAt: string;
  source: PendingPhotoCandidateSource;
}

export type PhotoConsensusStatus = "accepted" | "pending" | "confirmed" | "capped";

export interface PhotoConsensusCommitResult {
  status: PhotoConsensusStatus;
  photos: string[];
  profileMedia: ProfileMedia[];
  uploadedPhotoHashes: string[];
  photoFaceScores: number[];
  pendingCandidates: PendingPhotoCandidate[];
  acceptedCount: number;
  pendingCount: number;
  rejectedCount: number;
  rejectedCandidates: PendingPhotoCandidate[];
}

export interface CommitProfilePhotoCandidateInput {
  userId: string;
  photoRef: string;
  profileMedia: ProfileMedia;
  perceptualHash?: string | null;
  faceScore?: number | null;
  source: PendingPhotoCandidateSource;
  candidateBuffer?: Buffer | null;
  api?: Api<RawApi> | null;
}

interface ConsensusEvaluationDeps {
  getPhotoBuffer: (candidate: PendingPhotoCandidate) => Promise<Buffer | null>;
  compareFaces: (reference: Buffer, candidate: Buffer) => Promise<FaceMatchResult>;
}

export interface ConsensusEvaluation {
  winner: PendingPhotoCandidate[] | null;
  rejected: PendingPhotoCandidate[];
}

export function parsePendingPhotoCandidates(
  value: unknown,
): PendingPhotoCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(parsePendingPhotoCandidate)
    .filter((candidate): candidate is PendingPhotoCandidate => candidate !== null);
}

export function pendingPhotoCandidatesToJson(
  candidates: readonly PendingPhotoCandidate[],
): Prisma.InputJsonValue[] {
  return candidates.map((candidate) => ({
    version: candidate.version,
    photoRef: candidate.photoRef,
    profileMedia: candidate.profileMedia as unknown as Prisma.InputJsonValue,
    ...(candidate.perceptualHash
      ? { perceptualHash: candidate.perceptualHash }
      : {}),
    faceScore: candidate.faceScore,
    uploadedAt: candidate.uploadedAt,
    source: candidate.source,
  }));
}

export async function evaluatePhotoCandidateConsensus(
  candidates: readonly PendingPhotoCandidate[],
  deps: ConsensusEvaluationDeps,
  threshold = FACE_SIMILARITY_THRESHOLD,
): Promise<ConsensusEvaluation> {
  if (candidates.length < 2) {
    return { winner: null, rejected: [] };
  }

  const parents = candidates.map((_, index) => index);
  const buffers = new Map<string, Buffer>();

  const getBuffer = async (
    candidate: PendingPhotoCandidate,
  ): Promise<Buffer | null> => {
    const cached = buffers.get(candidate.photoRef);
    if (cached) return cached;
    const buffer = await deps.getPhotoBuffer(candidate);
    if (buffer) buffers.set(candidate.photoRef, buffer);
    return buffer;
  };

  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length; j += 1) {
      const left = candidates[i]!;
      const right = candidates[j]!;
      const leftBuffer = await getBuffer(left);
      const rightBuffer = await getBuffer(right);
      if (!leftBuffer || !rightBuffer) continue;

      const result = await deps.compareFaces(leftBuffer, rightBuffer);
      if (
        result.ok &&
        result.faceFound &&
        result.similarity >= threshold
      ) {
        union(parents, i, j);
      }
    }
  }

  const components = new Map<number, number[]>();
  candidates.forEach((_, index) => {
    const root = findRoot(parents, index);
    components.set(root, [...(components.get(root) ?? []), index]);
  });

  const ranked = [...components.values()]
    .filter((indices) => indices.length >= 2)
    .sort((a, b) => {
      if (b.length !== a.length) return b.length - a.length;
      const aTime = earliestUploadedAt(candidates, a);
      const bTime = earliestUploadedAt(candidates, b);
      if (aTime !== bTime) return aTime - bTime;
      return Math.min(...a) - Math.min(...b);
    });

  const winnerIndices = ranked[0] ?? null;
  if (!winnerIndices) {
    return { winner: null, rejected: [] };
  }

  const winnerSet = new Set(winnerIndices);
  const winner = winnerIndices
    .map((index) => candidates[index]!)
    .sort(compareCandidatesByUploadOrder);
  const rejected = candidates
    .filter((_, index) => !winnerSet.has(index))
    .sort(compareCandidatesByUploadOrder);

  return { winner, rejected };
}

export async function commitProfilePhotoCandidate(
  input: CommitProfilePhotoCandidateInput,
): Promise<PhotoConsensusCommitResult> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: {
      verifiedSelfiePath: true,
      profile: {
        select: {
          photos: true,
          profileMedia: true,
          photoFaceScores: true,
          referenceFaceEmbedding: true,
          uploadedPhotoHashes: true,
          pendingPhotoCandidates: true,
        },
      },
    },
  });
  if (!user) {
    throw new Error("User not found");
  }

  const profile = user.profile;
  const photos = [...(profile?.photos ?? [])];
  const profileMedia = normalizeProfileMedia(profile?.profileMedia ?? [], photos);
  const uploadedPhotoHashes = [...(profile?.uploadedPhotoHashes ?? [])];
  const photoFaceScores = [...(profile?.photoFaceScores ?? [])];
  while (photoFaceScores.length < photos.length) photoFaceScores.push(0);

  const candidate: PendingPhotoCandidate = {
    version: PENDING_PHOTO_CANDIDATE_VERSION,
    photoRef: input.photoRef,
    profileMedia: input.profileMedia,
    ...(input.perceptualHash ? { perceptualHash: input.perceptualHash } : {}),
    faceScore: input.faceScore ?? 0,
    uploadedAt: new Date().toISOString(),
    source: input.source,
  };

  // Every candidate that reaches here already passed per-photo validation
  // (safe content + not a duplicate + a usable face, and — when the user is
  // Persona-verified — a match against the verified selfie). We accept it
  // immediately.
  //
  // There is intentionally NO pre-verification cross-photo "is this the same
  // person" gate anymore. The old consensus pool held the first photos hidden
  // until two of them clustered, which stranded honest users whose genuine
  // same-person photos scored below the CompareFaces threshold (different
  // angle / light / time). The real identity guarantee lives in Persona
  // verification, which re-checks every photo against the selfie. We also never
  // derive a self-photo identity anchor here (`skipReferenceCreation: true`),
  // so a later photo is never gated against an earlier upload.
  const nextPhotos = [...photos, candidate.photoRef];
  const nextMedia = [...profileMedia, candidate.profileMedia];
  const nextHashes = [
    ...uploadedPhotoHashes,
    ...(candidate.perceptualHash ? [candidate.perceptualHash] : []),
  ];
  const nextScores = [...photoFaceScores, candidate.faceScore];
  const photoState = photoUploadStatePatch({
    photos: nextPhotos,
    uploadedPhotoHashes: nextHashes,
    referenceFaceEmbedding: profile?.referenceFaceEmbedding ?? null,
    skipReferenceCreation: true,
  });
  await upsertPhotoState(input.userId, {
    photos: nextPhotos,
    profileMedia: nextMedia,
    photoFaceScores: nextScores,
    uploadedPhotoHashes: nextHashes,
    pendingPhotoCandidates: [],
    photoState,
  });
  return {
    status: "accepted",
    photos: nextPhotos,
    profileMedia: nextMedia,
    uploadedPhotoHashes: nextHashes,
    photoFaceScores: nextScores,
    pendingCandidates: [],
    acceptedCount: nextPhotos.length,
    pendingCount: 0,
    rejectedCount: 0,
    rejectedCandidates: [],
  };
}

async function upsertPhotoState(
  userId: string,
  input: {
    photos: string[];
    profileMedia: ProfileMedia[];
    photoFaceScores: number[];
    uploadedPhotoHashes: string[];
    pendingPhotoCandidates: PendingPhotoCandidate[];
    photoState: {
      uploadedPhotoHashes: string[];
      acceptedPhotoCount: number;
      referenceFaceEmbedding?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    };
  },
): Promise<void> {
  await prisma.profile.upsert({
    where: { userId },
    create: {
      userId,
      photos: input.photos,
      profileMedia: profileMediaToJson(input.profileMedia),
      photoFaceScores: input.photoFaceScores,
      pendingPhotoCandidates: pendingPhotoCandidatesToJson(
        input.pendingPhotoCandidates,
      ),
      ...input.photoState,
    },
    update: {
      photos: input.photos,
      profileMedia: profileMediaToJson(input.profileMedia),
      photoFaceScores: input.photoFaceScores,
      pendingPhotoCandidates: pendingPhotoCandidatesToJson(
        input.pendingPhotoCandidates,
      ),
      ...input.photoState,
    },
  });
}

function parsePendingPhotoCandidate(value: unknown): PendingPhotoCandidate | null {
  if (!isRecord(value)) return null;
  const photoRef = cleanString(value.photoRef);
  const uploadedAt = cleanString(value.uploadedAt);
  if (!photoRef || !uploadedAt) return null;
  const profileMedia = parseProfileMedia(value.profileMedia, photoRef);
  const source =
    value.source === "telegram_onboarding" ||
    value.source === "telegram_edit" ||
    value.source === "mobile" ||
    value.source === "aether"
      ? value.source
      : "mobile";
  return {
    version: PENDING_PHOTO_CANDIDATE_VERSION,
    photoRef,
    profileMedia,
    ...(typeof value.perceptualHash === "string" && value.perceptualHash.length > 0
      ? { perceptualHash: value.perceptualHash }
      : {}),
    faceScore: typeof value.faceScore === "number" ? value.faceScore : 0,
    uploadedAt,
    source,
  };
}

function parseProfileMedia(value: unknown, fallbackPhotoRef: string): ProfileMedia {
  const normalized = normalizeProfileMedia([value], [fallbackPhotoRef]);
  return normalized[0] ?? profilePhotoMedia(fallbackPhotoRef);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareCandidatesByUploadOrder(
  a: PendingPhotoCandidate,
  b: PendingPhotoCandidate,
): number {
  const diff = Date.parse(a.uploadedAt) - Date.parse(b.uploadedAt);
  if (diff !== 0) return diff;
  return a.photoRef.localeCompare(b.photoRef);
}

function earliestUploadedAt(
  candidates: readonly PendingPhotoCandidate[],
  indices: readonly number[],
): number {
  return Math.min(
    ...indices.map((index) => Date.parse(candidates[index]!.uploadedAt)),
  );
}

function findRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) root = parents[root]!;
  while (parents[index] !== index) {
    const next = parents[index]!;
    parents[index] = root;
    index = next;
  }
  return root;
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
}
