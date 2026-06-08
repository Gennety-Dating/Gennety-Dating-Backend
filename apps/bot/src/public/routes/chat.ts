import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { chatMessageLimiter, chatUploadLimiter } from "../rate-limit.js";
import { runAetherTurn } from "../../services/aether-agent.js";
import {
  uploadChatImage,
  createChatImageSignedUrl,
} from "../../services/storage.js";
import { sniffImageMime } from "../../utils/image-sniff.js";

/**
 * Aether Concierge — multimodal AI chat for the mobile app.
 *
 * Two endpoints:
 *   POST /v1/chat/upload   multipart image → opaque storage path
 *   POST /v1/chat/message  { text?, imageUrl? } → assistant reply
 *
 * Mobile flow: upload image first (returns `imageUrl`), then send a
 * `/message` referencing it. Either field is sufficient; both can be
 * combined for a captioned image.
 */

export const chatRouter: Router = Router();

chatRouter.use(requireAuth);

const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_TEXT_MAX_LENGTH = 4_000;
const SIGNED_URL_TTL_S = 300;

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CHAT_IMAGE_MAX_BYTES },
});

function chatUploadWithErrorHandling(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  chatUpload.single("image")(req, res, (err) => {
    if (!err) return next();
    if (err instanceof MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      res.status(status).json({ error: err.code });
      return;
    }
    next(err);
  });
}

chatRouter.post(
  "/upload",
  chatUploadLimiter,
  chatUploadWithErrorHandling,
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing image" });
      return;
    }
    // The client-supplied Content-Type is attacker-controlled, so sniff the
    // actual magic bytes and reject anything that isn't a real raster image
    // (audit M2). The sniffed MIME — not the header — is what we persist.
    const sniffed = sniffImageMime(req.file.buffer);
    if (!sniffed) {
      res.status(400).json({ error: "File must be a valid image" });
      return;
    }
    const mime = sniffed;
    try {
      const uploaded = await uploadChatImage(req.userId!, req.file.buffer, mime);
      const signedUrl = await createChatImageSignedUrl(uploaded.path, SIGNED_URL_TTL_S);
      res.status(201).json({
        imageUrl: uploaded.path,
        signedUrl: signedUrl ?? "",
      });
    } catch (err) {
      console.warn("[POST /v1/chat/upload] storage upload failed:", err);
      res.status(502).json({ error: "Storage unavailable, please retry" });
    }
  },
);

chatRouter.post(
  "/message",
  chatMessageLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const rawText = req.body?.text;
    const rawImageUrl = req.body?.imageUrl;

    const text = typeof rawText === "string" ? rawText.trim() : "";
    const imageUrl = typeof rawImageUrl === "string" ? rawImageUrl.trim() : "";

    if (!text && !imageUrl) {
      res.status(400).json({ error: "Provide text or imageUrl" });
      return;
    }
    if (text.length > CHAT_TEXT_MAX_LENGTH) {
      res.status(413).json({ error: "Text too long" });
      return;
    }
    if (imageUrl && !imageUrl.startsWith(`${req.userId!}/`)) {
      res.status(403).json({ error: "Image not owned by caller" });
      return;
    }

    const turn = await runAetherTurn({
      userId: req.userId!,
      text,
      imageUrl: imageUrl || null,
    });

    res.json({
      message: {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        imageUrl: turn.imageUrl,
        createdAt: turn.createdAt.toISOString(),
      },
    });
  },
);

/**
 * GET /v1/chat/history — paginated, oldest-first slice. Mobile uses this
 * to hydrate the chat view on app open. Each row's storage path gets a
 * fresh signed URL (5-min TTL) for client-side rendering.
 */
chatRouter.get("/history", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const rows = await prisma.message.findMany({
    where: { userId: req.userId! },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  rows.reverse();
  const messages = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      imageUrl: row.imageUrl,
      signedImageUrl: row.imageUrl
        ? (await createChatImageSignedUrl(row.imageUrl, SIGNED_URL_TTL_S)) ?? ""
        : null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
  res.json({ messages });
});
