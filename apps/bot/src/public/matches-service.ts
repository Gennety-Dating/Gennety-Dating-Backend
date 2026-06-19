import { Prisma, prisma, type MatchStatus } from "@gennety/db";
import { t, type Language, type TranslationKey } from "@gennety/shared";
import { env } from "../config.js";
import { parseVibe, mergeParsed, type VenueCategory } from "../services/vibe-parser.js";
import {
  midpoint,
  haversineDistanceKm,
  venueSearchRadiusMeters,
  type LatLng,
} from "../services/geo.js";
import { resolveVenue } from "../services/curated-venue.js";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";
import { applyReportAction, type ReportTier } from "../services/moderation.js";
import { sendPushToUser } from "../services/push.js";
import { generateAndSaveWingmanHints } from "../services/wingman-hint.js";
import { runVenueFinalizationOnce } from "../services/venue-finalization-flight.js";
import { createMatchEventBestEffort } from "../services/match-events.js";
import { claimMatchDecision } from "../services/match-decision-claim.js";
import { updateEloScores } from "../utils/elo-calculator.js";
import { startScheduling } from "../handlers/matching/scheduler.js";
import { sendTicketOffer } from "../handlers/matching/ticket-gate.js";
import {
  boostAcceptedSidePriority,
  outcomeRevealKey,
} from "../services/match-decision-shared.js";
import { getBotApi } from "./server.js";
import { PROPOSAL_TTL_MS } from "../utils/countdown-plate.js";
import { PRE_DATE_WINGMAN_HOURS } from "@gennety/shared";

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
  /**
   * Phase 4 "Wingman" — asymmetric insider tip for THIS user about the
   * partner. `null` until T-1.5h before `agreedTime`, then the per-side
   * string from the DB. Gated server-side so clients cannot peek early.
   */
  wingmanHint: string | null;
  /**
   * AI Synergy Score — pair-level integer in [70, 99] shown on the match
   * reveal and upcoming-date screens. `null` for legacy rows that pre-date
   * the feature; the mobile UI hides the card in that case.
   */
  synergyScore: number | null;
  /** 1–2 sentence positive justification, language-aware. */
  synergyReason: string | null;
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
  /**
   * 24h proposal-response deadline as an ISO timestamp. Populated only
   * for `status === 'proposed'` matches that have been dispatched —
   * `null` everywhere else (already accepted, scheduled, expired, etc.).
   *
   * The Expo client renders the live countdown locally with a 1-second
   * tick: `proposalDeadlineAt - serverTimeAt` ≈ remaining duration, then
   * keep counting down on the client clock. Color thresholds are pure
   * client logic: `>20h` green, `10-20h` yellow, `<10h` red.
   */
  proposalDeadlineAt: string | null;
  /**
   * Server's current wall-clock at the time of this response, ISO. The
   * client subtracts this from its local `Date.now()` to derive an
   * offset, then applies that offset to `proposalDeadlineAt` so a
   * device with a skewed clock still shows the correct countdown.
   */
  serverTimeAt: string;
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

/** Fields needed to notify a participant on the correct channel. */
const MATCH_CONTACT_SELECT = {
  id: true,
  telegramId: true,
  language: true,
  platform: true,
} as const;

interface ParticipantContact {
  id: string;
  telegramId: bigint;
  language: string | null;
  platform: string;
}

/**
 * Deliver a decision notification to a participant on whichever channel(s)
 * they actually use: a Telegram DM for `telegram`/`both` accounts (when the
 * bot Api is wired) and an Expo push for `mobile`/`both` accounts. The
 * Telegram copy is the localized translation; the push reuses it as the body.
 *
 * This mirrors how `date-lifecycle.ts` fans out wingman hints, and is what
 * closes the cross-platform notification gap from audit H1 — a Telegram user
 * whose partner decided from the mobile app previously got nothing.
 * Best-effort: send failures are swallowed so they never abort the decision.
 */
