import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { ticketBundleFor } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  createStoreIntent,
  verifyStorePayment,
} from "../../services/ticket-payment.js";
import { grantTickets } from "../../services/ticket-wallet.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";

/**
 * Ticket store / wallet Mini App endpoints (pre-purchase bundles, not tied to a
 * match). TMA-authed (`Authorization: tma <initData>`) like the date-gate
 * ticket routes. Mounted at `/v1/tickets`.
 *
 *   GET  /v1/tickets/wallet         — current balance + per-ticket price
 *   POST /v1/tickets/store/intent   — create a (mock) bundle payment intent
 *   POST /v1/tickets/store/confirm  — confirm "payment" → credit the balance
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
    res.status(200).json({ ok: true, balance: user.ticketBalance, priceCents: env.TICKET_PRICE_CENTS });
  });

  router.post("/store/intent", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
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

    const intent = await createStoreIntent({
      userId: user.id,
      count: bundle.count,
      amountCents: bundle.priceCents,
    });
    emitTicketEvent("ticket_intent_created", { matchId: "store", scope: "self", amountCents: bundle.priceCents });
    res.status(200).json({
      ok: true,
      clientSecret: intent.clientSecret,
      amountCents: intent.amountCents,
      count: intent.count,
      mode: intent.mode,
    });
  });

  router.post("/store/confirm", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const bundle = parseBundle(req.body);
    if (!bundle) {
      res.status(400).json({ error: "unknown-bundle" });
      return;
    }
    const clientSecret =
      typeof (req.body as { clientSecret?: unknown })?.clientSecret === "string"
        ? (req.body as { clientSecret: string }).clientSecret
        : "";

    // TODO: Stripe Production Mode — in stripe mode this must defer to the
    // HMAC-verified webhook, not the client. See services/ticket-payment.ts.
    const verified = await verifyStorePayment({ clientSecret });
    if (!verified.ok) {
      res.status(400).json({ error: "payment-not-verified" });
      return;
    }
    const user = await resolveUser(auth.user.id);
    if (!user) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const balance = await grantTickets({
      userId: user.id,
      count: bundle.count,
      reason: "store_purchase",
      amountCents: bundle.priceCents,
      bundleSize: bundle.count,
    });
    emitTicketEvent("ticket_paid", { matchId: "store", scope: "self", amountCents: bundle.priceCents });
    res.status(200).json({ ok: true, balance, priceCents: env.TICKET_PRICE_CENTS });
  });

  return router;
}

function parseBundle(body: unknown): { count: number; priceCents: number } | null {
  const raw = (body as { count?: unknown })?.count;
  const count = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(count)) return null;
  return ticketBundleFor(count);
}

async function resolveUser(
  telegramId: number,
): Promise<{ id: string; ticketBalance: number } | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true, ticketBalance: true },
  });
  if (!user) return null;
  return { id: user.id, ticketBalance: user.ticketBalance };
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
