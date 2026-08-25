/**
 * Date Bump — the pair confirming, with a physical act, that they are sitting
 * at the same table (PRODUCT_SPEC §6.2).
 *
 * Both people shake their phones. The pair verifies when the two shakes land
 * within `BUMP_SHAKE_WINDOW_MS` of each other AND both coordinates are inside
 * `BUMP_VENUE_RADIUS_M` of the venue. Verification is the only event that does
 * anything: reliability, the bonus ticket, the attendance write and the deck
 * all hang off one compare-and-set.
 *
 * ── Why this is allowed to write attendance ─────────────────────────────
 *
 * `services/attendance.ts` states the rule it protects: **the evidence
 * classifier NEVER writes `dateAttended*`, only a live human answer does.** A
 * Bump does not weaken that rule, it satisfies it. The classifier reads a proxy
 * chat and guesses; a Bump is two people, deliberately, at the venue, at the
 * time — a stronger human answer than the one the T+24h form collects, and
 * earlier. What the rule forbids is a machine inventing the fact, and nothing
 * here invents anything.
 *
 * ── The three refusals worth understanding ──────────────────────────────
 *
 * `too-early` / `too-late` and `too-far` are the whole anti-abuse story, and
 * they are deliberately the only one. There is no device attestation and no
 * anti-spoofing: a determined user can lie about their coordinates, and the
 * product's answer to that is that they would be lying their way into a free
 * ticket on a date they are already paying for, at a venue we chose, in a
 * fifteen-minute window. The cost of being wrong is one ticket; the cost of a
 * heavier gate is a real couple at a real table who cannot make it work.
 */

import { prisma } from "@gennety/db";
import {
  BUMP_ICEBREAKER_COUNT,
  BUMP_RELIABILITY_REWARD,
  BUMP_SHAKE_WINDOW_MS,
  BUMP_VENUE_RADIUS_M,
  checkBumpWindow,
  formatProfilerAnswersBlock,
  generateBumpDeckPrompt,
  scoreProfilerAnswers,
  t,
  type Language,
} from "@gennety/shared";

import { haversineDistanceKm, type LatLng } from "./geo.js";
import { getMainBotApi } from "./main-bot-api.js";
import { sendPushToUser } from "./push.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { callOpenAIText } from "./openai.js";
import { grantTickets, isUniqueViolation } from "./ticket-wallet.js";
import { sideOf } from "./date-state.js";

export type BumpRefusal =
  /** The caller is on neither side of this match. */
  | "not-participant"
  /** The match is not a scheduled date (or has no agreed time / venue). */
  | "wrong-state"
  /** Before the window opens. */
  | "too-early"
  /** After the grace window closes. */
  | "too-late"
  /** This shake was not near the venue. */
  | "too-far";

export interface BumpOutcome {
  ok: boolean;
  reason?: BumpRefusal;
  /** True once BOTH sides are in and the pair has been credited. */
  verified: boolean;
  /** True when this call is what verified the pair (never true twice). */
  justVerified: boolean;
}

// ---------------------------------------------------------------------------
// Pure half — testable without a database, a clock or a network
// ---------------------------------------------------------------------------

// The window itself lives in `@gennety/shared` because the demo's pure decision
// table needs it and must not import Prisma. Re-exported here so callers of the
// bump service have one import site.
export { bumpWindowFor, checkBumpWindow } from "@gennety/shared";

/** Whether a shake happened close enough to the venue. */
export function withinVenue(shake: LatLng, venue: LatLng): boolean {
  return haversineDistanceKm(shake, venue) * 1000 <= BUMP_VENUE_RADIUS_M;
}

/**
 * Whether two shakes count as one gesture.
 *
 * Deliberately symmetric — `|A − B|`, not "B after A". Which phone registers
 * first is decided by accelerometer sampling and network latency, not by who
 * moved first, so an ordered rule would fail half the real bumps for no reason.
 */
export function shakesAligned(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= BUMP_SHAKE_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// The write path
// ---------------------------------------------------------------------------

export interface RecordBumpInput {
  matchId: string;
  userId: string;
  at: Date;
  coords: LatLng;
}

/**
 * Record one side's shake, and verify the pair if this completes it.
 *
 * Idempotent per side: a second shake from the same person overwrites their own
 * timestamp (they may genuinely be retrying) but can never verify a pair on its
 * own, because the peer's column is what the alignment check reads.
 */
export async function recordBump(input: RecordBumpInput): Promise<BumpOutcome> {
  const { matchId, userId, at, coords } = input;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userAId: true,
      userBId: true,
      agreedTime: true,
      venueLat: true,
      venueLng: true,
    },
  });
  if (!match) return refuse("wrong-state");

  const side = sideOf(match, userId);
  if (!side) return refuse("not-participant");

  if (match.status !== "scheduled" || !match.agreedTime) return refuse("wrong-state");
  if (match.venueLat === null || match.venueLng === null) return refuse("wrong-state");

  const window = checkBumpWindow(match.agreedTime, at);
  if (window !== "ok") return refuse(window);

  if (!withinVenue(coords, { lat: match.venueLat, lng: match.venueLng })) {
    return refuse("too-far");
  }

  const mine = side === "A" ? "userAShakeAt" : "userBShakeAt";
  const session = await prisma.dateBumpSession.upsert({
    where: { matchId },
    create: { matchId, [mine]: at },
    update: { [mine]: at },
    select: { isVerified: true, userAShakeAt: true, userBShakeAt: true },
  });

  // Already credited — say so plainly rather than pretending this shake did it.
  if (session.isVerified) return { ok: true, verified: true, justVerified: false };

  const peerShake = side === "A" ? session.userBShakeAt : session.userAShakeAt;
  if (!peerShake || !shakesAligned(at, peerShake)) {
    return { ok: true, verified: false, justVerified: false };
  }

  const claimed = await verifyBump(match, at);
  return { ok: true, verified: true, justVerified: claimed };
}

