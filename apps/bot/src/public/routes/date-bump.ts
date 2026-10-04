import { Router, type Request, type Response } from "express";

import { prisma } from "@gennety/db";
import { BUMP_HOLD_WAIT_MS } from "@gennety/shared";

import { requireCanvasAuth } from "../canvas-auth.js";
import { canvasLimiter } from "../rate-limit.js";
import {
  announceBumpVerified,
  generateAndStoreBumpDeck,
  recordBump,
  recordHold,
  type BumpRefusal,
} from "../../services/date-bump.js";
import {
  CEREMONY_SNAPSHOT_SELECT,
  HOLD_POLL_MS,
  ceremonyFor,
  waitForBumpVerification,
  type CeremonySnapshot,
} from "../../services/bump-ceremony.js";

/**
 * `POST /v1/dates/:matchId/bump` — one side's shake (PRODUCT_SPEC §6.2).
 *
 * The client detects the shake (CoreMotion on iOS, `DeviceMotionEvent` in the
 * Mini App) and posts when and where it happened. **The server decides whether
 * it counts** — the window, the radius and the alignment are all re-checked
 * here, because a client-side verdict is a client-side ticket grant.
 *
 * `at` is the DEVICE's clock and is deliberately trusted only as far as the
 * server's own bounds allow: it is clamped into the accepted window before
 * anything reads it, so a phone with a wrong date cannot bump its way outside
 * the date, and two phones that disagree by seconds still align.
 *
 * **`hold: true` is the meeting ceremony's gesture (2026-09-29)** and takes a
 * different path after the same checks — see `handleHold`. Without it, this
 * route answers exactly as it did before holds existed: old iOS builds and a
 * cached Mini App keep shaking.
 */
export interface DateBumpRouterOptions {
  /** How long a hold waits for the partner. Tests shorten it. */
  holdWaitMs?: number;
  /** The fallback poll while a hold waits. Tests shorten it. */
  holdPollMs?: number;
}

export function createDateBumpRouter(options: DateBumpRouterOptions = {}): Router {
  const holdWaitMs = options.holdWaitMs ?? BUMP_HOLD_WAIT_MS;
  const holdPollMs = options.holdPollMs ?? HOLD_POLL_MS;
  const router = Router();

  // Either rail: the canvas is one screen on two clients (see canvas-auth.ts).
  router.use(requireCanvasAuth);
  // After auth, so the key is the PERSON rather than a shared address —
  // see `canvasLimiter`. The canvas polls while nothing is happening, which
  // the global IP floor cannot tell apart from abuse.
  router.use(canvasLimiter);

  router.post("/:matchId/bump", async (req: Request, res: Response): Promise<void> => {
    const parsed = parseBumpRequest(req, res);
    if (!parsed) return;
    if (parsed.hold) {
      await handleHold(req, res, parsed, { holdWaitMs, holdPollMs });
      return;
    }
    await handleShake(req, res, parsed);
  });

  return router;
}

export const dateBumpRouter: Router = createDateBumpRouter();

/** How far the device clock may run ahead of ours before we stop trusting it. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const REFUSAL_STATUS: Record<BumpRefusal, number> = {
  // The caller is authenticated and simply not on this match — 404 rather than
  // 403 so the endpoint cannot be used to probe which match ids exist.
  "not-participant": 404,
  "wrong-state": 409,
  "too-early": 409,
  "too-late": 409,
  "too-far": 409,
};

interface BumpRequest {
  matchId: string;
  lat: number;
  lng: number;
  rawAt: unknown;
  hold: boolean;
}

function parseBumpRequest(req: Request, res: Response): BumpRequest | null {
  const matchId = (req.params as Record<string, string | undefined>).matchId;
  if (!matchId || !isUuid(matchId)) {
    res.status(400).json({ error: "matchId must be a UUID" });
    return null;
  }

  const body = (req.body ?? {}) as { lat?: unknown; lng?: unknown; at?: unknown; hold?: unknown };
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "lat and lng are required" });
    return null;
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    res.status(400).json({ error: "lat/lng out of range" });
    return null;
  }
  // Strictly `true`: anything else is an old client, and an old client gets
  // the old answer.
  return { matchId, lat, lng, rawAt: body.at, hold: body.hold === true };
}

/** The shake — unchanged since before holds existed. */
async function handleShake(req: Request, res: Response, parsed: BumpRequest): Promise<void> {
  const { matchId, lat, lng } = parsed;
  const at = resolveShakeTime(parsed.rawAt, new Date());

  const outcome = await recordBump({
    matchId,
    userId: req.userId!,
    at,
    coords: { lat, lng },
  });

  if (!outcome.ok) {
    res.status(REFUSAL_STATUS[outcome.reason!] ?? 409).json({ error: outcome.reason });
    return;
  }

  // The deck and the announcement hang off the ONE call that verified the
  // pair, never off `verified` — otherwise the partner's own shake, arriving
  // a beat later and correctly reporting `verified: true`, would generate a
  // second deck and send the whole thing twice.
  if (outcome.justVerified) {
    // Deliberately awaited rather than fired and forgotten: this is the
    // response the client draws its deck from, and the pair is sitting at a
    // table looking at it. `generateAndStoreBumpDeck` has its own fallback,
    // so a slow model costs seconds, never the screen.
    const deck = await generateAndStoreBumpDeck(matchId).catch((err: unknown) => {
      console.error("[date-bump] deck generation failed:", err);
      return null;
    });
    await announceBumpVerified(matchId).catch((err: unknown) => {
      console.error("[date-bump] announce failed:", err);
    });

    res.json({ ok: true, verified: true, deck: deck ?? null });
    return;
  }

  res.json({ ok: true, verified: outcome.verified, deck: null });
}

