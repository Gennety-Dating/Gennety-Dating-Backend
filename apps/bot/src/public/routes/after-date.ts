import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { afterDateT, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { requireAuth } from "../auth-middleware.js";
import { appStoreConfigured, decodeJwsPayload } from "../../services/appstore.js";
import { purchaseWishlistSheet } from "../../services/appstore-wishlist.js";
import {
  announceMutual,
  pendingMorningAfterFor,
  recentMutualMatchIds,
  recordMorningAfter,
} from "../../services/morning-after.js";
import { mutualOfferFor, type MutualOffer } from "../../services/wishlist.js";
import { sendMutualOfferDm } from "../../handlers/date/morning-after.js";
import { getMainBotApi } from "../../services/main-bot-api.js";
import { createProfilePhotoSignedUrl } from "../../services/storage.js";

/**
 * «The Morning After» and the mutual offer for the NATIVE client (decision
 * journal 2026-10-08).
 *
 *   GET  /v1/me/after-date                         — the check owed now + live offers
 *   POST /v1/me/after-date/answer                  — 🔥 / 🤷
 *   GET  /v1/me/after-date/:matchId                — one offer (flowers + cheat sheet)
 *   POST /v1/me/after-date/:matchId/wishlist/appstore — the StoreKit purchase
 *
 * The GET answers empty while `MORNING_AFTER_ENABLED` is off, like the
 * feedback pending endpoint: "nothing to show" is this endpoint's ordinary
 * state, not an error.
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWS_MAX_LENGTH = 20_000;

async function languageOf(userId: string): Promise<Language> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { language: true } });
  return (user?.language ?? "en") as Language;
}

export function serializeOffer(offer: MutualOffer): Record<string, unknown> {
  return {
    matchId: offer.matchId,
    mutualAt: offer.mutualAt.toISOString(),
    partner: offer.partner,
    title: offer.title,
    body: offer.body,
    timing: offer.timing,
    gift: offer.gift,
    flowersHint: offer.flowersHint,
    wishlistLine: offer.wishlistLine,
    wishlist: offer.wishlist,
  };
}

export function createAfterDateRouter(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId!;
    if (!env.MORNING_AFTER_ENABLED) {
      res.json({ check: null, offers: [] });
      return;
    }
    const language = await languageOf(userId);
    const pending = await pendingMorningAfterFor(userId);
    // The card on «Сегодня» shows who and where (founder's pick 2026-10-08):
    // the photo is signed for an hour, like the offer's; a photo that cannot
    // be signed leaves the card with the initial.
    const partnerPhotoUrl = pending?.partnerPhotoPath
      ? await createProfilePhotoSignedUrl(pending.partnerPhotoPath, 60 * 60).catch(() => null)
      : null;
    const offers: Record<string, unknown>[] = [];
    for (const matchId of await recentMutualMatchIds(userId)) {
      const result = await mutualOfferFor(matchId, userId, language);
      if (result.ok) offers.push(serializeOffer(result.offer));
    }
    res.json({
      check: pending
        ? {
            matchId: pending.matchId,
            partnerFirstName: pending.partnerFirstName,
            partnerPhotoUrl,
            venueName: pending.venueName,
            agreedTime: pending.agreedTime.toISOString(),
            question: afterDateT(language, "morningAfterQuestion", {
              name: pending.partnerFirstName ?? "",
            }),
            blindNote: afterDateT(language, "morningAfterBlind", {
              name: pending.partnerFirstName ?? "",
            }),
            great: afterDateT(language, "morningAfterGreat"),
            pass: afterDateT(language, "morningAfterPass"),
          }
        : null,
      offers,
    });
  });

  router.post("/answer", async (req: Request, res: Response): Promise<void> => {
    const userId = req.userId!;
    const matchId = typeof req.body?.matchId === "string" ? req.body.matchId : "";
    if (!env.MORNING_AFTER_ENABLED || !UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const result = await recordMorningAfter({ matchId, userId, answer: req.body?.answer });
    if (!result.ok) {
      const status =
        result.error === "bad-answer" ? 400 : result.error === "already-answered" ? 409 : 404;
      res.status(status).json({ error: result.error });
      return;
    }
    if (result.mutualJustNow) {
      // Both sides are told on their own rails; this caller also gets the
      // offer in the response below, so the screen turns at once.
      void announceMutual(getMainBotApi(), matchId, sendMutualOfferDm).catch(() => undefined);
    }
    const language = await languageOf(userId);
    const thanks = afterDateT(
      language,
      result.answer === "great" ? "morningAfterThanksGreat" : "morningAfterThanksPass",
    );
    let offer: Record<string, unknown> | null = null;
    if (result.mutual) {
      const view = await mutualOfferFor(matchId, userId, language);
      if (view.ok) offer = serializeOffer(view.offer);
    }
    res.json({ answer: result.answer, mutual: result.mutual, thanks, offer });
  });

  router.get("/:matchId", async (req: Request, res: Response): Promise<void> => {
    const matchId = String(req.params.matchId ?? "");
    if (!env.MORNING_AFTER_ENABLED || !UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    const result = await mutualOfferFor(matchId, req.userId!, await languageOf(req.userId!));
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json({ offer: serializeOffer(result.offer) });
  });

  router.post("/:matchId/wishlist/appstore", async (req: Request, res: Response): Promise<void> => {
    const matchId = String(req.params.matchId ?? "");
    if (!env.WISHLIST_APPSTORE_ENABLED || !UUID_REGEX.test(matchId)) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!appStoreConfigured()) {
      res.status(503).json({ error: "App Store verification not configured" });
      return;
    }
    const jws = typeof req.body?.jws === "string" ? req.body.jws.trim() : "";
    if (!jws || jws.length > JWS_MAX_LENGTH) {
      res.status(400).json({ error: "Missing jws" });
      return;
    }
    const payload = decodeJwsPayload(jws);
    const transactionId =
      payload && typeof payload.transactionId === "string" ? payload.transactionId : "";
    if (!transactionId) {
      res.status(400).json({ error: "Invalid transaction payload" });
      return;
    }
    const result = await purchaseWishlistSheet(req.userId!, matchId, transactionId);
    switch (result.status) {
      case "unlocked": {
        const view = await mutualOfferFor(matchId, req.userId!, await languageOf(req.userId!));
        res.json({ ok: true, offer: view.ok ? serializeOffer(view.offer) : null });
        return;
      }
      case "invalid":
        res.status(422).json({ error: "Transaction rejected", code: result.reason });
        return;
      case "unclaimed":
        // Apple took the money and we cannot deliver: the client finishes the
        // transaction (so it is not re-reported forever) and says so; the
        // founder was told with the transaction id.
        res.status(409).json({ error: "unclaimed", code: result.reason });
        return;
      case "unavailable":
        res.status(503).json({ error: "App Store unavailable" });
        return;
    }
  });

  return router;
}
