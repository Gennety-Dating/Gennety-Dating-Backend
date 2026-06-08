import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  getTicketState,
  applyTicketPayment,
  useTicketFromBalance,
} from "../../handlers/matching/ticket-gate.js";
import {
  createTicketIntent,
  verifyTicketPayment,
  amountForScope,
  type TicketScope,
} from "../../services/ticket-payment.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";

/** See routes/calendar.ts for why we pre-validate the UUID shape here. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Date Ticket Mini App endpoints — REST-nested under the match for parity with
 * the rest of the `/v1/matches/:id/*` surface, but authenticated with
 * `Authorization: tma <initData>` (NOT a Bearer JWT) because the caller is the
 * Telegram Mini App, which only shares the bot's secret. Mounted in server.ts
 * BEFORE the JWT-gated `matchesRouter` so the more-specific prefix wins.
 *
 *   GET  /v1/matches/:id/ticket/state    — screen state (status, price, gender,
 *                                           partner-paid-for-me, expiry, ...)
 *   POST /v1/matches/:id/ticket/intent   — create a (mock) payment intent
 *   POST /v1/matches/:id/ticket/confirm  — confirm "payment" → mark paid
 */
export function createTicketRouter(api: Api<RawApi>): Router {
  // mergeParams so `:matchId` from the mount path is visible here.
  const router = Router({ mergeParams: true });

  router.get("/state", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }

    const result = await getTicketState(BigInt(auth.user.id), matchId);
    if (!result.ok) {
      res.status(result.reason === "not-participant" ? 403 : 404).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, ...result.state });
  });

  router.post("/intent", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const scope = parseScope(req.body);
    if (!scope) {
      res.status(400).json({ error: "scope must be 'self' or 'both'" });
      return;
    }

    // Read state to resolve price + gender + participation in one place.
    const stateRes = await getTicketState(BigInt(auth.user.id), matchId);
    if (!stateRes.ok) {
      res.status(stateRes.reason === "not-participant" ? 403 : 404).json({ error: stateRes.reason });
      return;
    }
    if ((scope === "both" || scope === "partner") && stateRes.state.myGender !== "male") {
      res.status(403).json({ error: "scope-not-allowed" });
      return;
    }

    const amountCents = amountForScope(scope, stateRes.state.priceCents);
    const intent = await createTicketIntent({ matchId, scope, amountCents });
    emitTicketEvent("ticket_intent_created", { matchId, scope, amountCents });
    res.status(200).json({
      ok: true,
      clientSecret: intent.clientSecret,
      amountCents: intent.amountCents,
      mode: intent.mode,
    });
  });

  router.post("/confirm", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const scope = parseScope(req.body);
    if (!scope) {
      res.status(400).json({ error: "scope must be 'self' or 'both'" });
      return;
    }
    const clientSecret =
      typeof (req.body as { clientSecret?: unknown })?.clientSecret === "string"
        ? (req.body as { clientSecret: string }).clientSecret
        : "";

    // TODO: Stripe Production Mode — in stripe mode this verify must defer to
    // the HMAC-verified webhook, not the client. See services/ticket-payment.ts.
    const verified = await verifyTicketPayment({ clientSecret });
    if (!verified.ok) {
      res.status(400).json({ error: "payment-not-verified" });
      return;
    }

    const result = await applyTicketPayment(api, BigInt(auth.user.id), matchId, scope);
    if (!result.ok) {
      const status =
        result.reason === "not-participant"
          ? 403
          : result.reason === "match-not-found"
            ? 404
            : 400;
      res.status(status).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, ...result.state });
  });

  // Spend a ticket from the wallet instead of paying. No payment intent — the
  // server re-validates balance + scope and consumes from `User.ticketBalance`.
  router.post("/use", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const scope = parseScope(req.body);
    if (!scope) {
      res.status(400).json({ error: "scope must be 'self', 'both' or 'partner'" });
      return;
    }

    const result = await useTicketFromBalance(api, BigInt(auth.user.id), matchId, scope);
    if (!result.ok) {
      const status =
        result.reason === "not-participant"
          ? 403
          : result.reason === "match-not-found"
            ? 404
            : result.reason === "insufficient-balance"
              ? 409
              : 400;
      res.status(status).json({ error: result.reason });
      return;
    }
    res.status(200).json({ ok: true, ...result.state });
  });

  return router;
}

function matchIdOf(req: Request): string | null {
  const raw = (req.params as { matchId?: string }).matchId;
  if (typeof raw !== "string" || !UUID_REGEX.test(raw)) return null;
  return raw;
}

function parseScope(body: unknown): TicketScope | null {
  const scope = (body as { scope?: unknown })?.scope;
  return scope === "self" || scope === "both" || scope === "partner" ? scope : null;
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
