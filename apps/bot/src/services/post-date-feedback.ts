import { prisma } from "@gennety/db";
import { SUPPORTED_LANGUAGES, type Language } from "@gennety/shared";
import { recordPostDateFeedback } from "../handlers/date/feedback.js";

/**
 * Post-date feedback — the mechanics, shared by both surfaces
 * (PRODUCT_SPEC §Phase 4.3).
 *
 * Same split as `emergency-cancel.ts` and `proxy-chat.ts`: everything that
 * decides whether a submission is valid, how the structured answers become the
 * one text blob the LLM analyst reads, and what else the answer writes, lives
 * here. The Mini App route and the native `POST /v1/feedback/post-date` keep
 * only their own idiom — initData vs. JWT, a thank-you DM vs. none.
 *
 * The reason this file exists at all: the form is the only place the product
 * learns whether a date worked, and two implementations of "what counts as an
 * answer" would quietly produce two different training sets.
 */

export const FEEDBACK_MAX_TEXT_LEN = 1000;

export const SECOND_DATE_ANSWERS = ["yes", "maybe", "no"] as const;
export type SecondDateAnswer = (typeof SECOND_DATE_ANSWERS)[number];

export const VENUE_FIT_ANSWERS = ["yes", "partly", "no"] as const;
export type VenueFitAnswer = (typeof VENUE_FIT_ANSWERS)[number];

export const VENUE_FIT_REASONS = [
  "wrong_vibe",
  "too_loud",
  "too_expensive",
  "route_unfair",
  "accessibility",
  "closed_or_unavailable",
] as const;

/** How many venue-fit reasons a single answer may carry. */
const MAX_VENUE_REASONS = 3;

export type FeedbackRefusal =
  | "match-not-found"
  | "not-participant"
  | "wrong-state"
  | "empty-text"
  | "bad-chemistry"
  | "bad-second-date"
  | "no-pending-feedback";

export interface FeedbackSubmission {
  chemistry: number;
  wantsSecondDate: SecondDateAnswer;
  text: string;
  venueFit: VenueFitAnswer | null;
  venueFitReasons: string[];
}

export type FeedbackResult = { ok: true } | { ok: false; error: FeedbackRefusal };

const ALLOWED_LANGS: ReadonlySet<string> = new Set(SUPPORTED_LANGUAGES);
const ALLOWED_SECOND_DATE: ReadonlySet<string> = new Set(SECOND_DATE_ANSWERS);
const ALLOWED_VENUE_FIT: ReadonlySet<string> = new Set(VENUE_FIT_ANSWERS);
const ALLOWED_VENUE_REASONS: ReadonlySet<string> = new Set(VENUE_FIT_REASONS);

/**
 * Normalise one raw submission body.
 *
 * Refuses rather than coerces on the two answers that carry meaning: a
 * chemistry of 0 or a second-date value the client invented are not "close
 * enough to 1" or "probably maybe" — they are a client bug, and silently
 * rounding one into the dataset is worse than a 400. `text` and the venue
 * chips ARE coerced, because an empty comment and an unknown chip are both
 * legitimately "nothing said".
 */
export function normaliseFeedback(raw: {
  chemistry?: unknown;
  wantsSecondDate?: unknown;
  text?: unknown;
  venueFit?: unknown;
  venueFitReasons?: unknown;
}): { ok: true; value: FeedbackSubmission } | { ok: false; error: FeedbackRefusal } {
  const chemistryRaw =
    typeof raw.chemistry === "number" ? raw.chemistry : Number(raw.chemistry);
  if (!Number.isFinite(chemistryRaw) || chemistryRaw < 1 || chemistryRaw > 10) {
    return { ok: false, error: "bad-chemistry" };
  }

  const second = typeof raw.wantsSecondDate === "string" ? raw.wantsSecondDate : "";
  if (!ALLOWED_SECOND_DATE.has(second)) return { ok: false, error: "bad-second-date" };

  const text =
    typeof raw.text === "string" ? raw.text.trim().slice(0, FEEDBACK_MAX_TEXT_LEN) : "";

  const venueFit =
    typeof raw.venueFit === "string" && ALLOWED_VENUE_FIT.has(raw.venueFit)
      ? (raw.venueFit as VenueFitAnswer)
      : null;

  const venueFitReasons = Array.isArray(raw.venueFitReasons)
    ? [
        ...new Set(
          raw.venueFitReasons.filter(
            (value): value is string =>
              typeof value === "string" && ALLOWED_VENUE_REASONS.has(value),
          ),
        ),
      ].slice(0, MAX_VENUE_REASONS)
    : [];

  return {
    ok: true,
    value: {
      chemistry: Math.round(chemistryRaw),
      wantsSecondDate: second as SecondDateAnswer,
      text,
      venueFit,
      venueFitReasons,
    },
  };
}

export function resolveLanguage(candidate: unknown, fallback: string | null): Language {
  if (typeof candidate === "string" && ALLOWED_LANGS.has(candidate)) return candidate as Language;
  if (fallback && ALLOWED_LANGS.has(fallback)) return fallback as Language;
  return "en";
}

/**
 * Structured answers → the single text blob `parsePostDateFeedbackPrompt`
 * expects.
 *
 * Deliberately NOT new Prisma columns: the LLM already reads these cues from
 * prose, and the row schema stays untouched. Written in the user's own
 * language because the analyst prompt is language-agnostic and a Russian
 * comment under an English header reads to it as two voices.
 */
