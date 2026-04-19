import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { serializeProfile, serializeUser } from "./serializers.js";
import { selfieLimiter } from "../rate-limit.js";
import { validateSingleFaceFromBuffer } from "../../services/vision/validate-face.js";
import { uploadSelfie } from "../../services/storage.js";

export const meRouter: Router = Router();

meRouter.use(requireAuth);

const SELFIE_MAX_BYTES = 8 * 1024 * 1024; // 8MB — selfies compress well under this
const selfieUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SELFIE_MAX_BYTES },
});

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
 * GET /v1/me/verification — return just the verification status (no
 * selfie URL, no timestamps). The mobile client polls this after
 * submitting a selfie; transitions are: `unverified` → `pending` →
 * `verified` | `rejected`.
 */
meRouter.get("/verification", async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.userId! },
    select: { verificationStatus: true },
  });
  res.json({ status: user.verificationStatus });
});

/**
 * POST /v1/me/verify-selfie — accept a multipart selfie, run the same
 * one-face vision gate used at onboarding, upload the bytes to Supabase
 * Storage, and flip the user to `verified` / `rejected` / `pending`.
 *
 * Decision matrix:
 *   vision says `valid: true`  → `verified`, selfiePath written
 *   vision says `valid: false` → `rejected`, selfiePath cleared
 *   vision errored             → `pending`, retry prompt to user
 *   Supabase not configured    → `pending`, so admins can review manually
 *                                 once storage is wired in prod
 */
/**
 * Multer throws synchronous `MulterError`s for bad field names / over-limit
 * uploads. Translate them to 4xx so the client gets a clean JSON error.
 */
function selfieUploadWithErrorHandling(req: Request, res: Response, next: NextFunction): void {
  selfieUpload.single("selfie")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: err.code });
      return;
    }
    next(err);
  });
}

meRouter.post(
  "/verify-selfie",
  selfieLimiter,
  selfieUploadWithErrorHandling,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing selfie" });
      return;
    }

    const mime = req.file.mimetype || "image/jpeg";
    if (!mime.startsWith("image/")) {
      res.status(400).json({ error: "Selfie must be an image" });
      return;
    }

    const vision = await validateSingleFaceFromBuffer(req.file.buffer, mime);

    if (!vision.ok) {
      await prisma.user.update({
        where: { id: req.userId! },
        data: { verificationStatus: "pending" },
      });
      res.status(502).json({ error: "Vision service unavailable, please retry" });
      return;
    }

    if (!vision.valid) {
      await prisma.user.update({
        where: { id: req.userId! },
        data: { verificationStatus: "rejected", selfiePath: null },
      });
      res.json({ status: "rejected" });
      return;
    }

    let selfiePath: string | null = null;
    try {
      const upload = await uploadSelfie(req.userId!, req.file.buffer, mime);
      selfiePath = upload.path;
    } catch (err) {
      // Storage not configured or transient — keep the verification in
      // `pending` state so a human admin can finalise it. We don't fail
      // the request because the face check already passed.
      console.warn("[verify-selfie] storage upload failed:", err);
      await prisma.user.update({
        where: { id: req.userId! },
        data: { verificationStatus: "pending" },
      });
      res.json({ status: "pending" });
      return;
    }

    await prisma.user.update({
      where: { id: req.userId! },
      data: { verificationStatus: "verified", selfiePath },
    });
    res.json({ status: "verified" });
  },
);