function refuse(reason: BumpRefusal): BumpOutcome {
  return { ok: false, reason, verified: false, justVerified: false };
}

/**
 * Flip the pair to verified and pay for it — one transaction, one CAS.
 *
 * The CAS (`updateMany` on `isVerified: false`) is what makes the rewards
 * exactly-once under two shakes landing in the same millisecond: the loser
 * updates zero rows and returns false, so it credits nothing. Same shape the
 * ticket gate and the venue-change settle already use.
 *
 * `dateAttended*` is written for BOTH sides here, not one — attendance is a
 * property of the PAIR (`services/attendance.ts`), and a Bump observes the pair.
 */
async function verifyBump(
  match: { id: string; userAId: string; userBId: string },
  at: Date,
): Promise<boolean> {
  const [claim] = await prisma.$transaction([
    prisma.dateBumpSession.updateMany({
      where: { matchId: match.id, isVerified: false },
      data: { isVerified: true, verifiedAt: at },
    }),
    prisma.match.update({
      where: { id: match.id },
      data: { dateAttendedA: true, dateAttendedB: true },
    }),
    prisma.profile.updateMany({
      where: { userId: { in: [match.userAId, match.userBId] } },
      data: { reliabilityScore: { increment: BUMP_RELIABILITY_REWARD } },
    }),
  ]);

  if (claim.count === 0) return false;

  // Tickets ride their own exactly-once rail rather than the transaction above:
  // `grantTickets` writes a ledger row plus the materialized balance and is the
  // only thing allowed to move a wallet. The synthetic external id makes a
  // retry (a redelivered request, a restarted process) a no-op instead of a
  // second free ticket.
  for (const userId of [match.userAId, match.userBId]) {
    try {
      await grantTickets({
        userId,
        count: 1,
        reason: "bump_bonus",
        matchId: match.id,
        externalPaymentId: `bump:${match.id}:${userId}`,
      });
    } catch (err) {
      // A duplicate id means it was already granted, which is the point of the
      // id. Anything else is a real failure and must not cost the pair their
      // verification, which is already committed above.
      if (!isUniqueViolation(err)) {
        console.error(`[date-bump] ticket grant failed for ${userId}:`, err);
      }
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Telling the pair
// ---------------------------------------------------------------------------

/**
 * Announce a verified Bump to both sides, on whichever rails reach each of
 * them (`telegramReachable` / `pushReachable`).
 *
 * **A single shake announces nothing**, and that is a product rule rather than
 * an omission: nudging the second person means the first person's phone told on
 * them, which is the same claim about someone's location that §6.3's masking
 * exists to prevent. The gesture is "shake together"; if you are at the table,
 * you shake together.
 */
export async function announceBumpVerified(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      bumpSession: { select: { icebreakerDeck: true } },
      userA: { select: RECIPIENT_SELECT },
      userB: { select: RECIPIENT_SELECT },
    },
  });
  if (!match) return;

  const deck = match.bumpSession?.icebreakerDeck as BumpDeck | null;

  await Promise.all([
    tellSide(match.userA, deck?.topicsForA ?? [], matchId),
    tellSide(match.userB, deck?.topicsForB ?? [], matchId),
  ]);
}

const RECIPIENT_SELECT = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
} as const;

async function tellSide(
  user: { id: string; telegramId: bigint; platform: string; language: Language | null },
  topics: string[],
  matchId: string,
): Promise<void> {
  const lang: Language = user.language ?? "en";
  const headline = t(lang, "bumpVerifiedDm");
  const body = topics.length
    ? `${headline}\n\n${t(lang, "bumpDeckIntro")}\n${topics.map((x) => `• ${x}`).join("\n")}`
    : headline;

  if (telegramReachable(user)) {
    const api = getMainBotApi();
    if (api) {
      await api
        .sendMessage(Number(user.telegramId), body)
        .catch((err: unknown) => console.error("[date-bump] DM failed:", err));
    }
  }

  if (pushReachable(user)) {
    // The deck stays out of the lock screen: it is five lines of prose written
    // to be read at a table, and iOS would truncate it into nonsense. The push
    // says the thing happened; the app draws the deck.
    await sendPushToUser(user.id, {
      title: headline,
      body: t(lang, "bumpDeckIntro"),
      data: { type: "date.bump", matchId },
    }).catch(() => false);
  }
}

