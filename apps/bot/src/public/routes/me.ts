import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { Prisma, prisma } from "@gennety/db";
import {
  MIN_PHOTOS,
  MAX_PHOTOS,
  MIN_AGE,
  MAX_AGE,
  MAX_BIO_LENGTH,
  MAX_MAJOR_LENGTH,
} from "@gennety/shared";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { serializeProfile, serializeUser } from "./serializers.js";
import {
  accountDeleteLimiter,
  photoUploadLimiter,
} from "../rate-limit.js";
import { validateSingleFaceFromBuffer } from "../../services/vision/validate-face.js";
import {
  createProfilePhotoSignedUrl,
  deleteStorageObject,
  uploadProfilePhoto,
} from "../../services/storage.js";
import { gateProfilePhoto } from "../../services/face-match-gate.js";
import {
  injectSystemMessage,
  runAgentTurn,
} from "../../services/onboarding-agent.js";
import { buildInterviewState, loadStateContext } from "./onboarding-state.js";

export const meRouter: Router = Router();

meRouter.use(requireAuth);

// 8MB ceiling used by the profile-photo multer config below — previously
// shared with the removed /verify-selfie endpoint.
const PHOTO_MAX_BYTES = 8 * 1024 * 1024;

meRouter.get("/", async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId! },
    include: { profile: true },
  });
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    user: serializeUser(user),
    profile: user.profile ? serializeProfile(user.profile) : null,
  });
});

/**
 * PATCH /v1/me — edit the mutable slice of the settings screen.
 *
 * Editable (see PRODUCT_SPEC Phase 2 — Edit Profile):
 *   user:    `major`
 *   profile: `hobbies`, `partnerPreferences`, `psychologicalSummary`,
 *            `ageRangeMin`, `ageRangeMax`
 *
 * Fixed identity fields (`firstName`, `surname`, `age`, `universityDomain`,
 * `email`, `gender`, `preference`, `status`, `photos`, `matchRadius`) are
 * silently ignored — clients may send a whole object back; we don't punish
 * them with a 400 for touching read-only fields.
 *
 * Intentionally does NOT trigger embedding recomputation — that's a separate
 * background worker.
 */
