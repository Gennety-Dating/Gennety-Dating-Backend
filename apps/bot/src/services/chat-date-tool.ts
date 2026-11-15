import { prisma } from "@gennety/db";
import { isValidTimeZone, preDateBriefingVisibility } from "@gennety/shared";
import { env } from "../config.js";
import { RENDER_TZ } from "./datetime-entity.js";
import { proxyChatWindow } from "./proxy-chat.js";

/**
 * `get_my_date` — the app's chat agent reading the person's booked date
 * (app audit 2026-11-15, item 3). The chat addendum promised «могу
 * подготовить к свиданию — место, темы, что надеть», and the agent had nothing
 * to prepare from: a venue name and a time in the live context, so hours and
 * dress codes were made up.
 *
 * Read-only. What it returns is what this person already sees about their own
 * date: the time (in their zone), the place and the catalogue facts about it,
 * the ice-breakers already written for THEM (only once the date card shows
 * them, `preDateBriefingVisibility`), and the anonymous chat's window. Of the
 * partner only the first name, which the date card already shows. Nothing
 * about anyone's decision — a `scheduled` date is one both already accepted,
 * and no other stage answers with details.
 */

export const GET_MY_DATE_TOOL_NAME = "get_my_date";

export const GET_MY_DATE_TOOL = {
  type: "function" as const,
  function: {
    name: GET_MY_DATE_TOOL_NAME,
    description:
      "Read their booked date: the time in their zone, the venue (address, opening hours, price level, what kind of place it is, how far from transit), the ice-breakers already prepared for them and when the anonymous chat opens. Use it for any question about the date itself — preparing for it, what to wear, what to talk about, whether the place is open, how to get there. Read-only.",
    parameters: { type: "object", properties: {}, required: [] as string[] },
  },
};

const DATE_SELECT = {
  id: true,
  status: true,
  agreedTime: true,
  venueName: true,
  venueAddress: true,
  venuePlaceId: true,
  venueGoogleMapsUri: true,
  proxyClosedAt: true,
  iceBreakersA: true,
  iceBreakersB: true,
} as const;

/** Places `regularOpeningHours`, as the catalogue stores it. */
function weekdayHours(raw: unknown): string[] | null {
  if (!raw || typeof raw !== "object") return null;
  const lines = (raw as { weekdayDescriptions?: unknown }).weekdayDescriptions;
  if (!Array.isArray(lines)) return null;
  const out = lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
  return out.length > 0 ? out : null;
}

function zoneOf(raw: string | null | undefined): string {
  return raw && isValidTimeZone(raw) ? raw : RENDER_TZ;
}

function localTime(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

/** The tool's JSON answer for this person, now. */
export async function executeGetMyDate(userId: string, now: Date = new Date()): Promise<string> {
  const [asA, asB, profile] = await Promise.all([
    prisma.match.findFirst({
      where: { userAId: userId, status: "scheduled" },
      orderBy: { createdAt: "desc" },
      select: { ...DATE_SELECT, userB: { select: { firstName: true } } },
    }),
    prisma.match.findFirst({
      where: { userBId: userId, status: "scheduled" },
      orderBy: { createdAt: "desc" },
      select: { ...DATE_SELECT, userA: { select: { firstName: true } } },
    }),
    prisma.profile.findUnique({ where: { userId }, select: { timeZone: true } }),
  ]);
  const side: "A" | "B" | null = asA ? "A" : asB ? "B" : null;
  const match = asA ?? asB;
  if (!match || !side) {
    return JSON.stringify({
      success: true,
      scheduled: false,
      note: "No booked date right now. Answer from the live context (their stage) and never describe a date that is not booked.",
    });
  }

  const zone = zoneOf(profile?.timeZone);
  const partnerFirstName =
    side === "A"
      ? (asA as { userB?: { firstName: string | null } } | null)?.userB?.firstName ?? null
      : (asB as { userA?: { firstName: string | null } } | null)?.userA?.firstName ?? null;

  const venue = match.venuePlaceId
    ? await prisma.curatedVenue
        .findFirst({
          where: { placeId: match.venuePlaceId },
          select: {
            name: true,
            address: true,
            category: true,
            openingHours: true,
            hoursConfidence: true,
            priceLevel: true,
            editorialSummary: true,
            vibeTags: true,
            transitWalkM: true,
          },
        })
        .catch(() => null)
    : null;

  const briefing = preDateBriefingVisibility(match.agreedTime, now);
  const iceBreakers = briefing.iceBreakers ? (side === "A" ? match.iceBreakersA : match.iceBreakersB) ?? [] : [];

  const window = env.COORDINATION_FEATURE_ENABLED ? proxyChatWindow(match) : null;
  const chat = window
    ? {
        opensAt: localTime(window.opensAt, zone),
        closesAt: localTime(window.closesAt, zone),
        state: match.proxyClosedAt
          ? "closed"
          : now < window.opensAt
            ? "not_open_yet"
            : now < window.closesAt
              ? "open_now"
              : "closed",
      }
    : null;

  const hours = venue ? weekdayHours(venue.openingHours) : null;
  return JSON.stringify({
    success: true,
    scheduled: true,
    when: match.agreedTime
      ? { local: localTime(match.agreedTime, zone), timeZone: zone, past: match.agreedTime.getTime() < now.getTime() }
      : null,
    partnerFirstName,
    venue: {
      name: match.venueName ?? venue?.name ?? null,
      address: match.venueAddress ?? venue?.address ?? null,
      mapsLink: Boolean(match.venueGoogleMapsUri),
      kind: venue?.category ?? null,
      openingHours: hours,
      // `provider` / `operator_confirmed` / `always_open` / `unknown`.
      hoursConfidence: venue?.hoursConfidence ?? null,
      priceLevel: venue?.priceLevel ?? null,
      about: venue?.editorialSummary ?? null,
      vibe: venue && venue.vibeTags.length > 0 ? venue.vibeTags : null,
      walkFromTransitMetres: venue?.transitWalkM ?? null,
    },
    iceBreakers,
    ...(iceBreakers.length === 0 ? { iceBreakersNote: "Not written yet — they arrive about 5 hours before the date." } : {}),
    anonymousChat: chat,
    rules:
      "Facts only from here. A field that is null is unknown: say you don't know rather than guessing, and never invent a dress code, opening hours, prices or a menu. There is no dress code in the catalogue — what to wear is your advice from the kind of place and the evening, said as advice. Of the partner you know only the first name.",
  });
}
