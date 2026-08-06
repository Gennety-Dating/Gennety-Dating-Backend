import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";

import { env } from "../config.js";
import { MATCH_COOLDOWN_MS, createProposedMatch } from "../services/match-engine.js";
import { ACTIVE_MATCH_STATUSES } from "../services/active-match-priority.js";
import { dispatchMatches } from "../services/dispatch-queue.js";
import { applyMatchDecision } from "../public/matches-service.js";
import { processCalendarSlotsUpdate } from "../handlers/matching/scheduler.js";
import {
  confirmVenueIntent,
  interpretVenueIntent,
  venueIntentMode,
} from "../services/venue-intent-v2.js";
import { tryFinalize } from "../handlers/matching/venue-negotiation.js";
import { useTicketFromBalance } from "../handlers/matching/ticket-gate.js";
import {
  getVenueChangeCatalog,
  isHeteroPair,
  payerSide,
  settleFreeVenueChange,
  submitVenueLikes,
  venueKeyOf,
  KEEP_KEY,
} from "../handlers/matching/venue-change.js";
import { runDateLifecycleTick } from "../services/date-lifecycle.js";

import {
  DEMO_PARTNERS,
  pickDemoPartner,
  releaseMatchCooldown,
  seedDemoPartners,
} from "./partners.js";
import { decideDemoAction, type DemoAction, type DemoMatchSnapshot, type DemoSnapshot } from "./decide.js";
import { demoContinueLabel, demoText, type DemoBeat } from "./script.js";

const LOG = "[demo]";

/**
 * The puppet, and the demo's own voice.
 *
 * Runs on a short `setInterval`. Every tick it re-derives what the visitor's
 * situation is, asks `decideDemoAction` what is owed, and performs it through
 * the same production service a real partner's client would call. It holds no
 * flow state of its own — see `decide.ts` for why that matters.
 *
 * The only in-memory state is bookkeeping that must not become a Prisma table:
 *
 *   - `spokenBeats` — which narration lines a visitor has already read. Losing
 *     it on restart repeats at most one explanatory message mid-demo, which is
 *     harmless; a schema change to production's shared `schema.prisma` for a
 *     demo-only concern would not be.
 *   - `pendingSince` — when the currently-owed action was first observed, which
 *     is what the "wait a beat before answering" delay is measured from. Using a
 *     row timestamp instead would be fragile: `Match.updatedAt` also moves for
 *     unrelated writes (the peer-wait worker stamps its own anchor).
 *   - `inFlight` — a visitor is never acted on twice concurrently. Actions here
 *     are multi-second (an LLM call, a venue selection, a card render) and the
 *     tick is 3s.
 */
const spokenBeats = new Map<string, Set<DemoBeat>>();
const pendingSince = new Map<string, { key: string; at: number }>();
const inFlight = new Set<string>();

/** Reset a visitor's in-memory bookkeeping (used by `/restart`). */
export function forgetDemoVisitor(userId: string): void {
  spokenBeats.delete(userId);
  pendingSince.delete(userId);
}

export interface DemoTickResult {
  scanned: number;
  acted: number;
  errors: number;
}

let partnersSeeded = false;

export async function demoDriverTick(api: Api<RawApi>): Promise<DemoTickResult> {
  const result: DemoTickResult = { scanned: 0, acted: 0, errors: 0 };

  if (!partnersSeeded) {
    await seedDemoPartners();
    partnersSeeded = true;
  }

  const partnerTelegramIds = DEMO_PARTNERS.map((p) => p.telegramId);
  const visitors = await prisma.user.findMany({
    where: {
      // Real Telegram accounts only. The puppets carry negative ids, so this
      // also guarantees the driver can never act "on behalf of" a puppet as if
      // it were a visitor.
      telegramId: { gt: 0n },
      status: { in: ["onboarding", "active", "paused"] },
    },
    select: { id: true, telegramId: true, language: true },
    take: 100,
  });

  for (const visitor of visitors) {
    result.scanned += 1;
    if (inFlight.has(visitor.id)) continue;

    try {
      const snapshot = await buildSnapshot(visitor.id, partnerTelegramIds);
      if (!snapshot) continue;

      const decision = decideDemoAction(snapshot);
      if (decision.action.kind === "none") {
        pendingSince.delete(visitor.id);
        continue;
      }

      if (!waitElapsed(visitor.id, decision.action, decision.waitMs)) continue;

      inFlight.add(visitor.id);
      try {
        await performAction(api, visitor.id, visitor.telegramId, snapshot, decision.action);
        result.acted += 1;
      } finally {
        inFlight.delete(visitor.id);
        pendingSince.delete(visitor.id);
      }
    } catch (err) {
      result.errors += 1;
      console.error(`${LOG} tick failed for ${visitor.id}:`, err);
    }
  }

  return result;
}

