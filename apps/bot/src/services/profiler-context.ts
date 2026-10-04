import { prisma } from "@gennety/db";
import {
  PROFILER_SIGNATURE_MIN_DATES,
  PROFILER_TOPIC_MAX_LEAD_MS,
  isProfilerSignatureExperience,
  profilerQuestionById,
  profilerQuestionText,
  type Language,
  type ProfilerQuestion,
} from "@gennety/shared";
import { readDateHistory } from "./date-map.js";
import { LOCALE_TAGS } from "./datetime-entity.js";
import { resolveZone, type ProfilerContextSignals } from "./profiler-schedule.js";

/**
 * The IO half of the Profiler's contextual questions
 * (`packages/shared/src/profiler-context-questions.ts`): what happened to the
 * person (the triggers' input) and what a question is about (the card shown
 * above it).
 *
 * Reads only what the person did through Gennety or told it themselves —
 * scheduled and confirmed dates (the same rows and attendance rule as the date
 * map) and their own Profiler answers. Never music, Apple Health rhythm or
 * frequent places (founder decision 2026-10-04; the rhythm and music boundary
 * tests fence those off independently).
 */

/** How long a quoted own answer may run on the card before it is cut. */
const QUOTE_MAX_CHARS = 160;

/**
 * Everything the contextual triggers need, in two reads: the upcoming dates
 * and the date history. Called only when a batch is about to open.
 */
export async function loadProfilerContextSignals(
  userId: string,
  now: Date,
): Promise<ProfilerContextSignals> {
  const [upcoming, history] = await Promise.all([
    prisma.match.findMany({
      where: {
        status: "scheduled",
        agreedTime: { gt: now, lte: new Date(now.getTime() + PROFILER_TOPIC_MAX_LEAD_MS) },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      orderBy: { agreedTime: "asc" },
      select: { id: true, agreedTime: true },
    }),
    readDateHistory(userId, now),
  ]);
  const leading = history.map.vibes[0];
  return {
    upcomingDates: upcoming.flatMap((match) =>
      match.agreedTime ? [{ matchId: match.id, at: match.agreedTime }] : [],
    ),
    attendedDates: history.dates.map((date) => ({ matchId: date.matchId, at: date.at })),
    signatureExperience:
      leading &&
      leading.dates >= PROFILER_SIGNATURE_MIN_DATES &&
      isProfilerSignatureExperience(leading.experience)
        ? leading.experience
        : null,
  };
}

// ---------------------------------------------------------------------------
// The card above a contextual question
// ---------------------------------------------------------------------------

export interface ProfilerContextCardDate {
  /** The venue as the match row names it; null on a date that never got one. */
  venueName: string | null;
  at: Date;
}

/**
 * What a contextual question refers to, shown above it like a quoted message:
 *
 *   - `upcoming_date` — the date the `topic` question is about (one entry);
 *   - `past_date`     — the date the `format` question is about (one entry);
 *   - `past_dates`    — up to three recent confirmed dates that share the
 *                       experience the `signature` question names;
 *   - `own_answer`    — the person's own earlier answer a `followup` asks about.
 *
 * Never the partner: like the date map, the card says where and when, not with
 * whom.
 */
export interface ProfilerContextCard {
  kind: "upcoming_date" | "past_date" | "past_dates" | "own_answer";
  dates: ProfilerContextCardDate[];
  answer: { question: string; text: string; answeredAt: Date } | null;
}

/**
 * - `none`  — the question needs no card (a bank question, or a `recheck`,
 *             which deliberately hides the earlier answer it re-measures);
 * - `card`  — show this above the question;
 * - `stale` — the moment it was about is gone (the date was cancelled or has
 *             passed, the quoted answer was erased): the question must not be
 *             asked any more.
 */
export type ProfilerContextResolution =
  | { kind: "none" }
  | { kind: "card"; card: ProfilerContextCard }
  | { kind: "stale" };

const SIGNATURE_CARD_DATES = 3;

function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= QUOTE_MAX_CHARS ? flat : `${flat.slice(0, QUOTE_MAX_CHARS - 1).trimEnd()}…`;
}

async function ownMatch(userId: string, matchId: string) {
  return prisma.match.findFirst({
    where: { id: matchId, OR: [{ userAId: userId }, { userBId: userId }] },
    select: { status: true, agreedTime: true, venueName: true },
  });
}

