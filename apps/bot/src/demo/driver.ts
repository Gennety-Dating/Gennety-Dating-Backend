import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import type { MatchStatus } from "@gennety/db";
import { t, type Language } from "@gennety/shared";

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
import { isVenueOriginRefusal } from "../services/venue-origin.js";
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
import { runCoordinationTick } from "../services/coordination.js";
import { sendCoordCard } from "../services/coordination-card/send.js";
import type { CoordCardTheme } from "../services/coordination-card/index.js";
import { relayProxyMessage } from "../services/proxy-chat.js";

import { createFailureTracker } from "./failure-tracker.js";
import { composeProxyReply, type ProxyReplyTurn } from "./proxy-partner.js";

import {
  DEMO_PARTNERS,
  ensureFreshEmbeddings,
  ensurePuppetTicket,
  pickDemoPartner,
  releaseMatchCooldown,
  seedDemoPartners,
} from "./partners.js";
import {
  decideDemoAction,
  offerableEnding,
  type DemoAction,
  type DemoMatchSnapshot,
  type DemoSnapshot,
} from "./decide.js";
import {
  DEMO_AFTER_DATE_CALLBACK,
  DEMO_CONTINUE_CALLBACK,
  DEMO_PREDATE_CALLBACK,
  demoAfterDateLabel,
  demoContinueLabel,
  demoCoordCallback,
  demoPredateLabel,
  demoText,
  type DemoBeat,
  type DemoCoordChoice,
} from "./script.js";

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
 *   - `redoOffered` — the finished match a visitor has already been offered a
 *     way back from, so the offer is made once per ending rather than once per
 *     tick. Keyed by match id, so a later ending gets its own offer with no
 *     bookkeeping to reset. Losing it on restart is NOT harmless the way the
 *     others are — a terminal match is terminal forever, so the closing message
 *     would go out again after every restart — which is why the ending also has
 *     to be fresh (`DEMO_ENDING_OFFER_MAX_AGE_MS`).
 */
const spokenBeats = new Map<string, Set<DemoBeat>>();
const pendingSince = new Map<string, { key: string; at: number }>();
const inFlight = new Set<string>();
const redoOffered = new Map<string, string>();
/**
 * Which of the two impossible coordination variants a visitor has already had
 * explained (§Phase 4 fork).
 *
 * The only piece of demo state here that genuinely cannot be derived: tapping
 * "share my Telegram" or "ask for theirs" writes NOTHING to the match — that is
 * the point, it leaves the fork open — so the product carries no trace of it.
 * Used purely to thin the re-offer keyboard; losing it on restart shows a button
 * that has already been read, which is the cheapest possible failure.
 */
const coordExplained = new Map<string, Set<DemoCoordChoice>>();

/**
 * How many times the same action may be refused before the demo stops trying
 * and says so.
 *
 * Three, at `DEMO_STEP_WAIT_MS` apart, is a little over half a minute — long
 * enough to ride out a transient provider hiccup, short enough that nobody is
 * left staring at a chat that has quietly stopped. The alternative is what
 * shipped: a refusal logged and retried every tick forever, which is how
 * `puppet ticket settle failed: insufficient-balance` reached 1500 identical
 * lines while a visitor sat in front of a demo that had died.
 */
const DEMO_MAX_ACTION_FAILURES = 3;
const failures = createFailureTracker(DEMO_MAX_ACTION_FAILURES);

/** Reset a visitor's in-memory bookkeeping (used by `/restart`). */
export function forgetDemoVisitor(userId: string): void {
  spokenBeats.delete(userId);
  pendingSince.delete(userId);
  redoOffered.delete(userId);
  coordExplained.delete(userId);
  failures.clear(userId);
}

/**
 * What a puppet move did. `reason` is for the log, never for the visitor —
 * `insufficient-balance` is not something a person can act on.
 */
export type DemoActionOutcome = { ok: true } | { ok: false; reason: string };

const ACTED: DemoActionOutcome = { ok: true };

function refused(reason: string): DemoActionOutcome {
  return { ok: false, reason };
}

/**
 * Forget the beats that belong to ONE run through the flow.
 *
 * Called whenever a new match is created, so a second pass (after "show me
 * another profile") gets its own date-card handover and its own pre-date
 * replay. The beats that explain the product rather than a match — the intro,
 * the photo and verification notes, how matchmaking works — are deliberately
 * left alone: they were true the first time and repeating them is noise.
 */