export function composeFeedbackText(input: {
  text: string;
  chemistry: number;
  wantsSecondDate: SecondDateAnswer;
  language: Language;
}): string {
  const labels = FEEDBACK_LABELS[input.language] ?? FEEDBACK_LABELS.en;
  const second =
    input.wantsSecondDate === "yes"
      ? labels.yes
      : input.wantsSecondDate === "no"
        ? labels.no
        : labels.maybe;
  return [
    `${labels.chem}: ${input.chemistry}`,
    `${labels.second}: ${second}`,
    input.text ? `${labels.notes}: ${input.text}` : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

interface FeedbackLabels {
  chem: string;
  second: string;
  notes: string;
  yes: string;
  maybe: string;
  no: string;
}

const FEEDBACK_LABELS: Record<Language, FeedbackLabels> = {
  en: {
    chem: "Chemistry (1–10)",
    second: "Second date?",
    notes: "Notes",
    yes: "yes",
    maybe: "maybe",
    no: "no",
  },
  ru: {
    chem: "Химия (1–10)",
    second: "Готов(а) на вторую встречу?",
    notes: "Комментарий",
    yes: "да",
    maybe: "может быть",
    no: "нет",
  },
  uk: {
    chem: "Хімія (1–10)",
    second: "Готовий(а) на другу зустріч?",
    notes: "Коментар",
    yes: "так",
    maybe: "можливо",
    no: "ні",
  },
  de: {
    chem: "Chemie (1–10)",
    second: "Zweites Date?",
    notes: "Notizen",
    yes: "ja",
    maybe: "vielleicht",
    no: "nein",
  },
  pl: {
    chem: "Chemia (1–10)",
    second: "Druga randka?",
    notes: "Notatki",
    yes: "tak",
    maybe: "może",
    no: "nie",
  },
};

/**
 * Persist one submission: the feedback blob through the shared analysis
 * pipeline, then the venue-fit answer on the actor's own side.
 *
 * Venue fit is written AFTER the pipeline succeeds, not before: it is the
 * lesser half of the answer, and writing it against a submission the pipeline
 * rejected would leave a row claiming a verdict about a date nobody reviewed.
 */
export async function submitPostDateFeedback(input: {
  userId: string;
  matchId: string;
  language: Language;
  submission: FeedbackSubmission;
}): Promise<FeedbackResult> {
  const composed = composeFeedbackText({
    text: input.submission.text,
    chemistry: input.submission.chemistry,
    wantsSecondDate: input.submission.wantsSecondDate,
    language: input.language,
  });

  const recorded = await recordPostDateFeedback({
    userId: input.userId,
    matchId: input.matchId,
    text: composed,
    language: input.language,
  });
  if (!recorded.ok) return { ok: false, error: recorded.reason };

  if (input.submission.venueFit) {
    const match = await prisma.match.findUnique({
      where: { id: input.matchId },
      select: { userAId: true, userBId: true },
    });
    const data = {
      venueFit: input.submission.venueFit,
      reasons: input.submission.venueFitReasons,
    };
    if (match?.userAId === input.userId) {
      await prisma.match.update({
        where: { id: input.matchId },
        data: { venueFitByA: data.venueFit, venueFitReasonsByA: data.reasons },
      });
    } else if (match?.userBId === input.userId) {
      await prisma.match.update({
        where: { id: input.matchId },
        data: { venueFitByB: data.venueFit, venueFitReasonsByB: data.reasons },
      });
    }
  }

  return { ok: true };
}

export interface PendingFeedbackView {
  matchId: string;
  partnerFirstName: string | null;
  venueName: string | null;
  agreedTime: Date;
  /** Already answered — the form opens read-only rather than 404ing. */
  submitted: boolean;
  maxTextLength: number;
  serverNow: Date;
}

/**
 * The date this user still owes feedback on, if any.
 *
 * This endpoint exists because `/v1/matches/current` deliberately excludes
 * `completed` (`ACTIVE_MATCH_STATUSES`), so once the date is over the app has
 * no way to learn that a form is waiting. In Telegram the DM carries the link
 * and no discovery is needed; the app has no such carrier.
 *
 * Gated on `feedbackPromptedAt`, the same one-shot marker the lifecycle tick
 * writes — not on `status === "completed"` alone. Asking before the product
 * has decided to ask would surface the form minutes after the date, while one
 * of them may still be at the table.
 */
export async function pendingFeedbackFor(
  userId: string,
  now: Date = new Date(),
): Promise<PendingFeedbackView | null> {
  const match = await prisma.match.findFirst({
    where: {
      status: "completed",
      feedbackPromptedAt: { not: null },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { agreedTime: "desc" },
    select: {
      id: true,
      agreedTime: true,
      venueName: true,
      userAId: true,
      userBId: true,
      feedbackByA: true,
      feedbackByB: true,
      userA: { select: { firstName: true } },
      userB: { select: { firstName: true } },
    },
  });
  if (!match || !match.agreedTime) return null;

  const isA = match.userAId === userId;
  return {
    matchId: match.id,
    partnerFirstName: (isA ? match.userB.firstName : match.userA.firstName) ?? null,
    venueName: match.venueName,
    agreedTime: match.agreedTime,
    submitted: Boolean(isA ? match.feedbackByA : match.feedbackByB),
    maxTextLength: FEEDBACK_MAX_TEXT_LEN,
    serverNow: now,
  };
}
