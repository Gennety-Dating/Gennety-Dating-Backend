import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { ACTIVE_MATCH_STATUSES } from "../services/active-match-priority.js";
import {
  APP_REVIEW_PARTNER_TELEGRAM_ID,
  APP_REVIEW_REVIEWER_TELEGRAM_ID,
  ensureAppReviewPartner,
  ensureAppReviewTickets,
  isAppReviewEnabled,
} from "../services/app-review.js";
import { createProposedMatch } from "../services/match-engine.js";
import { dispatchMatches } from "../services/dispatch-queue.js";
import { applyMatchDecision } from "../public/matches-service.js";
import { useTicketFromBalance } from "../handlers/matching/ticket-gate.js";
import { processCalendarSlotsUpdate } from "../handlers/matching/scheduler.js";
import {
  confirmVenueIntent,
  interpretVenueIntent,
  venueIntentMode,
} from "../services/venue-intent-v2.js";
import { tryFinalize } from "../handlers/matching/venue-negotiation.js";
import { isVenueOriginRefusal } from "../services/venue-origin.js";
import { refreshUserEmbedding } from "./embedding-refresh.js";

/**
 * The stand-in partner for the App Store review account (founder decision
 * 2026-10-15, `services/app-review.ts`).
 *
 * The production twin of the demo driver's puppet, cut down to the moves a
 * reviewer needs: say yes, settle its half of the date ticket, take the
 * reviewer's time slot, give a departure point. Every move goes through the
 * same production function a real partner's tap would reach, so the reviewer
 * sees the real product, not a mock of it.
 *
 * It only ever acts on a match between the two review accounts. A finished
 * pair is replaced by a fresh one after `APP_REVIEW_RESTART_DELAY_MS`, so a
 * reviewer who declined, let it expire, or cancelled the date always has
 * something to look at again.
 */

export const APP_REVIEW_TICK_SCHEDULE = "*/20 * * * * *";
export const APP_REVIEW_RESTART_DELAY_MS = 2 * 60 * 1000;

export interface AppReviewLiveMatch {
  status: string;
  reviewerAccepted: boolean | null;
  partnerAccepted: boolean | null;
  ticketOpen: boolean;
  reviewerTicketPaid: boolean;
  partnerTicketPaid: boolean;
  proposedTimes: string[];
  reviewerSlots: string[];
  partnerSlots: string[];
  reviewerVenueDone: boolean;
  partnerVenueDone: boolean;
}

export type AppReviewAction =
  | { kind: "none" }
  | { kind: "start_match" }
  | { kind: "partner_accept" }
  | { kind: "partner_pay_ticket" }
  | { kind: "partner_slots"; slots: string[] }
  | { kind: "partner_venue" };

const NONE: AppReviewAction = { kind: "none" };

