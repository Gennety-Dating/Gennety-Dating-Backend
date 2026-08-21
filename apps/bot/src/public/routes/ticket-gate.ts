import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import {
  getTicketState,
  useTicketFromBalance,
  notePartnerPaidSeen,
  type TicketStateView,
} from "../../handlers/matching/ticket-gate.js";
import { partnerPhotoUrls } from "../partner-photos.js";
import type { TicketScope } from "../../services/ticket-payment.js";

/**
 * Date Ticket gate for the NATIVE client (JWT auth) — PRODUCT_SPEC §3.5b.
 *
 * The gate itself already arms on the mobile mutual-accept path
 * (`matches-service.ts` calls `sendTicketOffer` whenever `TICKET_FEATURE_ENABLED`),
 * but until now nothing on `/v1/*` could *read* or *settle* it: the Mini App
 * routes under `/v1/matches/:id/ticket` are `initData`-authed, and an iOS user
 * has no Telegram session to sign with. An iOS-only pair therefore sat in a
 * `negotiating` match with no Calendar and no way to pay until the partial
 * window lapsed and the expiry cron opened scheduling for free. This router is
 * that missing surface.
 *
 *   GET  /v1/matches/:id/ticket-gate       — gate state for this side
 *   POST /v1/matches/:id/ticket-gate/use   — spend wallet ticket(s)
 *   POST /v1/matches/:id/ticket-gate/seen  — read-receipt for the cover reveal
 *
 * **The wallet is the only rail here.** On Telegram the gate is paid directly
 * in Stars, per scope. The App Store has no equivalent: a consumable is a
 * fixed-price SKU, so a per-scope gate charge would need one product per scope
 * — and another per famine-discount state — all of them created by hand in App
 * Store Connect and impossible to re-price server-side. Instead StoreKit only
 * ever credits the wallet (`POST /v1/tickets/appstore/transaction`, three
 * consumables), and the gate only ever spends from it. Every gate action is
 * then expressible with the products that already exist, and a settle that
 * loses its race refunds a ticket to the wallet instead of a dollar through
 * Apple. The famine single-ticket discount is USD-only and so does not apply on
 * iOS at all — same rule Stars already follows.
 *
 * Mounted BEFORE the `initData`-authed `/v1/matches/:matchId/ticket` router so
 * prefix resolution can never be in question.
 */
export function createNativeTicketGateRouter(api: Api<RawApi>): Router {
  // mergeParams so `:matchId` from the mount path is visible here.
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const view = await loadState(req, res, api);
    if (!view) return;
    // Read-receipt for the goodwill cover (§3.5b takt 2): she just opened the
    // reveal → tell him once that she saw it, and release the Calendar that
    // `completeTicketGateAndUnlockScheduling` held back for exactly this
    // moment. Fire-and-forget: a DM hiccup must never fail the screen read.
    if (view.state.partnerPaidForMe) {
      void notePartnerPaidSeen(api, view.telegramId, view.matchId).catch(() => {});
    }
    res.json(await nativeState(view.state, req.userId!, view.matchId));
  });

  /**
   * Spend wallet tickets on this gate. `scope` is `self` (my slot), `partner`
   * (hers, after mine is already settled) or `both`.
   *
   * The male-only rule for `partner`/`both` lives in `useTicketFromBalance`,
   * not here — the client is told what it may do via `canCoverPartner` and is
   * never the one enforcing it.
   */
  router.post("/use", async (req: Request, res: Response): Promise<void> => {
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
    const telegramId = await telegramIdOf(req.userId!);
    if (telegramId === null) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const result = await useTicketFromBalance(api, telegramId, matchId, scope);
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
    res.json(await nativeState(result.state, req.userId!, matchId));
  });

  /**
   * Explicit read-receipt. `GET /` already fires one, but the reveal is a
   * screen the client can hold behind an animation — this lets it stamp the
   * receipt when she has actually *seen* it rather than when it loaded.
   * Idempotent (a CAS on `partnerPaidSeenAt`), so calling both is harmless.
   */
  router.post("/seen", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const telegramId = await telegramIdOf(req.userId!);
    if (telegramId === null) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    await notePartnerPaidSeen(api, telegramId, matchId).catch(() => {});
    res.json({ ok: true });
  });

  return router;
}

