import { prisma, type MatchStatus } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { parseVibe, mergeParsed, type VenueCategory } from "../services/vibe-parser.js";
import {
  midpoint,
  haversineDistanceKm,
  venueSearchRadiusMeters,
  type LatLng,
} from "../services/geo.js";
import { pickVenueAtMidpoint } from "../services/venue.js";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";
import { applyReportAction, type ReportTier } from "../services/moderation.js";
import { sendPushToUser } from "../services/push.js";

/**
 * Mobile-only wrappers around the existing match-engine pipeline. These
 * deliberately mirror the behaviour of the Telegram handlers but speak in
 * pure DB state transitions so Express can call them without a `BotContext`.
 *
 * Anything that would have produced a Telegram DM in the bot flow (notify
 * peer of decline, concierge prompt, etc.) is intentionally omitted here —
 * the mobile app polls `/v1/matches/current` and pull-based notifications
 * cover the rest.
 */

export type MatchSide = "A" | "B";
export type MatchDecision = "accept" | "decline";
export type VibeTag = "coffee" | "walk" | "drinks" | "study";
export type ReportCategory = "tier1_disappointment" | "tier2_ghosting" | "tier3_safety";

export interface MobileVibeLocationPayload {
  vibe: VibeTag;
  lat: number;
  lng: number;
}

export interface MobileReportPayload {
  category: ReportCategory;
  message: string;
}

export interface SerializedMatch {
  id: string;
  status: MatchStatus;
  pitchForMe: string | null;
  iceBreakers: string[];
  agreedTime: string | null;
  venueName: string | null;
  venueAddress: string | null;
  venueLat: number | null;
  venueLng: number | null;
  venueCategory: string | null;
  mapPreviewUrl: string | null;
  transitHint: string | null;
  partnerFirstName: string | null;
  partnerAge: number | null;
  partnerUniversityDomain: string | null;
  myVibeSubmitted: boolean;
  partnerVibeSubmitted: boolean;
  safetyBriefAck: boolean;
}

// `VibeTag` is a friendlier mobile label. Translate to the existing
// free-text "vibe" that the safety parser already knows how to handle.
const VIBE_TEXT: Record<VibeTag, string> = {
  coffee: "cafe",
  walk: "quiet park walk",
  drinks: "restaurant with drinks",
  study: "quiet cafe for studying",
};

const REPORT_TIER: Record<ReportCategory, ReportTier> = {
  tier1_disappointment: 1,
  tier2_ghosting: 2,
  tier3_safety: 3,
};

async function sideFor(matchId: string, userId: string): Promise<MatchSide | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userBId: true },
  });
  if (!match) return null;
  if (match.userAId === userId) return "A";
  if (match.userBId === userId) return "B";
  return null;
}

/**
 * Fetch the most relevant in-flight match for this user. Priority order
 * mirrors what the Expo UI wants on the "Current match" screen:
 *   1. `scheduled` — the date is locked in, show countdown + venue
 *   2. `negotiating_venue` — prompt for vibe + location
 *   3. `negotiating` — waiting for peer time-pick (mobile users skip iter
 *      1/2 for now, see README)
 *   4. `proposed` — brand-new pitch awaiting accept/decline
 *
 * Returns `null` when the user has nothing open.
 */
