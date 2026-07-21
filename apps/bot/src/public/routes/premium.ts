import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  buildSubInvoicePayload,
  PREMIUM_SUBSCRIPTION_PERIOD_SECONDS,
} from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { getPremiumState } from "../../services/premium.js";

/**
 * Gennety Premium Mini App endpoints (PRODUCT_SPEC §Premium). TMA-authed
 * (`Authorization: tma <initData>`) like the ticket / venue-change Mini Apps.
 * Mounted at `/v1/premium`.
 *
 *   GET  /v1/premium/state          — subscription state + price
 *   POST /v1/premium/stars-invoice  — mint the recurring Stars subscription link
 *
 * The wallet-style trust boundary is the bot's `successful_payment` handler
 * (handlers/payments.ts), keyed on the `sub:premium` payload — including every
 * 30-day auto-renewal. This router only reads state and mints the invoice link.
 */
export function createPremiumRouter(): Router {
  const router = Router();

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    const state = await getPremiumState(user.id);
    res.status(200).json({
      ok: true,
      featureEnabled: env.PREMIUM_FEATURE_ENABLED,
      active: state.active,
      premiumUntil: state.premiumUntil?.toISOString() ?? null,
      autoRenew: state.autoRenew,
      provider: state.provider,
      priceStars: env.PREMIUM_STARS,
      priceDisplay: env.PREMIUM_PRICE_USD_DISPLAY,
    });
  });

  router.post("/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (!env.PREMIUM_FEATURE_ENABLED) {
      res.status(404).json({ error: "premium-not-enabled" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { id: true, language: true },
    });
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    const { getBotApi } = await import("../server.js");
    const api = getBotApi();
    if (!api) {
      res.status(503).json({ error: "bot-unavailable" });
      return;
    }
    const lang = (user.language ?? "en") as Language;
    try {
      // Recurring Telegram Stars subscription: `subscription_period` makes this a
      // renewing invoice (Telegram supports only the 30-day period). Empty
      // provider token + XTR = Stars, no merchant account needed.
      const link = await api.createInvoiceLink(
        t(lang, "premiumInvoiceTitle"),
        t(lang, "premiumInvoiceDesc"),
        buildSubInvoicePayload("premium"),
        "",
        "XTR",
        [{ label: t(lang, "premiumInvoiceLabel"), amount: env.PREMIUM_STARS }],
        { subscription_period: PREMIUM_SUBSCRIPTION_PERIOD_SECONDS },
      );
      res.status(200).json({ ok: true, link, stars: env.PREMIUM_STARS });
    } catch (err) {
      console.error("[premium] createInvoiceLink (subscription) failed:", err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  return router;
}

type AuthOk = { ok: true; user: { id: number } };
type AuthErr = { ok: false; body: { error: string; reason?: string } };

function authenticate(req: Request): AuthOk | AuthErr {
  const authHeader = req.header("authorization") ?? req.header("Authorization");
  if (!authHeader?.startsWith("tma ")) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const initData = authHeader.slice(4).trim();
  if (!initData) return { ok: false, body: { error: "Empty initData" } };
  const validation = validateInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}
