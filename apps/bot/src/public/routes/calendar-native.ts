import { Router, type Request, type Response } from "express";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { requireAuth } from "../auth-middleware.js";
import {
  getCalendarState,
  processCalendarSlotsUpdate,
  type CalendarStateResult,
} from "../../handlers/matching/scheduler.js";

/**
 * Slot calendar for the NATIVE client (JWT auth) — PRODUCT_SPEC §3.6.
 *
 * The same hole the ticket gate had: `startScheduling` writes `proposedTimes`
 * for every `negotiating` match regardless of which client accepted, but the
 * only way to read or answer that grid was `/v1/calendar/*`, which is
 * `initData`-authed. An iOS pair reached scheduling and had no calendar.
 *
 *   GET  /v1/matches/:id/calendar  — the grid + both sides' marks
 *   POST /v1/matches/:id/calendar  — replace THIS side's marks
 *
 * Both answer the same shape, so the client re-renders straight from the POST
 * rather than re-fetching; at a ~4s poll that round trip is the difference
 * between a tap landing and a tap appearing to do nothing.
 *
 * **The mechanics are the scheduler's, not this router's.** Auto-lock on a
 * single overlap, `overlapCandidates` when several are shared, the first-mover
 * DM and the peer's live card all live in `processCalendarSlotsUpdate` and are
 * reused verbatim — a second implementation of "when does a date lock in" is
 * exactly the kind of divergence the two surfaces cannot afford.
 */
export function createNativeCalendarRouter(api: Api<RawApi>): Router {
  // mergeParams so `:matchId` from the mount path is visible here.
  const router = Router({ mergeParams: true });
  router.use(requireAuth);

  router.get("/", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const caller = await callerOf(req.userId!);
    if (!caller) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }
    const result = await getCalendarState(caller.telegramId, matchId);
    if (!result.ok) {
      answerFailure(res, result.reason);
      return;
    }
    res.json(nativeState(result, caller.timeZone));
  });

  /**
   * Replace this side's availability with `slots` (a full set, not a delta —
   * the same contract the Mini App has always used, so "unmark" is expressible
   * without a second verb).
   */
  router.post("/", async (req: Request, res: Response): Promise<void> => {
    const matchId = matchIdOf(req);
    if (!matchId) {
      res.status(404).json({ error: "match-not-found" });
      return;
    }
    const slots = parseSlots(req.body);
    if (slots === null) {
      res.status(400).json({ error: "slots must be an array of ISO timestamps" });
      return;
    }
    const caller = await callerOf(req.userId!);
    if (!caller) {
      res.status(404).json({ error: "user-not-found" });
      return;
    }

    const result = await processCalendarSlotsUpdate(api, caller.telegramId, matchId, slots);
    if (!result.ok) {
      answerFailure(res, result.reason);
      return;
    }
    // A submission does not echo the band: `processCalendarSlotsUpdate` has no
    // reason to recompute it, and the client already holds it from the GET it
    // polls. Re-reading state here purely to restate an unchanged field would
    // buy a query per tap.
    res.json({
      proposedTimes: await proposedTimesFor(matchId),
      mySlots: result.mySlots,
      peerSlots: result.peerSlots,
      agreedTime: result.agreedTime,
      overlapCandidates: result.overlapCandidates,
      timeZone: caller.timeZone,
      serverNow: new Date().toISOString(),
    });
  });

  return router;
}

/**
 * The scheduler is keyed on `telegramId` because it grew up inside the bot; a
 * mobile-first user has a synthetic negative one (`mobile-user.ts`), so the
 * lookup is exact and the whole tested scheduling path is reused rather than
 * forked.
 *
 * `timeZone` rides along because the grid is a set of instants and the client
 * has to choose a wall clock to draw them on. The device's own zone is the
 * wrong choice: the date happens in the pair's city, so someone travelling
 * would be shown a grid in a timezone the date will not take place in, and
 * would agree to a time neither of them meant. Telegram already made this call
 * for the locked-time card, which renders in the canonical city zone.
 */
async function callerOf(
  userId: string,
): Promise<{ telegramId: bigint; timeZone: string | null } | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, profile: { select: { timeZone: true } } },
  });
  if (!user) return null;
  return { telegramId: user.telegramId, timeZone: user.profile?.timeZone ?? null };
}

/** `processCalendarSlotsUpdate` does not echo the grid; it never changes. */
async function proposedTimesFor(matchId: string): Promise<string[]> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { proposedTimes: true },
  });
  return (match?.proposedTimes ?? []).map((d) => d.toISOString());
}

function nativeState(
  result: Extract<CalendarStateResult, { ok: true }>,
  timeZone: string | null,
): Record<string, unknown> {
  return {
    proposedTimes: result.proposedTimes,
    mySlots: result.mySlots,
    peerSlots: result.peerSlots,
    agreedTime: result.agreedTime,
    // A read never resolves an overlap — only a submission does.
    overlapCandidates: [],
    /**
     * Prime Time (§12). The native calendar IS gated — a founder decision — so
     * it has to be told what is locked, or it draws free the cells the server
     * will refuse with 402. Additive: a shipped build that does not know the
     * field keeps its current behaviour and merely discovers the refusal.
     */
    primeTime: result.primeTime,
    timeZone,
    serverNow: new Date().toISOString(),
  };
}

/**
 * `wrong-state` is a 409 rather than a 404: the match exists and the caller is
 * on it, the calendar is simply closed (cancelled, expired, or already past
 * the venue step). A 404 would read as "no such match" and send the client
 * hunting for a routing bug that isn't there.
 */
function answerFailure(res: Response, reason: string): void {
  const status =
    reason === "not-participant"
      ? 403
      : reason === "wrong-state"
        ? 409
        : // 402: the slot exists and the caller may have it — for a price.
          reason === "prime-time-locked"
          ? 402
          : reason === "invalid-iso" || reason === "invalid-slot"
            ? 400
            : 404;
  res.status(status).json({ error: reason });
}

function parseSlots(body: unknown): string[] | null {
  const slots = (body as { slots?: unknown } | undefined)?.slots;
  if (!Array.isArray(slots)) return null;
  if (!slots.every((s) => typeof s === "string")) return null;
  return slots as string[];
}

function matchIdOf(req: Request): string | null {
  const raw = (req.params as Record<string, string | undefined>).matchId;
  return typeof raw === "string" && UUID_REGEX.test(raw) ? raw : null;
}

/** See routes/calendar.ts for why we pre-validate the UUID shape here. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
