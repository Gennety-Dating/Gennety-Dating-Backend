import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { chatMessageLimiter, chatUploadLimiter } from "../rate-limit.js";
import { runChatTurn } from "../../services/chat-agent.js";
import { listChatTopics } from "../../services/chat-topics.js";
import {
  uploadChatImage,
  createChatImageSignedUrl,
} from "../../services/storage.js";
import { sniffImageMime } from "../../utils/image-sniff.js";

/**
 * Gennety chat agent — multimodal AI chat for the mobile app.
 *
 * Four endpoints:
 *   POST /v1/chat/upload   multipart image → opaque storage path
 *   POST /v1/chat/message  { text?, imageUrl? } → assistant reply
 *   GET  /v1/chat/history  newest page, `before` pages backwards
 *   GET  /v1/chat/topics   read-only index of past conversations
 *
 * Mobile flow: upload image first (returns `imageUrl`), then send a
 * `/message` referencing it. Either field is sufficient; both can be
 * combined for a captioned image.
 */

export const chatRouter: Router = Router();

chatRouter.use(requireAuth);
chatRouter.use(usageGuard);

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

    const turn = await runChatTurn({
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
      // Hybrid-chat contract slot (same shape as the interview's uiHint).
      // Chat turns are free-form, so no hint is derived yet — the field
      // exists so the generated client handles both surfaces uniformly.
      uiHint: null,
    });
  },
);

/**
 * GET /v1/chat/history — oldest-first slice, newest page first. Mobile uses
 * this to hydrate the chat view on app open and, with `before`, to page
 * backwards into older conversation. Each row's storage path gets a fresh
 * signed URL (5-min TTL) for client-side rendering.
 *
 * `before` is a message id, not a timestamp: `createdAt` ties are real (a
 * turn writes the user row and the assistant row inside the same request),
 * and a timestamp cursor would either skip a row or repeat one. Ordering is
 * `(createdAt, id)` on both sides so the cursor is total.
 *
 * `system` rows are excluded. The client already drops them before rendering,
 * and `/topics` counts messages the same way — a slice that disagreed with
 * the topic index would make `depth` point a page short.
 */
chatRouter.get("/history", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const rawBefore = req.query.before;
  const before = typeof rawBefore === "string" && rawBefore ? rawBefore : null;

  if (before) {
    // A cursor from another user's stream must not page this one. Checking
    // ownership here also turns a stale id (deleted account, wiped history)
    // into an honest 404 instead of a silently empty page.
    const owner = await prisma.message.findUnique({
      where: { id: before },
      select: { userId: true },
    });
    if (!owner || owner.userId !== req.userId!) {
      res.status(404).json({ error: "Unknown cursor" });
      return;
    }
  }

  // One row over the page size: its existence is the `hasMore` answer, and
  // it costs nothing next to a second COUNT.
  const rows = await prisma.message.findMany({
    where: { userId: req.userId!, role: { not: "system" } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();

  const messages = await Promise.all(
    page.map(async (row) => ({
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
  res.json({ messages, hasMore });
});

/**
 * GET /v1/chat/topics — the read-only index of past conversations.
 *
 * Not threads: see the header of `services/chat-topics.ts`. The agent's
 * context is untouched by this route, and nothing here can be sent, renamed
 * or deleted — a topic is a slice of the one continuous transcript, cut at a
 * silence, that the client uses to scroll back to a point in time.
 */
chatRouter.get("/topics", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const { topics, hasMore } = await listChatTopics(req.userId!, limit);
  res.json({ topics, hasMore });
});