function forgetMatchBeats(userId: string): void {
  coordExplained.delete(userId);
  const set = spokenBeats.get(userId);
  if (!set) return;
  set.delete("date_ready");
  set.delete("predate");
  set.delete("coord_offer");
  set.delete("chat_open");
  set.delete("after_date");
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
      const snapshot = await buildSnapshot(visitor.id, visitor.telegramId, partnerTelegramIds);
      if (!snapshot) continue;

      const decision = decideDemoAction(snapshot);
      if (decision.action.kind === "none") {
        pendingSince.delete(visitor.id);
        failures.clear(visitor.id);
        continue;
      }

      // Already given up on this exact action: the visitor has been told, and
      // hammering a service that has refused three times helps nobody.
      if (failures.abandoned(visitor.id, actionKey(decision.action))) continue;

      if (!waitElapsed(visitor.id, decision.action, decision.waitMs)) continue;

      inFlight.add(visitor.id);
      try {
        // A throw is counted exactly like a refusal. Letting it reach the outer
        // catch would leave the streak at zero, so a step that reliably throws
        // would retry forever and never reach the give-up below — which is the
        // very failure mode this block exists to end.
        const outcome = await performAction(
          api,
          visitor.id,
          visitor.telegramId,
          snapshot,
          decision.action,
        ).catch((err: unknown) =>
          refused(`threw:${err instanceof Error ? err.message : String(err)}`),
        );
        if (outcome.ok) {
          result.acted += 1;
          failures.clear(visitor.id);
        } else {
          result.errors += 1;
          const streak = failures.note(visitor.id, actionKey(decision.action));
          // One line per streak, not one per tick — the whole point is that a
          // flood of identical warnings is indistinguishable from noise.
          if (streak === DEMO_MAX_ACTION_FAILURES) {
            console.error(
              `${LOG} giving up on ${actionKey(decision.action)} for visitor ` +
                `${visitor.id} after ${streak} refusals: ${outcome.reason}`,
            );
            await say(api, visitor.telegramId, demoText("stuck", snapshot.language));
          }
        }
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
  telegramId: bigint,
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
    awaitingPhotoUpload: await isAwaitingPhotoUpload(telegramId),
    spokenBeats: spokenBeats.get(userId) ?? new Set<DemoBeat>(),
    match: match.live,
    finishedMatch: offerableEnding(match.finished, redoOffered.get(userId), Date.now()),
    hasEverMatched: match.hasEverMatched,
  };
}

/**
 * Is the bot currently waiting for the visitor's profile photos?
 *
 * Read from the grammY session store rather than from a column, because that is
 * where the answer lives: `expectingPhoto` is set from the agent's own turn
 * result at every site that asks for photos (`handlers/onboarding/conversational.ts`,
 * and `sessionPatchAfterRadar` on the Type Radar resume paths). Session keys are
 * the chat id, which for a private chat is the Telegram id.
 *
 * Absent/unparsable session ⇒ false: the note it gates is worth skipping rather
 * than mistiming, and the visitor is told the same thing by the intro anyway.
 */
async function isAwaitingPhotoUpload(telegramId: bigint): Promise<boolean> {
  const row = await prisma.botSession.findUnique({
    where: { key: String(telegramId) },
    select: { data: true },
  });
  const data = row?.data;
  if (typeof data !== "object" || data === null) return false;
  return (data as { expectingPhoto?: unknown }).expectingPhoto === true;
}

const LIVE_STATUSES = ["proposed", "negotiating", "negotiating_venue", "scheduled"] as const;

interface DemoMatchLookup {
  live: DemoMatchSnapshot | null;
  /**
   * The most recent puppet match, once it is terminal. `endedAt` is the row's
   * `updatedAt`, which for a terminal match is when it went terminal: nothing
   * writes to one afterwards (the peer-wait worker only ever stamps live rows).
   */
  finished: { id: string; status: MatchStatus; endedAt: Date } | null;
  /** Any puppet match at all — see `DemoSnapshot.hasEverMatched`. */
  hasEverMatched: boolean;
}

const NO_MATCH: DemoMatchLookup = { live: null, finished: null, hasEverMatched: false };