/**
 * True once the same action has been owed continuously for `waitMs`. A change
 * of action restarts the clock, so a visitor who acts mid-wait is answered
 * against their new state rather than the stale one.
 */
function waitElapsed(userId: string, action: DemoAction, waitMs: number): boolean {
  if (waitMs <= 0) return true;
  const key = actionKey(action);
  const now = Date.now();
  const pending = pendingSince.get(userId);
  if (!pending || pending.key !== key) {
    pendingSince.set(userId, { key, at: now });
    return false;
  }
  return now - pending.at >= waitMs;
}

function actionKey(action: DemoAction): string {
  return action.kind === "narrate" ? `narrate:${action.beat}` : action.kind;
}

// ── Snapshot ───────────────────────────────────────────────────────────────

async function buildSnapshot(
  userId: string,
  partnerTelegramIds: readonly bigint[],
): Promise<DemoSnapshot | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      language: true,
      status: true,
      onboardingStep: true,
      verificationStatus: true,
      gender: true,
      preference: true,
    },
  });
  if (!user) return null;

  const progress = await prisma.onboardingProgress.findUnique({
    where: { userId },
    select: { currentQuestion: true },
  });

  const match = await loadDemoMatch(userId, partnerTelegramIds);

  return {
    language: user.language,
    status: user.status,
    onboardingStep: user.onboardingStep,
    verificationStatus: user.verificationStatus,
    currentQuestion: progress?.currentQuestion ?? null,
    spokenBeats: spokenBeats.get(userId) ?? new Set<DemoBeat>(),
    match: match.live,
    awaitingContinueOffer: match.awaitingContinueOffer,
  };
}

const LIVE_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"] as const;

async function loadDemoMatch(
  userId: string,
  partnerTelegramIds: readonly bigint[],
): Promise<{ live: DemoMatchSnapshot | null; awaitingContinueOffer: boolean }> {
  const row = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      acceptedByA: true,
      acceptedByB: true,
      ticketStatus: true,
      ticketPaidA: true,
      ticketPaidB: true,
      proposedTimes: true,
      availableTimesA: true,
      availableTimesB: true,
      agreedTime: true,
      venueIntentA: true,
      venueIntentB: true,
      icebreakersSentAt: true,
      venueChangeStatus: true,
      venueChangeProposerId: true,
      venueLikesA: true,
      venueLikesB: true,
      userA: { select: { id: true, telegramId: true, gender: true } },
      userB: { select: { id: true, telegramId: true, gender: true } },
    },
  });
  if (!row) return { live: null, awaitingContinueOffer: false };

  const visitorSide = row.userAId === userId ? "A" : "B";
  const partner = visitorSide === "A" ? row.userB : row.userA;
  // Only pairs with a puppet are the demo's business. A demo database should
  // contain nothing else, but two visitors could in principle be paired by a
  // stray batch run, and the driver must not start puppeteering a real person.
  if (!partnerTelegramIds.includes(partner.telegramId)) {
    return { live: null, awaitingContinueOffer: false };
  }

  const isLive = (LIVE_STATUSES as readonly string[]).includes(row.status);
  if (!isLive) {
    // A finished match with a puppet means the visitor passed (or it expired).
    // Offer the way back rather than leaving the demo at a dead end.
    return { live: null, awaitingContinueOffer: true };
  }

  const own = <T>(a: T, b: T): T => (visitorSide === "A" ? a : b);
  const payer = payerSide({
    userA: { id: row.userA.id, gender: row.userA.gender },
    userB: { id: row.userB.id, gender: row.userB.gender },
    venueChangeProposerId: row.venueChangeProposerId,
  });

  return {
    awaitingContinueOffer: false,
    live: {
      id: row.id,
      status: row.status,
      visitorSide,
      visitorAccepted: own(row.acceptedByA, row.acceptedByB),
      partnerAccepted: own(row.acceptedByB, row.acceptedByA),
      ticketOpen: env.TICKET_FEATURE_ENABLED && row.ticketStatus !== "completed",
      visitorTicketPaid: own(row.ticketPaidA, row.ticketPaidB) !== null,
      partnerTicketPaid: own(row.ticketPaidB, row.ticketPaidA) !== null,
      proposedTimes: row.proposedTimes.map(iso),
      visitorSlots: own(row.availableTimesA, row.availableTimesB).map(iso),
      partnerSlots: own(row.availableTimesB, row.availableTimesA).map(iso),
      agreedTime: row.agreedTime,
      visitorVenueConfirmed: isConfirmedIntent(own(row.venueIntentA, row.venueIntentB)),
      partnerVenueConfirmed: isConfirmedIntent(own(row.venueIntentB, row.venueIntentA)),
      icebreakersSentAt: row.icebreakersSentAt,
      venueChangeStatus: row.venueChangeStatus,
      visitorLikeKeys: likeKeys(own(row.venueLikesA, row.venueLikesB)),
      partnerLikeKeys: likeKeys(own(row.venueLikesB, row.venueLikesA)),
      venueChangePayerIsPartner:
        payer !== null && payer !== visitorSide && isHeteroPair({
          userA: { id: row.userA.id, gender: row.userA.gender },
          userB: { id: row.userB.id, gender: row.userB.gender },
          venueChangeProposerId: row.venueChangeProposerId,
        }),
    },
  };
}