/**
 * The hold — the meeting ceremony's gesture (bump-ceremony.ts).
 *
 * Three differences from the shake, and nothing else:
 *
 * - **The time is the server's.** Both holds are live requests, so there is
 *   no device clock worth reading; `at` from the body is ignored.
 * - **The first hold waits for the second** (long-poll, up to `holdWaitMs`),
 *   so both phones learn the verification within a network hop of each other
 *   and can start one scene together.
 * - **The verifying hold does not wait for the deck.** The scene starts
 *   `BUMP_CEREMONY_LEAD_MS` after verification; an OpenAI round trip in front
 *   of that answer would start it on one phone only. The deck and the
 *   announcement run after the response, and both clients read the deck from
 *   `GET /v1/date/state` — which already serves it to the side that did not
 *   verify.
 */
async function handleHold(
  req: Request,
  res: Response,
  parsed: BumpRequest,
  options: { holdWaitMs: number; holdPollMs: number },
): Promise<void> {
  const { matchId, lat, lng } = parsed;
  const at = new Date();

  const outcome = await recordHold({
    matchId,
    userId: req.userId!,
    at,
    coords: { lat, lng },
  });

  if (!outcome.ok || !outcome.side) {
    res.status(REFUSAL_STATUS[outcome.reason!] ?? 409).json({ error: outcome.reason });
    return;
  }
  const side = outcome.side;

  if (outcome.justVerified && outcome.snapshot) {
    answerVerified(res, outcome.snapshot, side);
    // After the response, deliberately (see above). Same order as the shake:
    // the announcement reads the deck the generation stores.
    void afterHoldVerified(matchId);
    return;
  }

  if (outcome.verified) {
    // Verified before this call (a retry after a dropped long-poll, or the
    // partner's call won the compare-and-set a moment ago).
    const row = await readSnapshot(matchId);
    answerVerified(res, row, side);
    return;
  }

  // Not yet — wait for the partner. The client going away ends the wait; a
  // 'close' AFTER our response is the ordinary end of the exchange and must
  // not count, hence `writableFinished`.
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  res.on("close", onClose);
  if (res.socket == null || res.socket.destroyed) controller.abort();

  const row = await waitForBumpVerification(matchId, {
    until: at.getTime() + options.holdWaitMs,
    signal: controller.signal,
    pollMs: options.holdPollMs,
  });
  res.off("close", onClose);

  if (controller.signal.aborted) return;
  if (!row) {
    res.json({ ok: true, verified: false, deck: null });
    return;
  }
  answerVerified(res, row, side);
}

function answerVerified(res: Response, row: CeremonySnapshot | null, side: "A" | "B"): void {
  // `serverNow` is taken here, as late as possible: it is what the phone
  // measures its clock offset against.
  const ceremony = row ? ceremonyFor(row, side, new Date()) : null;
  res.json({ ok: true, verified: true, deck: null, ...(ceremony ? { ceremony } : {}) });
}

async function readSnapshot(matchId: string): Promise<CeremonySnapshot | null> {
  return prisma.dateBumpSession.findUnique({
    where: { matchId },
    select: CEREMONY_SNAPSHOT_SELECT,
  });
}

/** The verifying hold's deck and announcement, after its response. */
async function afterHoldVerified(matchId: string): Promise<void> {
  await generateAndStoreBumpDeck(matchId).catch((err: unknown) => {
    console.error("[date-bump] deck generation failed:", err);
  });
  await announceBumpVerified(matchId).catch((err: unknown) => {
    console.error("[date-bump] announce failed:", err);
  });
}

/**
 * The device's own timestamp, bounded by ours.
 *
 * A client clock is the only thing the phone can honestly report about WHEN it
 * was shaken, and the two phones' clocks are what the alignment check compares
 * — so it has to be used. What it must not be is authoritative: a device an
 * hour fast would otherwise bump outside its own date. Anything further from
 * the server's clock than the tolerance is replaced by the server's, which
 * fails toward "this shake happened now" rather than toward a refusal.
 */
export function resolveShakeTime(raw: unknown, serverNow: Date): Date {
  if (typeof raw !== "string") return serverNow;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return serverNow;
  if (Math.abs(parsed.getTime() - serverNow.getTime()) > CLOCK_SKEW_TOLERANCE_MS) {
    return serverNow;
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