async function loadDemoMatch(
  userId: string,
  partnerTelegramIds: readonly bigint[],
): Promise<DemoMatchLookup> {
  const row = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      updatedAt: true,
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
      coordMethod: true,
      proxyOpenedAt: true,
      proxyClosedAt: true,
      venueChangeStatus: true,
      venueChangeProposerId: true,
      venueLikesA: true,
      venueLikesB: true,
      userA: { select: { id: true, telegramId: true, gender: true } },
      userB: { select: { id: true, telegramId: true, gender: true } },
    },
  });
  if (!row) return NO_MATCH;

  const visitorSide = row.userAId === userId ? "A" : "B";
  const partner = visitorSide === "A" ? row.userB : row.userA;
  // Only pairs with a puppet are the demo's business. A demo database should
  // contain nothing else, but two visitors could in principle be paired by a
  // stray batch run, and the driver must not start puppeteering a real person.
  if (!partnerTelegramIds.includes(partner.telegramId)) return NO_MATCH;

  const isLive = (LIVE_STATUSES as readonly string[]).includes(row.status);
  if (!isLive) {
    // Terminal: the visitor passed, the window expired, or the demo ran all the
    // way through to the post-date feedback (which is what flips a `scheduled`
    // row to `completed`). Which of those it was decides what the demo says
    // next, so the status travels with it.
    return {
      live: null,
      finished: { id: row.id, status: row.status, endedAt: row.updatedAt },
      hasEverMatched: true,
    };
  }

  const own = <T>(a: T, b: T): T => (visitorSide === "A" ? a : b);
  const relay = await loadProxyRelayState(row.id, userId);
  const payer = payerSide({
    userA: { id: row.userA.id, gender: row.userA.gender },
    userB: { id: row.userB.id, gender: row.userB.gender },
    venueChangeProposerId: row.venueChangeProposerId,
  });

  return {
    finished: null,
    hasEverMatched: true,
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
      coordMethod: row.coordMethod,
      proxyState:
        row.proxyOpenedAt === null ? "none" : row.proxyClosedAt === null ? "open" : "closed",
      proxyLastSender: relay.lastSender,
      proxyPartnerMessageCount: relay.partnerCount,
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

/**
 * Who spoke last in the anonymous relay, and how much the puppet has already
 * said.
 *
 * Read from `proxy_messages` — the production log every relayed message lands in
 * — rather than tracked in memory, so the puppet's turn survives a restart and
 * the demo cannot double-answer. Two cheap queries instead of one aggregate:
 * both are indexed by `matchId` and the table holds a handful of rows per match.
 */
async function loadProxyRelayState(
  matchId: string,
  visitorId: string,
): Promise<{ lastSender: "visitor" | "partner" | null; partnerCount: number }> {
  const [last, partnerCount] = await Promise.all([
    prisma.proxyMessage.findFirst({
      where: { matchId },
      orderBy: { createdAt: "desc" },
      select: { senderId: true },
    }),
    prisma.proxyMessage.count({ where: { matchId, senderId: { not: visitorId } } }),
  ]);
  return {
    lastSender: last === null ? null : last.senderId === visitorId ? "visitor" : "partner",
    partnerCount,
  };
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
  // `none` is filtered by the caller, and saying so in the type is what makes
  // the switch below provably exhaustive — otherwise a future action kind added
  // to `DemoAction` would fall through and be counted as a successful move.
  action: Exclude<DemoAction, { kind: "none" }>,
): Promise<DemoActionOutcome> {
  const lang = snapshot.language;

  switch (action.kind) {
    case "narrate":
      await say(api, telegramId, demoText(action.beat, lang), beatKeyboard(action.beat, lang));
      markSpoken(userId, action.beat);
      return ACTED;

    case "pitch":
      return startDemoMatch(api, userId, telegramId, lang);

    case "offer_continue": {
      await say(api, telegramId, demoText(action.beat, lang), {
        reply_markup: new InlineKeyboard().text(
          demoContinueLabel(action.beat, lang),
          DEMO_CONTINUE_CALLBACK,
        ),
      });
      // Record the ending rather than deleting it. Deleting was how the demo
      // used to make the offer one-shot, and it also erased the only evidence
      // that this visitor had ever matched — so the next tick read the empty
      // state as "the demo has not started" and pitched a fresh profile twelve
      // seconds later, whether or not the button was touched. The rows now stay
      // until the tap, which is the only thing that may start a second run.
      redoOffered.set(userId, action.matchId);
      return ACTED;
    }

    case "partner_accept": {
      const partnerId = await partnerIdFor(snapshot.match!, userId);
      // `applyMatchDecision` answers `null` rather than throwing when the row is
      // no longer `proposed`. That return used to be dropped on the floor, so a
      // refusal here looked exactly like a successful accept and the driver
      // re-tried it every tick — the same shape as the ticket-gate stall.
      const decided = await applyMatchDecision(snapshot.match!.id, partnerId, "accept");
      return decided ? ACTED : refused("decision-refused");
    }

    case "partner_pay_ticket": {
      const partnerId = await partnerIdFor(snapshot.match!, userId);
      const partnerTelegramId = await partnerTelegramIdFor(snapshot.match!, userId);
      // Top up FIRST. `useTicketFromBalance` is the production wallet path and
      // it refuses at zero — which is where a seeded puppet starts, so a visitor
      // who paid only for themselves watched the demo stop dead: every tick
      // logged `insufficient-balance`, the gate never completed, and the
      // Calendar was never sent. There is no second person to chase, so the
      // demo owes the visitor the other half of the gate.
      await ensurePuppetTicket(partnerId);
      const paid = await useTicketFromBalance(
        api,
        partnerTelegramId,
        snapshot.match!.id,
        "self",
      );
      return paid.ok ? ACTED : refused(`ticket-settle:${paid.reason}`);
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
      return res.ok ? ACTED : refused(`calendar:${res.reason}`);
    }

    case "partner_venue":
      return submitPuppetVenue(api, snapshot.match!, userId);

    case "partner_counter_likes":
    case "partner_agree_likes":
      return submitPuppetLikes(api, snapshot.match!, userId, action.kind);

    case "partner_settle_venue_change": {
      const partnerTelegramId = await partnerTelegramIdFor(snapshot.match!, userId);
      const res = await settleFreeVenueChange(api, partnerTelegramId, snapshot.match!.id);
      return res.ok ? ACTED : refused(`venue-change-settle:${res.reason}`);
    }

    case "run_predate":
      return runDemoPredate(
        api,
        userId,
        telegramId,
        lang,
        snapshot.match!.id,
        snapshot.match!.agreedTime,
      );

    case "coord_offer": {
      const sent = await sendDemoCoordOffer(api, userId, telegramId, snapshot.match!);
      if (sent.ok) markSpoken(userId, "coord_offer");
      return sent;
    }

    case "coord_pick_proxy":
      return chooseDemoProxy(
        api,
        userId,
        telegramId,
        lang,
        snapshot.match!.id,
        snapshot.match!.agreedTime,
      );

    case "partner_proxy_reply":
      return sendPuppetProxyMessage(userId, snapshot.match!);

    case "run_after_date":
      return runDemoAfterDate(
        api,
        userId,
        telegramId,
        lang,
        snapshot.match!.id,
        snapshot.match!.agreedTime,
      );
  }
}

/**
 * The two beats that end with something to press.
 *
 * Both are "here is a screen, go touch it" moments where the button is the
 * intended path and the driver's own timer is only the floor under a visitor who
 * never taps — so neither may be the ONLY way forward.
 */
function beatKeyboard(beat: DemoBeat, lang: Language | null): Record<string, unknown> {
  if (beat === "date_ready") {
    return {
      reply_markup: new InlineKeyboard().text(demoPredateLabel(lang), DEMO_PREDATE_CALLBACK),
    };
  }
  if (beat === "chat_open") {
    return {
      reply_markup: new InlineKeyboard().text(demoAfterDateLabel(lang), DEMO_AFTER_DATE_CALLBACK),
    };
  }
  return {};
}

/**
 * Explain the days before the date, then play them out.
 *
 * Reached two ways — the visitor taps «Что происходит дальше», or the
 * exploration window runs out — so the beat marker is claimed BEFORE any of it
 * runs. The lifecycle steps are individually idempotent, but the narration is
 * an ordinary message and a tap landing a moment before the timer would
 * otherwise send it twice.
 */
export async function runDemoPredate(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  lang: Language | null,
  matchId: string,
  agreedTime: Date | null,
): Promise<DemoActionOutcome> {
  if (spokenBeats.get(userId)?.has("predate")) return ACTED;
  markSpoken(userId, "predate");

  await say(api, telegramId, demoText("predate", lang));
  try {
    await replayGates(api, PRE_DATE_GATES, agreedTime);
  } catch (err) {
    // The claim above is NOT released: the narration has already gone out, and
    // re-running would promise the pre-date days a second time. What must not
    // happen is silence — the visitor has just been told "I'll play all of it
    // now", so a half-played replay is reported rather than swallowed.
    return refused(`predate-replay:${err instanceof Error ? err.message : String(err)}`);
  }
  return ACTED;
}

/**
 * The visitor pressed one of the two variants that cannot work here.
 *
 * Nothing is written: `coordMethod` stays null, so the fork stays open and the
 * driver keeps holding. That is the whole mechanic the founder asked for — the
 * button is answered with what it WOULD do, and the choice is handed back.
 *
 * The re-offer keyboard drops whichever explanations have been read, so a
 * visitor who works through both is left with the anonymous chat as the only
 * remaining button rather than being invited to re-read a paragraph.
 */
export async function explainDemoCoordChoice(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  lang: Language | null,
  choice: Exclude<DemoCoordChoice, "proxy">,
): Promise<void> {
  const explained = coordExplained.get(userId) ?? new Set<DemoCoordChoice>();
  explained.add(choice);
  coordExplained.set(userId, explained);

  // Restart the fork's five-minute floor. The tap changes no product state, so
  // the derived action stays `coord_pick_proxy` and its clock would otherwise
  // keep running from when the card was sent — meaning a visitor who spends the
  // window reading both explanations could have the choice made for them
  // mid-sentence. Pressing a button IS the signal that someone is still here.
  pendingSince.delete(userId);

  const beat = choice === "share_self" ? "coord_share_self" : "coord_request_partner";
  const language = lang ?? "en";
  // Whatever is still worth pressing: the other contact variant if it has not
  // been read yet (`choice` is in the set by now, so it drops out on its own),
  // and always the anonymous chat, which is the one that actually runs.
  const keyboard = new InlineKeyboard();
  if (!explained.has("share_self")) {
    keyboard.text(t(language, "coordBtnShareSelf"), demoCoordCallback("share_self")).row();
  }
  if (!explained.has("request_partner")) {
    keyboard.text(t(language, "coordBtnRequestPartner"), demoCoordCallback("request_partner")).row();
  }
  keyboard.text(t(language, "coordBtnProxy"), demoCoordCallback("proxy"));

  await say(api, telegramId, demoText(beat, lang), { reply_markup: keyboard });
}

/**
 * Send the coordination fork — production's card, production's copy, production's
 * button labels, the demo's own callback data.
 *
 * Production would send NOTHING here: `resolveCoordRecipients` needs both sides
 * reachable on Telegram and the puppet never is, so `sendOffers` silently
 * selects the anonymous chat instead. Rather than widen that rule with a ninth
 * `if (DEMO_MODE_ENABLED)` inside `services/coordination.ts` — which still could
 * not show the two contact-exchange buttons, because production hides those
 * without a `@username` — the demo owns this one screen. See `script.ts` →
 * `DEMO_COORD_PREFIX` for why the callback data cannot be production's.
 */
async function sendDemoCoordOffer(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  match: DemoMatchSnapshot,
): Promise<DemoActionOutcome> {
  const partnerId = await partnerIdFor(match, userId);
  const [partner, visitor] = await Promise.all([
    prisma.user.findUnique({
      where: { id: partnerId },
      select: { firstName: true, profile: { select: { photos: true } } },
    }),
    prisma.user.findUnique({ where: { id: userId }, select: { language: true, theme: true } }),
  ]);
  if (!partner) return refused("puppet-row-missing");

  const language = (visitor?.language ?? "en") as Language;
  const keyboard = new InlineKeyboard()
    .text(t(language, "coordBtnShareSelf"), demoCoordCallback("share_self"))
    .row()
    .text(t(language, "coordBtnRequestPartner"), demoCoordCallback("request_partner"))
    .row()
    .text(t(language, "coordBtnProxy"), demoCoordCallback("proxy"));

  // The demo's own framing first, then the real card — same order as every other
  // beat that introduces a production screen.
  await say(api, telegramId, demoText("coord_offer", language));
  await sendCoordCard(
    api,
    telegramId,
    {
      variant: "offer",
      personName: partner.firstName ?? "",
      personPhotoRef: partner.profile?.photos?.[0] ?? null,
      language,
      theme: (visitor?.theme ?? "dark") as CoordCardTheme,
    },
    t(language, "coordOfferIntro"),
    { keyboard },
  );
  return ACTED;
}

/**
 * Variant C, for real: lock in the anonymous chat and play the two gates that
 * open it.
 *
 * The four-field write mirrors `handleCoordMethod`'s own `proxy` branch
 * (`handlers/date/coordination.ts`) — the demo cannot route the tap through that
 * handler, because it refuses anyone who is not an eligible offer recipient and
 * in demo there are none. Guarded on `coordMethod: null`, so the visitor's tap
 * and the five-minute floor cannot both fire.
 */
export async function chooseDemoProxy(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  lang: Language | null,
  matchId: string,
  agreedTime: Date | null,
): Promise<DemoActionOutcome> {
  const now = new Date();
  const claimed = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", coordMethod: null },
    data: {
      coordInitiatorId: userId,
      coordMethod: "proxy",
      coordChosenAt: now,
      coordResolvedAt: now,
    },
  });
  // Already chosen — the tap lost to the timer or to itself. Not a failure: the
  // gates below are idempotent, so just don't say "got it" a second time.
  if (claimed.count > 0) {
    await say(api, telegramId, t((lang ?? "en") as Language, "coordProxyChosenAck"));
  }

  try {
    await replayGates(api, COORD_GATES, agreedTime);
  } catch (err) {
    return refused(`coord-replay:${err instanceof Error ? err.message : String(err)}`);
  }
  return ACTED;
}

