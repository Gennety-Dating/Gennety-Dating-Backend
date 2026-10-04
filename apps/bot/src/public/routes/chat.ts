import { Router, type Request, type Response, type NextFunction } from "express";
import multer, { MulterError } from "multer";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { requireAgentAccess } from "../agent-access-middleware.js";
import { chatMessageLimiter, chatUploadLimiter, voiceLimiter } from "../rate-limit.js";
import { runChatTurn } from "../../services/chat-agent.js";
import { listChatTopics } from "../../services/chat-topics.js";
import {
  claimChatSession,
  listChatSessions,
  normalizeChatSessionTitle,
  ownsChatSession,
  parseChatSessionIdField,
  renameChatSession,
} from "../../services/chat-sessions.js";
import {
  parseChatContextRef,
  readChatContextSnapshot,
  resolveChatContextSnapshot,
  type ChatContextSnapshot,
} from "../../services/chat-context.js";
import {
  uploadChatImage,
  createChatImageSignedUrl,
  createChatImageSignedUrls,
} from "../../services/storage.js";
import { sniffImageMime } from "../../utils/image-sniff.js";
import { isUuid } from "../../utils/uuid.js";
import { transcribeVoice, WHISPER_MAX_BYTES } from "../../services/whisper.js";
import { CHAT_SESSIONS_PAGE_DEFAULT, CHAT_SESSIONS_PAGE_MAX } from "@gennety/shared";

/**
 * Gennety chat agent — multimodal AI chat for the mobile app.
 *
 * Endpoints:
 *   POST  /v1/chat/upload         multipart image → opaque storage path
 *   POST  /v1/chat/message        { text?, imageUrl?, context?, sessionId? } → assistant reply
 *   POST  /v1/chat/voice          the same turn from a voice note
 *   GET   /v1/chat/history        newest page, `before` pages backwards, `sessionId` = one chat
 *   GET   /v1/chat/sessions       the person's chats, most recently active first
 *   PATCH /v1/chat/sessions/:id   rename a chat
 *   GET   /v1/chat/topics         the pre-sessions index, kept for older builds
 *
 * Chats (decision journal 2026-09-30): every turn lands in one chat — the one
 * the client names with a `sessionId` it minted, or, for an older build that
 * names none, the most recent chat under six hours quiet (else a new one).
 * See `services/chat-sessions.ts`.
 *
 * Mobile flow: upload image first (returns `imageUrl`), then send a
 * `/message` referencing it. Either field is sufficient; both can be
 * combined for a captioned image.
 *
 * A turn may carry SEVERAL photos: `imageUrls` (up to `CHAT_IMAGES_MAX`),
 * album parity with Telegram. `imageUrl` stays accepted and is the first of
 * them — an older app build keeps working, and its single photo lands in the
 * same place. The agent sees every photo of the turn and answers ONCE: that
 * is the whole point of a list instead of N separate messages.
 *
 * The two spending routes carry `requireAgentAccess` — the same rule the
 * Telegram router and `/v1/assistant` ask. The read routes deliberately do
 * not: showing someone the conversation they already had costs no tokens and
 * writes nothing, and a history that went blank on suspension would read as
 * data loss rather than as enforcement.
 */

export const chatRouter: Router = Router();

chatRouter.use(requireAuth);
chatRouter.use(usageGuard);

const CHAT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const CHAT_TEXT_MAX_LENGTH = 4_000;
/** Сколько снимков несёт один ход — как альбом Telegram. */
const CHAT_IMAGES_MAX = 10;
const SIGNED_URL_TTL_S = 300;

