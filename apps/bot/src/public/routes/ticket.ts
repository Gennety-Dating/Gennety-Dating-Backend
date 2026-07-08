import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, buildGateInvoicePayload, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import { validateInitData } from "../init-data.js";
import {
  getTicketState,
  getTicketPhoto,
  applyTicketPayment,
  useTicketFromBalance,
  notePartnerPaidSeen,
} from "../../handlers/matching/ticket-gate.js";
import { downloadProfileImage } from "../../services/storage.js";
import {
  createTicketIntent,
  verifyTicketPayment,
  amountForScope,
  gateStarsForScope,
  type TicketScope,
} from "../../services/ticket-payment.js";
import type { TicketStateView } from "../../handlers/matching/ticket-gate.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";

/**
 * Per-scope Star (XTR) prices surfaced to the gate Mini App so it can render
 * "Pay … ⭐N" buttons (mirrors the wallet route's `starsEnabled`/`bundleStars`).
 * Null when Stars is off (the Mini App then falls back to the mock USD buttons).
 */
function gateStarsView(): { self: number; both: number; partner: number } | null {
  if (!env.TICKET_STARS_ENABLED) return null;
  return {
    self: gateStarsForScope("self"),
    both: gateStarsForScope("both"),
    partner: gateStarsForScope("partner"),
  };
}

/**
 * Charged amount for a gate action. The `self` scope honours the famine
 * single-ticket discount (`selfPriceCents` is pre-discounted by the gate state
 * builder); `both`/`partner` always charge full per-ticket price × count.
 */
function priceForScope(scope: TicketScope, state: TicketStateView): number {
  if (scope === "self") return state.selfPriceCents;
  return amountForScope(scope, state.priceCents);
}

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
    // Read-receipt for the goodwill cover (§3.5b takt 2): the covered partner
    // just opened her reveal → let the payer know once she's seen his gesture.
    // Fire-and-forget so a DM hiccup never delays or fails the screen read.
    if (result.state.partnerPaidForMe) {
      void notePartnerPaidSeen(api, BigInt(auth.user.id), matchId).catch(() => {});
    }
    // When Stars is on, the gate Mini App renders Star-priced pay buttons and
    // pays natively via WebApp.openInvoice (see POST /stars-invoice).
    res.status(200).json({
      ok: true,
      ...result.state,
      starsEnabled: env.TICKET_STARS_ENABLED,
      stars: gateStarsView(),
    });
  });

  // Native Telegram Stars (XTR) payment for the §3.5b date gate. Returns a
  // Telegram invoice link the Mini App opens with WebApp.openInvoice(); the gate
  // is settled by the bot's successful_payment handler (handlers/payments.ts),
  // keyed on the `gate:<matchId>:<scope>` payload. The mock intent/confirm path
  // stays for TICKET_STARS_ENABLED=false.
  router.post("/stars-invoice", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    if (!env.TICKET_STARS_ENABLED) {
      res.status(404).json({ error: "stars-not-enabled" });
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

    // Re-validate participation + male-only scope before issuing the invoice.
    const stateRes = await getTicketState(BigInt(auth.user.id), matchId);
    if (!stateRes.ok) {
      res.status(stateRes.reason === "not-participant" ? 403 : 404).json({ error: stateRes.reason });
      return;
    }
    if ((scope === "both" || scope === "partner") && stateRes.state.myGender !== "male") {
      res.status(403).json({ error: "scope-not-allowed" });
      return;
    }

    const stars = gateStarsForScope(scope);
    if (stars <= 0) {
      res.status(400).json({ error: "stars-not-priced" });
      return;
    }

    const { getBotApi } = await import("../server.js");
    const botApi = getBotApi();
    if (!botApi) {
      res.status(503).json({ error: "bot-unavailable" });
      return;
    }
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(auth.user.id) },
      select: { language: true },
    });
    const lang = (user?.language ?? "en") as Language;
    const count = scope === "both" ? 2 : 1;
    try {
      const link = await botApi.createInvoiceLink(
        t(lang, "ticketStoreInvoiceTitle"),
        t(lang, "ticketGateInvoiceDesc", { count }),
        buildGateInvoicePayload(matchId, scope),
        "", // provider_token — empty for Telegram Stars (XTR)
        "XTR",
        [{ label: t(lang, "ticketStoreInvoiceLabel", { count }), amount: stars }],
      );
      emitTicketEvent("ticket_intent_created", { matchId, scope, amountCents: stars });
      res.status(200).json({ ok: true, link, stars });
    } catch (err) {
      console.error("[ticket] createInvoiceLink (stars gate) failed:", err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  // Stream a participant's first profile photo for the Mini App avatars. Auth
  // via `?a=<initData>` (see authenticate). `side` = self | partner, resolved
  // relative to the authenticated caller so no one can enumerate others' photos.
  router.get("/photo/:side", async (req: Request, res: Response): Promise<void> => {
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
    const rawSide = (req.params as { side?: string }).side;
    const which = rawSide === "self" || rawSide === "partner" ? rawSide : null;
    if (!which) {
      res.status(400).json({ error: "side must be 'self' or 'partner'" });
      return;
    }
    const photo = await getTicketPhoto(BigInt(auth.user.id), matchId, which);
    if (!photo.ok) {
      res.status(photo.reason === "not-participant" ? 403 : 404).json({ error: photo.reason });
      return;
    }
    const bytes = await downloadProfileImage(photo.ref, api);
    if (!bytes) {
      res.status(404).json({ error: "photo-unavailable" });
      return;
    }
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    res.status(200).end(bytes);
  });

  router.post("/intent", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticate(req);
    if (!auth.ok) {
      res.status(401).json(auth.body);
      return;
    }
    // PAY-1: when Stars is the live rail, the simulated mock intent/confirm must
    // NOT settle anything — Stars (/stars-invoice + successful_payment) is the
    // sole purchase path. Otherwise any Mini App user could mint a free ticket
    // via the mock flow. The mock survives only as the TICKET_STARS_ENABLED=false
    // fallback. The wallet /use path stays open (spending earned tickets is not a
    // purchase).
    if (env.TICKET_STARS_ENABLED) {
      res.status(404).json({ error: "stars-mode" });
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

    const amountCents = priceForScope(scope, stateRes.state);
    const intent = await createTicketIntent({
      payerId: String(auth.user.id),
      matchId,
      scope,
      amountCents,
    });
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
    // PAY-1: Stars is the sole purchase rail when enabled — see /intent above.
    if (env.TICKET_STARS_ENABLED) {
      res.status(404).json({ error: "stars-mode" });
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
    const stateRes = await getTicketState(BigInt(auth.user.id), matchId);
    if (!stateRes.ok) {
      const status = stateRes.reason === "not-participant" ? 403 : 404;
      res.status(status).json({ error: stateRes.reason });
      return;
    }
    const amountCents = priceForScope(scope, stateRes.state);
    const verified = await verifyTicketPayment({
      clientSecret,
      payerId: String(auth.user.id),
      matchId,
      scope,
      amountCents,
    });
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
  let authHeader = req.header("authorization") ?? req.header("Authorization");
  // `<img>` tags can't set an Authorization header, so the photo route passes
  // initData via the `?a=` query param instead. validateInitData still enforces
  // the HMAC signature, so this is no weaker than the header path.
  if (!authHeader) {
    const q = (req.query as { a?: unknown }).a;
    if (typeof q === "string" && q.length > 0) authHeader = `tma ${q}`;
  }
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
