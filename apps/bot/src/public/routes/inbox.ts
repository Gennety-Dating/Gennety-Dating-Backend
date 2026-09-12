import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth-middleware.js";
import { getInboxItemDetail, listInbox, markInboxRead } from "../../services/inbox.js";
import { buildPulse } from "../../services/pulse.js";

/**
 * The bell's inbox and the Today pulse, native client (JWT) — decision journal
 * 2026-09-13.
 *
 *   GET  /v1/inbox?limit&before  newest first, with the unread count
 *   GET  /v1/inbox/:id           one row + the announcement it carries
 *   POST /v1/inbox/read          { ids } → { unreadCount }
 *   GET  /v1/pulse               the Live Pulse rows
 *
 * Reads only, apart from the read marker. No feature flag: an empty inbox is a
 * true answer for every account, and the rows only exist once something writes
 * them.
 */

export function createInboxRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const rawLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : null;
    const result = await listInbox(req.userId as string, {
      ...(rawLimit !== undefined ? { limit: rawLimit } : {}),
      before,
    });
    if (!result.ok) {
      res.status(404).json({ error: "Unknown cursor" });
      return;
    }
    res.json({ items: result.items, unreadCount: result.unreadCount, hasMore: result.hasMore });
  });

  // Registered before `/:id`, which would otherwise read "read" as an id.
  router.post("/read", async (req: Request, res: Response): Promise<void> => {
    const result = await markInboxRead(req.userId as string, (req.body as { ids?: unknown } | undefined)?.ids);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ unreadCount: result.unreadCount });
  });

  router.get("/:id", async (req: Request, res: Response): Promise<void> => {
    const detail = await getInboxItemDetail(req.userId as string, String(req.params.id));
    if (!detail) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(detail);
  });

  return router;
}

export function createPulseRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const now = new Date();
    const rows = await buildPulse(req.userId as string, { now });
    res.json({ rows, serverNow: now.toISOString() });
  });
  return router;
}
