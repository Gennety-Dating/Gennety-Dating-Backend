import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { PROFILE_VIDEO_NATIVE_MAX_FILE_SIZE_BYTES } from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { videoUploadLimiter } from "../rate-limit.js";
import {
  removeNativeProfileVideo,
  saveNativeProfileVideo,
} from "../../services/native-profile-video.js";

/**
 * `POST /v1/me/video` and `DELETE /v1/me/video` — the profile video for the
 * native app. All logic lives in `services/native-profile-video.ts`; this file
 * is transport: multipart parsing, status codes, error bodies.
 *
 * Error body is the photo route's shape — `{ error, code, retryable }` — so the
 * client switches on `code` the same way for both.
 */

/** A first-frame JPEG at ≤1080 px is ~200 KB; five megabytes is not a poster. */
const THUMB_MAX_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROFILE_VIDEO_NATIVE_MAX_FILE_SIZE_BYTES, files: 2 },
});

function receiveVideo(req: Request, res: Response, next: NextFunction): void {
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "thumb", maxCount: 1 },
  ])(req, res, (err) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "The video is larger than 50 MB",
          code: "video_too_large",
          retryable: false,
        });
        return;
      }
      res.status(400).json({ error: err.code, code: "invalid_media", retryable: false });
      return;
    }
    next(err);
  });
}

/** HTTP status for a refused save. Exported for the contract test. */
export function profileVideoErrorStatus(error: string): number {
  switch (error) {
    case "invalid_media":
      return 400;
    case "profile_missing":
      return 404;
    case "video_too_long":
    case "video_too_large":
    case "video_too_large_to_check":
      return 413;
    case "storage_unavailable":
      return 502;
    case "processing_unavailable":
      return 503;
    default:
      // unsafe_content, video_too_short and any reason the validator adds later:
      // the server looked at the clip and said no.
      return 422;
  }
}

function profileVideoErrorMessage(error: string): string {
  switch (error) {
    case "invalid_media":
      return "The uploaded file is not a supported video";
    case "profile_missing":
      return "Profile not found";
    case "video_too_long":
      return "The video must be 60 seconds or shorter";
    case "video_too_large":
    case "video_too_large_to_check":
      return "The video is larger than 50 MB";
    case "video_too_short":
      return "The video must be at least 3 seconds long";
    case "unsafe_content":
      return "That video can't be published in a profile";
    case "storage_unavailable":
      return "Storage unavailable, please retry";
    default:
      return "Media validation is temporarily unavailable";
  }
}

export function createProfileVideoRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.post(
    "/",
    videoUploadLimiter,
    receiveVideo,
    async (req: Request, res: Response): Promise<void> => {
      const files = req.files as Record<string, Express.Multer.File[] | undefined> | undefined;
      const video = files?.video?.[0];
      const thumb = files?.thumb?.[0];
      if (!video || !thumb) {
        res.status(400).json({
          error: "Both `video` and `thumb` are required",
          code: "invalid_media",
          retryable: false,
        });
        return;
      }
      if (thumb.size > THUMB_MAX_BYTES) {
        res.status(400).json({
          error: "The poster image is too large",
          code: "invalid_media",
          retryable: false,
        });
        return;
      }

      const result = await saveNativeProfileVideo({
        userId: req.userId as string,
        video: video.buffer,
        thumb: thumb.buffer,
      });
      if (!result.ok) {
        res.status(profileVideoErrorStatus(result.error)).json({
          error: profileVideoErrorMessage(result.error),
          code: result.error,
          retryable: result.retryable,
        });
        return;
      }
      res.status(201).json({
        videoUrl: result.videoUrl,
        thumbUrl: result.thumbUrl,
        duration: result.duration,
        bonusGranted: result.bonusGranted,
      });
    },
  );

  router.delete("/", async (req: Request, res: Response): Promise<void> => {
    const { removed } = await removeNativeProfileVideo(req.userId as string);
    res.json({ removed });
  });

  return router;
}
