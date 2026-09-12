import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { ANNOUNCEMENT_MEDIA } from "@gennety/shared";
import {
  archiveAnnouncement,
  attachAnnouncementMedia,
  clearAnnouncementMedia,
  countAudience,
  createAnnouncement,
  getAnnouncement,
  listAnnouncements,
  parseAnnouncementAudience,
  previewAnnouncement,
  scheduleAnnouncement,
  unscheduleAnnouncement,
  updateAnnouncementDraft,
  type WriteResult,
} from "../../services/announcements.js";

/**
 * `/admin/announcements` — the founder's composer for rich in-app
 * announcements (decision journal 2026-09-13). Behind the admin Bearer gate
 * like every other router here.
 *
 *   GET    /admin/announcements                    list, newest first
 *   POST   /admin/announcements                    create a draft
 *   POST   /admin/announcements/audience-count     { audience } → { count }
 *   GET    /admin/announcements/:id                one, with signed media
 *   PATCH  /admin/announcements/:id                edit a draft
 *   POST   /admin/announcements/:id/media          multipart `file` + `role`
 *   DELETE /admin/announcements/:id/media          drop image/video/poster
 *   POST   /admin/announcements/:id/preview        { userId } — one phone first
 *   POST   /admin/announcements/:id/schedule       { scheduledAt? } — now by default
 *   POST   /admin/announcements/:id/unschedule
 *   POST   /admin/announcements/:id/archive
 *
 * Validation lives in the service so the rules have one home; this file only
 * maps results onto HTTP.
 */

const LOG_PREFIX = "[admin][announcements]";

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: ANNOUNCEMENT_MEDIA.videoMaxBytes, files: 1 },
});

function withMulter(req: Request, res: Response, next: NextFunction): void {
  mediaUpload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code });
      return;
    }
    next(err);
  });
}

function send(res: Response, result: WriteResult, created = false): void {
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.status(created ? 201 : 200).json({ announcement: result.announcement });
}

function id(req: Request): string {
  return String(req.params.id);
}

export const announcementsRouter: Router = Router();

announcementsRouter.get("/admin/announcements", async (_req: Request, res: Response) => {
  res.json({ announcements: await listAnnouncements() });
});

announcementsRouter.post("/admin/announcements", async (req: Request, res: Response) => {
  send(res, await createAnnouncement(req.body), true);
});

// Before `/:id` routes so "audience-count" is never read as an id.
announcementsRouter.post("/admin/announcements/audience-count", async (req: Request, res: Response) => {
  const audience = parseAnnouncementAudience((req.body as { audience?: unknown } | undefined)?.audience);
  if (!audience) {
    res.status(400).json({ error: "audience_invalid" });
    return;
  }
  res.json({ count: await countAudience(audience) });
});

announcementsRouter.get("/admin/announcements/:id", async (req: Request, res: Response) => {
  const announcement = await getAnnouncement(id(req));
  if (!announcement) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ announcement });
});

announcementsRouter.patch("/admin/announcements/:id", async (req: Request, res: Response) => {
  send(res, await updateAnnouncementDraft(id(req), req.body));
});

announcementsRouter.post("/admin/announcements/:id/media", withMulter, async (req: Request, res: Response) => {
  const role = (req.body as { role?: unknown } | undefined)?.role;
  if (role !== "media" && role !== "poster") {
    res.status(400).json({ error: "role_invalid" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "file_required" });
    return;
  }
  const result = await attachAnnouncementMedia(id(req), { role, buffer: req.file.buffer });
  if (result.ok) console.log(`${LOG_PREFIX} ${role} attached to ${id(req)}`);
  send(res, result);
});

announcementsRouter.delete("/admin/announcements/:id/media", async (req: Request, res: Response) => {
  send(res, await clearAnnouncementMedia(id(req)));
});

announcementsRouter.post("/admin/announcements/:id/preview", async (req: Request, res: Response) => {
  const result = await previewAnnouncement(id(req), (req.body as { userId?: unknown } | undefined)?.userId);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  console.log(`${LOG_PREFIX} preview of ${id(req)} → inbox ${result.inboxItemId} (pushed=${result.pushed})`);
  res.json({ inboxItemId: result.inboxItemId, pushed: result.pushed });
});

announcementsRouter.post("/admin/announcements/:id/schedule", async (req: Request, res: Response) => {
  send(res, await scheduleAnnouncement(id(req), (req.body as { scheduledAt?: unknown } | undefined)?.scheduledAt));
});

announcementsRouter.post("/admin/announcements/:id/unschedule", async (req: Request, res: Response) => {
  send(res, await unscheduleAnnouncement(id(req)));
});

announcementsRouter.post("/admin/announcements/:id/archive", async (req: Request, res: Response) => {
  send(res, await archiveAnnouncement(id(req)));
});
