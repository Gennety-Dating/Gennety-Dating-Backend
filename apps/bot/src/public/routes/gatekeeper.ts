import { Router, type Request, type Response, type NextFunction } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { isStrongEventQrSecret } from "../../services/event-qr.js";
import { redeemPerk, scanEventTicket } from "../../services/event-ticket.js";
import { gatekeeperLimiter } from "../rate-limit.js";

/**
 * `/gk/*` — the venue door portal (LAUNCH_EVENTS_PRODUCT_SPEC.md §8).
 *
 * ── Why this is not a `/v1/*` route with the usual auth ─────────────────
 *
 * Venue staff are NOT users. They have no account, no Telegram, no profile and
 * no place in the matching pool, so neither rail of `requireCanvasAuth` can
 * describe them. They authenticate with a per-event token minted in the admin
 * hub, shown once, stored as a bcrypt hash, scoped to one event and revocable
 * — so a phone left behind a bar cannot admit anyone to the next party.
 *
 * The prefix is deliberately outside `/v1` too: this is not the product's
 * client API and should never inherit its shape by accident.
 */

const LOG_PREFIX = "[gatekeeper]";

interface StaffRequest extends Request {
  staff?: { tokenId: string; eventId: string; label: string };
}

/**
 * Resolve a staff token.
 *
 * The token is bcrypt-hashed, so it cannot be looked up by equality — every
 * live token for the named event is compared. That is bounded by how many
 * doors one party has (a handful), and the event id in the URL is what keeps
 * it from becoming a scan of every token ever minted.
 */
