import { prisma } from "@gennety/db";
import { generateWingmanHintPrompt, type Language } from "@gennety/shared";
import { callOpenAIText } from "./openai.js";

/**
 * Phase 4 "Wingman" — asymmetric insider tip generation.
 *
 * One short imperative sentence per user about the OTHER user, generated
 * at match-scheduling time and cached on the `Match` row. The reveal gate
 * (T-1h before `agreedTime`) lives in:
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
  language: Language,
): Promise<string> {
  const systemPrompt = generateWingmanHintPrompt({
    viewerFirstName,
    targetFirstName,
    viewerSummary,
    targetSummary,
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
        },
      },
      userB: {
        select: {
          firstName: true,
          language: true,
          profile: { select: { psychologicalSummary: true } },
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

  const [hintA, hintB] = await Promise.all([
    match.wingmanHintA
      ? Promise.resolve(match.wingmanHintA)
      : generateOneHint(nameA, nameB, summaryA, summaryB, langA),
    match.wingmanHintB
      ? Promise.resolve(match.wingmanHintB)
      : generateOneHint(nameB, nameA, summaryB, summaryA, langB),
  ]);

  await prisma.match.update({
    where: { id: matchId },
    data: { wingmanHintA: hintA, wingmanHintB: hintB },
  });

  return { a: hintA, b: hintB };
}
