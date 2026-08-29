import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { requireCanvasAuth } from "../canvas-auth.js";
import { canvasLimiter } from "../rate-limit.js";
import { isStrongEventQrSecret } from "../../services/event-qr.js";
import {
  claimEventTicket,
  mintTicketQr,
  rotateTicketNonce,
} from "../../services/event-ticket.js";
import { ADMITTED_TIERS, tierOneApplication } from "../../services/event-admission.js";
import { confirmMet, getEventLiveState, setPartyPause } from "../../services/event-live.js";

/**
 * `/v1/events/*` — the attendee's own surface for launch events
 * (LAUNCH_EVENTS_PRODUCT_SPEC.md §6).
 *
 * Dual-rail auth (`requireCanvasAuth`): Telegram `initData` from the Mini App
 * OR a JWT from the native client, leaving `req.userId` set either way. This
 * is the same case that middleware was written for — one screen, two clients,
 * a byte-identical answer — so it is reused rather than copied.
 *
 * ── What this surface may never reveal ──────────────────────────────────
 *
 * The applicant sees their TIER and nothing else about the decision: never
 * their attractiveness score, never a threshold, never the cohort's ratio.
 * Those are the founder's tuning instruments, and a number that reads as a
 * rating OF THE PERSON is the one thing this product does not put on screen
 * (the same rule `explain_my_match` follows in §2.1).
 */

const LOG_PREFIX = "[events-api]";

/** What the applicant is told, in product language rather than in tier names. */
function publicAdmission(tier: string | null): "none" | "pending" | "admitted" | "reserve" {
  if (!tier) return "none";
  if ((ADMITTED_TIERS as readonly string[]).includes(tier)) return "admitted";
  if (tier === "waitlisted" || tier === "revoked") return "reserve";
  // `screening` and `pending_review` are both "we're looking at it" from the
  // outside. Distinguishing them would leak that verification is what is
  // missing, which the verification gate itself already says far better.
  return "pending";
}

function serializeEvent(event: {
  id: string;
  title: string;
  kind: string;
  status: string;
  venueName: string;
  venueAddress: string;
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
}) {
  return {
    id: event.id,
    title: event.title,
    kind: event.kind,
    status: event.status,
    venueName: event.venueName,
    venueAddress: event.venueAddress,
    startsAt: event.startsAt.toISOString(),
    endsAt: event.endsAt.toISOString(),
    // The event happens on the city's wall clock, and the reader's device is
    // the wrong one for a traveller — same field, same reason, as
    // `SerializedMatch.timeZone`.
    timeZone: event.timeZone,
  };
}

function featureOff(res: Response): boolean {
  if (!env.EVENTS_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return true;
  }
  return false;
}

export const eventsPublicRouter: Router = Router();

eventsPublicRouter.use(canvasLimiter);
eventsPublicRouter.use(requireCanvasAuth);