meRouter.patch("/", async (req: Request, res: Response): Promise<void> => {
  const body: Record<string, unknown> = (req.body ?? {}) as Record<string, unknown>;
  const profilePatch: Record<string, unknown> =
    body.profile && typeof body.profile === "object" && body.profile !== null
      ? (body.profile as Record<string, unknown>)
      : {};

  // --- user: major ---------------------------------------------------------
  const userUpdate: { major?: string | null } = {};
  if (Object.prototype.hasOwnProperty.call(body, "major")) {
    const v = body.major;
    if (v !== null && typeof v !== "string") {
      res.status(400).json({ error: "Invalid major" });
      return;
    }
    if (typeof v === "string" && v.length > MAX_MAJOR_LENGTH) {
      res.status(400).json({ error: "Field too long: major" });
      return;
    }
    userUpdate.major = v as string | null;
  }

  // --- profile: hobbies ----------------------------------------------------
  const profileUpdate: {
    hobbies?: string[];
    partnerPreferences?: string | null;
    psychologicalSummary?: string | null;
    ageRangeMin?: number | null;
    ageRangeMax?: number | null;
  } = {};

  if (Object.prototype.hasOwnProperty.call(profilePatch, "hobbies")) {
    const v = profilePatch.hobbies;
    if (v === null) {
      profileUpdate.hobbies = [];
    } else if (!Array.isArray(v)) {
      res.status(400).json({ error: "Invalid hobbies" });
      return;
    } else {
      if (v.length > 10) {
        res.status(400).json({ error: "Field too long: hobbies" });
        return;
      }
      for (const item of v) {
        if (typeof item !== "string") {
          res.status(400).json({ error: "Invalid hobbies" });
          return;
        }
        if (item.length > 50) {
          res.status(400).json({ error: "Field too long: hobbies" });
          return;
        }
      }
      profileUpdate.hobbies = v as string[];
    }
  }

  // --- profile: partnerPreferences / psychologicalSummary ------------------
  for (const field of ["partnerPreferences", "psychologicalSummary"] as const) {
    if (!Object.prototype.hasOwnProperty.call(profilePatch, field)) continue;
    const v = profilePatch[field];
    if (v !== null && typeof v !== "string") {
      res.status(400).json({ error: `Invalid ${field}` });
      return;
    }
    if (typeof v === "string" && v.length > MAX_BIO_LENGTH) {
      res.status(400).json({ error: `Field too long: ${field}` });
      return;
    }
    profileUpdate[field] = v as string | null;
  }

  // --- profile: ageRangeMin / ageRangeMax (validated together) -------------
  const rangeMinProvided = Object.prototype.hasOwnProperty.call(profilePatch, "ageRangeMin");
  const rangeMaxProvided = Object.prototype.hasOwnProperty.call(profilePatch, "ageRangeMax");
  if (rangeMinProvided || rangeMaxProvided) {
    const rawMin = rangeMinProvided ? profilePatch.ageRangeMin : undefined;
    const rawMax = rangeMaxProvided ? profilePatch.ageRangeMax : undefined;
    if (!isValidAgeBound(rawMin) || !isValidAgeBound(rawMax)) {
      res.status(400).json({ error: "Invalid age range" });
      return;
    }

    // When only one side is provided, compare against the persisted
    // counterpart so we don't accept a half-update that inverts the range.
    const current = await prisma.profile.findUnique({
      where: { userId: req.userId! },
      select: { ageRangeMin: true, ageRangeMax: true },
    });
    const effectiveMin =
      rangeMinProvided ? (rawMin as number | null) : current?.ageRangeMin ?? null;
    const effectiveMax =
      rangeMaxProvided ? (rawMax as number | null) : current?.ageRangeMax ?? null;
    if (
      typeof effectiveMin === "number" &&
      typeof effectiveMax === "number" &&
      effectiveMin > effectiveMax
    ) {
      res.status(400).json({ error: "Invalid age range" });
      return;
    }

    if (rangeMinProvided) profileUpdate.ageRangeMin = rawMin as number | null;
    if (rangeMaxProvided) profileUpdate.ageRangeMax = rawMax as number | null;
  }

  const hasUserUpdate = Object.keys(userUpdate).length > 0;
  const hasProfileUpdate = Object.keys(profileUpdate).length > 0;

  // M-2: any field that feeds the embedding (hobbies, partnerPreferences,
  // psychologicalSummary) needs to mark the row dirty so the background
  // worker recomputes. `ageRangeMin/Max` doesn't feed the embedding.
  const profileChangedEmbeddingInput =
    Object.prototype.hasOwnProperty.call(profileUpdate, "hobbies") ||
    Object.prototype.hasOwnProperty.call(profileUpdate, "partnerPreferences") ||
    Object.prototype.hasOwnProperty.call(profileUpdate, "psychologicalSummary");
  const profileUpdateWithDirty: Record<string, unknown> = profileChangedEmbeddingInput
    ? { ...profileUpdate, embeddingDirty: true, embeddingDirtyAt: new Date() }
    : profileUpdate;

  if (hasUserUpdate || hasProfileUpdate) {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (hasUserUpdate) {
      ops.push(prisma.user.update({ where: { id: req.userId! }, data: userUpdate }));
    }
    if (hasProfileUpdate) {
      ops.push(
        prisma.profile.upsert({
          where: { userId: req.userId! },
          update: profileUpdateWithDirty,
          create: { userId: req.userId!, ...profileUpdateWithDirty },
        }),
      );
    }
    await prisma.$transaction(ops);
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    include: { profile: true },
  });
  res.json({
    user: serializeUser(user),
    profile: user.profile ? serializeProfile(user.profile) : null,
  });
});

function isValidAgeBound(v: unknown): v is number | null | undefined {
  if (v === undefined || v === null) return true;
  return typeof v === "number" && Number.isInteger(v) && v >= MIN_AGE && v <= MAX_AGE;
}

/**
 * DELETE /v1/me — GDPR "Right to be Forgotten".
 *
 * Prisma cascade removes the `Profile` row (including its pgvector
 * embedding) and all `Match` rows where this user participates. Storage
 * cleanup (selfie + profile photos) is best-effort: a dangling object is
 * far less bad than leaving a zombie DB row. See the Zero-Chat vector
 * rules — hard-delete is only triggered here, never from match lifecycle.
 */