/** Аудио: лимит Whisper, а не картиночные 8 МБ. */
const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: WHISPER_MAX_BYTES },
});

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
  requireAgentAccess,
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
  requireAgentAccess,
  chatMessageLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const rawText = req.body?.text;
    const rawImageUrl = req.body?.imageUrl;
    const rawImageUrls = req.body?.imageUrls;

    const text = typeof rawText === "string" ? rawText.trim() : "";
    const imageUrl = typeof rawImageUrl === "string" ? rawImageUrl.trim() : "";
    // Оба поля принимаются вместе: старая сборка шлёт одно, новая — список.
    // Порядок списка — порядок, в котором человек отмечал снимки; дубли
    // снимаются, пустые строки отбрасываются.
    const listed = Array.isArray(rawImageUrls)
      ? rawImageUrls
          .filter((value: unknown): value is string => typeof value === "string")
          .map((value) => value.trim())
      : [];
    const imageUrls = [...new Set([...(imageUrl ? [imageUrl] : []), ...listed])].filter(Boolean);

    if (!text && imageUrls.length === 0) {
      res.status(400).json({ error: "Provide text or imageUrl" });
      return;
    }
    if (text.length > CHAT_TEXT_MAX_LENGTH) {
      res.status(413).json({ error: "Text too long" });
      return;
    }
    if (imageUrls.length > CHAT_IMAGES_MAX) {
      res.status(413).json({ error: `At most ${CHAT_IMAGES_MAX} images per message` });
      return;
    }
    // Владение проверяется у КАЖДОГО пути: один чужой в списке — отказ всему
    // ходу, а не тихая отправка остальных.
    if (imageUrls.some((path) => !isOwnChatImagePath(path, req.userId!))) {
      res.status(403).json({ error: "Image not owned by caller" });
      return;
    }
    const context = await contextFromRequest(req.body?.context, req.userId!, res);
    if (context === false) return;
    const sessionId = await sessionFromRequest(req.body?.sessionId, req.userId!, res);
    if (sessionId === false) return;

    const turn = await runChatTurn({
      userId: req.userId!,
      text,
      imageUrls,
      context,
      sessionId,
    });

    res.json({
      message: {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        imageUrl: turn.imageUrl,
        createdAt: turn.createdAt.toISOString(),
      },
      sessionId: turn.sessionId,
      // Hybrid-chat contract slot (same shape as the interview's uiHint).
      // Chat turns are free-form, so no hint is derived yet — the field
      // exists so the generated client handles both surfaces uniformly.
      uiHint: null,
      // Код-владельческие подтверждения записей и native-действие, которое
      // агент не умеет нарисовать сам. Раньше и то и другое существовало
      // только на телеграм-поверхности: `/v1/assistant` уже несло их в DTO, а
      // этот маршрут ронял на пол — приложение узнавало об изменении профиля
      // исключительно из прозы модели.
      ...(turn.receipts ? { receipts: turn.receipts } : {}),
      ...(turn.action ? { action: turn.action } : {}),
    });
  },
);

/**
 * POST /v1/chat/voice — голосовая реплика в чат приложения.
 *
 * Близнец `/v1/assistant/voice`, и это не дублирование: у поверхностей разные
 * циклы и разные хранилища истории, а общий у них Whisper и набор
 * инструментов. Расшифровка возвращается вместе с ответом — человек должен
 * видеть, что именно услышал агент, иначе неверно понятая фраза выглядит как
 * его собственная ошибка.
 *
 * Картинку голосом не приложить: запись и вложение — разные ходы.
 */