// ---------------------------------------------------------------------------
// The icebreaker deck
// ---------------------------------------------------------------------------

export interface BumpDeck {
  topicsForA: string[];
  topicsForB: string[];
}

/**
 * Generate and store the at-the-table deck.
 *
 * Runs AFTER the verification commits, deliberately: it is an LLM round trip,
 * and holding a transaction open across one would put the pair's ticket behind
 * OpenAI's latency. A failure here costs topics, never the bump — the same
 * fail-open rule §Phase 4 applies to the pre-date icebreakers.
 */
export async function generateAndStoreBumpDeck(matchId: string): Promise<BumpDeck | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userA: { select: PARTICIPANT_SELECT },
      userB: { select: PARTICIPANT_SELECT },
    },
  });
  if (!match) return null;

  const [topicsForA, topicsForB] = await Promise.all([
    topicsFor(match.userA, match.userB),
    topicsFor(match.userB, match.userA),
  ]);

  const deck: BumpDeck = { topicsForA, topicsForB };
  await prisma.dateBumpSession.update({
    where: { matchId },
    data: { icebreakerDeck: { ...deck } },
  });
  return deck;
}

const PARTICIPANT_SELECT = {
  id: true,
  firstName: true,
  language: true,
  profile: { select: { psychologicalSummary: true } },
  profilerAnswers: {
    select: { questionId: true, answerText: true, priority: true, skipped: true },
  },
} as const;

type Participant = {
  id: string;
  firstName: string | null;
  /** Nullable on legacy rows — every read falls back to English. */
  language: Language | null;
  profile: { psychologicalSummary: string | null } | null;
  profilerAnswers: {
    questionId: string;
    answerText: string | null;
    priority: string;
    skipped: boolean;
  }[];
};

async function topicsFor(viewer: Participant, partner: Participant): Promise<string[]> {
  const language: Language = viewer.language ?? "en";
  const fallback = staticDeck(language);

  const scored = scoreProfilerAnswers(
    partner.profilerAnswers.map((a) => ({
      questionId: a.questionId,
      answerText: a.answerText,
      priority: a.priority as never,
      skipped: a.skipped,
    })),
  );

  const prompt = generateBumpDeckPrompt({
    userFirstName: viewer.firstName ?? "",
    matchFirstName: partner.firstName ?? "",
    userSummary: viewer.profile?.psychologicalSummary ?? null,
    matchSummary: partner.profile?.psychologicalSummary ?? null,
    language,
    matchProfilerBlock: formatProfilerAnswersBlock(scored, language) || null,
    count: BUMP_ICEBREAKER_COUNT,
  });

  try {
    const raw = await callOpenAIText(prompt, "Generate the topics now.");
    const parsed = parseNumberedLines(raw);
    return parsed.length >= 2 ? parsed.slice(0, BUMP_ICEBREAKER_COUNT) : fallback;
  } catch (err) {
    console.error("[date-bump] deck generation failed:", err);
    return fallback;
  }
}

/**
 * Pull the numbered lines out of the model's answer.
 *
 * Tolerant on purpose — the prompt asks for `1. …` and models occasionally
 * answer with `1)` or a bare dash. A deck of two good lines beats refusing the
 * whole thing over punctuation.
 */
export function parseNumberedLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .map((line) => line.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim())
    .filter((line) => line.length > 0 && line.length <= 200);
}

/**
 * The deck when there is no `OPENAI_API_KEY` or the call fails.
 *
 * Same rule and same reason as `date-lifecycle.ts`'s static icebreakers: the
 * pair is sitting at a table waiting for their phones, so "nothing" is the one
 * answer this path may not give.
 */
function staticDeck(language: Language): string[] {
  const decks: Record<string, string[]> = {
    en: [
      "What's been the best part of your week?",
      "What are you listening to lately?",
      "Seen anything good recently?",
      "Where would you go if you could leave tomorrow?",
      "What's something you want to learn this year?",
    ],
    ru: [
      "Что было лучшим за эту неделю?",
      "Что сейчас слушаешь?",
      "Смотрел(а) что-нибудь стоящее в последнее время?",
      "Куда бы уехал(а), если бы можно было завтра?",
      "Чему хочешь научиться в этом году?",
    ],
    uk: [
      "Що було найкращим цього тижня?",
      "Що зараз слухаєш?",
      "Дивився(лась) щось вартісне останнім часом?",
      "Куди б поїхав(ла), якби можна було завтра?",
      "Чого хочеш навчитися цього року?",
    ],
    de: [
      "Was war das Beste an deiner Woche?",
      "Was hörst du gerade so?",
      "Zuletzt was Gutes gesehen?",
      "Wohin würdest du fahren, wenn es morgen losginge?",
      "Was möchtest du dieses Jahr lernen?",
    ],
    pl: [
      "Co było najlepsze w tym tygodniu?",
      "Czego teraz słuchasz?",
      "Widziałeś(aś) ostatnio coś dobrego?",
      "Dokąd byś pojechał(a), gdyby można było jutro?",
      "Czego chcesz się w tym roku nauczyć?",
    ],
  };
  return decks[language] ?? decks.en!;
}
