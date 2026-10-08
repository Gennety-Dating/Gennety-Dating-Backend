import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { usageGuard } from "../usage-middleware.js";
import { toCatalogItem } from "../../services/style-picks/catalog.js";
import { shopUrl, styleOutSignatureValid } from "../../services/style-picks/out-link.js";
import { getStylePicks } from "../../services/style-picks/service.js";

/**
 * Vibe Check (decision journal 2026-10-08).
 *
 * `GET /v1/me/style-picks` — the person's personal selection, JWT. 204 when the
 * flag is off, the profile is too thin, or a generation failed with nothing
 * cached: the Shop then simply shows no Vibe Check result, never an error.
 * Runs under `usageGuard`, so the one model call is metered against the person
 * like every other AI route.
 *
 * `GET /v1/style/out/{itemId}` — the outbound redirect a card opens in the
 * system browser. No JWT (a browser sends none): a signed link logs the click,
 * anything else just redirects. Works with the flag off too — an old card's
 * link must not dead-end.
 */
export function createStylePicksRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.get("/", usageGuard, async (req: Request, res: Response): Promise<void> => {
    if (!env.STYLE_PICKS_ENABLED) {
      res.status(204).end();
      return;
    }
    try {
      const result = await getStylePicks(req.userId!);
      if (!result) {
        res.status(204).end();
        return;
      }
      res.set("Cache-Control", "private, no-store").json(result);
    } catch (err) {
      console.error("[style-picks] failed:", err);
      res.status(204).end();
    }
  });
  return router;
}

const ITEM_ID = /^[a-z0-9-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function queryString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createStyleOutRouter(): Router {
  const router = Router();
  router.get("/out/:itemId", async (req: Request, res: Response): Promise<void> => {
    const itemId = String(req.params.itemId ?? "");
    if (!ITEM_ID.test(itemId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const row = await prisma.styleProduct.findUnique({ where: { id: itemId } });
    // Inactive products still redirect: a card shown yesterday keeps working.
    const item = row ? toCatalogItem(row) : null;
    if (!item) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const userId = queryString(req.query.u);
    const expiresAt = Number(queryString(req.query.e));
    const signed =
      UUID.test(userId) && styleOutSignatureValid(userId, itemId, expiresAt, queryString(req.query.s));
    if (signed) {
      // Best-effort: the shopper is redirected whatever the log does.
      await prisma.styleClick
        .create({ data: { userId, itemId, category: item.category } })
        .catch((err: unknown) => console.warn("[style-picks] click not logged:", err));
    }

    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    res.redirect(302, shopUrl(item, queryString(req.query.l) || null));
  });
  return router;
}