export async function getCurrentMatchForUser(
  userId: string,
): Promise<SerializedMatch | null> {
  const match = await prisma.match.findFirst({
    where: {
      status: { in: ["proposed", "negotiating", "negotiating_venue", "scheduled"] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: [
      { status: "asc" }, // enum order happens to align — defensive; refined below
      { createdAt: "desc" },
    ],
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      pitchForA: true,
      pitchForB: true,
      iceBreakersA: true,
      iceBreakersB: true,
      agreedTime: true,
      venueName: true,
      venueAddress: true,
      venueLat: true,
      venueLng: true,
      parsedCategoryA: true,
      parsedCategoryB: true,
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
      safetyAckA: true,
      safetyAckB: true,
      userA: { select: { firstName: true, age: true, universityDomain: true } },
      userB: { select: { firstName: true, age: true, universityDomain: true } },
    },
  });
  if (!match) return null;

  const side: MatchSide = match.userAId === userId ? "A" : "B";
  const partner = side === "A" ? match.userB : match.userA;

  const myVibeSubmitted =
    side === "A"
      ? Boolean(match.vibeTextA) && match.vibeLatA != null && match.vibeLngA != null
      : Boolean(match.vibeTextB) && match.vibeLatB != null && match.vibeLngB != null;

  const partnerVibeSubmitted =
    side === "A"
      ? Boolean(match.vibeTextB) && match.vibeLatB != null && match.vibeLngB != null
      : Boolean(match.vibeTextA) && match.vibeLatA != null && match.vibeLngA != null;

  // Prefer side-specific category; fall back to the other side for the label.
  const venueCategory =
    (side === "A" ? match.parsedCategoryA : match.parsedCategoryB) ??
    match.parsedCategoryA ??
    match.parsedCategoryB ??
    null;

  return {
    id: match.id,
    status: match.status,
    pitchForMe: side === "A" ? match.pitchForA : match.pitchForB,
    iceBreakers: (side === "A" ? match.iceBreakersA : match.iceBreakersB) ?? [],
    agreedTime: match.agreedTime?.toISOString() ?? null,
    venueName: match.venueName,
    venueAddress: match.venueAddress,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueCategory,
    mapPreviewUrl: null,
    transitHint: null,
    partnerFirstName: partner.firstName,
    partnerAge: partner.age,
    partnerUniversityDomain: partner.universityDomain,
    myVibeSubmitted,
    partnerVibeSubmitted,
    safetyBriefAck: side === "A" ? match.safetyAckA : match.safetyAckB,
  };
}

/**
 * Apply an accept/decline on a match. Mirrors `handleMatchDecision` in
 * `handlers/matching/decision.ts` but without the grammY notifications.
 *
 * Returns the reloaded `SerializedMatch` or `null` if the user isn't on
 * this match / the match is already terminal.
 */
export async function applyMatchDecision(
  matchId: string,
  userId: string,
  decision: MatchDecision,
): Promise<SerializedMatch | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userBId: true, status: true, acceptedByA: true, acceptedByB: true },
  });
  if (!match) return null;
  if (match.status === "cancelled" || match.status === "completed" || match.status === "expired") {
    return null;
  }

  const side: MatchSide = match.userAId === userId ? "A" : match.userBId === userId ? "B" : (null as unknown as MatchSide);
  if (!side) return null;

  if (decision === "decline") {
    await prisma.match.update({
      where: { id: matchId },
      data:
        side === "A"
          ? { acceptedByA: false, status: "cancelled" }
          : { acceptedByB: false, status: "cancelled" },
    });
    return getCurrentMatchForUser(userId);
  }

  const updated = await prisma.match.update({
    where: { id: matchId },
    data: side === "A" ? { acceptedByA: true } : { acceptedByB: true },
    select: { acceptedByA: true, acceptedByB: true },
  });

  // If both accepted, atomically flip to `negotiating` — the Telegram bot's
  // scheduler would normally take over from here and DM iteration 1 buttons.
  // Mobile users can't tap those, but moving to `negotiating` is still the
  // right state transition; iteration is bumped by the scheduler cron.
  if (updated.acceptedByA === true && updated.acceptedByB === true) {
    const transitioned = await prisma.match.updateMany({
      where: { id: matchId, status: "proposed" },
      data: { status: "negotiating" },
    });
    if (transitioned.count > 0) {
      // Nudge the peer so they know to open the app and lock in vibe+pin.
      const peerId = match.userAId === userId ? match.userBId : match.userAId;
      await sendPushToUser(peerId, {
        title: "It's a match",
        body: "Open Gennety to lock in your spot.",
        data: { type: "match.both_accepted", matchId },
      });
    }
  }

  return getCurrentMatchForUser(userId);
}

/**
 * Persist the mobile user's "vibe + location" pin. Runs the same safety
 * parser the Telegram flow uses; when both sides have submitted we compute
 * the midpoint, query Google Places, and flip the match to `scheduled`.
 *
 * Unlike the Telegram flow we don't require `agreedTime` to be set first —
 * the mobile app assumes the iter-1/2 time negotiation is vestigial for
 * mobile users and the backend promotes `proposed` straight to
 * `negotiating_venue` when both have accepted.
 */
export async function submitVibeLocation(
  matchId: string,
  userId: string,
  payload: MobileVibeLocationPayload,
): Promise<SerializedMatch | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userBId: true, status: true },
  });
  if (!match) return null;
  const side = match.userAId === userId ? "A" : match.userBId === userId ? "B" : null;
  if (!side) return null;
  if (match.status !== "negotiating" && match.status !== "negotiating_venue") {
    return null;
  }

  const vibeText = VIBE_TEXT[payload.vibe];
  const parsed = await parseVibe(vibeText);

  const base =
    side === "A"
      ? {
          vibeTextA: vibeText,
          vibeLatA: payload.lat,
          vibeLngA: payload.lng,
          parsedCategoryA: parsed.category,
        }
      : {
          vibeTextB: vibeText,
          vibeLatB: payload.lat,
          vibeLngB: payload.lng,
          parsedCategoryB: parsed.category,
        };

  // If we're still in `negotiating`, flip to `negotiating_venue` now that
  // the first vibe+pin is in — matches the bot's `startVenueNegotiation`
  // transition without touching Telegram.
  const data =
    match.status === "negotiating"
      ? { ...base, status: "negotiating_venue" as const, venuePromptAskedAt: new Date() }
      : base;

  await prisma.match.update({ where: { id: matchId }, data });

  await tryFinalizeMatchVenue(matchId);
  return getCurrentMatchForUser(userId);
}