async function notifyParticipant(
  user: ParticipantContact,
  key: TranslationKey,
  push: { type: string; title: string; matchId: string },
  options: { telegram?: boolean } = {},
): Promise<void> {
  const lang = (user.language ?? "en") as Language;
  const text = t(lang, key);
  const api = getBotApi();
  if (
    options.telegram !== false &&
    api &&
    user.telegramId > 0n &&
    (user.platform === "telegram" || user.platform === "both")
  ) {
    await api.sendMessage(Number(user.telegramId), text).catch(() => {});
  }
  if (user.platform === "mobile" || user.platform === "both") {
    await sendPushToUser(user.id, {
      title: push.title,
      body: text,
      data: { type: push.type, matchId: push.matchId },
    }).catch(() => {});
  }
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
      synergyScore: true,
      synergyReason: true,
      iceBreakersA: true,
      iceBreakersB: true,
      wingmanHintA: true,
      wingmanHintB: true,
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
      dispatchedAt: true,
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

  // Wingman hint is only revealed within T-1.5h of the agreed time. This is
  // the single source of truth for the reveal gate — the column may already
  // contain the string well ahead of that window (generation happens at
  // `scheduled` transition), but clients see `null` until the gate opens.
  const revealAtMs = match.agreedTime
    ? match.agreedTime.getTime() - PRE_DATE_WINGMAN_HOURS * 60 * 60 * 1000
    : null;
  const wingmanUnlocked = revealAtMs !== null && Date.now() >= revealAtMs;
  const wingmanHint = wingmanUnlocked
    ? (side === "A" ? match.wingmanHintA : match.wingmanHintB) ?? null
    : null;

  // 24h response deadline. Only meaningful while the proposal is still
  // open — once we transition to `negotiating`/`scheduled`/etc. there's
  // nothing left to count down to. The expiry job overwrites `status`
  // to `expired` once the deadline passes, so a `proposed` row with a
  // past deadline is a brief race window the client should treat as
  // "expiring imminently" rather than "still valid".
  const proposalDeadlineAt =
    match.status === "proposed" && match.dispatchedAt
      ? new Date(match.dispatchedAt.getTime() + PROPOSAL_TTL_MS).toISOString()
      : null;

  return {
    id: match.id,
    status: match.status,
    pitchForMe: side === "A" ? match.pitchForA : match.pitchForB,
    iceBreakers: (side === "A" ? match.iceBreakersA : match.iceBreakersB) ?? [],
    wingmanHint,
    synergyScore: match.synergyScore,
    synergyReason: match.synergyReason,
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
    proposalDeadlineAt,
    serverTimeAt: new Date().toISOString(),
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
    select: {
      userAId: true,
      userBId: true,
      status: true,
      acceptedByA: true,
      acceptedByB: true,
      userA: { select: MATCH_CONTACT_SELECT },
      userB: { select: MATCH_CONTACT_SELECT },
    },
  });
  if (!match) return null;
  if (match.status !== "proposed") return null;

  const side: MatchSide =
    match.userAId === userId
      ? "A"
      : match.userBId === userId
        ? "B"
        : (null as unknown as MatchSide);
  if (!side) return null;

  const actorId = side === "A" ? match.userAId : match.userBId;
  const targetId = side === "A" ? match.userBId : match.userAId;
  const actor: ParticipantContact = side === "A" ? match.userA : match.userB;
  const peer: ParticipantContact = side === "A" ? match.userB : match.userA;
  const claimed = await claimMatchDecision({
    matchId,
    side,
    decision: decision === "accept",
  });
  if (!claimed.claimed) return getCurrentMatchForUser(userId);
  const peerPrior = side === "A" ? claimed.acceptedByB : claimed.acceptedByA;

  if (decision === "accept") {
    await createMatchEventBestEffort({
      matchId,
      actorId,
      targetId,
      actionType: "ACCEPTED",
    });

    // Mutual accept → atomic flip to `negotiating` (one concurrent caller
    // wins the WHERE-guarded transition), then the same Elo + handoff the
    // Telegram decision path runs.
    if (claimed.acceptedByA === true && claimed.acceptedByB === true) {
      const transitioned = await prisma.match.updateMany({
        where: { id: matchId, status: "proposed" },
        data: { status: "negotiating" },
      });
      if (transitioned.count > 0) {
        await updateEloScores(match.userAId, match.userBId, true, true);
        // Establish the scheduling state before best-effort notifications.
        // A blocked Telegram user must not strand an accepted match.
        const api = getBotApi();
        if (api) {
          if (env.TICKET_FEATURE_ENABLED) await sendTicketOffer(api, matchId);
          else await startScheduling(api, matchId);
        }
        const telegramHandledByCta = Boolean(api);
        await notifyParticipant(
          actor,
          "matchBothAccepted",
          {
            type: "match.both_accepted",
            title: "It's a match",
            matchId,
          },
          { telegram: !telegramHandledByCta },
        );
        await notifyParticipant(
          peer,
          "matchBothAccepted",
          {
            type: "match.both_accepted",
            title: "It's a match",
            matchId,
          },
          { telegram: !telegramHandledByCta },
        );
      }
      return getCurrentMatchForUser(userId);
    }

    // Peer already declined → mixed verdict. Cancel, update Elo, compensate
    // the accepter, and reveal the outcome both ways. (Previously the mobile
    // accept path ignored this and left the row stuck in `proposed` — H1.)
    if (peerPrior === false) {
      await prisma.match.updateMany({
        where: { id: matchId, status: "proposed" },
        data: { status: "cancelled" },
      });
      await updateEloScores(
        match.userAId,
        match.userBId,
        side === "A" ? true : false,
        side === "B" ? true : false,
      );
      const boosted = await boostAcceptedSidePriority(actorId);
      await notifyParticipant(actor, outcomeRevealKey(true, false, boosted), {
        type: "match.outcome",
        title: "Gennety",
        matchId,
      });
      await notifyParticipant(peer, outcomeRevealKey(false, true, boosted), {
        type: "match.outcome",
        title: "Gennety",
        matchId,
      });
      return getCurrentMatchForUser(userId);
    }

    // First decider accepted → keep the row `proposed` (blind invariant) and
    // send the peer a neutral "your match answered" nudge that reveals nothing.
    await notifyParticipant(peer, "matchPeerDecided", {
      type: "match.peer_decided",
      title: "Gennety",
      matchId,
    });
    return getCurrentMatchForUser(userId);
  }

  // ----- decline -----
  if (peerPrior === null) {
    // First decider declines: KEEP `proposed` so the peer's keyboard stays
    // live and they decide blind. Only record this side's verdict + nudge.
    await createMatchEventBestEffort({
      matchId,
      actorId,
      targetId,
      actionType: "DECLINED",
    });
    await notifyParticipant(peer, "matchPeerDecided", {
      type: "match.peer_decided",
      title: "Gennety",
      matchId,
    });
    return getCurrentMatchForUser(userId);
  }

  // Second decider declines → both decided. Cancel, update Elo, and (if the
  // peer had accepted) compensate them; reveal the outcome both ways.
  await prisma.match.updateMany({
    where: { id: matchId, status: "proposed" },
    data: { status: "cancelled" },
  });
  await createMatchEventBestEffort({
    matchId,
    actorId,
    targetId,
    actionType: "DECLINED",
  });
  await updateEloScores(
    match.userAId,
    match.userBId,
    side === "A" ? false : peerPrior,
    side === "B" ? false : peerPrior,
  );
  const boosted = peerPrior === true ? await boostAcceptedSidePriority(targetId) : false;
  await notifyParticipant(actor, outcomeRevealKey(false, peerPrior, boosted), {
    type: "match.outcome",
    title: "Gennety",
    matchId,
  });
  await notifyParticipant(peer, outcomeRevealKey(peerPrior, false, boosted), {
    type: "match.outcome",
    title: "Gennety",
    matchId,
  });
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
    select: { userAId: true, userBId: true, status: true, agreedTime: true },
  });
  if (!match) return null;
  const side = match.userAId === userId ? "A" : match.userBId === userId ? "B" : null;
  if (!side) return null;
  if (match.status !== "negotiating" && match.status !== "negotiating_venue") {
    return null;
  }
  if (!match.agreedTime) {
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
  return runVenueFinalizationOnce(matchId, () => finalizeMatchVenue(matchId));
}