function iso(value: Date): string {
  return value.toISOString();
}

function isConfirmedIntent(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { state?: unknown }).state === "confirmed"
  );
}

function likeKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "object" && entry !== null
        ? (entry as { key?: unknown }).key
        : null,
    )
    .filter((key): key is string => typeof key === "string");
}

// ── Execution ──────────────────────────────────────────────────────────────

async function performAction(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  snapshot: DemoSnapshot,
  action: DemoAction,
): Promise<void> {
  const lang = snapshot.language;

  switch (action.kind) {
    case "narrate":
      await say(api, telegramId, demoText(action.beat, lang));
      markSpoken(userId, action.beat);
      return;

    case "pitch":
      await startDemoMatch(api, userId, telegramId, lang);
      return;

    case "offer_continue": {
      await say(api, telegramId, demoText("declined", lang), {
        reply_markup: new InlineKeyboard().text(
          demoContinueLabel(lang),
          "demo:continue",
        ),
      });
      // The offer is a one-shot: clear the finished rows so the next tick sees
      // "no match" rather than re-offering every 3 seconds. The visitor's tap
      // is what creates the new pitch (`handleDemoContinue`).
      await clearDemoMatches(userId);
      return;
    }

    case "partner_accept": {
      const partnerId = await partnerIdFor(snapshot.match!, userId);
      await applyMatchDecision(snapshot.match!.id, partnerId, "accept");
      return;
    }

    case "partner_pay_ticket": {
      const partnerTelegramId = await partnerTelegramIdFor(snapshot.match!, userId);
      const paid = await useTicketFromBalance(
        api,
        partnerTelegramId,
        snapshot.match!.id,
        "self",
      );
      if (!paid.ok) console.warn(`${LOG} puppet ticket settle failed: ${paid.reason}`);
      return;
    }

    case "partner_counter_slots":
    case "partner_converge_slots": {
      const partnerTelegramId = await partnerTelegramIdFor(snapshot.match!, userId);
      const picks =
        action.kind === "partner_counter_slots"
          ? action.slots
          : // Keep whatever the puppet already offered and add the visitor's
            // slot, so the calendar reads as "fine, let's do your time" rather
            // than the puppet silently abandoning its own availability.
            [...snapshot.match!.partnerSlots, ...action.slots];
      const res = await processCalendarSlotsUpdate(
        api,
        partnerTelegramId,
        snapshot.match!.id,
        picks,
      );
      if (!res.ok) console.warn(`${LOG} puppet calendar update failed: ${res.reason}`);
      return;
    }

    case "partner_venue": {
      await submitPuppetVenue(api, snapshot.match!, userId);
      return;
    }

    case "partner_counter_likes":
    case "partner_agree_likes": {
      await submitPuppetLikes(api, snapshot.match!, userId, action.kind);
      return;
    }

    case "partner_settle_venue_change": {
      const partnerTelegramId = await partnerTelegramIdFor(snapshot.match!, userId);
      const res = await settleFreeVenueChange(api, partnerTelegramId, snapshot.match!.id);
      if (!res.ok) console.warn(`${LOG} puppet venue-change settle failed: ${res.reason}`);
      return;
    }

    case "run_predate": {
      await say(api, telegramId, demoText("predate", lang));
      await replayDateLifecycle(api, snapshot.match!.agreedTime);
      return;
    }
  }
}