interface LoadedState {
  state: TicketStateView;
  matchId: string;
  telegramId: bigint;
}

/**
 * Resolve + authorize the gate state, answering the error itself on failure.
 *
 * `api` is passed only by the GET read, which is what lets `getTicketState`
 * settle a slot for a caller who became a Premium subscriber after the gate
 * opened (§3.5b). Withheld elsewhere on purpose: the settle is a write, and it
 * belongs on the polled read rather than bolted onto every action.
 */
async function loadState(
  req: Request,
  res: Response,
  api?: Api<RawApi>,
): Promise<LoadedState | null> {
  const matchId = matchIdOf(req);
  if (!matchId) {
    res.status(404).json({ error: "match-not-found" });
    return null;
  }
  const telegramId = await telegramIdOf(req.userId!);
  if (telegramId === null) {
    res.status(404).json({ error: "user-not-found" });
    return null;
  }
  const result = await getTicketState(telegramId, matchId, api);
  if (!result.ok) {
    res.status(result.reason === "not-participant" ? 403 : 404).json({ error: result.reason });
    return null;
  }
  return { state: result.state, matchId, telegramId };
}

/**
 * The gate service is keyed on `telegramId` because it grew up inside the bot.
 * A mobile-first user still has one — a synthetic negative id minted at signup
 * (`mobile-user.ts`), unique by the same schema constraint — so the lookup is
 * exact and the whole tested settle path is reused rather than forked.
 */
async function telegramIdOf(userId: string): Promise<bigint | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true },
  });
  return user?.telegramId ?? null;
}

/**
 * Native projection of `TicketStateView`. Deliberately narrower than the Mini
 * App's: `paymentMode`, `starsEnabled`, `stars` and `selfDiscountPct` describe
 * rails iOS does not have, and shipping them would invite the client to branch
 * on a currency it can never charge in.
 *
 * `canCoverPartner` is the one field the client would otherwise have to derive,
 * and deriving it means hard-coding "men may cover" into the app. Computed here
 * so the rule stays server-owned and re-validated on `/use` regardless.
 */
async function nativeState(
  state: TicketStateView,
  userId: string,
  matchId: string,
): Promise<Record<string, unknown>> {
  return {
    status: state.ticketStatus,
    iPaid: state.iPaid,
    partnerPaid: state.partnerPaid,
    bothPaid: state.bothPaid,
    partnerPaidForMe: state.partnerPaidForMe,
    iCoveredPartner: state.iCoveredPartner,
    canCoverPartner: state.myGender === "male" && !state.partnerPaid,
    partnerFirstName: state.partnerName,
    partnerPhotoUrl: state.partnerPhotoUrl ? partnerPhotoUrls(userId, matchId, 1)[0] : null,
    balance: state.myBalance,
    priceCents: state.priceCents,
    expiresAt: state.expiresAt,
    // Whether an active subscription is what covers this caller's own slot
    // (§3.8). The client renders the "covered by Premium" plate from it; the
    // slot itself is already settled server-side either way, so a client that
    // ignores the field is merely quieter, never wrong.
    myPremiumActive: state.myPremiumActive,
    serverNow: new Date().toISOString(),
  };
}

function matchIdOf(req: Request): string | null {
  const raw = (req.params as Record<string, string | undefined>).matchId;
  return typeof raw === "string" && UUID_REGEX.test(raw) ? raw : null;
}

function parseScope(body: unknown): TicketScope | null {
  const scope = (body as { scope?: unknown } | undefined)?.scope;
  return scope === "self" || scope === "both" || scope === "partner" ? scope : null;
}

/** See routes/calendar.ts for why we pre-validate the UUID shape here. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