/**
 * The puppet's turn in the anonymous chat.
 *
 * Goes through `relayProxyMessage` (`services/proxy-chat.ts`) rather than
 * writing the row and the DM by hand, so the message is logged to
 * `proxy_messages` and reaches the visitor by exactly the path, with exactly the
 * prefix and exactly the controls keyboard a real partner's message would.
 *
 * The injected clock is the one demo-ism, and it is load-bearing: that module
 * derives the window from `agreedTime` (deliberately, so the two surfaces cannot
 * drift on cron timing), while the demo's date sits days in the real future — so
 * without the shift the production path would honestly answer `closed`. Same
 * trick as the lifecycle replay above.
 */
async function sendPuppetProxyMessage(
  userId: string,
  match: DemoMatchSnapshot,
): Promise<DemoActionOutcome> {
  if (!match.agreedTime) return refused("proxy-reply-no-agreed-time");
  const partnerId = await partnerIdFor(match, userId);

  const [partner, visitor, rows, row] = await Promise.all([
    prisma.user.findUnique({
      where: { id: partnerId },
      select: { firstName: true, gender: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, language: true, profile: { select: { timeZone: true } } },
    }),
    prisma.proxyMessage.findMany({
      where: { matchId: match.id },
      orderBy: { createdAt: "asc" },
      select: { senderId: true, body: true },
    }),
    prisma.match.findUnique({
      where: { id: match.id },
      select: { venueName: true, venueAddress: true },
    }),
  ]);
  if (!partner) return refused("puppet-row-missing");

  const transcript: ProxyReplyTurn[] = rows.map((entry) => ({
    from: entry.senderId === userId ? "visitor" : "partner",
    body: entry.body,
  }));

  const body = await composeProxyReply({
    partnerName: partner.firstName ?? "",
    partnerGender: partner.gender,
    visitorName: visitor?.firstName ?? null,
    language: (visitor?.language ?? null) as Language | null,
    venueName: row?.venueName ?? null,
    venueAddress: row?.venueAddress ?? null,
    agreedTime: match.agreedTime,
    timeZone: visitor?.profile?.timeZone ?? "Europe/Kyiv",
    transcript,
  });

  const relayed = await relayProxyMessage({
    matchId: match.id,
    senderUserId: partnerId,
    body,
    now: new Date(match.agreedTime.getTime() - 15 * 60_000),
  });
  return relayed.ok ? ACTED : refused(`proxy-relay:${relayed.error}`);
}

