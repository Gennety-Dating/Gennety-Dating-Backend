import { prisma, Prisma, type MatchStatus, type Theme } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  ACTIVE_MATCH_STATUSES,
  pickCurrentMatch,
} from "./active-match-priority.js";

/**
 * The four in-flight match statuses. A user has at most one row in any of
 * these at a time in practice; the lifetime-ban invariant + cooldown keep the
 * active set to one. Mirrors `getCurrentMatchForUser` (matches-service.ts) and
 * the `PROFILER_BLOCKING_MATCH_STATUSES` set, but keeps `scheduled` in — the
 * "My date" menu hub needs the locked-in date too.
 */
export { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";

export type MatchSide = "A" | "B";

/** The subset of columns the menu row + date hub read. */
export interface ActiveMatchPartner {
  id: string;
  firstName: string | null;
  telegramId: bigint;
  language: Language;
  theme: Theme;
  photos: string[];
}

export interface ActiveMatchResult {
  /** The raw match row (selected fields — see the query below). */
  match: {
    id: string;
    status: MatchStatus;
    agreedTime: Date | null;
    venueName: string | null;
    venueAddress: string | null;
    venueGoogleMapsUri: string | null;
    venueLat: number | null;
    venueLng: number | null;
    venuePhotoUrl: string | null;
    venuePhotoName: string | null;
    parsedCategoryA: string | null;
    parsedCategoryB: string | null;
    proxyOpenedAt: Date | null;
    proxyClosedAt: Date | null;
    proxyClosesAt: Date | null;
    venueChangeStatus: string | null;
    ticketStatus: string | null;
    dateCardFileIdA: string | null;
    dateCardFileIdB: string | null;
  };
  /** Which side of the match the caller is. */
  side: MatchSide;
  /** The other participant (what the caller sees on the date). */
  partner: ActiveMatchPartner;
  /** The caller's own participant record (language/theme drive rendering). */
  self: ActiveMatchPartner;
}

/**
 * Find the caller's single in-flight match (proposed / negotiating /
 * negotiating_venue / scheduled) by Telegram id, resolving the caller's side
 * and the partner in one round-trip. Returns `null` when the user has no live
 * match (or no account). Used by the main-menu "My date" row and the date hub
 * (`handlers/menu/my-date.ts`).
 *
 * Explicit product priority selects the most-progressed status; `createdAt
 * desc` breaks ties. Never rely on Prisma/PostgreSQL enum declaration order.
 */
export async function findActiveMatchForTelegramId(
  telegramId: bigint,
): Promise<ActiveMatchResult | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return null;

  const participantSelect = {
    id: true,
    firstName: true,
    telegramId: true,
    language: true,
    theme: true,
    profile: { select: { photos: true } },
  } satisfies Prisma.UserSelect;

  const matches = await prisma.match.findMany({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: user.id }, { userBId: user.id }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      agreedTime: true,
      venueName: true,
      venueAddress: true,
      venueGoogleMapsUri: true,
      venueLat: true,
      venueLng: true,
      venuePhotoUrl: true,
      venuePhotoName: true,
      parsedCategoryA: true,
      parsedCategoryB: true,
      proxyOpenedAt: true,
      proxyClosedAt: true,
      proxyClosesAt: true,
      venueChangeStatus: true,
      ticketStatus: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
      dateCardFileIdA: true,
      dateCardFileIdB: true,
      userA: { select: participantSelect },
      userB: { select: participantSelect },
    },
  });
  // A proposed match becomes visible to each participant only after that
  // participant's pitch was actually delivered. Match creation and the
  // two Telegram delivery legs are intentionally separate, so a global
  // dispatched marker can reveal a partner during pre-roll or while only the
  // other side has received their pitch.
  const visibleMatches = matches.filter((candidate) => {
    if (candidate.status !== "proposed") return true;
    const callerIsA = candidate.userAId === user.id;
    return callerIsA
      ? candidate.pitchMessageIdA !== null
      : candidate.pitchMessageIdB !== null;
  });
  const match = pickCurrentMatch(visibleMatches);
  if (!match) return null;

  const side: MatchSide = match.userAId === user.id ? "A" : "B";
  const rawSelf = side === "A" ? match.userA : match.userB;
  const rawPartner = side === "A" ? match.userB : match.userA;

  const toParticipant = (u: {
    id: string;
    firstName: string | null;
    telegramId: bigint;
    language: Language | null;
    theme: Theme;
    profile: { photos: string[] } | null;
  }): ActiveMatchPartner => ({
    id: u.id,
    firstName: u.firstName,
    telegramId: u.telegramId,
    language: u.language ?? "en",
    theme: u.theme,
    photos: u.profile?.photos ?? [],
  });

  return {
    match: {
      id: match.id,
      status: match.status,
      agreedTime: match.agreedTime,
      venueName: match.venueName,
      venueAddress: match.venueAddress,
      venueGoogleMapsUri: match.venueGoogleMapsUri,
      venueLat: match.venueLat,
      venueLng: match.venueLng,
      venuePhotoUrl: match.venuePhotoUrl,
      venuePhotoName: match.venuePhotoName,
      parsedCategoryA: match.parsedCategoryA,
      parsedCategoryB: match.parsedCategoryB,
      proxyOpenedAt: match.proxyOpenedAt,
      proxyClosedAt: match.proxyClosedAt,
      proxyClosesAt: match.proxyClosesAt,
      venueChangeStatus: match.venueChangeStatus,
      ticketStatus: match.ticketStatus,
      dateCardFileIdA: match.dateCardFileIdA,
      dateCardFileIdB: match.dateCardFileIdB,
    },
    side,
    partner: toParticipant(rawPartner),
    self: toParticipant(rawSelf),
  };
}
