import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  WISHLIST_PASTE_MAX_LEN,
  isWishlistCategory,
  wishlistCatalogFor,
  type Language,
  type WishlistCatalogItem,
} from "@gennety/shared";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import {
  addWishlistItems,
  deleteWishlistItem,
  getOwnWishlist,
  resolveWishlistSession,
  setWishlistShown,
  type WishlistItemInput,
} from "../../services/wishlist.js";
import {
  catalogImageFor,
  lookupWishlistEntry,
  parseWishlistPaste,
} from "../../services/wishlist-lookup.js";
import { wishlistSuggestions } from "../../services/wishlist-suggest.js";

/**
 * Date Wishlist for the NATIVE client — the owner's side (decision journal
 * 2026-10-08). The «Сегодня» session draws the agent on top, the cards in the
 * middle and the search field at the bottom; every call it makes is here.
 *
 *   GET    /v1/me/wishlist             — shown/hidden, items, catalog, suggestions
 *   PUT    /v1/me/wishlist/visibility  — «Не показывать мой список» and back
 *   POST   /v1/me/wishlist/parse       — a pasted list → entries to look up
 *   POST   /v1/me/wishlist/lookup      — one entry → candidate cards
 *   POST   /v1/me/wishlist/items       — confirmed cards → items
 *   DELETE /v1/me/wishlist/items/:id
 *   POST   /v1/me/wishlist/session     — «Готово» / «Позже» on the session
 *
 * The whole router answers 404 `feature-disabled` while
 * `WISHLIST_FEATURE_ENABLED` is off, so a build that knows the feature shows
 * nothing rather than a screen whose every call fails.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ITEMS_PER_POST = 12;

async function viewerLanguageAndAudience(
  userId: string,
): Promise<{ language: Language; audience: "female" | "male"; cityKey: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { language: true, gender: true, profile: { select: { homeCityKey: true } } },
  });
  return {
    language: (user?.language ?? "en") as Language,
    audience: user?.gender === "male" ? "male" : "female",
    cityKey: user?.profile?.homeCityKey ?? null,
  };
}

async function catalogItemView(item: WishlistCatalogItem, language: Language, suggested: boolean) {
  const resolved = item.image
    ? { imageUrl: null, productUrl: null }
    : await catalogImageFor(item, language).catch(() => ({ imageUrl: null, productUrl: null }));
  return {
    key: item.key,
    category: item.category,
    title: item.title[language] ?? item.title.en,
    brand: item.brand,
    priceBand: item.priceBand,
    image: item.image,
    imageUrl: resolved.imageUrl,
    productUrl: resolved.productUrl,
    suggested,
  };
}

export function createWishlistRouter(): Router {
  const router = Router();
  router.use((_req: Request, res: Response, next): void => {
    if (!env.WISHLIST_FEATURE_ENABLED) {
      res.status(404).json({ error: "feature-disabled" });
      return;
    }
    next();
  });
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId!;
    const own = await getOwnWishlist(userId);
    if (!own) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const { language, audience } = await viewerLanguageAndAudience(userId);
    const catalog = wishlistCatalogFor(audience);
    const suggestions = await wishlistSuggestions(userId, audience, language).catch(() => ({
      places: [],
      catalogKeys: [],
    }));
    const suggested = new Set(suggestions.catalogKeys);
    const ordered = [
      ...catalog.filter((item) => suggested.has(item.key)),
      ...catalog.filter((item) => !suggested.has(item.key)),
    ];
    res.json({
      shown: own.shown,
      items: own.items,
      maxItems: own.maxItems,
      sessionOpen: own.sessionOpen,
      done: own.done,
      catalog: await Promise.all(
        ordered.map((item) => catalogItemView(item, language, suggested.has(item.key))),
      ),
      suggestedPlaces: suggestions.places,
    });
  });

  router.put("/visibility", async (req: Request, res: Response): Promise<void> => {
    const shown = req.body?.shown;
    if (typeof shown !== "boolean") {
      res.status(400).json({ error: "bad-request" });
      return;
    }
    await setWishlistShown(req.userId!, shown);
    res.json({ shown });
  });

  router.post("/parse", (req: Request, res: Response): void => {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text.trim()) {
      res.status(400).json({ error: "empty" });
      return;
    }
    res.json(parseWishlistPaste(text.slice(0, WISHLIST_PASTE_MAX_LEN)));
  });

  router.post("/lookup", async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const kind = body.kind === "url" ? "url" : body.kind === "query" ? "query" : null;
    const value = typeof body.value === "string" ? body.value.trim().slice(0, 500) : "";
    if (!kind || !value) {
      res.status(400).json({ error: "bad-entry" });
      return;
    }
    const { language, cityKey } = await viewerLanguageAndAudience(req.userId!);
    const result = await lookupWishlistEntry({
      userId: req.userId!,
      kind,
      value,
      category: isWishlistCategory(body.category) ? body.category : undefined,
      language,
      cityKey,
    });
    if (!result.ok) {
      const status =
        result.error === "rate_limited" ? 429 : result.error === "unavailable" ? 503 : 200;
      // `not_found` / `timeout` / `blocked` are ordinary answers of the agent
      // ("nothing real found — keep it in your words?"), not errors.
      if (status === 200) {
        res.json({ candidates: [], reason: result.error });
        return;
      }
      res.status(status).json({ error: result.error });
      return;
    }
    res.json({ candidates: result.candidates });
  });

  router.post("/items", async (req: Request, res: Response): Promise<void> => {
    const raw = Array.isArray(req.body?.items) ? (req.body.items as unknown[]) : [];
    if (raw.length === 0 || raw.length > MAX_ITEMS_PER_POST) {
      res.status(400).json({ error: "bad-item" });
      return;
    }
    const result = await addWishlistItems(
      req.userId!,
      raw.map((entry) => (entry ?? {}) as WishlistItemInput),
    );
    if (!result.ok) {
      res.status(result.error === "too-many" ? 409 : 400).json({
        error: result.error,
      });
      return;
    }
    res.json({ items: result.items });
  });

  router.delete("/items/:id", async (req: Request, res: Response): Promise<void> => {
    const id = String(req.params.id ?? "");
    if (!UUID_REGEX.test(id)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const removed = await deleteWishlistItem(req.userId!, id);
    res.status(removed ? 200 : 404).json(removed ? { ok: true } : { error: "not-found" });
  });

  router.post("/session", async (req: Request, res: Response): Promise<void> => {
    const action = req.body?.action === "done" ? "done" : req.body?.action === "later" ? "later" : null;
    if (!action) {
      res.status(400).json({ error: "bad-action" });
      return;
    }
    const result = await resolveWishlistSession(req.userId!, action);
    if (!result.ok) {
      res.status(409).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