/**
 * Explain how matching works, then produce the first real match.
 *
 * `createProposedMatch` is the production allocator, so BOTH participants have
 * to be genuinely eligible — which is exactly the behaviour we want the demo to
 * exercise. It also stamps `lastMatchedAt` on both sides, hence the release
 * call covering the visitor as well as the puppet: neither may inherit the 24h
 * candidate cooldown, or the second pitch of the session never happens.
 */
async function startDemoMatch(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  lang: Language | null,
): Promise<void> {
  const visitor = await prisma.user.findUnique({
    where: { id: userId },
    select: { gender: true, preference: true },
  });
  if (!visitor) return;

  const definition = pickDemoPartner(visitor);
  const partner = await prisma.user.findUnique({
    where: { telegramId: definition.telegramId },
    select: { id: true },
  });
  if (!partner) {
    console.error(`${LOG} puppet ${definition.firstName} is not seeded — cannot pitch`);
    return;
  }

  await releaseMatchCooldown([userId, partner.id]);

  // Marked the moment it is sent, not after the pitch lands. This beat is the
  // one piece of narration delivered from inside an action rather than through
  // `decideNarration`, because it ends with "here is your profile 👇" and must
  // sit immediately above the card — a separate narrate tick would put
  // DEMO_STEP_WAIT_MS between the promise and the card. The cost of living
  // outside the normal path is that nothing else dedupes it: when
  // `createProposedMatch` refused (a puppet with no embedding), every 3-second
  // retry re-sent the whole explanation and the visitor collected seven copies
  // of it with no profile ever arriving.
  if (!spokenBeats.get(userId)?.has("matchmaking")) {
    await say(api, telegramId, demoText("matchmaking", lang));
    markSpoken(userId, "matchmaking");
  }

  // A plausible frozen breakdown so `match_score_logs` — and therefore the
  // agent's `explain_my_match` tool — has something real to describe when a
  // visitor asks "why her?". Neutral multipliers, strong compatibility.
  const match = await createProposedMatch(userId, partner.id, {
    explicit: 0.88,
    research: 0.79,
    league: 1,
    penalty: 0,
    agePref: 1,
    type: 1,
    embeddingDistance: 0.24,
    starvationBonus: 0,
  });
  if (!match) {
    console.error(
      `${LOG} createProposedMatch refused for visitor ${userId}: ` +
        (await explainRefusal(userId, partner.id)),
    );
    return;
  }
  const dispatch = await dispatchMatches(api, [match.id], 0);
  if (dispatch.failed > 0) {
    console.error(`${LOG} pitch dispatch failed:`, dispatch.errors);
  }
}

/**
 * Say WHY the allocator said no.
 *
 * `createProposedMatch` returns a bare `null` for every one of a dozen reasons —
 * correct for production, where the weekly batch simply moves on to the next
 * pair, and useless in a demo, where it means the visitor is watching a chat
 * that has stopped. The first time this fired it took reading
 * `loadEligibleUsersForIds` line by line to discover that the VISITOR was inside
 * the 24h candidate cooldown; the log had said only "refused".
 *
 * Re-derives the same predicates rather than sharing them: they live inside a
 * Prisma `where` in the allocator with no exported form, and the demo must not
 * grow a second copy that production is obliged to keep in sync. If this ever
 * reports "no obvious cause" the allocator has a filter this list has not
 * learned about — go read it. Runs only on the failure path, so it costs
 * nothing in the normal case.
 */
