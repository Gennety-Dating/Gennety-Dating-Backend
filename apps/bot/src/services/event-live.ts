/**
 * The attendee's own view of Party Mode, and the two taps it allows
 * (LAUNCH_EVENTS_PRODUCT_SPEC §9.1, §9.3).
 *
 * The entire interaction surface is: read your current pairing, say you found
 * each other, and take a break. There is no message field, no list of other
 * attendees, and no verdict — the thumbs open at T+2h with the recap, so the
 * party is never a place where someone is visibly swiping on people standing
 * in the room.
 *
 * **The gate is `checkedInAt`, not a coordinate.** A staff-scanned QR at the
 * door is stronger evidence of presence than any client-reported location and
 * costs no permission prompt — the same reasoning that lets a verified Date
 * Bump write attendance. An optional radius check could tighten it later; it
 * is explicitly not the gate.
 *
 * **There is deliberately no partner photo.** Two reasons, and the second is
 * the product one. The photo rail (`public/partner-photos.ts`) is match-scoped
 * end to end — its entitlement check requires a live `matches` row — so
 * showing a face here would mean widening a live, security-sensitive path for
 * a feature that ships dark. And at a party the mechanic that actually finds
 * someone is the named spot plus two digits said out loud; a face turns that
 * into scanning the room comparing people, which is the behaviour §9.3 exists
 * to keep out of the venue.
 */
import { prisma } from "@gennety/db";

const LOG_PREFIX = "[event-live]";

export interface EventLivePairing {
  pairingId: string;
  roundIndex: number;
  closesAt: string;
  partnerFirstName: string | null;
  spotLabel: string;
  code: number;
  /** This side's own mission line. The partner's is never sent. */
  mission: string | null;
  /** Whether THIS side has said they found each other. */
  iConfirmed: boolean;
  /**
   * True only once BOTH have. A single confirmation reveals nothing, the same
   * rule §3.4 enforces for the pitch decision — otherwise the first tapper
   * learns the other person's answer before giving their own.
   */
  mutual: boolean;
}

export interface EventLiveState {
  checkedIn: boolean;
  paused: boolean;
  pairing: EventLivePairing | null;
}

/** What the live screen shows right now. */
export async function getEventLiveState(
  userId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<EventLiveState> {
  const ticket = await prisma.eventTicket.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { status: true, pausedAt: true },
  });

  const checkedIn = ticket?.status === "checked_in";
  const paused = Boolean(ticket?.pausedAt);
  if (!checkedIn) return { checkedIn: false, paused, pairing: null };

  const pairing = await prisma.eventRoundPairing.findFirst({
    where: {
      eventId,
      OR: [{ userAId: userId }, { userBId: userId }],
      round: { status: "open", closesAt: { gt: now } },
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userAId: true,
      missionA: true,
      missionB: true,
      metConfirmedA: true,
      metConfirmedB: true,
      spotLabel: true,
      code: true,
      round: { select: { index: true, closesAt: true } },
      userA: { select: { firstName: true } },
      userB: { select: { firstName: true } },
    },
  });

  if (!pairing) return { checkedIn: true, paused, pairing: null };

  const isA = pairing.userAId === userId;
  return {
    checkedIn: true,
    paused,
    pairing: {
      pairingId: pairing.id,
      roundIndex: pairing.round.index,
      closesAt: pairing.round.closesAt.toISOString(),
      partnerFirstName: (isA ? pairing.userB : pairing.userA).firstName,
      spotLabel: pairing.spotLabel,
      code: pairing.code,
      mission: isA ? pairing.missionA : pairing.missionB,
      iConfirmed: Boolean(isA ? pairing.metConfirmedA : pairing.metConfirmedB),
      mutual: Boolean(pairing.metConfirmedA && pairing.metConfirmedB),
    },
  };
}

export type ConfirmMetResult =
  | { ok: true; mutual: boolean }
  | { ok: false; reason: "unknown_pairing" | "not_participant" };

/**
 * "We crossed paths."
 *
 * A compare-and-set on this side's own column, so a double tap is the same
 * timestamp rather than a second one, and two simultaneous taps both resolve
 * to `mutual: true` without either overwriting the other.
 *
 * Deliberately NOT gated on the round still being open. The round closing is
 * how the product stops asking, not a deadline the attendee has to beat —
 * someone who tapped thirty seconds late still met the person, and §9.2.6's
 * "no penalty" is meaningless if a late tap is refused.
 */
export async function confirmMet(
  userId: string,
  pairingId: string,
  now: Date = new Date(),
): Promise<ConfirmMetResult> {
  const pairing = await prisma.eventRoundPairing.findUnique({
    where: { id: pairingId },
    select: { id: true, userAId: true, userBId: true },
  });
  if (!pairing) return { ok: false, reason: "unknown_pairing" };

  const isA = pairing.userAId === userId;
  const isB = pairing.userBId === userId;
  if (!isA && !isB) return { ok: false, reason: "not_participant" };

  await prisma.eventRoundPairing.updateMany({
    where: isA
      ? { id: pairingId, metConfirmedA: null }
      : { id: pairingId, metConfirmedB: null },
    data: isA ? { metConfirmedA: now } : { metConfirmedB: now },
  });

  // Re-read rather than trusting the CAS count: the other side may have
  // confirmed between our write and this read, and being told "mutual" a beat
  // late is the harmless direction — claiming it early is not.
  const after = await prisma.eventRoundPairing.findUnique({
    where: { id: pairingId },
    select: { metConfirmedA: true, metConfirmedB: true },
  });

  return { ok: true, mutual: Boolean(after?.metConfirmedA && after?.metConfirmedB) };
}

/**
 * "Taking a break" / "I'm back."
 *
 * Durable rather than an in-memory chip, because losing it fails in the unsafe
 * direction: a deploy mid-party would silently re-enter someone who had just
 * asked to be left alone. Sitting out never costs anything — the next round
 * simply passes them by, and resuming is one tap.
 */
export async function setPartyPause(
  userId: string,
  eventId: string,
  paused: boolean,
  now: Date = new Date(),
): Promise<boolean> {
  const updated = await prisma.eventTicket.updateMany({
    where: { eventId, userId },
    data: { pausedAt: paused ? now : null },
  });
  if (updated.count === 0) {
    console.warn(`${LOG_PREFIX} pause for a ticket that does not exist: ${eventId}/${userId}`);
    return false;
  }
  return true;
}