meRouter.delete(
  "/",
  accountDeleteLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const [user, chatImages] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.userId! },
        include: { profile: true },
      }),
      prisma.message.findMany({
        where: { userId: req.userId!, imageUrl: { not: null } },
        select: { imageUrl: true },
      }),
    ]);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const selfiePath = user.selfiePath;
    const photoPaths = user.profile?.photos ?? [];
    const chatImagePaths = chatImages
      .map((row) => row.imageUrl)
      .filter((path): path is string => typeof path === "string" && path.length > 0);

    try {
      await prisma.user.delete({ where: { id: req.userId! } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      throw err;
    }

    // Best-effort storage cleanup — never fail the request on storage
    // errors because the DB state has already been committed.
    if (selfiePath) {
      try {
        await deleteStorageObject(env.SUPABASE_SELFIE_BUCKET, selfiePath);
      } catch (err) {
        console.warn("[DELETE /v1/me] selfie cleanup failed:", err);
      }
    }
    for (const path of photoPaths) {
      try {
        await deleteStorageObject(env.SUPABASE_PHOTO_BUCKET, path);
      } catch (err) {
        console.warn("[DELETE /v1/me] photo cleanup failed:", err);
      }
    }
    for (const path of chatImagePaths) {
      try {
        await deleteStorageObject(env.SUPABASE_CHAT_BUCKET, path);
      } catch (err) {
        console.warn("[DELETE /v1/me] chat image cleanup failed:", err);
      }
    }

    res.status(204).end();
  },
);

/**
 * POST /v1/me/location — persist the user's "home base" coordinates used by
 * the Meet-Halfway matching algorithm.
 *
 * Distinct from `Match.vibeLat{A,B}` which are per-match commute pins set
 * during venue negotiation — this is the persistent baseline read by the
 * match engine when scoring candidates.
 *
 * Validation: lat ∈ [-90, 90], lng ∈ [-180, 180], both finite numbers.
 * Does NOT mark the embedding dirty — geolocation isn't part of the
 * psychological context that feeds the embedding.
 */
meRouter.post("/location", async (req: Request, res: Response): Promise<void> => {
  const { latitude, longitude } = (req.body ?? {}) as {
    latitude?: unknown;
    longitude?: unknown;
  };

  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    res.status(400).json({ error: "Invalid latitude" });
    return;
  }
  if (
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    res.status(400).json({ error: "Invalid longitude" });
    return;
  }

  const now = new Date();
  const profile = await prisma.profile.upsert({
    where: { userId: req.userId! },
    update: { latitude, longitude, locationUpdatedAt: now },
    create: { userId: req.userId!, latitude, longitude, locationUpdatedAt: now },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
  });

  res.json({
    user: serializeUser(user),
    profile: serializeProfile(profile),
  });
});

/** PATCH /v1/me/preferences — currently exposes `matchRadius` only. */
meRouter.patch("/preferences", async (req: Request, res: Response): Promise<void> => {
  const radius = req.body?.matchRadius;
  if (radius !== "campus_only" && radius !== "citywide") {
    res.status(400).json({ error: "Invalid matchRadius" });
    return;
  }

  const profile = await prisma.profile.upsert({
    where: { userId: req.userId! },
    update: { matchRadius: radius },
    create: { userId: req.userId!, matchRadius: radius },
  });

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
  });

  res.json({
    user: serializeUser(user),
    profile: serializeProfile(profile),
  });
});

/**
 * POST /v1/me/push-token — register the Expo push token so the push
 * dispatcher (Phase 5 worker) can send OS-level notifications on match /
 * schedule events. A user row can hold only one token at a time; we
 * overwrite silently on re-registration (common when Expo rotates tokens).
 */
meRouter.post("/push-token", async (req: Request, res: Response): Promise<void> => {
  const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
  const platform =
    typeof req.body?.platform === "string" ? req.body.platform.trim().slice(0, 16) : "expo";
  if (!token) {
    res.status(400).json({ error: "Missing token" });
    return;
  }

  await prisma.user.update({
    where: { id: req.userId! },
    data: { pushToken: token, pushPlatform: platform },
  });

  res.json({ ok: true });
});