async function finalizeMatchVenue(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userAId: true,
      userBId: true,
      status: true,
      agreedTime: true,
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
      userA: { select: { universityDomain: true } },
    },
  });
  if (!match || match.status !== "negotiating_venue") return;
  if (!match.agreedTime) return;
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

  // Curated-first: a hand-picked venue for this university wins; Places is the
  // fallback when nothing curated is in commute range. See `resolveVenue`.
  const venue = await resolveVenue({
    universityDomain: match.userA.universityDomain,
    midpoint: mid,
    originA: a,
    originB: b,
    radiusMeters,
    category: merged.category as VenueCategory,
    keywords: merged.keywords,
    agreedTime: match.agreedTime,
  });

  const committed = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating_venue" },
    data: {
      status: "scheduled",
      venueName: venue.name,
      venueAddress: venue.address,
      venueLat: mid.lat,
      venueLng: mid.lng,
      // Parity with the bot path: curated venues always carry a Maps URI.
      venueGoogleMapsUri: venue.googleMapsUri,
    },
  });
  if (committed.count === 0) return;

  // Pre-generate the asymmetric "Wingman" hints now so the T-1.5h lifecycle
  // tick has them cached. Fire-and-forget: a transient LLM outage here
  // doesn't block venue finalisation; the tick will retry via the same
  // idempotent service if either hint is still null at reveal time.
  generateAndSaveWingmanHints(matchId).catch((err) => {
    console.warn(`[wingman] generation failed for match ${matchId}:`, err);
  });

  await Promise.all([
    sendPushToUser(match.userAId, {
      title: "Venue locked in",
      body: `${venue.name} — tap for details.`,
      data: { type: "match.scheduled", matchId },
    }),
    sendPushToUser(match.userBId, {
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

  // M-1: classify Prisma errors specifically (only P2002 is a duplicate),
  // and keep Tier 2/3 moderation inside the same transaction as the report
  // row so retries never hit a phantom duplicate with no action applied.
  try {
    if (tier === 1) {
      await prisma.report.create({
        data: {
          reporterId: reporterUserId,
          reportedId: reportedUserId,
          matchId,
          rawText,
          tier,
          reasonSummary,
          adminReviewed: true,
        },
      });
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.report.create({
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
        await applyReportAction({
          tier,
          reporterUserId,
          reportedUserId,
          reasonSummary,
          language,
        }, tx);
      });
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return "duplicate";
    }
    // Anything else is a real failure — log + re-throw so the caller turns
    // it into a 500 instead of misreporting it as a 409 dup.
    console.error("[matches-service] submitMatchReport report.create failed:", err);
    throw err;
  }

  if (tier === 1) {
    try {
      await appendNegativeConstraint(reporterUserId, reasonSummary, language);
    } catch (err) {
      console.error(
        "[matches-service] submitMatchReport moderation action failed:",
        err,
      );
      throw err;
    }
  }
  return "ok";
}