/**
 * Idempotent finalise: if both sides have vibe + lat/lng, compute the
 * midpoint, call Places, and write venue + `scheduled` status. Safe to
 * call repeatedly; no-op if pre-conditions aren't met.
 */
async function tryFinalizeMatchVenue(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
    },
  });
  if (!match || match.status !== "negotiating_venue") return;
  if (
    !match.vibeTextA ||
    !match.vibeTextB ||
    match.vibeLatA == null ||
    match.vibeLngA == null ||
    match.vibeLatB == null ||
    match.vibeLngB == null
  ) {
    return;
  }

  const [parsedA, parsedB] = await Promise.all([
    parseVibe(match.vibeTextA),
    parseVibe(match.vibeTextB),
  ]);
  const merged = mergeParsed(parsedA, parsedB);

  const a: LatLng = { lat: match.vibeLatA, lng: match.vibeLngA };
  const b: LatLng = { lat: match.vibeLatB, lng: match.vibeLngB };
  const mid = midpoint(a, b);
  const radiusMeters = venueSearchRadiusMeters(haversineDistanceKm(a, b));

  const venue = await pickVenueAtMidpoint({
    lat: mid.lat,
    lng: mid.lng,
    category: merged.category as VenueCategory,
    keywords: merged.keywords,
    radiusMeters,
  });

  const scheduled = await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "scheduled",
      venueName: venue.name,
      venueAddress: venue.address,
      venueLat: mid.lat,
      venueLng: mid.lng,
    },
    select: { userAId: true, userBId: true },
  });

  await Promise.all([
    sendPushToUser(scheduled.userAId, {
      title: "Venue locked in",
      body: `${venue.name} — tap for details.`,
      data: { type: "match.scheduled", matchId },
    }),
    sendPushToUser(scheduled.userBId, {
      title: "Venue locked in",
      body: `${venue.name} — tap for details.`,
      data: { type: "match.scheduled", matchId },
    }),
  ]);
}

/** Mobile safety-brief ack. Flips the per-side boolean once; idempotent. */
export async function acknowledgeSafetyBrief(
  matchId: string,
  userId: string,
): Promise<SerializedMatch | null> {
  const side = await sideFor(matchId, userId);
  if (!side) return null;
  await prisma.match.update({
    where: { id: matchId },
    data: side === "A" ? { safetyAckA: true } : { safetyAckB: true },
  });
  return getCurrentMatchForUser(userId);
}

/**
 * Persist a mobile report + run the same moderation engine the Telegram
 * flow uses. Unlike the Telegram version the category is chosen directly
 * by the user (three-tap UI), so we skip the LLM triage and trust the
 * client mapping to Tier 1/2/3.
 *
 * Returns `"duplicate"` when the reporter already filed on this match,
 * so the HTTP layer can surface a 409.
 */
export async function submitMatchReport(
  matchId: string,
  reporterUserId: string,
  payload: MobileReportPayload,
): Promise<"ok" | "duplicate" | "forbidden"> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userBId: true },
  });
  if (!match) return "forbidden";

  const reportedUserId =
    match.userAId === reporterUserId
      ? match.userBId
      : match.userBId === reporterUserId
        ? match.userAId
        : null;
  if (!reportedUserId) return "forbidden";

  const reporter = await prisma.user.findUnique({
    where: { id: reporterUserId },
    select: { language: true },
  });
  const language: Language = (reporter?.language ?? "en") as Language;

  const tier = REPORT_TIER[payload.category];
  const rawText = payload.message.slice(0, 1000);
  const reasonSummary = rawText.slice(0, 240);

  try {
    await prisma.report.create({
      data: {
        reporterId: reporterUserId,
        reportedId: reportedUserId,
        matchId,
        rawText,
        tier,
        reasonSummary,
        adminReviewed: tier !== 3,
      },
    });
  } catch {
    return "duplicate";
  }

  if (tier === 1) {
    await appendNegativeConstraint(reporterUserId, reasonSummary, language);
    return "ok";
  }

  await applyReportAction({
    tier,
    reporterUserId,
    reportedUserId,
    reasonSummary,
    language,
  });
  return "ok";
}