export async function resolveProfilerQuestionContext(
  userId: string,
  question: ProfilerQuestion,
  language: Language,
  now: Date,
): Promise<ProfilerContextResolution> {
  const ref = question.context;
  if (!ref) return { kind: "none" };

  switch (ref.family) {
    case "topic": {
      const match = await ownMatch(userId, ref.key);
      if (!match?.agreedTime || match.status !== "scheduled" || match.agreedTime <= now) {
        return { kind: "stale" };
      }
      return {
        kind: "card",
        card: {
          kind: "upcoming_date",
          dates: [{ venueName: match.venueName?.trim() || null, at: match.agreedTime }],
          answer: null,
        },
      };
    }
    case "format": {
      const match = await ownMatch(userId, ref.key);
      if (!match?.agreedTime) return { kind: "stale" };
      return {
        kind: "card",
        card: {
          kind: "past_date",
          dates: [{ venueName: match.venueName?.trim() || null, at: match.agreedTime }],
          answer: null,
        },
      };
    }
    case "signature": {
      const { map } = await readDateHistory(userId, now);
      const dates = map.places
        .filter((place) => place.experiences.some((experience) => experience === ref.key))
        .slice(0, SIGNATURE_CARD_DATES)
        .map((place) => ({ venueName: place.name, at: place.lastDateAt }));
      if (dates.length === 0) return { kind: "stale" };
      return { kind: "card", card: { kind: "past_dates", dates, answer: null } };
    }
    case "followup": {
      const source = profilerQuestionById(ref.key);
      const row = await prisma.profilerAnswer.findUnique({
        where: { userId_questionId: { userId, questionId: ref.key } },
        select: { answerText: true, answeredAt: true },
      });
      const text = row?.answerText?.trim();
      if (!source || !text || !row?.answeredAt) return { kind: "stale" };
      return {
        kind: "card",
        card: {
          kind: "own_answer",
          dates: [],
          answer: {
            question: profilerQuestionText(source, language),
            text: quote(text),
            answeredAt: row.answeredAt,
          },
        },
      };
    }
    case "recheck":
      return { kind: "none" };
  }
}

// ---------------------------------------------------------------------------
// Telegram rendering
// ---------------------------------------------------------------------------

/**
 * "11 June" / "11 июня", plus ", 19:00" for an upcoming date. Day and time are
 * formatted apart and joined here: ICU's own joiner ("at" / "в") changes
 * between ICU versions, and a card should read the same on every server.
 */
function formatDay(at: Date, language: Language, timeZone: string, withTime: boolean): string {
  const locale = LOCALE_TAGS[language];
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone }).format(at);
  if (!withTime) return day;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(at);
  return `${day}, ${time}`;
}

/**
 * Text that reaches a Markdown message from outside our copy (a venue name, the
 * person's own answer) loses the characters that would turn into formatting,
 * and its line breaks, so it cannot break out of the quote.
 */
function plain(text: string): string {
  return text.replace(/[\\`*_~|[\]<>#]/g, "").replace(/\s+/g, " ").trim();
}

function dateLine(
  date: ProfilerContextCardDate,
  language: Language,
  timeZone: string,
  withTime: boolean,
): string {
  const day = `🗓 ${formatDay(date.at, language, timeZone, withTime)}`;
  const venue = date.venueName ? plain(date.venueName) : "";
  return venue ? `> ${day} · 📍 ${venue}` : `> ${day}`;
}

/**
 * The card as a Markdown quote for the Telegram question message — the chat's
 * own "reply to" look: the date and the place, or the person's own words with
 * the question they answered. The question text follows after a blank line,
 * which ends the quote.
 */
export function profilerContextMarkdown(
  card: ProfilerContextCard,
  language: Language,
  timeZone: string | null,
): string {
  const zone = resolveZone(timeZone);
  if (card.kind === "own_answer" && card.answer) {
    const day = formatDay(card.answer.answeredAt, language, zone, false);
    return [`> ${plain(card.answer.question)}`, `> 💬 «${plain(card.answer.text)}» · ${day}`].join(
      "\n",
    );
  }
  const withTime = card.kind === "upcoming_date";
  return card.dates.map((date) => dateLine(date, language, zone, withTime)).join("\n");
}
