/**
 * Dynamic system prompt builder for the post-onboarding LLM Router.
 *
 * Assembles the prompt at runtime from three sources:
 *   1. Base persona (static)
 *   2. Database-driven Knowledge Base (SystemKnowledge table)
 *   3. User-specific context (profile, match state, next batch date)
 */

import { prisma } from "@gennety/db";
import { formatNextBatchDate } from "./next-batch.js";

// ---------------------------------------------------------------------------
// Base Persona (static)
// ---------------------------------------------------------------------------

const BASE_PERSONA = `You are the Gennety Dating assistant — a warm, casual AI concierge for university students who have completed onboarding.

## Your Role
- Answer questions about how Gennety works, when matches arrive, profile editing, and the dating process.
- Execute profile edits when the user asks (via tool calls).
- Be honest about what you can and can't do.
- NEVER create chat between users. NEVER help users contact their match directly.

## Conversation Style
- Talk like a cool older friend — casual, warm, not cringe. Short sentences.
- 1-2 emojis per message max, placed naturally.
- Match the user's language. If they speak Russian, respond in Russian (informal "ты"). Same for Ukrainian.
- One idea per message. Don't stack multiple questions.
- No corporate speak, no fake enthusiasm.`;

// ---------------------------------------------------------------------------
// Knowledge Base Fetcher
// ---------------------------------------------------------------------------

/** Cached knowledge entries (refreshed every 5 minutes). */
let knowledgeCache: { text: string; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch active knowledge entries from the database, ordered by priority.
 * Results are cached in-memory for 5 minutes to avoid DB hits on every message.
 */
export async function fetchKnowledgeBase(): Promise<string> {
  const now = Date.now();
  if (knowledgeCache && now - knowledgeCache.fetchedAt < CACHE_TTL_MS) {
    return knowledgeCache.text;
  }

  const entries = await prisma.systemKnowledge.findMany({
    where: { active: true },
    orderBy: { priority: "asc" },
    select: { title: true, content: true },
  });

  const text = entries
    .map((e) => `### ${e.title}\n${e.content}`)
    .join("\n\n");

  knowledgeCache = { text, fetchedAt: now };
  return text;
}

/** Clear the in-memory cache (for testing or after admin edits). */
export function clearKnowledgeCache(): void {
  knowledgeCache = null;
}

// ---------------------------------------------------------------------------
// User Context Builder
// ---------------------------------------------------------------------------

interface UserContext {
  firstName: string;
  university: string;
  status: string;
  language: string;
  matchSummary: string;
  nextBatchDate: string;
  /**
   * Non-empty when the user recently declined a match and has not yet given
   * a reason. The agent is expected to steer the conversation toward
   * collecting it and call `record_rejection_feedback`.
   */
  pendingRejectionHint: string;
}

/** How far back to look for an un-explained decline (24 hours). */
const PENDING_REJECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

async function fetchUserContext(telegramId: bigint): Promise<UserContext> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      universityDomain: true,
      status: true,
      language: true,
      matchesAsA: {
        where: { status: { in: ["proposed", "negotiating", "scheduled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, agreedTime: true, venueName: true },
      },
      matchesAsB: {
        where: { status: { in: ["proposed", "negotiating", "scheduled"] } },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, agreedTime: true, venueName: true },
      },
    },
  });

  const activeMatch = user?.matchesAsA[0] ?? user?.matchesAsB[0] ?? null;

  let matchSummary: string;
  if (!activeMatch) {
    matchSummary = "No active match. Waiting for the next weekly batch.";
  } else if (activeMatch.status === "proposed") {
    matchSummary = "Has a pending match proposal — waiting for accept/decline.";
  } else if (activeMatch.status === "negotiating") {
    matchSummary = "Match accepted by both sides — currently scheduling the date.";
  } else if (activeMatch.status === "scheduled") {
    const when = activeMatch.agreedTime
      ? activeMatch.agreedTime.toLocaleString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        })
      : "TBD";
    const venue = activeMatch.venueName ?? "TBD";
    matchSummary = `Date scheduled: ${when} at ${venue}.`;
  } else {
    matchSummary = "No active match.";
  }

  const locale = user?.language === "ru" ? "ru-RU" : user?.language === "uk" ? "uk-UA" : "en-US";

  let pendingRejectionHint = "";
  if (user?.id) {
    const since = new Date(Date.now() - PENDING_REJECTION_WINDOW_MS);
    const pending = await prisma.match.findFirst({
      where: {
        status: "cancelled",
        updatedAt: { gte: since },
        OR: [
          { userAId: user.id, acceptedByA: false, rejectionReasonA: null },
          { userBId: user.id, acceptedByB: false, rejectionReasonB: null },
        ],
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    if (pending) {
      pendingRejectionHint = pending.id;
    }
  }

  return {
    firstName: user?.firstName ?? "User",
    university: user?.universityDomain ?? "unknown",
    status: user?.status ?? "active",
    language: user?.language ?? "en",
    matchSummary,
    nextBatchDate: formatNextBatchDate(new Date(), undefined, locale),
    pendingRejectionHint,
  };
}

// ---------------------------------------------------------------------------
// Prompt Assembly
// ---------------------------------------------------------------------------

/**
 * Build the full dynamic system prompt for a post-onboarding user.
 *
 * Structure:
 *   [Base Persona]
 *   [--- Knowledge Base ---]
 *   [--- User Context ---]
 */
export async function buildSystemPrompt(telegramId: bigint): Promise<string> {
  const [knowledge, userCtx] = await Promise.all([
    fetchKnowledgeBase(),
    fetchUserContext(telegramId),
  ]);

  const pendingSection = userCtx.pendingRejectionHint
    ? `\n\n## Pending Rejection Follow-up
The user recently declined match \`${userCtx.pendingRejectionHint}\` and has not yet given a reason. Naturally steer the conversation toward what specifically didn't click — ask about looks, vibe, interests, or lifestyle. Keep it warm and curious, not interrogative. Once the user gives a concrete answer, call \`record_rejection_feedback\` with \`match_id="${userCtx.pendingRejectionHint}"\` and their reason as a full sentence. If the user clearly refuses to explain ("just didn't click, let's move on"), drop the topic — do not call the tool with vague content.`
    : "";

  const userSection = `## Current User Context
- Name: ${userCtx.firstName}
- University: ${userCtx.university}
- Account status: ${userCtx.status}
- Preferred language: ${userCtx.language}
- Match status: ${userCtx.matchSummary}
- Next match batch: ${userCtx.nextBatchDate}

Respond in the user's preferred language (${userCtx.language}) unless they switch.${pendingSection}`;

  return `${BASE_PERSONA}

## Product Knowledge Base
${knowledge}

${userSection}`;
}