/**
 * The day after: close the chat and play the feedback prompt.
 *
 * Reached two ways — the button under the `chat_open` beat, or the exploration
 * window running out — so the beat marker is claimed BEFORE anything runs, for
 * the same reason `runDemoPredate` does it: the lifecycle steps are individually
 * idempotent but the narration is an ordinary message.
 */
export async function runDemoAfterDate(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  lang: Language | null,
  matchId: string,
  agreedTime: Date | null,
): Promise<DemoActionOutcome> {
  if (spokenBeats.get(userId)?.has("after_date")) return ACTED;
  markSpoken(userId, "after_date");

  await say(api, telegramId, demoText("after_date", lang));
  try {
    await replayGates(api, AFTER_DATE_GATES, agreedTime);
  } catch (err) {
    return refused(`after-date-replay:${err instanceof Error ? err.message : String(err)}`);
  }
  return ACTED;
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
): Promise<DemoActionOutcome> {
  const visitor = await prisma.user.findUnique({
    where: { id: userId },
    select: { gender: true, preference: true, language: true },
  });
  if (!visitor) return refused("visitor-row-missing");

  // Read off the row rather than the `lang` argument: that one is the language
  // the narration is being written in, while this decides which of the ten
  // puppet rows the visitor is paired with — and the pairing is durable, so it
  // has to follow the same source of truth every other surface reads.
  const definition = pickDemoPartner(visitor);
  const partner = await prisma.user.findUnique({
    where: { telegramId: definition.telegramId },
    select: { id: true },
  });
  if (!partner) {
    console.error(`${LOG} puppet ${definition.firstName} is not seeded — cannot pitch`);
    return refused("puppet-not-seeded");
  }

  // Both preconditions the production allocator enforces and a demo must not be
  // held by: the 24h candidate cooldown, and a vector left stale by the
  // visitor's own decline (see each helper for why).
  await releaseMatchCooldown([userId, partner.id]);
  await ensureFreshEmbeddings([userId, partner.id]);
  // A second pass through the flow gets its own date-card handover and its own
  // pre-date replay; without this it would land on a scheduled date in silence.
  forgetMatchBeats(userId);

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
    intent: 1,
    embeddingDistance: 0.24,
    starvationBonus: 0,
  });
  if (!match) {
    console.error(
      `${LOG} createProposedMatch refused for visitor ${userId}: ` +
        (await explainRefusal(userId, partner.id)),
    );
    return refused("allocator-refused");
  }
  const dispatch = await dispatchMatches(api, [match.id], 0);
  if (dispatch.failed > 0) {
    console.error(`${LOG} pitch dispatch failed:`, dispatch.errors);
    // The row exists but the visitor never saw a card. Reporting it is what
    // stops the demo sitting on a `proposed` match nobody was shown.
    return refused("pitch-dispatch-failed");
  }
  return ACTED;
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
    // Visitor only. The puppet is exempt from the single-live-match invariant
    // (`match-engine.ts`), so its live matches cannot be a cause — and naming
    // one here would point the next reader at the wrong suspect, which is
    // exactly how this was first read as "the demo is one-visitor-at-a-time".
    if (label === "visitor") {
      const live = [...row.matchesAsA, ...row.matchesAsB];
      if (live.length > 0) reasons.push(`${label} already occupies live match ${live[0]!.id}`);
    }
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
): Promise<DemoActionOutcome> {
  const partnerId = await partnerIdFor(match, visitorId);
  // A different part of central Kyiv from anywhere the visitor is likely to
  // drop their pin, so the concierge has a real midpoint to solve for.
  const origin = { lat: 50.4547, lng: 30.5238, address: "Золоті ворота, Київ" };
  const vibe = "тихое уютное кафе, где можно нормально поговорить";

  if (venueIntentMode(match.id) === "live") {
    const draft = await interpretVenueIntent(match.id, partnerId, vibe, origin);
    // The puppet's origin is hardcoded inside Kyiv, so the departure-point gate
    // (PRODUCT_SPEC §3.7) can only refuse it if the seeded partner's dating city
    // ever drifts — worth naming in the log rather than failing as "nothing".
    if (isVenueOriginRefusal(draft)) {
      return refused(`venue-origin-outside:${draft.market.city}`);
    }
    if (!draft) {
      return refused("venue-interpret-empty");
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
    return ACTED;
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
  return ACTED;
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
): Promise<DemoActionOutcome> {
  const partnerTelegramId = await partnerTelegramIdFor(match, visitorId);

  let keys: string[];
  if (mode === "partner_agree_likes") {
    const visitorPick = match.visitorLikeKeys.find((key) => key !== KEEP_KEY);
    keys = [...match.partnerLikeKeys, visitorPick ?? match.visitorLikeKeys[0]!].filter(Boolean);
  } else {
    const catalog = await getVenueChangeCatalog(partnerTelegramId, match.id);
    if (!catalog.ok) {
      return refused(`venue-catalog:${catalog.reason}`);
    }
    const taken = new Set(match.visitorLikeKeys);
    const alternative = catalog.venues
      .map((venue) => venueKeyOf(venue))
      .find((key) => key !== KEEP_KEY && !taken.has(key));
    // Nothing left that the visitor has not already hearted — there is no
    // counter-suggestion to make, so agreeing is the only move that keeps the
    // board alive. Reported rather than returned silently: a board with no
    // alternatives at all is a thin catalog, which is worth seeing in the log.
    if (!alternative) return refused("venue-catalog-exhausted");
    keys = [alternative];
  }

  const res = await submitVenueLikes(api, partnerTelegramId, match.id, keys);
  return res.ok ? ACTED : refused(`venue-likes:${res.reason}`);
}

/**
 * Play the days around the date, now — in three stretches rather than one run.
 *
 * `runDateLifecycleTick` takes an injected clock and every step claims its own
 * idempotency column, so shifting `now` to each gate is enough to fire the real
 * ice-breakers, the emergency window, the safety brief, the wingman hint and
 * the feedback prompt in order. No demo-specific lifecycle code exists.
 *
 * **`runCoordinationTick` has to be replayed too, and used not to be.** It is a
 * SEPARATE sweep, called from `index.ts` on the real clock — so a demo that
 * replayed only the lifecycle silently skipped the whole hour before the date:
 * the "how do we find each other" offer at T-60m, the anonymous chat at T-30m,
 * and all five coordination cards, with `COORDINATION_FEATURE_ENABLED` on the
 * entire time. The first demo ever to reach a scheduled date is what surfaced
 * it — `coordOfferSentAt` and `proxyOpenedAt` were both still null at the end.
 *
 * **Why three stretches.** Running every gate back to back put T+25h four
 * seconds after T-30m, so `closeProxies` shut the anonymous chat before anyone
 * could open it: the visitor was handed a live "Enter chat" button that was dead
 * by the time they reached it. Both the coordination fork and the relay are real
 * decisions the visitor makes, so the replay stops at each and waits — see
 * `decide.ts` → `decidePredateAction` for the states it waits in.
 */
interface Gate {
  /** Offset from `agreedTime`, in minutes. */
  minutes: number;
}

/** T-2h → ice-breakers, the emergency window, the date-day Live Activity. */
const PRE_DATE_GATES: readonly Gate[] = [{ minutes: -120 }];
/**
 * T-45m → the coordination sweep claims `coordOfferSentAt` and sends nothing
 * (the demo owns that card, see `sendDemoCoordOffer`); T-30m → wingman reveal,
 * safety brief, and `openProxies` opens the relay now that the method is set.
 */
const COORD_GATES: readonly Gate[] = [{ minutes: -45 }, { minutes: -30 }];
/** T+25h → the feedback prompt (which flips the row to `completed`) + close. */
const AFTER_DATE_GATES: readonly Gate[] = [{ minutes: 25 * 60 }];

async function replayGates(
  api: Api<RawApi>,
  gates: readonly Gate[],
  agreedTime: Date | null,
): Promise<void> {
  if (!agreedTime) return;
  for (const gate of gates) {
    const now = new Date(agreedTime.getTime() + gate.minutes * 60_000);
    await runDateLifecycleTick(api, now);
    await runCoordinationTick(api, now);
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
): Promise<DemoActionOutcome> {
  // Single-flight, shared with the driver. Two reasons, and the second is not
  // hypothetical: a double tap would run two pitches at once, and a tick landing
  // on the same visitor mid-tap would too — the driver decides `pitch` the
  // moment `clearDemoMatches` below removes the finished row.
  if (inFlight.has(userId)) return refused("already-in-flight");
  inFlight.add(userId);
  try {
    return await pitchAgain(api, userId, telegramId, language);
  } finally {
    inFlight.delete(userId);
  }
}

async function pitchAgain(
  api: Api<RawApi>,
  userId: string,
  telegramId: bigint,
  language: Language | null,
): Promise<DemoActionOutcome> {
  const cleared = await clearDemoMatches(userId);
  // A second run must not re-explain how matchmaking works. `spokenBeats` is in
  // memory (no demo-only schema, DEMO_MODE.md), so a deploy mid-demo forgets
  // what this visitor has read — and the demo is redeployed with every release,
  // which is exactly how a visitor came back from a pass and was told "you're
  // in the system, now here is how it actually works" a second time.
  //
  // A deleted match is durable proof the beat was delivered: it is sent
  // immediately before the pitch that created that row, and nothing else
  // creates one. Read from `clearDemoMatches`'s own delete count rather than a
  // separate query, because the evidence is gone a line later.
  if (cleared > 0) markSpoken(userId, "matchmaking");

  const outcome = await startDemoMatch(api, userId, telegramId, language);
  // The tap belongs to the SAME ladder as the driver's own attempts. Without
  // this its refusal was invisible in every direction: the visitor got no
  // answer, the streak stayed at zero, and they then waited out three more
  // driver attempts — 44 seconds of silence — before the give-up line landed.
  // A success clears the streak, so an earlier give-up can never outlive the
  // thing that caused it.
  if (outcome.ok) failures.clear(userId);
  else failures.note(userId, "pitch");
  return outcome;
}

/** Wipe every match this visitor has had with a puppet; returns how many. */
export async function clearDemoMatches(userId: string): Promise<number> {
  const partnerIds = await prisma.user.findMany({
    where: { telegramId: { in: DEMO_PARTNERS.map((p) => p.telegramId) } },
    select: { id: true },
  });
  const ids = partnerIds.map((p) => p.id);
  if (ids.length === 0) return 0;

  const removed = await prisma.match.deleteMany({
    where: {
      OR: [
        { userAId: userId, userBId: { in: ids } },
        { userBId: userId, userAId: { in: ids } },
      ],
    },
  });
  await releaseMatchCooldown([userId, ...ids]);
  return removed.count;
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