/**
 * GET /v1/me/verification — return just the verification status.
 *
 * The mobile client polls this after the user completes the Persona
 * hosted flow (opened via `GET /v1/me/verification/url`). Transitions:
 *   unverified → pending → verified | rejected
 *
 * The only writer of `verificationStatus` is the Persona webhook handler
 * (`/v1/webhooks/persona`) — this endpoint is read-only.
 */
meRouter.get("/verification", async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    select: { verificationStatus: true },
  });
  res.json({ status: user.verificationStatus });
});

// ---------------------------------------------------------------------------
// Profile photos (mobile settings screen)
// ---------------------------------------------------------------------------

const PHOTO_SIGNED_URL_TTL_S = 600; // 10 minutes — matches the spec.

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PHOTO_MAX_BYTES },
});

function photoUploadWithErrorHandling(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  photoUpload.single("photo")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: err.code });
      return;
    }
    next(err);
  });
}

/**
 * Mobile clients never see raw storage paths — render requires a
 * short-lived signed URL. This helper maps paths 1:1 to URLs; if
 * Supabase isn't configured (local dev) the URL slot is an empty
 * string so the array shape is stable.
 */
async function buildPhotosResponse(
  paths: string[],
): Promise<{ photos: string[]; signedUrls: string[] }> {
  const signedUrls = await Promise.all(
    paths.map(async (p) => (await createProfilePhotoSignedUrl(p, PHOTO_SIGNED_URL_TTL_S)) ?? ""),
  );
  return { photos: paths, signedUrls };
}

/**
 * GET /v1/me/photos — returns the ordered list of profile photo paths
 * plus matching signed URLs (TTL 10 minutes). Paths are kept in the
 * response so the client can pair with the URL on deletes.
 */
meRouter.get("/photos", async (req: Request, res: Response): Promise<void> => {
  const profile = await prisma.profile.findUnique({
    where: { userId: req.userId! },
    select: { photos: true },
  });
  const photos = profile?.photos ?? [];
  res.json(await buildPhotosResponse(photos));
});

/**
 * POST /v1/me/photos — upload a single profile photo.
 *
 * Order of gates is cheap-first: we reject obvious junk before spending
 * an OpenAI vision call or a Supabase round-trip.
 *
 *   1. mime must be `image/*`  → 400
 *   2. existing count < MAX_PHOTOS → 409 (mobile should have hidden the
 *      add button, but belt + braces)
 *   3. single-face vision gate → 400 (not a real face) / 502 (api down)
 *   4. upload to Supabase Storage + append to `profile.photos`
 *
 * Does NOT trigger embedding recomputation — that belongs to a worker.
 */
