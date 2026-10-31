import { Router, type Request, type Response } from "express";
import { SCREENSHOT_LIST_PAGE, SCREENSHOT_OCR_MAX_CHARS } from "@gennety/shared";
import { requireAuth } from "../auth-middleware.js";
import { screenshotReadLimiter, screenshotSearchLimiter, screenshotUploadLimiter } from "../rate-limit.js";
import { env } from "../../config.js";
import { isUuid } from "../../utils/uuid.js";
import {
  commitUpload,
  connectLibrary,
  deleteItem,
  disconnectLibrary,
  libraryView,
  listItems,
  readItem,
  reconcile,
  reserveUpload,
  ScreenshotLibraryError,
  searchItems,
  setLibraryPaused,
} from "../../services/screenshot-library.js";

/**
 * The private screenshot library for the native client
 * (docs/product/domains/screenshot-library.md). The owner is always the token's
 * person: no route takes a user id. Errors are distinct codes, so the phone can
 * tell "no consent" from "try later" from "this one is gone".
 */
export function createScreenshotsRouter(): Router {
  const router = Router();

  router.use((_req: Request, res: Response, next): void => {
    if (!env.SCREENSHOT_LIBRARY_ENABLED) {
      res.status(404).json({ error: "feature-disabled" });
      return;
    }
    next();
  });
  router.use(requireAuth);

  const guarded =
    (handler: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        await handler(req, res);
      } catch (err) {
        if (err instanceof ScreenshotLibraryError) {
          res.status(err.status).json({ error: err.code });
          return;
        }
        throw err;
      }
    };

  router.get("/library", screenshotReadLimiter, guarded(async (req, res) => {
    res.json(await libraryView(req.userId as string));
  }));

  router.put("/library", guarded(async (req, res) => {
    const { consentVersion, autoImport, rangeDays } = (req.body ?? {}) as Record<string, unknown>;
    const validRange = rangeDays === null || (typeof rangeDays === "number" && Number.isInteger(rangeDays) && rangeDays > 0 && rangeDays <= 36_500);
    if (typeof consentVersion !== "string" || typeof autoImport !== "boolean" || !validRange) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await connectLibrary(req.userId as string, { consentVersion, autoImport, rangeDays: rangeDays as number | null }));
  }));

  router.patch("/library", guarded(async (req, res) => {
    const paused = (req.body as Record<string, unknown> | undefined)?.paused;
    if (typeof paused !== "boolean") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await setLibraryPaused(req.userId as string, paused));
  }));

  router.delete("/library", guarded(async (req, res) => {
    res.status(202).json(await disconnectLibrary(req.userId as string));
  }));

  router.post("/library/reconcile", guarded(async (req, res) => {
    const { generation, removedSourceKeys } = (req.body ?? {}) as Record<string, unknown>;
    if (
      !Number.isInteger(generation) ||
      !Array.isArray(removedSourceKeys) ||
      removedSourceKeys.length > 500 ||
      !removedSourceKeys.every((k) => typeof k === "string" && k.length > 0 && k.length <= 200)
    ) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await reconcile(req.userId as string, generation as number, removedSourceKeys as string[]));
  }));

  router.post("/uploads", screenshotUploadLimiter, guarded(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const capturedAt = typeof body.capturedAt === "string" ? new Date(body.capturedAt) : null;
    const valid =
      Number.isInteger(body.generation) &&
      (body.source === "auto" || body.source === "manual") &&
      typeof body.sourceKey === "string" && body.sourceKey.length > 0 && body.sourceKey.length <= 200 &&
      typeof body.contentHash === "string" && /^[a-f0-9]{64}$/.test(body.contentHash) &&
      (capturedAt === null || !Number.isNaN(capturedAt.getTime())) &&
      (body.ocrText === undefined || body.ocrText === null || typeof body.ocrText === "string");
    if (!valid) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await reserveUpload(req.userId as string, {
      generation: body.generation as number,
      source: body.source as "auto" | "manual",
      sourceKey: body.sourceKey as string,
      contentHash: body.contentHash as string,
      capturedAt,
      ocrText: typeof body.ocrText === "string" ? body.ocrText.slice(0, SCREENSHOT_OCR_MAX_CHARS) : null,
    }));
  }));

  router.post("/:id/commit", screenshotUploadLimiter, guarded(async (req, res) => {
    const id = String(req.params.id);
    const generation = (req.body as Record<string, unknown> | undefined)?.generation;
    if (!isUuid(id) || !Number.isInteger(generation)) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await commitUpload(req.userId as string, id, generation as number));
  }));

  router.get("/", screenshotReadLimiter, guarded(async (req, res) => {
    const userId = req.userId as string;
    const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 300) : "";
    if (q) {
      screenshotSearchLimiter(req, res, () => {
        searchItems(userId, q)
          .then((items) => res.json({ items, nextBefore: null }))
          .catch(() => res.status(503).json({ error: "search-unavailable" }));
      });
      return;
    }
    const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const limit = Number(req.query.limit);
    if (before && Number.isNaN(before.getTime())) {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    res.json(await listItems(userId, {
      ...(before ? { before } : {}),
      ...(category ? { category } : {}),
      limit: Number.isInteger(limit) && limit > 0 ? limit : SCREENSHOT_LIST_PAGE,
    }));
  }));

  router.get("/:id", screenshotReadLimiter, guarded(async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json(await readItem(req.userId as string, id));
  }));

  router.delete("/:id", guarded(async (req, res) => {
    const id = String(req.params.id);
    if (isUuid(id)) await deleteItem(req.userId as string, id);
    res.status(204).end();
  }));

  return router;
}
