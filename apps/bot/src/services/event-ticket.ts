import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { ADMITTED_TIERS } from "./event-admission.js";
import { EVENT_QR_VERSION, newQrNonce, signEventQr, verifyEventQr } from "./event-qr.js";

/**
 * Event tickets: claiming a spot, minting the door code, and admitting someone
 * at the door (LAUNCH_EVENTS_PRODUCT_SPEC.md §6–§8).
 *
 * The ticket is free — it is the entry condition, not a product — so there is
 * no payment, no refund rail and no claim TTL here. What remains is capacity,
 * and capacity is the whole reason this file is careful.
 */

const LOG_PREFIX = "[event-ticket]";

/** How long a minted door code stays valid. Short on purpose: a forwarded
 *  screenshot has to die before its holder can reach the venue. */
export const EVENT_QR_TTL_SECONDS = 90;

export type ClaimResult =
  | { ok: true; ticketId: string; created: boolean }
  | {
      ok: false;
      reason: "event_not_found" | "tier_not_found" | "not_admitted" | "tier_full" | "event_closed";
    };

/**
 * Claim a ticket.
 *
 * The capacity guard is a CONDITIONAL ATOMIC INCREMENT
 * (`SET claimed = claimed + 1 WHERE claimed < capacity`), not a count-then-insert.
 * Two people racing for the last spot both read "49 of 50" under any read-first
 * scheme; here exactly one statement updates a row and the other updates zero,
 * so one gets a ticket and the other gets an honest refusal.
 *
 * It runs in the INTERACTIVE transaction form. The array form of
 * `$transaction` cannot short-circuit — it runs every statement it was handed
 * and only then lets you read the result — so a CAS written that way is an
 * after-the-fact report rather than a guard. That exact mistake cost this
 * codebase a double reward once (DECISIONS.md 2026-08-27); it is not repeated.
 */
export async function claimEventTicket(
  userId: string,
  eventId: string,
  tierId: string,
): Promise<ClaimResult> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({
      where: { id: eventId },
      select: { id: true, status: true },
    });
    if (!event) return { ok: false as const, reason: "event_not_found" as const };
    // `concluded`/`cancelled` cannot take new tickets. `draft` cannot either —
    // an unpublished event handing out real door codes is how a party gets
    // gate-crashed by people who found the link early.
    if (!["upcoming", "live"].includes(event.status)) {
      return { ok: false as const, reason: "event_closed" as const };
    }

    const tier = await tx.eventTicketTier.findUnique({
      where: { id: tierId },
      select: { id: true, eventId: true, requiresAdmission: true },
    });
    if (!tier || tier.eventId !== eventId) {
      return { ok: false as const, reason: "tier_not_found" as const };
    }

    // Idempotent by the unique (eventId, userId): a second tap returns the
    // ticket they already hold rather than consuming another seat. This check
    // is what makes a double-tap free; the unique index is what makes it safe.
    const existing = await tx.eventTicket.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { id: true },
    });
    if (existing) return { ok: true as const, ticketId: existing.id, created: false };

    if (tier.requiresAdmission) {
      const application = await tx.waitlistApplication.findUnique({
        where: { eventId_userId: { eventId, userId } },
        select: { tier: true },
      });
      if (!application || !(ADMITTED_TIERS as readonly string[]).includes(application.tier)) {
        return { ok: false as const, reason: "not_admitted" as const };
      }
    }

    const claimed = await tx.$executeRaw`
      UPDATE event_ticket_tiers SET claimed = claimed + 1, updated_at = NOW()
      WHERE id = ${tierId}::uuid AND claimed < capacity`;
    if (claimed === 0) return { ok: false as const, reason: "tier_full" as const };

    const ticket = await tx.eventTicket.create({
      data: { eventId, tierId, userId, qrNonce: newQrNonce() },
      select: { id: true },
    });
    return { ok: true as const, ticketId: ticket.id, created: true };
  });
}

/**
 * Mint a short-lived door code for the owner's own ticket.
 *
 * Returns null rather than throwing for a ticket that is not theirs: the
 * caller is a route, and "not yours" and "does not exist" must answer the same
 * way or the endpoint becomes a probe for ticket ids.
 */
export async function mintTicketQr(
  userId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: string; ticketId: string } | null> {
  const ticket = await prisma.eventTicket.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { id: true, eventId: true, qrNonce: true, status: true },
  });
  if (!ticket || ticket.status === "revoked") return null;

  const exp = Math.floor(now.getTime() / 1000) + EVENT_QR_TTL_SECONDS;
  const code = signEventQr(
    { v: EVENT_QR_VERSION, t: ticket.id, e: ticket.eventId, n: ticket.qrNonce, exp },
    env.EVENT_QR_SECRET,
  );
  return { code, expiresAt: new Date(exp * 1000).toISOString(), ticketId: ticket.id };
}

/** Rotate the nonce, killing every code already in the wild for this ticket. */
export async function rotateTicketNonce(userId: string, eventId: string): Promise<boolean> {
  const updated = await prisma.eventTicket.updateMany({
    where: { eventId, userId, status: { not: "revoked" } },
    data: { qrNonce: newQrNonce() },
  });
  return updated.count > 0;
}