async function requireStaff(req: StaffRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.headers.authorization;
    const eventId = (req.params as { eventId?: string }).eventId ?? "";
    if (!header?.startsWith("Bearer ") || !eventId) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const raw = header.slice(7).trim();
    if (!raw) {
      res.status(401).json({ error: "missing_token" });
      return;
    }

    const candidates = await prisma.eventStaffToken.findMany({
      where: { eventId, revokedAt: null },
      select: { id: true, tokenHash: true, label: true },
    });
    for (const candidate of candidates) {
      if (await bcrypt.compare(raw, candidate.tokenHash)) {
        req.staff = { tokenId: candidate.id, eventId, label: candidate.label };
        next();
        return;
      }
    }
    res.status(401).json({ error: "invalid_token" });
  } catch (err) {
    console.error(`${LOG_PREFIX} auth error:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
}

function featureOff(res: Response): boolean {
  if (!env.EVENTS_FEATURE_ENABLED) {
    res.status(404).json({ error: "Not found" });
    return true;
  }
  return false;
}

export const gatekeeperRouter: Router = Router();

gatekeeperRouter.use(gatekeeperLimiter);

/** Exchange a token for the event it opens — the portal's first screen. */
gatekeeperRouter.post(
  "/:eventId/auth",
  requireStaff,
  async (req: StaffRequest, res: Response) => {
    if (featureOff(res)) return;
    try {
      const event = await prisma.event.findUnique({
        where: { id: req.staff!.eventId },
        select: { id: true, title: true, venueName: true, startsAt: true, endsAt: true, timeZone: true, status: true },
      });
      if (!event) {
        res.status(404).json({ error: "event_not_found" });
        return;
      }
      res.json({
        event: {
          ...event,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
        },
        staff: { label: req.staff!.label },
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} auth lookup error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * Scan a code.
 *
 * Note what this answers with: every refusal is its own named outcome, and a
 * refusal is still HTTP 200. Staff are reading a screen with a person in front
 * of them — "expired, ask them to refresh" and "this ticket is already inside"
 * are different sentences to say out loud, and collapsing them into a 4xx with
 * one message would make the portal useless exactly when it matters.
 */
gatekeeperRouter.post(
  "/:eventId/scan",
  requireStaff,
  async (req: StaffRequest, res: Response) => {
    if (featureOff(res)) return;
    try {
      if (!isStrongEventQrSecret(env.EVENT_QR_SECRET)) {
        console.error(`${LOG_PREFIX} EVENT_QR_SECRET missing or too short — refusing to verify`);
        res.status(503).json({ error: "qr_unavailable" });
        return;
      }
      const body = req.body as Record<string, unknown>;
      const code = typeof body.code === "string" ? body.code.trim() : "";
      if (!code) {
        res.status(400).json({ error: "code is required" });
        return;
      }
      const verdict = await scanEventTicket(code, req.staff!.eventId, req.staff!.tokenId);
      if (verdict.ok) {
        console.log(`${LOG_PREFIX} admitted`, {
          eventId: req.staff!.eventId,
          ticketId: verdict.ticketId,
          by: req.staff!.label,
        });
      }
      res.json(verdict);
    } catch (err) {
      console.error(`${LOG_PREFIX} scan error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** One complimentary drink, CAS'd so two bar phones pour one. */
gatekeeperRouter.post(
  "/:eventId/perk/:ticketId",
  requireStaff,
  async (req: StaffRequest, res: Response) => {
    if (featureOff(res)) return;
    try {
      const { ticketId } = req.params as { ticketId: string };
      const result = await redeemPerk(ticketId, req.staff!.eventId);
      res.json(result);
    } catch (err) {
      console.error(`${LOG_PREFIX} perk error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/** Live headcount + arrivals, polled by the portal while the door is open. */
gatekeeperRouter.get(
  "/:eventId/stats",
  requireStaff,
  async (req: StaffRequest, res: Response) => {
    if (featureOff(res)) return;
    try {
      const eventId = req.staff!.eventId;
      const [tiers, tickets] = await Promise.all([
        prisma.eventTicketTier.findMany({
          where: { eventId },
          select: { id: true, title: true, capacity: true, claimed: true },
        }),
        prisma.eventTicket.findMany({
          where: { eventId, checkedInAt: { not: null } },
          select: { checkedInAt: true, perkRedeemedAt: true },
        }),
      ]);

      // Arrivals bucketed into quarter-hours so the door can see a rush
      // building rather than a single running total.
      const buckets = new Map<string, number>();
      for (const ticket of tickets) {
        if (!ticket.checkedInAt) continue;
        const at = new Date(ticket.checkedInAt);
        at.setMinutes(Math.floor(at.getMinutes() / 15) * 15, 0, 0);
        const key = at.toISOString();
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }

      res.json({
        insideNow: tickets.length,
        perksRedeemed: tickets.filter((t) => t.perkRedeemedAt).length,
        claimedTotal: tiers.reduce((sum, tier) => sum + tier.claimed, 0),
        capacityTotal: tiers.reduce((sum, tier) => sum + tier.capacity, 0),
        tiers,
        arrivals: [...buckets.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([at, count]) => ({ at, count })),
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} stats error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

/**
 * The offline fallback (§7): the door downloads the guest list while it still
 * has signal, and works off it if connectivity drops. Deliberately NOT a
 * cryptographic offline path — a phone that can verify signatures on its own
 * needs a device-held key, which is a much larger decision than a party needs.
 */
gatekeeperRouter.get(
  "/:eventId/manifest",
  requireStaff,
  async (req: StaffRequest, res: Response) => {
    if (featureOff(res)) return;
    try {
      const tickets = await prisma.eventTicket.findMany({
        where: { eventId: req.staff!.eventId, status: { not: "revoked" } },
        select: {
          id: true,
          checkedInAt: true,
          user: { select: { firstName: true, age: true, profile: { select: { photos: true } } } },
        },
        take: 2000,
      });
      res.json({
        generatedAt: new Date().toISOString(),
        guests: tickets.map((ticket) => ({
          ticketId: ticket.id,
          firstName: ticket.user.firstName,
          age: ticket.user.age,
          photo: ticket.user.profile?.photos?.[0] ?? null,
          checkedInAt: ticket.checkedInAt?.toISOString() ?? null,
        })),
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} manifest error:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
