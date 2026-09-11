import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { ticketBundleFor, buildStoreInvoicePayload, t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import { ticketPurchaseRail } from "../../services/ticket-payment.js";
import { grantTickets } from "../../services/ticket-wallet.js";
import { notifyFounderPurchase } from "../../services/founder-notify.js";
import {
  getActiveDiscount,
  discountedCents,
  consumeActiveDiscount,
} from "../../services/ticket-discount.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";
import { isPremiumActive } from "../../services/premium.js";

/**
 * Ticket store / wallet Mini App endpoints (pre-purchase bundles, not tied to a
 * match). TMA-authed (`Authorization: tma <initData>`) like the date-gate
 * ticket routes. Mounted at `/v1/tickets`.
 *
 *   GET  /v1/tickets/wallet                  — balance + per-ticket price + rail
 *   POST /v1/tickets/store/stars-invoice     — Telegram Stars invoice link: the
 *                                             only rail that moves money
 *   POST /v1/tickets/store/settle-no-charge  — demo / development only: credit
 *                                             a bundle without a charge
 */
export function createTicketStoreRouter(): Router {
  const router = Router();

  router.get("/wallet", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const user = await resolveUser(auth.user.id);
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    // Famine single-ticket discount applies ONLY to the "1 ticket" bundle; the
    // store UI shows the badge + reduced single price from these fields.
    const discount = await getActiveDiscount(user.id);
    res.status(200).json({
      ok: true,
      balance: user.ticketBalance,
      priceCents: env.TICKET_PRICE_CENTS,
      discountPct: discount?.pct ?? 0,
      discountExpiresAt: discount?.expiresAt.toISOString() ?? null,
      // When Stars is the store currency, the Mini App renders Star prices and
      // pays natively via WebApp.openInvoice (see /store/stars-invoice). The
      // famine discount is USD-only and never applies to a Stars purchase.
      starsEnabled: env.TICKET_STARS_ENABLED,
      bundleStars: env.TICKET_STARS_ENABLED ? env.TICKET_BUNDLE_STARS : null,
      rail: ticketPurchaseRail(),
      // Drives the "invite a friend instead" referral cross-promo link, shown
      // client-side only when the wallet is actually empty.
      referralEnabled: env.REFERRAL_FEATURE_ENABLED,
      // Gennety Premium covers the subscriber's OWN date slots (§3.5b), so the
      // store stops being the way they get onto a date and becomes the way they
      // cover their partner's ticket. The plate says that; the bundles stay on
      // sale, because with covering still priced this is the only place to buy
      // the ticket it takes — and the welcome gift, referral rewards and famine
      // discount all keep landing in the same wallet.
      premiumActive: await isPremiumActive(user.id),
    });
  });

  // Native Telegram Stars (XTR) purchase from inside the store Mini App. Returns
  // a Telegram invoice link; the Mini App opens it with WebApp.openInvoice(). The
  // wallet is credited by the bot's successful_payment handler
  // (handlers/payments.ts), keyed on the `store:<count>` payload — the same path
  // as any Stars invoice, and the only rail that moves money.
  router.post("/store/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (!env.TICKET_STARS_ENABLED) {
      res.status(404).json({ error: "stars-not-enabled" });
      return;
    }
    const bundle = parseBundle(req.body);
    const stars = bundle ? env.TICKET_BUNDLE_STARS[bundle.count] : undefined;
    if (!bundle || !stars) {
      res.status(400).json({ error: "unknown-bundle" });
      return;
    }
    const user = await resolveUser(auth.user.id);
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
      const link = await api.createInvoiceLink(
        t(lang, "ticketStoreInvoiceTitle"),
        t(lang, "ticketStoreInvoiceDesc", { count: bundle.count }),
        buildStoreInvoicePayload(bundle.count),
        "", // provider_token — empty for Telegram Stars (XTR)
        "XTR",
        [{ label: t(lang, "ticketStoreInvoiceLabel", { count: bundle.count }), amount: stars }],
      );
      res.status(200).json({ ok: true, link, stars });
    } catch (err) {
      console.error("[tickets] createInvoiceLink (stars) failed:", err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  // Credit a bundle WITHOUT a charge — the demo and local development only
  // (`ticketPurchaseRail()` → `no-charge`). It replaced the mock intent/confirm
  // pair (decision 2026-09-11); see the gate's `/settle-no-charge` for why the
  // runtime, not a config default, is what keeps it out of production.
  router.post("/store/settle-no-charge", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (ticketPurchaseRail() !== "no-charge") {
      res.status(404).json({ error: "no-charge-unavailable" });
      return;
    }
    const bundle = parseBundle(req.body);
    if (!bundle) {
      res.status(400).json({ error: "unknown-bundle" });
      return;
    }
    const user = await resolveUser(auth.user.id);
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    // The price the shelf showed, famine discount included — recorded exactly
    // as a real purchase of this bundle would be, so the demo's receipts read
    // like the product's.
    const amountCents = await effectiveBundlePrice(user.id, bundle);
    const discountedSingle = amountCents !== bundle.priceCents;

    const balance = await grantTickets({
      userId: user.id,
      count: bundle.count,
      reason: "store_purchase",
      amountCents,
      bundleSize: bundle.count,
    });
    // Founder ops feed, labelled as moving no money so it never reads as a sale.
    void notifyFounderPurchase({
      userId: user.id,
      kind: "tickets",
      provider: "no_charge",
      amountCents,
      currency: "USD",
      detail: `${bundle.count} ticket${bundle.count === 1 ? "" : "s"} · баланс ${balance}`,
    });
    // The one-time discount is spent by the purchase that actually used it.
    if (discountedSingle) await consumeActiveDiscount(user.id);
    emitTicketEvent("ticket_paid", { matchId: "store", scope: "self", amountCents });
    // Return the FRESH discount so the Mini App drops the badge after a
    // single-ticket redemption (and keeps it after a 3/6-bundle buy).
    const discount = await getActiveDiscount(user.id);
    res.status(200).json({
      ok: true,
      balance,
      priceCents: env.TICKET_PRICE_CENTS,
      discountPct: discount?.pct ?? 0,
      discountExpiresAt: discount?.expiresAt.toISOString() ?? null,
      rail: ticketPurchaseRail(),
    });
  });

  return router;
}

function parseBundle(body: unknown): { count: number; priceCents: number } | null {
  const raw = (body as { count?: unknown })?.count;
  const count = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(count)) return null;
  return ticketBundleFor(count);
}

/**
 * Charged price for a bundle, applying the famine single-ticket discount to the
 * "1 ticket" bundle only when the user has an active one. 3/6 bundles always
 * pay their catalog price. The same number the shelf shows, so what a bundle
 * is recorded at never disagrees with its label.
 */
async function effectiveBundlePrice(
  userId: string,
  bundle: { count: number; priceCents: number },
): Promise<number> {
  if (bundle.count !== 1) return bundle.priceCents;
  const discount = await getActiveDiscount(userId);
  return discount ? discountedCents(bundle.priceCents, discount.pct) : bundle.priceCents;
}

async function resolveUser(
  telegramId: number,
): Promise<{ id: string; ticketBalance: number; language: string | null } | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, ticketBalance: true, language: true },
  });
  if (!user) return null;
  return { id: user.id, ticketBalance: user.ticketBalance, language: user.language };
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