/** Open events in the caller's own market, with their own state on each. */
eventsPublicRouter.get("/", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const profile = await prisma.profile.findUnique({
      where: { userId },
      select: { homeCityKey: true },
    });
    // No dating city means no market, and an event in another city is not
    // something this product can invite anyone to — matching is same-city, so
    // the guest would have nobody there.
    if (!profile?.homeCityKey) {
      res.json({ events: [] });
      return;
    }

    const now = new Date();
    const events = await prisma.event.findMany({
      where: {
        cityKey: profile.homeCityKey,
        status: { in: ["upcoming", "live"] },
        endsAt: { gt: now },
      },
      orderBy: { startsAt: "asc" },
      take: 20,
      include: {
        applications: { where: { userId }, select: { tier: true } },
        tickets: { where: { userId }, select: { id: true, status: true } },
        tiers: {
          select: { id: true, kind: true, title: true, capacity: true, claimed: true, requiresAdmission: true },
        },
      },
    });

    res.json({
      events: events.map((event) => ({
        ...serializeEvent(event),
        admission: publicAdmission(event.applications[0]?.tier ?? null),
        hasTicket: event.tickets.length > 0,
        tiers: event.tiers
          // The guestlist is the founder's comp list and is never offered as a
          // self-serve option — it would be a "skip the queue" button.
          //
          // Filtered on `kind`, NOT on `requiresAdmission`. The two agree today
          // only because the admin route derives the second from the first
          // (`requiresAdmission: kind !== "vip_guestlist"`), and the schema lets
          // them diverge — at which point `requiresAdmission` would hide an
          // ordinary open tier from the one screen that can claim it, silently.
          .filter((tier) => tier.kind !== "vip_guestlist")
          .map((tier) => ({
            id: tier.id,
            title: tier.title,
            // A remaining COUNT, not the raw claimed/capacity pair: the exact
            // fill of a party is the founder's number, and "3 spots left" is
            // the only part of it an attendee can act on.
            spotsLeft: Math.max(0, tier.capacity - tier.claimed),
          })),
      })),
    });
  } catch (err) {
    console.error(`${LOG_PREFIX} list error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Apply. Deliberately an explicit act — see `autoApplyOnVerification`. */
eventsPublicRouter.post("/:id/apply", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { id } = req.params as { id: string };

    const [event, profile] = await Promise.all([
      prisma.event.findUnique({
        where: { id },
        select: { id: true, cityKey: true, status: true, admissionClosesAt: true },
      }),
      prisma.profile.findUnique({ where: { userId }, select: { homeCityKey: true } }),
    ]);
    if (!event || !["upcoming", "live"].includes(event.status)) {
      res.status(404).json({ error: "Event not found" });
      return;
    }
    if (profile?.homeCityKey !== event.cityKey) {
      res.status(403).json({ error: "wrong_market" });
      return;
    }
    if (event.admissionClosesAt && event.admissionClosesAt <= new Date()) {
      res.status(409).json({ error: "admission_closed" });
      return;
    }

    // Idempotent: the unique (eventId, userId) makes a second tap the same row
    // rather than a duplicate, so re-applying is free and never resets a tier.
    const application = await prisma.waitlistApplication.upsert({
      where: { eventId_userId: { eventId: id, userId } },
      create: { eventId: id, userId },
      update: {},
      select: { id: true, tier: true },
    });

    // Tier it immediately when the applicant is already verified — otherwise
    // somebody who applies AFTER verifying sits in `screening` until a human
    // presses a button, because the only other automatic trigger is the
    // verification pipeline they have already been through.
    const tier =
      application.tier === "screening"
        ? ((await tierOneApplication(application.id)) ?? application.tier)
        : application.tier;

    res.json({ admission: publicAdmission(tier) });
  } catch (err) {
    console.error(`${LOG_PREFIX} apply error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Claim the free ticket. Admission is the condition; the ticket costs nothing. */
eventsPublicRouter.post("/:id/ticket", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { id } = req.params as { id: string };
    const body = req.body as Record<string, unknown>;
    const tierId = typeof body.tierId === "string" ? body.tierId : "";
    if (!tierId) {
      res.status(400).json({ error: "tierId is required" });
      return;
    }

    const result = await claimEventTicket(userId, id, tierId);
    if (!result.ok) {
      const status =
        result.reason === "event_not_found" || result.reason === "tier_not_found"
          ? 404
          : result.reason === "not_admitted"
            ? 403
            : 409;
      res.status(status).json({ error: result.reason });
      return;
    }
    res.json({ ok: true, ticketId: result.ticketId, created: result.created });
  } catch (err) {
    console.error(`${LOG_PREFIX} claim error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Mint a fresh door code. Short-lived by design, so the client re-requests it
 * while the screen is open rather than holding one that outlives the queue.
 */
eventsPublicRouter.get("/:id/ticket/qr", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    if (!isStrongEventQrSecret(env.EVENT_QR_SECRET)) {
      // Refusing beats signing with a blank string, which would validate every
      // forgery while looking exactly like a working door.
      console.error(`${LOG_PREFIX} EVENT_QR_SECRET missing or too short — refusing to mint`);
      res.status(503).json({ error: "qr_unavailable" });
      return;
    }
    const userId = req.userId as string;
    const { id } = req.params as { id: string };
    const minted = await mintTicketQr(userId, id);
    if (!minted) {
      res.status(404).json({ error: "no_ticket" });
      return;
    }
    res.json(minted);
  } catch (err) {
    console.error(`${LOG_PREFIX} qr error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** "My code leaked" — kills every code already in the wild for this ticket. */
eventsPublicRouter.post("/:id/ticket/rotate", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { id } = req.params as { id: string };
    const rotated = await rotateTicketNonce(userId, id);
    if (!rotated) {
      res.status(404).json({ error: "no_ticket" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(`${LOG_PREFIX} rotate error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Party Mode (§9) ──────────────────────────────────────────────────────

/**
 * The live screen: am I checked in, am I sitting out, and who am I meeting.
 *
 * Polled every few seconds while a round is open, so it is deliberately two
 * indexed reads and no join beyond the pairing's own participants.
 */
eventsPublicRouter.get("/:id/live", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { id } = req.params as { id: string };
    res.json(await getEventLiveState(userId, id));
  } catch (err) {
    console.error(`${LOG_PREFIX} live error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** "We crossed paths." Blind until both — see `confirmMet`. */
eventsPublicRouter.post("/:id/pairings/:pairingId/met", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { pairingId } = req.params as { pairingId: string };
    const result = await confirmMet(userId, pairingId);
    if (!result.ok) {
      // Both refusals answer 404 rather than distinguishing "no such pairing"
      // from "not yours", so the route cannot be walked to discover whether a
      // pairing id exists.
      res.status(404).json({ error: "no_pairing" });
      return;
    }
    res.json({ ok: true, mutual: result.mutual });
  } catch (err) {
    console.error(`${LOG_PREFIX} met error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** The status chip: sit the next round out, or come back. */
eventsPublicRouter.post("/:id/pause", async (req: Request, res: Response) => {
  if (featureOff(res)) return;
  try {
    const userId = req.userId as string;
    const { id } = req.params as { id: string };
    const paused = (req.body as { paused?: unknown } | undefined)?.paused !== false;
    const ok = await setPartyPause(userId, id, paused);
    if (!ok) {
      res.status(404).json({ error: "no_ticket" });
      return;
    }
    res.json({ ok: true, paused });
  } catch (err) {
    console.error(`${LOG_PREFIX} pause error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});
