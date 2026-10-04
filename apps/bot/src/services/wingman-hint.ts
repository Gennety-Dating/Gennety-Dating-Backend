import { prisma } from "@gennety/db";
import {
  PRE_DATE_WINGMAN_HOURS,
  generateWingmanHintPrompt,
  formatProfilerAnswersBlock,
  scoreProfilerAnswers,
  type Language,
} from "@gennety/shared";
import { callOpenAIText } from "./openai.js";

/**
 * Phase 4 "Wingman" — asymmetric insider tip generation.
 *
 * One short imperative sentence per user about the OTHER user, generated
 * at match-scheduling time and cached on the `Match` row. The reveal gate
 * (T-1.5h before `agreedTime`) lives in:
 *   - `date-lifecycle.runDateLifecycleTick` (push dispatch + Telegram DM)
 *   - `matches-service.getCurrentMatchForUser` (mobile API serializer)
 *
 * This module is intentionally narrow: generate → validate → persist.
 * It is safe to call repeatedly; it no-ops when both hints already exist.
 */

const MAX_HINT_CHARS = 220;

const FALLBACK: Record<Language, string> = {
  en: "Ask them about something they've been genuinely excited about this week.",
  ru: "Спроси, чем они по-настоящему загорелись на этой неделе.",
  uk: "Спитай, чим вони по-справжньому запалилися цього тижня.",
  de: "Frag sie nach etwas, das sie diese Woche wirklich begeistert hat.",
  pl: "Zapytaj, co naprawdę ich nakręciło w tym tygodniu.",
};

/**
 * Reject model output that drifts from the "one imperative sentence" contract.
 * Returns the cleaned string on success, null on rejection — callers then
 * substitute a language-specific fallback.
 */
function validateHint(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .replace(/^["'«»]+|["'«»]+$/g, "")
    .replace(/^\d+\.\s*/, "")
    .trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_HINT_CHARS) return null;
  if (trimmed.includes("?")) return null;
  return trimmed;
}

async function generateOneHint(
  viewerFirstName: string,
  targetFirstName: string,
  viewerSummary: string | null,
  targetSummary: string | null,
  targetProfilerBlock: string | null,
  language: Language,
): Promise<string> {
  const systemPrompt = generateWingmanHintPrompt({
    viewerFirstName,
    targetFirstName,
    viewerSummary,
    targetSummary,
    targetProfilerBlock,
    language,
  });
  const text = await callOpenAIText(systemPrompt, "Write the wingman tip now.", {
    maxTokens: 120,
    temperature: 0.8,
  });
  return validateHint(text) ?? FALLBACK[language];
}

export interface WingmanHints {
  a: string;
  b: string;
}

/**
 * Generate and persist both wingman hints for a match. Idempotent: skips
 * generation entirely when both hint slots are already populated. Partial
 * regeneration (one side missing) is supported.
 *
 * Returns `null` if the match doesn't exist or lacks the user data needed
 * to produce a meaningful tip (e.g. a mid-delete cascade).
 */
export async function generateAndSaveWingmanHints(
  matchId: string,
): Promise<WingmanHints | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      wingmanHintA: true,
      wingmanHintB: true,
      userA: {
        select: {
          firstName: true,
          language: true,
          profile: { select: { psychologicalSummary: true } },
          profilerAnswers: { select: { questionId: true, answerText: true } },
        },
      },
      userB: {
        select: {
          firstName: true,
          language: true,
          profile: { select: { psychologicalSummary: true } },
          profilerAnswers: { select: { questionId: true, answerText: true } },
        },
      },
    },
  });
  if (!match) return null;

  if (match.wingmanHintA && match.wingmanHintB) {
    return { a: match.wingmanHintA, b: match.wingmanHintB };
  }

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;
  const nameA = match.userA.firstName ?? "your date";
  const nameB = match.userB.firstName ?? "your date";
  const summaryA = match.userA.profile?.psychologicalSummary ?? null;
  const summaryB = match.userB.profile?.psychologicalSummary ?? null;

  // PRIMARY source: each target's own Profiler answers, weighted and rendered
  // in the viewer's language. Null → the prompt falls back to the summary.
  const profilerA = scoreProfilerAnswers(match.userA.profilerAnswers ?? [], { matchId });
  const profilerB = scoreProfilerAnswers(match.userB.profilerAnswers ?? [], { matchId });

  const [hintA, hintB] = await Promise.all([
    match.wingmanHintA
      ? Promise.resolve(match.wingmanHintA)
      : generateOneHint(
          nameA,
          nameB,
          summaryA,
          summaryB,
          formatProfilerAnswersBlock(profilerB, langA),
          langA,
        ),
    match.wingmanHintB
      ? Promise.resolve(match.wingmanHintB)
      : generateOneHint(
          nameB,
          nameA,
          summaryB,
          summaryA,
          formatProfilerAnswersBlock(profilerA, langB),
          langB,
        ),
  ]);

  await prisma.match.update({
    where: { id: matchId },
    data: { wingmanHintA: hintA, wingmanHintB: hintB },
  });

  return { a: hintA, b: hintB };
}

/**
 * Margin before the reveal (T-`PRE_DATE_WINGMAN_HOURS`) inside which a tip is
 * no longer rewritten: a regeneration takes seconds, and a tip rewritten as it
 * is being shown would read as the app changing its mind.
 */
const REFRESH_MARGIN_MS = 30 * 60 * 1000;

/**
 * Rewrite the tip ABOUT `subjectUserId` (the one their partner will read),
 * because the subject just told the Profiler something new for this date — the
 * "fresh topic before the date" question. The tip was generated when the venue
 * locked, before that answer existed.
 *
 * Only while the tip is unrevealed: the match is still `scheduled`, the reveal
 * push has not gone out (`wingmanSentAt`), and the reveal is more than
 * `REFRESH_MARGIN_MS` away. The partner's slot is cleared with a
 * compare-and-set on exactly those conditions, then `generateAndSaveWingmanHints`
 * refills the one empty slot. Returns whether a rewrite happened.
 */
export async function refreshWingmanHintAbout(
  matchId: string,
  subjectUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { status: true, agreedTime: true, userAId: true, userBId: true, wingmanSentAt: true },
  });
  if (!match?.agreedTime || match.status !== "scheduled" || match.wingmanSentAt) return false;
  const revealAt = match.agreedTime.getTime() - PRE_DATE_WINGMAN_HOURS * 60 * 60 * 1000;
  if (revealAt - now.getTime() <= REFRESH_MARGIN_MS) return false;

  // `wingmanHintA` is read by A and is about B (see `generateOneHint` above),
  // so the tip about the subject lives in the OTHER side's slot.
  const readerSlot =
    match.userAId === subjectUserId
      ? { wingmanHintB: null }
      : match.userBId === subjectUserId
        ? { wingmanHintA: null }
        : null;
  if (!readerSlot) return false;

  const { count } = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", wingmanSentAt: null },
    data: readerSlot,
  });
  if (count !== 1) return false;
  await generateAndSaveWingmanHints(matchId);
  return true;
}
