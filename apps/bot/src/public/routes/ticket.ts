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
import { toAvatarThumbnail } from "../../services/avatar-thumbnail.js";
import { recordMiniAppAction } from "../../services/chat-events.js";
import {
  createTicketIntent,
  verifyTicketPayment,
  amountForScope,
  gateStarsForScope,
  type TicketScope,
} from "../../services/ticket-payment.js";
import type { TicketStateView } from "../../handlers/matching/ticket-gate.js";
import { emitTicketEvent } from "../../services/ticket-analytics.js";
import { allowCrossOriginImage } from "../cross-origin-image.js";

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
 * The single shape every state-returning gate route answers with. `/use` and
 * `/confirm` MUST decorate their new state exactly like `GET /state` does: the
 * Mini App re-renders straight from those responses (it does not re-fetch), so
 * a response missing `starsEnabled`/`stars` reads as "Stars is off" and routes
 * the next tap into the mock `/intent` path — which 404s under the PAY-1 guard
 * while Stars is the live rail. That is exactly what broke the male
 * "cover both with my ticket + pay hers" combo: his wallet ticket was spent,
 * then the follow-up partner payment fell back to the mock rail and died with a
 * generic error.
 */
function stateResponse(state: TicketStateView): Record<string, unknown> {
  return {
    ok: true,
    ...state,
    starsEnabled: env.TICKET_STARS_ENABLED,
    stars: gateStarsView(),
    // Drives the "invite a friend instead" referral cross-promo link, shown
    // client-side only on the offer screen when the wallet balance is 0.
    referralEnabled: env.REFERRAL_FEATURE_ENABLED,
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
    res.status(200).json(stateResponse(result.state));
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
    // Nothing left to cover once she settled her own slot: a `both` invoice
    // would charge the doubled price while only his single slot can still be
    // claimed, and a `partner` invoice would buy nothing at all. Refuse to mint
    // it — the Mini App re-fetches state and falls back to the `self` scope.
    if ((scope === "both" || scope === "partner") && stateRes.state.partnerPaid) {
      res.status(409).json({ error: "partner-already-paid" });
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
      recordMiniAppAction(
        auth.user.id,
        `in the Date Ticket Mini App, opened the Stars payment sheet for ${count} ticket(s) (not paid yet)`,
        { surface: "ticket", matchId },
      );
      res.status(200).json({ ok: true, link, stars });
    } catch (err) {
      console.error("[ticket] createInvoiceLink (stars gate) failed:", err);
      res.status(502).json({ error: "invoice-failed" });
    }
  });

  // Stream a participant's first profile photo for the Mini App avatars. Auth
  // via `?a=<initData>` (see authenticatePhotoRequest — this is the ONLY route
  // that accepts the query-param form). `side` = self | partner, resolved
  // relative to the authenticated caller so no one can enumerate others' photos.
  router.get("/photo/:side", async (req: Request, res: Response): Promise<void> => {
    const auth = authenticatePhotoRequest(req);
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
    const cached = readAvatarCache(photo.ref);
    if (cached) {
      sendAvatar(res, cached);
      return;
    }
    const bytes = await downloadProfileImage(photo.ref, api);
    if (!bytes) {
      res.status(404).json({ error: "photo-unavailable" });
      return;
    }
    // Shrunk to avatar size, not streamed at full resolution — see
    // `services/avatar-thumbnail.ts` for the measurement behind that.
    const thumb = await toAvatarThumbnail(bytes);
    writeAvatarCache(photo.ref, thumb);
    sendAvatar(res, thumb);
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
    res.status(200).json(stateResponse(result.state));
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
    recordMiniAppAction(
      auth.user.id,
      scope === "both"
        ? "in the Date Ticket Mini App, used 2 tickets — covering both their own and their partner's"
        : scope === "partner"
          ? "in the Date Ticket Mini App, used a ticket to cover their partner's"
          : "in the Date Ticket Mini App, used a ticket for their own slot",
      { surface: "ticket", matchId },
    );
    res.status(200).json(stateResponse(result.state));
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

/**
 * Header-only initData auth. Every route on this router uses it EXCEPT
 * `GET /photo/:side`, which opts into the query-param variant below.
 *
 * The `?a=` fallback used to live here, which meant it also authenticated
 * state-changing POSTs like `/use` (spending the caller's ticket wallet).
 * initData is a bearer-equivalent credential valid for two hours, and a query
 * string lands in reverse-proxy access logs, browser history, and `Referer`
 * headers on cross-origin subresources — so the fallback is now scoped to the
 * one route that genuinely cannot send a header. This mirrors
 * `routes/venue-change.ts`, which already keeps its photo-proxy check inline.
 */
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

/**
 * `GET /photo/:side` only. An `<img src>` cannot carry an Authorization header,
 * so initData rides `?a=` there and is HMAC-verified exactly like the header
 * path. Accepts the header too, so a non-`<img>` caller needn't downgrade.
 */
function authenticatePhotoRequest(req: Request): AuthOk | AuthErr {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (header?.startsWith("tma ")) return authenticate(req);

  const q = (req.query as { a?: unknown }).a;
  if (typeof q !== "string" || q.length === 0) {
    return { ok: false, body: { error: "Missing tma initData" } };
  }
  const validation = validateInitData(q.trim(), env.BOT_TOKEN);
  if (!validation.valid) {
    return { ok: false, body: { error: "Invalid initData", reason: validation.reason } };
  }
  return { ok: true, user: { id: validation.user.id } };
}

// ── Avatar bytes ───────────────────────────────────────────────────────────

/**
 * In-process cache of already-shrunk avatars, keyed by the storage ref.
 *
 * The key is a Telegram `file_id` or a Supabase path, both of which change when
 * the photo does, so a cached entry can never outlive the photo it belongs to.
 * What it removes is the two Telegram round trips (`getFile` + download) and the
 * decode on every cold open — the Mini App is reopened repeatedly from a
 * persistent chat card that is never edited (§3.5b), and the entry is a few tens
 * of kilobytes. Same shape as the venue-change board's Places photo cache.
 *
 * Bounded and swept on insert: this holds bytes, so an unbounded map on a 2 GB
 * droplet is a leak rather than an optimisation.
 */
const AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const AVATAR_CACHE_MAX = 200;
const avatarCache = new Map<string, { bytes: Buffer; at: number }>();

function readAvatarCache(ref: string): Buffer | null {
  const hit = avatarCache.get(ref);
  if (!hit) return null;
  if (Date.now() - hit.at > AVATAR_CACHE_TTL_MS) {
    avatarCache.delete(ref);
    return null;
  }
  return hit.bytes;
}

function writeAvatarCache(ref: string, bytes: Buffer): void {
  if (avatarCache.size >= AVATAR_CACHE_MAX) {
    // Insertion-ordered, so the first key is the oldest write.
    const oldest = avatarCache.keys().next().value;
    if (oldest !== undefined) avatarCache.delete(oldest);
  }
  avatarCache.set(ref, { bytes, at: Date.now() });
}

function sendAvatar(res: Response, bytes: Buffer): void {
  res.setHeader("Content-Type", "image/jpeg");
  allowCrossOriginImage(res);
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).end(bytes);
}