export type ScanVerdict =
  | {
      ok: true;
      outcome: "admitted";
      ticketId: string;
      attendee: { firstName: string | null; age: number | null; photo: string | null };
      tierTitle: string;
      perkRedeemedAt: string | null;
    }
  | {
      ok: false;
      outcome:
        | "bad_signature"
        | "expired"
        | "malformed"
        | "wrong_version"
        | "wrong_event"
        | "unknown_ticket"
        | "stale_code"
        | "revoked"
        | "already_used";
      /** Populated for `already_used` so staff can see WHO is already inside. */
      attendee?: { firstName: string | null; age: number | null; photo: string | null };
      checkedInAt?: string;
    };

/**
 * Admit someone at the door.
 *
 * Every refusal is a distinct outcome because staff have to SAY something to a
 * person standing in front of them, and "expired code, ask them to refresh" is
 * a completely different sentence from "this ticket is already inside". A
 * single boolean would collapse an apology and an accusation into one.
 */
export async function scanEventTicket(
  rawCode: string,
  eventId: string,
  staffTokenId: string,
  now: Date = new Date(),
): Promise<ScanVerdict> {
  const verdict = verifyEventQr(rawCode, env.EVENT_QR_SECRET, Math.floor(now.getTime() / 1000));
  if (!verdict.ok) return { ok: false, outcome: verdict.reason };
  // Refused by SHAPE, before any database call: a genuine code from last
  // month's party is not this door's problem to look up.
  if (verdict.payload.e !== eventId) return { ok: false, outcome: "wrong_event" };

  return prisma.$transaction(async (tx) => {
    const ticket = await tx.eventTicket.findUnique({
      where: { id: verdict.payload.t },
      select: {
        id: true,
        eventId: true,
        status: true,
        qrNonce: true,
        checkedInAt: true,
        perkRedeemedAt: true,
        tier: { select: { title: true } },
        user: {
          select: { firstName: true, age: true, profile: { select: { photos: true } } },
        },
      },
    });
    if (!ticket || ticket.eventId !== eventId) {
      return { ok: false as const, outcome: "unknown_ticket" as const };
    }

    const attendee = {
      firstName: ticket.user.firstName,
      age: ticket.user.age,
      // The face is the human anti-spoof: the signature proves the ticket, the
      // photo proves the holder. Staff compare it before waving someone in.
      photo: ticket.user.profile?.photos?.[0] ?? null,
    };

    // A rotated nonce kills every code minted before the rotation — that is
    // what "my code leaked" actually does.
    if (ticket.qrNonce !== verdict.payload.n) {
      return { ok: false as const, outcome: "stale_code" as const, attendee };
    }
    if (ticket.status === "revoked") {
      return { ok: false as const, outcome: "revoked" as const, attendee };
    }
    if (ticket.checkedInAt) {
      return {
        ok: false as const,
        outcome: "already_used" as const,
        attendee,
        checkedInAt: ticket.checkedInAt.toISOString(),
      };
    }

    // The single-use guarantee, and it is the database's rather than the
    // signature's: two doors scanning the same screenshot in the same second
    // produce one admission and one `already_used`.
    const claimed = await tx.eventTicket.updateMany({
      where: { id: ticket.id, checkedInAt: null },
      data: { status: "checked_in", checkedInAt: now, checkedInByTokenId: staffTokenId },
    });
    if (claimed.count === 0) {
      return { ok: false as const, outcome: "already_used" as const, attendee };
    }

    return {
      ok: true as const,
      outcome: "admitted" as const,
      ticketId: ticket.id,
      attendee,
      tierTitle: ticket.tier.title,
      perkRedeemedAt: ticket.perkRedeemedAt?.toISOString() ?? null,
    };
  });
}

/**
 * Redeem the one complimentary perk (a drink). Same CAS shape as check-in,
 * for the same reason: a bar with two staff phones must pour one cocktail.
 */
export async function redeemPerk(
  ticketId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: "unknown_ticket" | "not_checked_in" | "already_redeemed" }> {
  const ticket = await prisma.eventTicket.findUnique({
    where: { id: ticketId },
    select: { id: true, eventId: true, checkedInAt: true, perkRedeemedAt: true },
  });
  if (!ticket || ticket.eventId !== eventId) return { ok: false, reason: "unknown_ticket" };
  // A perk before entry is a drink for somebody who is not at the party.
  if (!ticket.checkedInAt) return { ok: false, reason: "not_checked_in" };
  if (ticket.perkRedeemedAt) return { ok: false, reason: "already_redeemed" };

  const claimed = await prisma.eventTicket.updateMany({
    where: { id: ticketId, perkRedeemedAt: null },
    data: { perkRedeemedAt: now },
  });
  if (claimed.count === 0) return { ok: false, reason: "already_redeemed" };
  console.log(`${LOG_PREFIX} perk redeemed`, { ticketId, eventId });
  return { ok: true };
}

/**
 * Release a claimed seat back to its tier.
 *
 * Called when a ticket is revoked (admission withdrawn, event cancelled). The
 * decrement is floored at zero in SQL rather than trusted: a counter that can
 * go negative silently inflates capacity for everyone after it.
 */
export async function revokeEventTicket(ticketId: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const ticket = await tx.eventTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, tierId: true, status: true },
    });
    if (!ticket || ticket.status === "revoked") return false;

    const claimed = await tx.eventTicket.updateMany({
      where: { id: ticketId, status: { not: "revoked" } },
      data: { status: "revoked" },
    });
    if (claimed.count === 0) return false;

    await tx.$executeRaw`
      UPDATE event_ticket_tiers SET claimed = GREATEST(claimed - 1, 0), updated_at = NOW()
      WHERE id = ${ticket.tierId}::uuid`;
    return true;
  });
}