meRouter.post(
  "/photos",
  photoUploadLimiter,
  photoUploadWithErrorHandling,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing photo" });
      return;
    }

    const mime = req.file.mimetype || "image/jpeg";
    if (!mime.startsWith("image/")) {
      res.status(400).json({ error: "Photo must be an image" });
      return;
    }

    const profile = await prisma.profile.findUnique({
      where: { userId: req.userId! },
      select: { photos: true },
    });
    const existing = profile?.photos ?? [];
    if (existing.length >= MAX_PHOTOS) {
      res.status(409).json({ error: "Photo limit reached", max: MAX_PHOTOS });
      return;
    }

    const vision = await validateSingleFaceFromBuffer(req.file.buffer, mime);
    if (!vision.ok) {
      res.status(502).json({ error: "Vision service unavailable, please retry" });
      return;
    }
    if (!vision.valid) {
      res.status(400).json({ error: "Photo must contain exactly one clear face" });
      return;
    }

    // Face-match gate: for users who have already verified, every new photo
    // must depict the same person as the Persona-captured selfie. Without
    // this, a verified user could swap in someone else's photos. The gate
    // is no-op for unverified users (no reference selfie yet).
    const gate = await gateProfilePhoto(req.userId!, req.file.buffer);
    if (gate.kind === "blocked") {
      res.status(422).json({
        error: "Photo doesn't match your verification selfie",
        score: gate.score,
      });
      return;
    }

    let uploadedPath: string;
    try {
      const uploaded = await uploadProfilePhoto(req.userId!, req.file.buffer, mime);
      uploadedPath = uploaded.path;
    } catch (err) {
      console.warn("[POST /v1/me/photos] storage upload failed:", err);
      res.status(502).json({ error: "Storage unavailable, please retry" });
      return;
    }

    const nextPhotos = [...existing, uploadedPath];
    // Append the gate's per-photo score in lockstep with `photos[]` so the
    // admin dashboard can spot a specific weak photo. `null` (gate didn't
    // run — e.g. unverified user, or fail-open) is preserved as such.
    const existingScores = await prisma.profile
      .findUnique({
        where: { userId: req.userId! },
        select: { photoFaceScores: true },
      })
      .then((p) => p?.photoFaceScores ?? []);
    // Pad existingScores with 0 if it's shorter than existing photos (legacy
    // rows from before this column existed). The 0 is a sentinel meaning
    // "score unknown"; admin rerun will refill it on next pipeline run.
    while (existingScores.length < existing.length) existingScores.push(0);
    const nextScores = [...existingScores, gate.score ?? 0];

    await prisma.profile.upsert({
      where: { userId: req.userId! },
      update: { photos: nextPhotos, photoFaceScores: nextScores },
      create: {
        userId: req.userId!,
        photos: nextPhotos,
        photoFaceScores: nextScores,
      },
    });

    const photosResponse = await buildPhotosResponse(nextPhotos);

    // During onboarding, mirror the Telegram photo flow: notify the agent so
    // it can advance to the next step (or finalize) once MIN_PHOTOS is hit.
    // Outside onboarding (profile editing) we skip the LLM round-trip.
    const userMeta = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: { telegramId: true, onboardingStep: true },
    });

    let interviewState = null;
    if (userMeta.onboardingStep !== "completed") {
      try {
        await injectSystemMessage(
          userMeta.telegramId,
          `User uploaded 1 verified photo via mobile. Total uploaded: ${nextPhotos.length}/${MAX_PHOTOS}.`,
        );
        const result = await runAgentTurn(
          userMeta.telegramId,
          `[Photo uploaded: total ${nextPhotos.length}/${MAX_PHOTOS}]`,
        );
        const ctx = await loadStateContext(req.userId!);
        interviewState = buildInterviewState({ ...ctx, question: result.reply });
      } catch (err) {
        // Photo is already saved — agent failure must not bubble up as a
        // user-facing photo upload error. Log and let the client refetch.
        console.warn("[POST /v1/me/photos] agent-turn after upload failed:", err);
      }
    }

    res.status(201).json({ ...photosResponse, interviewState });
  },
);

/**
 * DELETE /v1/me/photos/:index — remove a photo by its position in the
 * `profile.photos` array. Active users can't drop below MIN_PHOTOS —
 * paused users can (they're off the match grid anyway).
 *
 * Storage cleanup is best-effort; the DB update is the source of truth.
 */
meRouter.delete(
  "/photos/:index",
  async (req: Request, res: Response): Promise<void> => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId! },
      select: {
        status: true,
        profile: { select: { photos: true, photoFaceScores: true } },
      },
    });
    const photos = user.profile?.photos ?? [];
    if (index >= photos.length) {
      res.status(404).json({ error: "Photo not found" });
      return;
    }

    const nextPhotos = [...photos.slice(0, index), ...photos.slice(index + 1)];
    if (nextPhotos.length < MIN_PHOTOS && user.status === "active") {
      res.status(409).json({ error: "Minimum photos required", min: MIN_PHOTOS });
      return;
    }

    const removedPath = photos[index]!;
    try {
      await deleteStorageObject(env.SUPABASE_PHOTO_BUCKET, removedPath);
    } catch (err) {
      console.warn("[DELETE /v1/me/photos/:index] storage delete failed:", err);
    }

    // Drop the corresponding face-match score in parallel — keeps the
    // photoFaceScores[] array index-aligned with photos[].
    const scores = user.profile?.photoFaceScores ?? [];
    const nextScores =
      scores.length === photos.length
        ? [...scores.slice(0, index), ...scores.slice(index + 1)]
        : []; // misaligned legacy row → reset; pipeline rerun refills

    await prisma.profile.update({
      where: { userId: req.userId! },
      data: { photos: nextPhotos, photoFaceScores: nextScores },
    });

    res.json(await buildPhotosResponse(nextPhotos));
  },
);