chatRouter.post(
  "/voice",
  requireAgentAccess,
  voiceLimiter,
  voiceUpload.single("file"),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.file) {
      res.status(400).json({ error: "Missing file" });
      return;
    }
    // Multipart carries no nested object, so the chip rides as two plain form
    // fields. Checked BEFORE transcription: a refused context must not cost a
    // Whisper call. The chat id likewise.
    const rawKind: unknown = req.body?.contextKind;
    const rawId: unknown = req.body?.contextId;
    const context = await contextFromRequest(
      rawKind === undefined && rawId === undefined ? undefined : { kind: rawKind, id: rawId },
      req.userId!,
      res,
    );
    if (context === false) return;
    const sessionId = await sessionFromRequest(req.body?.sessionId, req.userId!, res);
    if (sessionId === false) return;

    const user = await prisma.user.findUnique({
      where: { id: req.userId! },
      select: { language: true },
    });

    const transcript = await transcribeVoice(req.file.buffer, {
      mime: req.file.mimetype,
      ...(user?.language ? { language: user.language } : {}),
    });
    if (!transcript) {
      res.status(422).json({ error: "Could not transcribe audio" });
      return;
    }

    const turn = await runChatTurn({
      userId: req.userId!,
      text: transcript,
      imageUrls: [],
      context,
      sessionId,
    });

    res.json({
      message: {
        id: turn.id,
        role: turn.role,
        content: turn.content,
        imageUrl: turn.imageUrl,
        createdAt: turn.createdAt.toISOString(),
      },
      sessionId: turn.sessionId,
      uiHint: null,
      transcript,
      ...(turn.receipts ? { receipts: turn.receipts } : {}),
      ...(turn.action ? { action: turn.action } : {}),
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
 *
 * `sessionId` pages ONE chat (decision journal 2026-09-30): an unknown or
 * foreign id is a 404, and so is a `before` from another chat. Without it the
 * route is what it always was — the whole stream across chats, which is what
 * older builds read.
 *
 * Every photo of the page is signed in ONE Storage request
 * (`createChatImageSignedUrls`), and `signedImageUrl` is simply the first of
 * `signedImageUrls` — it used to be a second signature of the same object.
 */
chatRouter.get("/history", async (req: Request, res: Response): Promise<void> => {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const rawBefore = req.query.before;
  const before = typeof rawBefore === "string" && rawBefore ? rawBefore : null;
  const rawSession = req.query.sessionId;
  const sessionId = typeof rawSession === "string" && rawSession ? rawSession.toLowerCase() : null;

  if (rawSession !== undefined && typeof rawSession !== "string") {
    res.status(404).json({ error: "Unknown chat" });
    return;
  }
  if (sessionId && !(await ownsChatSession(req.userId!, sessionId))) {
    res.status(404).json({ error: "Unknown chat" });
    return;
  }

  if (before) {
    // A cursor from another user's stream must not page this one. Checking
    // ownership here also turns a stale id (deleted account, wiped history)
    // into an honest 404 instead of a silently empty page. A non-UUID is the
    // same 404 — handed to Prisma it would be a P2023 and a 500.
    const owner = isUuid(before)
      ? await prisma.message.findUnique({
          where: { id: before },
          select: { userId: true, sessionId: true },
        })
      : null;
    if (!owner || owner.userId !== req.userId! || (sessionId && owner.sessionId !== sessionId)) {
      res.status(404).json({ error: "Unknown cursor" });
      return;
    }
  }

  // One row over the page size: its existence is the `hasMore` answer, and
  // it costs nothing next to a second COUNT.
  const rows = await prisma.message.findMany({
    where: {
      userId: req.userId!,
      role: { not: "system" },
      ...(sessionId ? { sessionId } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(before ? { cursor: { id: before }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  page.reverse();

  // Список — источник правды; одиночные поля остаются ПЕРВЫМ снимком для
  // сборок, которые про список не знают.
  const images = page.map(rowImages);
  const paths = images.flat();
  const signStartedAt = Date.now();
  const signed = await createChatImageSignedUrls(paths, SIGNED_URL_TTL_S);
  const signMs = Date.now() - signStartedAt;

  let cursor = 0;
  const messages = page.map((row, i) => {
    const rowPaths = images[i]!;
    const signedUrls = rowPaths.map(() => signed[cursor++] ?? "");
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      imageUrl: row.imageUrl,
      signedImageUrl: row.imageUrl ? (signedUrls[0] ?? "") : null,
      imageUrls: rowPaths,
      signedImageUrls: signedUrls,
      createdAt: row.createdAt.toISOString(),
      // The chip the message was sent with. Omitted — not null — when there is
      // none: the generated Swift client drops a nullable object silently.
      ...contextField(readChatContextSnapshot(row.context)),
    };
  });
  console.log(
    `[chat/history] rows=${page.length} images=${paths.length} sign_ms=${signMs} total_ms=${Date.now() - startedAt}${sessionId ? " session=1" : ""}`,
  );
  res.json({ messages, hasMore });
});

/**
 * GET /v1/chat/sessions — the person's chats, most recently active first
 * (decision journal 2026-09-30). `before` is a chat id, exclusive; an unknown
 * or foreign one is a 404, like `/history`'s cursor.
 *
 * Read-only and free, so outside `requireAgentAccess` for the same reason as
 * `/history`: a list that went blank on suspension would read as data loss.
 */
chatRouter.get("/sessions", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(
    Math.max(Number(req.query.limit ?? CHAT_SESSIONS_PAGE_DEFAULT) || CHAT_SESSIONS_PAGE_DEFAULT, 1),
    CHAT_SESSIONS_PAGE_MAX,
  );
  const rawBefore = req.query.before;
  const before = typeof rawBefore === "string" && rawBefore ? rawBefore.toLowerCase() : null;
  const page = await listChatSessions(req.userId!, { limit, before });
  if (!page) {
    res.status(404).json({ error: "Unknown cursor" });
    return;
  }
  res.json(page);
});

/**
 * PATCH /v1/chat/sessions/:id — rename a chat by hand. From then on the
 * automatic titler never touches it. Someone else's chat is the same 404 as
 * one that never existed.
 */
chatRouter.patch("/sessions/:id", async (req: Request, res: Response): Promise<void> => {
  const title = normalizeChatSessionTitle(req.body?.title);
  if (title === null) {
    res.status(400).json({ error: "Title must be 1–80 characters" });
    return;
  }
  const session = await renameChatSession(req.userId!, String(req.params.id).toLowerCase(), title);
  if (!session) {
    res.status(404).json({ error: "Unknown chat" });
    return;
  }
  res.json(session);
});

/**
 * Снимки строки: список, а у строк до 2026-09-21 — одиночный путь. Одна
 * точка чтения, потому что читают их и лента, и агент.
 */
function rowImages(row: { imageUrl: string | null; imageUrls: string[] }): string[] {
  return row.imageUrls.length > 0 ? row.imageUrls : row.imageUrl ? [row.imageUrl] : [];
}

/**
 * GET /v1/chat/topics — the read-only index of past conversations.
 *
 * Superseded by `/sessions` (2026-09-30) and kept, unchanged, for app builds
 * that still read it. Not threads: see the header of `services/chat-topics.ts`. The agent's
 * context is untouched by this route, and nothing here can be sent, renamed
 * or deleted — a topic is a slice of the one continuous transcript, cut at a
 * silence, that the client uses to scroll back to a point in time.
 */
chatRouter.get("/topics", async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 100);
  const { topics, hasMore } = await listChatTopics(req.userId!, limit);
  res.json({ topics, hasMore });
});

/**
 * Parse and ownership-check the chat context of a request. Writes the error
 * response itself and answers `false` when the request must stop; otherwise the
 * snapshot to store, or `null` for an ordinary message.
 *
 * Someone else's inbox id is a 404, the same answer as an id that never
 * existed — the difference is exactly what a prober would want to learn.
 */
async function contextFromRequest(
  raw: unknown,
  userId: string,
  res: Response,
): Promise<ChatContextSnapshot | null | false> {
  const ref = parseChatContextRef(raw);
  if (ref === "invalid") {
    res.status(400).json({ error: "Invalid context" });
    return false;
  }
  if (!ref) return null;
  const snapshot = await resolveChatContextSnapshot(userId, ref);
  if (!snapshot) {
    res.status(404).json({ error: "Unknown context" });
    return false;
  }
  return snapshot;
}

/**
 * Parse and claim the optional chat id of a turn. Writes the error response
 * itself and answers `false` when the request must stop; `null` for a turn
 * that names no chat (an older build); otherwise the id, now the caller's.
 *
 * Not a UUID → 400. Someone else's chat → 404 with the body an unknown inbox
 * context gets — the two are the same answer on purpose. An id nobody has
 * used yet becomes the caller's new chat.
 */
async function sessionFromRequest(
  raw: unknown,
  userId: string,
  res: Response,
): Promise<string | null | false> {
  const parsed = parseChatSessionIdField(raw);
  if (parsed === "invalid") {
    res.status(400).json({ error: "Invalid sessionId" });
    return false;
  }
  if (parsed === null) return null;
  if (!(await claimChatSession(userId, parsed))) {
    res.status(404).json({ error: "Unknown context" });
    return false;
  }
  return parsed;
}

function contextField(snapshot: ChatContextSnapshot | null): { context?: ChatContextSnapshot } {
  return snapshot ? { context: snapshot } : {};
}

/**
 * Does this storage key belong to the caller?
 *
 * The whole key is matched, not just its first segment. A `startsWith` test was
 * not an ownership check: the key is interpolated into the Supabase URL, and
 * `fetch` collapses dot segments before the request leaves, so
 * `<caller>/../<victim>/1750000000000.jpg` passed the prefix and then addressed
 * the victim's object — readable back through `GET /v1/chat/history`'s signed
 * URL, and copyable into the caller's own profile through the concierge's
 * `attach_profile_photo` tool (which only checks that the MESSAGE row is
 * theirs, and it is).
 *
 * The shape below is exactly what `uploadChatImage` mints, so nothing the
 * product can legitimately produce is refused. `storage.ts` refuses a
 * traversing key a second time at the URL, which is the layer that covers any
 * future caller; this is the layer that gives the honest 403.
 */
function isOwnChatImagePath(path: string, userId: string): boolean {
  const match = /^([0-9a-f-]{36})\/(\d{1,20})\.(jpg|png|webp)$/i.exec(path);
  return match?.[1]?.toLowerCase() === userId.toLowerCase();
}