async function explainRefusal(visitorId: string, partnerId: string): Promise<string> {
  const reasons: string[] = [];

  const priorPair = await prisma.match.findFirst({
    where: {
      OR: [
        { userAId: visitorId, userBId: partnerId },
        { userAId: partnerId, userBId: visitorId },
      ],
    },
    select: { id: true, status: true },
  });
  if (priorPair) {
    reasons.push(
      `lifetime pair ban — these two already have match ${priorPair.id} (${priorPair.status}); ` +
        `the demo clears its own rows in clearDemoMatches()`,
    );
  }

  const cutoff = new Date(Date.now() - MATCH_COOLDOWN_MS);
  for (const [label, id] of [
    ["visitor", visitorId],
    ["puppet", partnerId],
  ] as const) {
    const row = await prisma.user.findUnique({
      where: { id },
      select: {
        status: true,
        onboardingStep: true,
        gender: true,
        preference: true,
        verificationStatus: true,
        verificationSkippedAt: true,
        profile: {
          select: {
            lastMatchedAt: true,
            embeddingDirty: true,
            homeCityKey: true,
            latitude: true,
            longitude: true,
          },
        },
        matchesAsA: { where: { status: { in: [...ACTIVE_MATCH_STATUSES] } }, select: { id: true } },
        matchesAsB: { where: { status: { in: [...ACTIVE_MATCH_STATUSES] } }, select: { id: true } },
      },
    });
    if (!row) {
      reasons.push(`${label} row is missing`);
      continue;
    }
    const verified =
      row.verificationStatus === "verified" ||
      (row.verificationStatus === "unverified" && row.verificationSkippedAt !== null);

    if (row.status !== "active") reasons.push(`${label} status=${row.status}`);
    if (row.onboardingStep !== "completed") reasons.push(`${label} onboardingStep=${row.onboardingStep}`);
    if (!row.gender || !row.preference) reasons.push(`${label} gender/preference not set`);
    if (!verified) reasons.push(`${label} verificationStatus=${row.verificationStatus}`);
    if (!row.profile) reasons.push(`${label} has no profile`);
    else {
      if (row.profile.embeddingDirty) reasons.push(`${label} embeddingDirty (no vector yet)`);
      if (!row.profile.homeCityKey) reasons.push(`${label} homeCityKey is null`);
      if (row.profile.latitude === null || row.profile.longitude === null) {
        reasons.push(`${label} has no saved city coordinates`);
      }
      const last = row.profile.lastMatchedAt;
      if (last && last >= cutoff) {
        reasons.push(
          `${label} is inside the ${Math.round(MATCH_COOLDOWN_MS / 3_600_000)}h candidate ` +
            `cooldown (lastMatchedAt=${last.toISOString()}) — releaseMatchCooldown() must cover BOTH sides`,
        );
      }
    }
    const live = [...row.matchesAsA, ...row.matchesAsB];
    if (live.length > 0) reasons.push(`${label} already occupies live match ${live[0]!.id}`);
  }

  return reasons.length > 0 ? reasons.join("; ") : "no obvious cause — read loadEligibleUsersForIds()";
}

/**
 * The puppet's half of venue negotiation.
 *
 * Goes through the same two calls the visitor's own Location Mini App makes —
 * interpret the free text into canonical chips, then confirm with a departure
 * origin — because the V2 finalizer reads confirmed intent snapshots from BOTH
 * sides and nothing else. Falls back to the legacy columns when V2 is not the
 * live path for this match, so the demo works under either rollout setting.
 */