/** Pure: what the stand-in should do next. Unit-tested. */
export function decideAppReviewAction(
  live: AppReviewLiveMatch | null,
  lastEndedAt: Date | null,
  now: Date,
): AppReviewAction {
  if (!live) {
    if (lastEndedAt && now.getTime() - lastEndedAt.getTime() < APP_REVIEW_RESTART_DELAY_MS) {
      return NONE;
    }
    return { kind: "start_match" };
  }

  switch (live.status) {
    case "proposed":
      // After the reviewer's own answer, never before: the partner's decision
      // must not be on record while theirs is still open (blind invariant).
      return live.reviewerAccepted !== null && live.partnerAccepted === null
        ? { kind: "partner_accept" }
        : NONE;

    case "negotiating": {
      if (live.proposedTimes.length === 0) {
        // Only once the reviewer has paid, so "pay for both" stays theirs to choose.
        return live.ticketOpen && live.reviewerTicketPaid && !live.partnerTicketPaid
          ? { kind: "partner_pay_ticket" }
          : NONE;
      }
      if (live.reviewerSlots.length === 0) return NONE;
      const overlap = live.reviewerSlots.some((slot) => live.partnerSlots.includes(slot));
      if (overlap) return NONE;
      // Keep anything the partner already offered and take the reviewer's first.
      return { kind: "partner_slots", slots: [...live.partnerSlots, live.reviewerSlots[0]!] };
    }

    case "negotiating_venue":
      return live.reviewerVenueDone && !live.partnerVenueDone ? { kind: "partner_venue" } : NONE;

    default:
      return NONE;
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────

const LOG = "[app-review]";
const FAILURE_LOG_INTERVAL_MS = 10 * 60 * 1000;
const lastFailureLog = new Map<string, number>();
let inFlight = false;

function noteFailure(key: string, detail: unknown): void {
  const now = Date.now();
  if (now - (lastFailureLog.get(key) ?? 0) < FAILURE_LOG_INTERVAL_MS) return;
  lastFailureLog.set(key, now);
  console.warn(`${LOG} ${key}:`, detail);
}

export async function appReviewPartnerTick(api: Api<RawApi>): Promise<void> {
  if (!isAppReviewEnabled() || inFlight) return;
  inFlight = true;
  try {
    await runTick(api);
  } catch (err) {
    noteFailure("tick", err);
  } finally {
    inFlight = false;
  }
}

async function runTick(api: Api<RawApi>): Promise<void> {
  // The reviewer row exists only after a review sign-in; until then there is
  // nobody to pair.
  const reviewer = await prisma.user.findUnique({
    where: { telegramId: APP_REVIEW_REVIEWER_TELEGRAM_ID },
    select: { id: true, onboardingStep: true },
  });
  if (!reviewer) return;
  const partner = await prisma.user.findUnique({
    where: { telegramId: APP_REVIEW_PARTNER_TELEGRAM_ID },
    select: { id: true },
  });

  const latest = partner
    ? await prisma.match.findFirst({
        where: {
          OR: [
            { userAId: reviewer.id, userBId: partner.id },
            { userAId: partner.id, userBId: reviewer.id },
          ],
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          userAId: true,
          acceptedByA: true,
          acceptedByB: true,
          ticketStatus: true,
          ticketPaidA: true,
          ticketPaidB: true,
          proposedTimes: true,
          availableTimesA: true,
          availableTimesB: true,
          venueIntentA: true,
          venueIntentB: true,
          vibeTextA: true,
          vibeTextB: true,
        },
      })
    : null;

  const isLive = latest !== null && ACTIVE_MATCH_STATUSES.includes(latest.status);
  const reviewerIsA = latest?.userAId === reviewer.id;
  const own = <T>(a: T, b: T): T => (reviewerIsA ? a : b);
  const legacyVenue = latest ? venueIntentMode(latest.id) !== "live" : false;

  const live: AppReviewLiveMatch | null =
    latest && isLive
      ? {
          status: latest.status,
          reviewerAccepted: own(latest.acceptedByA, latest.acceptedByB),
          partnerAccepted: own(latest.acceptedByB, latest.acceptedByA),
          ticketOpen: env.TICKET_FEATURE_ENABLED && latest.ticketStatus !== "completed",
          reviewerTicketPaid: own(latest.ticketPaidA, latest.ticketPaidB) !== null,
          partnerTicketPaid: own(latest.ticketPaidB, latest.ticketPaidA) !== null,
          proposedTimes: latest.proposedTimes.map((d) => d.toISOString()),
          reviewerSlots: own(latest.availableTimesA, latest.availableTimesB).map((d) =>
            d.toISOString(),
          ),
          partnerSlots: own(latest.availableTimesB, latest.availableTimesA).map((d) =>
            d.toISOString(),
          ),
          reviewerVenueDone: legacyVenue
            ? own(latest.vibeTextA, latest.vibeTextB) !== null
            : isConfirmedIntent(own(latest.venueIntentA, latest.venueIntentB)),
          partnerVenueDone: legacyVenue
            ? own(latest.vibeTextB, latest.vibeTextA) !== null
            : isConfirmedIntent(own(latest.venueIntentB, latest.venueIntentA)),
        }
      : null;

  // A reviewer still in onboarding (e.g. right after re-creation) is not shown
  // a pitch yet; the sign-in path normally leaves them `completed`.
  if (!live && reviewer.onboardingStep !== "completed") return;

  const action = decideAppReviewAction(live, latest && !isLive ? latest.updatedAt : null, new Date());
  if (action.kind === "none") return;

  if (action.kind === "start_match") {
    await startReviewMatch(api, reviewer.id);
    return;
  }

  const match = latest!;
  const partnerId = partner!.id;
  switch (action.kind) {
    case "partner_accept": {
      const decided = await applyMatchDecision(match.id, partnerId, "accept");
      if (!decided) noteFailure("partner_accept", "decision refused");
      return;
    }
    case "partner_pay_ticket": {
      await ensureAppReviewTickets(partnerId, 1);
      const paid = await useTicketFromBalance(api, APP_REVIEW_PARTNER_TELEGRAM_ID, match.id, "self");
      if (!paid.ok) noteFailure("partner_pay_ticket", paid.reason);
      return;
    }
    case "partner_slots": {
      const res = await processCalendarSlotsUpdate(
        api,
        APP_REVIEW_PARTNER_TELEGRAM_ID,
        match.id,
        action.slots,
      );
      if (!res.ok) noteFailure("partner_slots", res.reason);
      return;
    }
    case "partner_venue":
      await submitPartnerVenue(api, match.id, partnerId, reviewerIsA ? "B" : "A", legacyVenue);
      return;
  }
}

/**
 * Fresh pair through the production allocator. The previous review-pair rows
 * are removed first: the lifetime pair ban (§3.2 filter 6) is right for people
 * and meaningless for a stage pair, and the demo already handles its own
 * history the same way (`demo/driver.ts` → `clearDemoMatches`).
 */
async function startReviewMatch(api: Api<RawApi>, reviewerId: string): Promise<void> {
  const partner = await ensureAppReviewPartner();
  await prisma.match.deleteMany({
    where: {
      status: { notIn: [...ACTIVE_MATCH_STATUSES] },
      OR: [
        { userAId: reviewerId, userBId: partner.id },
        { userAId: partner.id, userBId: reviewerId },
      ],
    },
  });
  await prisma.profile.updateMany({
    where: { userId: { in: [reviewerId, partner.id] } },
    data: { lastMatchedAt: null, calibrationUntil: null },
  });
  await ensureAppReviewTickets(reviewerId);

  // Matching requires a vector even for a pair named explicitly; a fresh or
  // edited profile is dirty until the refresher runs.
  const stale = await prisma.profile.findMany({
    where: { userId: { in: [reviewerId, partner.id] }, embeddingDirty: true },
    select: { userId: true },
  });
  for (const { userId } of stale) {
    await refreshUserEmbedding(userId).catch((err: unknown) => noteFailure("embedding", err));
  }

  const match = await createProposedMatch(reviewerId, partner.id, {
    explicit: 0.88,
    research: 0.79,
    league: 1,
    penalty: 0,
    agePref: 1,
    type: 1,
    intent: 1,
    rhythm: 1,
    rhythmSimilarity: null,
    embeddingDistance: 0.24,
    starvationBonus: 0,
  });
  if (!match) {
    noteFailure("start_match", "createProposedMatch refused (embedding? reviewer edited out of eligibility?)");
    return;
  }
  const dispatch = await dispatchMatches(api, [match.id], 0);
  if (dispatch.failed > 0) noteFailure("dispatch", dispatch.errors);
}

/** Same two paths as the demo puppet (`demo/driver.ts` → `submitPuppetVenue`). */
async function submitPartnerVenue(
  api: Api<RawApi>,
  matchId: string,
  partnerId: string,
  partnerSide: "A" | "B",
  legacy: boolean,
): Promise<void> {
  const origin = { lat: 50.4547, lng: 30.5238, address: "Golden Gate, Kyiv" };
  const vibe = "a quiet cosy café where we can actually talk";

  if (!legacy) {
    const draft = await interpretVenueIntent(matchId, partnerId, vibe, origin);
    if (isVenueOriginRefusal(draft)) {
      noteFailure("partner_venue", `origin outside ${draft.market.city}`);
      return;
    }
    if (!draft) {
      noteFailure("partner_venue", "interpret returned nothing");
      return;
    }
    await confirmVenueIntent(
      matchId,
      partnerId,
      {
        experiences: draft.experiences,
        ambiences: draft.ambiences,
        formats: draft.formats,
        hardConstraints: draft.hardConstraints,
        origin,
      },
      { awaitFinalization: false },
    );
    return;
  }

  await prisma.match.update({
    where: { id: matchId },
    data:
      partnerSide === "A"
        ? { vibeTextA: vibe, vibeLatA: origin.lat, vibeLngA: origin.lng, vibeAddressA: origin.address }
        : { vibeTextB: vibe, vibeLatB: origin.lat, vibeLngB: origin.lng, vibeAddressB: origin.address },
  });
  await tryFinalize(api, matchId);
}

function isConfirmedIntent(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { state?: unknown }).state === "confirmed"
  );
}