async function submitPuppetVenue(
  api: Api<RawApi>,
  match: DemoMatchSnapshot,
  visitorId: string,
): Promise<void> {
  const partnerId = await partnerIdFor(match, visitorId);
  // A different part of central Kyiv from anywhere the visitor is likely to
  // drop their pin, so the concierge has a real midpoint to solve for.
  const origin = { lat: 50.4547, lng: 30.5238, address: "Золоті ворота, Київ" };
  const vibe = "тихое уютное кафе, где можно нормально поговорить";

  if (venueIntentMode(match.id) === "live") {
    const draft = await interpretVenueIntent(match.id, partnerId, vibe, origin);
    if (!draft) {
      console.warn(`${LOG} puppet venue interpret returned nothing`);
      return;
    }
    await confirmVenueIntent(
      match.id,
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

  // Legacy concierge path: write the side's columns, then let the existing
  // finalizer notice both sides are complete.
  const side = match.visitorSide === "A" ? "B" : "A";
  await prisma.match.update({
    where: { id: match.id },
    data:
      side === "A"
        ? { vibeTextA: vibe, vibeLatA: origin.lat, vibeLngA: origin.lng, vibeAddressA: origin.address }
        : { vibeTextB: vibe, vibeLatB: origin.lat, vibeLngB: origin.lng, vibeAddressB: origin.address },
  });
  await tryFinalize(api, match.id);
}

/**
 * The puppet's turn on the venue-change board (§3.7b).
 *
 * Two rounds on purpose. The first heart lands on a venue the visitor did NOT
 * pick, so they see a real counter-suggestion and the board behaves like the
 * shared activity it is meant to be. The second takes one of theirs, which is
 * what agrees the change.
 */
async function submitPuppetLikes(
  api: Api<RawApi>,
  match: DemoMatchSnapshot,
  visitorId: string,
  mode: "partner_counter_likes" | "partner_agree_likes",
): Promise<void> {
  const partnerTelegramId = await partnerTelegramIdFor(match, visitorId);

  let keys: string[];
  if (mode === "partner_agree_likes") {
    const visitorPick = match.visitorLikeKeys.find((key) => key !== KEEP_KEY);
    keys = [...match.partnerLikeKeys, visitorPick ?? match.visitorLikeKeys[0]!].filter(Boolean);
  } else {
    const catalog = await getVenueChangeCatalog(partnerTelegramId, match.id);
    if (!catalog.ok) {
      console.warn(`${LOG} puppet could not read venue catalog: ${catalog.reason}`);
      return;
    }
    const taken = new Set(match.visitorLikeKeys);
    const alternative = catalog.venues
      .map((venue) => venueKeyOf(venue))
      .find((key) => key !== KEEP_KEY && !taken.has(key));
    if (!alternative) return;
    keys = [alternative];
  }

  const res = await submitVenueLikes(api, partnerTelegramId, match.id, keys);
  if (!res.ok) console.warn(`${LOG} puppet like submission failed: ${res.reason}`);
}

/**
 * Play the days before the date, now.
 *
 * `runDateLifecycleTick` takes an injected clock and every step claims its own
 * idempotency column, so shifting `now` to each gate is enough to fire the real
 * ice-breakers, the emergency window, the safety brief, the wingman hint and
 * the feedback prompt in order. No demo-specific lifecycle code exists.
 */
async function replayDateLifecycle(
  api: Api<RawApi>,
  agreedTime: Date | null,
): Promise<void> {
  if (!agreedTime) return;
  const at = agreedTime.getTime();
  const gates = [
    at - 2 * 60 * 60 * 1000, // T-2h  → ice-breakers + emergency window
    at - 30 * 60 * 1000, // T-30m → wingman reveal + safety brief
    at + 25 * 60 * 60 * 1000, // T+25h → feedback prompt
  ];
  for (const gate of gates) {
    await runDateLifecycleTick(api, new Date(gate));
    await sleep(4_000);
  }
}

// ── Recovery ───────────────────────────────────────────────────────────────

/**
 * "Show me that profile again" after a pass.
 *
 * Deletes the terminal rows first: `createProposedMatch` enforces the lifetime
 * pair ban (§3.2 filter 6), and that rule is correct — so rather than adding a
 * demo bypass inside the allocator, the demo removes its own history. Nothing
 * else in the database refers to those rows.
 */
export async function restartDemoPitch(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  language: Language | null,
): Promise<void> {
  await clearDemoMatches(userId);
  await startDemoMatch(api, userId, telegramId, language);
}

/** Wipe every match this visitor has had with a puppet. */
export async function clearDemoMatches(userId: string): Promise<void> {
  const partnerIds = await prisma.user.findMany({
    where: { telegramId: { in: DEMO_PARTNERS.map((p) => p.telegramId) } },
    select: { id: true },
  });
  const ids = partnerIds.map((p) => p.id);
  if (ids.length === 0) return;

  await prisma.match.deleteMany({
    where: {
      OR: [
        { userAId: userId, userBId: { in: ids } },
        { userBId: userId, userAId: { in: ids } },
      ],
    },
  });
  await releaseMatchCooldown([userId, ...ids]);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function markSpoken(userId: string, beat: DemoBeat): void {
  const set = spokenBeats.get(userId) ?? new Set<DemoBeat>();
  set.add(beat);
  spokenBeats.set(userId, set);
}

/** Mark a beat as already delivered without sending it (used by `/start`). */
export function noteDemoBeatSpoken(userId: string, beat: DemoBeat): void {
  markSpoken(userId, beat);
}

async function partnerIdFor(match: DemoMatchSnapshot, visitorId: string): Promise<string> {
  const row = await prisma.match.findUniqueOrThrow({
    where: { id: match.id },
    select: { userAId: true, userBId: true },
  });
  return row.userAId === visitorId ? row.userBId : row.userAId;
}

async function partnerTelegramIdFor(
  match: DemoMatchSnapshot,
  visitorId: string,
): Promise<bigint> {
  const partnerId = await partnerIdFor(match, visitorId);
  const row = await prisma.user.findUniqueOrThrow({
    where: { id: partnerId },
    select: { telegramId: true },
  });
  return row.telegramId;
}

async function say(
  api: Api<RawApi>,
  telegramId: bigint,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await api.sendMessage(Number(telegramId), text, extra);
  } catch (err) {
    console.warn(`${LOG} could not message ${telegramId}:`, err);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
