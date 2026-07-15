/**
 * Dynamic system prompt builder for the post-onboarding LLM Router.
 *
 * Assembles the prompt at runtime from three sources:
 *   1. Base persona (static)
 *   2. Database-driven Knowledge Base (SystemKnowledge table)
 *   3. User-specific context (profile, match state, next batch date)
 */

import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { formatNextBatchDate } from "./next-batch.js";
import {
  buildProductPlaybook,
  type PlaybookFeatures,
} from "./product-playbook.js";

// ---------------------------------------------------------------------------
// Base Persona (static)
// ---------------------------------------------------------------------------

const BASE_PERSONA = `You are the Gennety Dating assistant — the user's personal AI matchmaker: young, sharp, with quiet self-respect. A half-friend, half-acquaintance who is visibly good at his job.

## Your Role
- Answer questions about how Gennety works, when matches arrive, profile editing, and the whole dating process — accurately, using the Product Playbook and the user's live context below.
- Execute profile edits when the user asks (via tool calls).
- Be honest about what you can and can't do.
- You do NOT relay messages between users yourself and you do NOT hand out a partner's private contact directly. But when the product offers a sanctioned way to coordinate (see the Playbook), guide the user to it — don't pretend it doesn't exist.

## Conversation Style (see VOICE.md — source of truth)
- ONE voice: young and vibey, but a professional — finding this person a real date IS the job, and you're good at it. Confident, warm, lightly ironic, never cringe, never corporate. Short sentences; fragments are fine; one idea per message.
- BREVITY IS THE DEFAULT. 1–2 short sentences per reply; hard cap 3 unless the user explicitly asks you to explain in detail. No bullet lists unless asked. If your draft reads like a paragraph, cut it in half — twice.
- Write in chat bubbles: separate distinct thoughts with a BLANK line — each blank-line block is delivered as its own Telegram message. Most replies are ONE bubble. Two or three only when there genuinely are separate thoughts.
- **Never try to sound cool — you already are in the know. When in doubt, say it plainer.** Overdone slang reads as try-hard: one casual word per message max, usually zero. Understatement over hype — "неплохо. даже очень" beats "Это потрясающе!".
- Native & casual in the user's language. For Russian use informal "ты"; the same genuinely-native casual register for Ukrainian (ти), German (du), and Polish (ty) — never translated slang. Allowed seasoning: вайб/зайдёт/честно-tier words; banned: краш/слэй/база/сигма, rizz/slay/no cap, or their equivalents in any language.
- Chat-style lowercase sentence openings are fine and encouraged in short replies; keep names, places, and product terms capitalized.
- Mirror the user's energy and length; react to what they actually said. You always know the next step — state it plainly; never beg, gush, or over-apologize.
- Emoji are an accent, not punctuation: default is zero. Prefer ✨ for confirmations that genuinely land; occasionally 🍵 or 🤍 in a warm moment. Avoid ✅, 🔥, and emoji stacks. Max one per message.
- Adapt emphasis to the user's gender (see "Gender" in the context below) while keeping the SAME voice — do not become a different bot:
  - Women: lead with comfort, taste, and control; respect her standards; warm but never over-flatter or patronize.
  - Men: lead with clarity, momentum, and light ambition; direct and encouraging — never pushy or "pickup-artist".
- No gendered vocatives ("bro", "girl"), no corporate speak, no fake enthusiasm.`;

/** Read the live feature flags the playbook + context rendering depend on. */
function playbookFeatures(): PlaybookFeatures {
  return {
    coordination: env.COORDINATION_FEATURE_ENABLED === true,
    venueChange: env.VENUE_CHANGE_FEATURE_ENABLED === true,
    tickets: env.TICKET_FEATURE_ENABLED === true,
  };
}

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
  /** "male" | "female" | "unknown" — drives the per-gender tone delta (VOICE.md). */
  gender: string;
  university: string;
  status: string;
  language: string;
  matchSummary: string;
  nextBatchDate: string;
  /** Comma list of enabled optional features, e.g. "coordination, tickets". */
  enabledFeatures: string;
  /**
   * Non-empty when the user recently declined a match and has not yet given
   * a reason. The agent is expected to steer the conversation toward
   * collecting it and call `record_rejection_feedback`.
   */
  pendingRejectionHint: string;
}

/** How far back to look for an un-explained decline (24 hours). */
const PENDING_REJECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minutes before `agreedTime` the anonymous coordination chat opens (T-30m). */
const PROXY_OPEN_LEAD_MS = 30 * 60 * 1000;

/**
 * Flattened view of the user's single live match, side-resolved so `partner`
 * is always the OTHER person. Fields beyond `status` are best-effort — older
 * call sites / tests may not populate them, so every consumer guards for null.
 */
export interface ActiveMatchView {
  status: string;
  agreedTime: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  venueGoogleMapsUri: string | null;
  ticketStatus: string | null;
  coordOfferSentAt: Date | null;
  proxyOpenedAt: Date | null;
  proxyClosesAt: Date | null;
  proxyClosedAt: Date | null;
  venueChangeStatus: string | null;
  partnerFirstName: string | null;
}

/** Compact local clock label ("19:00"). */
function formatClock(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Full local date+time label ("Saturday, May 16, 19:00"). */
function formatWhen(date: Date, locale: string): string {
  return date.toLocaleString(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Human "time until" the date, e.g. "in ~4h", "in ~2 days", "~10 min ago". */
function humanizeUntil(target: Date, now: Date): string {
  const ms = target.getTime() - now.getTime();
  const future = ms >= 0;
  const absMin = Math.round(Math.abs(ms) / 60000);
  let phrase: string;
  if (absMin < 90) phrase = `${absMin} min`;
  else if (absMin < 48 * 60) phrase = `${Math.round(absMin / 60)}h`;
  else phrase = `${Math.round(absMin / (60 * 24))} days`;
  return future ? `in ~${phrase}` : `~${phrase} ago`;
}

/**
 * Render the live match into a multi-line context block the agent can reason
 * from. Flag-aware: coordination / ticket / venue-change lines only appear
 * when the corresponding feature is on. Leading phrases ("No active match.",
 * "Has a pending match proposal", "Date scheduled:") are kept stable because
 * other surfaces and tests key off them.
 */
export function describeActiveMatch(
  match: ActiveMatchView | null,
  now: Date,
  locale: string,
  features: PlaybookFeatures,
): string {
  if (!match) return "No active match. Waiting for the next weekly batch.";

  const partner = match.partnerFirstName ?? "their match";
  const lines: string[] = [];

  if (match.status === "proposed") {
    lines.push("Has a pending match proposal — waiting for accept/decline.");
    lines.push(`Partner: ${partner}. Has 24h from the proposal to decide; decision is blind and final.`);
    return lines.join("\n");
  }

  if (match.status === "negotiating") {
    lines.push("Match accepted by both sides — currently scheduling the date.");
    lines.push(`Partner: ${partner}. Both are marking availability in the Calendar Mini App.`);
    if (features.tickets && match.ticketStatus && match.ticketStatus !== "completed") {
      lines.push(`Date Ticket gate: ${match.ticketStatus} (Calendar unlocks once both tickets are settled).`);
    }
    return lines.join("\n");
  }

  if (match.status === "negotiating_venue") {
    lines.push("Match accepted — now choosing the meeting place.");
    lines.push(`Partner: ${partner}. Each submits a departure point (map) then a short vibe; the concierge then picks the venue.`);
    return lines.join("\n");
  }

  if (match.status === "scheduled") {
    const when = match.agreedTime ? formatWhen(match.agreedTime, locale) : "TBD";
    const venue = match.venueName ?? "TBD";
    lines.push(`Date scheduled: ${when} at ${venue}.`);
    lines.push(`Partner: ${partner}.`);
    if (match.agreedTime) {
      lines.push(`Time until the date: ${humanizeUntil(match.agreedTime, now)}.`);
    }
    if (match.venueAddress) lines.push(`Venue address: ${match.venueAddress}.`);
    if (match.venueGoogleMapsUri) {
      lines.push(`Venue map link exists (the "Open in Maps" button on their date card).`);
    }

    // Find-each-other status — the most-asked scheduled-stage question.
    if (features.coordination) {
      let coord: string;
      const proxyOpenNow =
        match.proxyOpenedAt != null &&
        match.proxyClosedAt == null &&
        match.proxyClosesAt != null &&
        match.proxyClosesAt.getTime() > now.getTime();
      if (proxyOpenNow) {
        coord = `the anonymous coordination chat is OPEN NOW (closes ${formatClock(
          match.proxyClosesAt!,
          locale,
        )}) — tell them to tap "Enter chat" to coordinate the exact spot.`;
      } else if (match.proxyClosedAt != null) {
        coord = `the coordination chat has closed.`;
      } else if (match.coordOfferSentAt != null) {
        coord = `the coordination offer was already sent (~1h before); the anonymous "Enter chat" opens ~30 min before the date.`;
      } else if (match.agreedTime != null) {
        const opensAt = new Date(match.agreedTime.getTime() - PROXY_OPEN_LEAD_MS);
        coord = `coordination opens automatically before the date — a contact-share option ~1h before, and an anonymous "Enter chat" button ~30 min before (around ${formatClock(
          opensAt,
          locale,
        )}).`;
      } else {
        coord = `coordination tools open automatically shortly before the date.`;
      }
      lines.push(`Find-each-other: ${coord}`);
    } else {
      lines.push(
        `Find-each-other: have them go to the venue pin ("Open in Maps") at the agreed time and look inside — it's a small, easy-to-find spot.`,
      );
    }

    if (features.venueChange && match.venueChangeStatus) {
      lines.push(`Venue change: status "${match.venueChangeStatus}".`);
    }
    return lines.join("\n");
  }

  return "No active match.";
}

/** Build the side-resolved view + select shape used to load the live match. */
const MATCH_CONTEXT_SELECT = {
  status: true,
  agreedTime: true,
  venueName: true,
  venueAddress: true,
  venueGoogleMapsUri: true,
  ticketStatus: true,
  coordOfferSentAt: true,
  proxyOpenedAt: true,
  proxyClosesAt: true,
  proxyClosedAt: true,
  venueChangeStatus: true,
} as const;

/** Live match statuses the concierge should be aware of. */
const ACTIVE_MATCH_STATUSES = [
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
] as const;

async function fetchUserContext(telegramId: bigint): Promise<UserContext> {
  const statusFilter = { status: { in: [...ACTIVE_MATCH_STATUSES] } };
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      gender: true,
      universityDomain: true,
      status: true,
      language: true,
      matchesAsA: {
        where: statusFilter,
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          ...MATCH_CONTEXT_SELECT,
          userB: { select: { firstName: true } },
        },
      },
      matchesAsB: {
        where: statusFilter,
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          ...MATCH_CONTEXT_SELECT,
          userA: { select: { firstName: true } },
        },
      },
    },
  });

  const asA = user?.matchesAsA?.[0] ?? null;
  const asB = user?.matchesAsB?.[0] ?? null;
  const raw = asA ?? asB;

  const features = playbookFeatures();
  const enabledFeatures =
    [
      features.coordination ? "coordination" : null,
      features.venueChange ? "venue change" : null,
      features.tickets ? "tickets" : null,
    ]
      .filter(Boolean)
      .join(", ") || "none";

  const locale =
    user?.language === "ru"
      ? "ru-RU"
      : user?.language === "uk"
        ? "uk-UA"
        : user?.language === "de"
          ? "de-DE"
          : user?.language === "pl"
            ? "pl-PL"
            : "en-US";

  const activeMatch: ActiveMatchView | null = raw
    ? {
        status: raw.status,
        agreedTime: raw.agreedTime ?? null,
        venueName: raw.venueName ?? null,
        venueAddress: raw.venueAddress ?? null,
        venueGoogleMapsUri: raw.venueGoogleMapsUri ?? null,
        ticketStatus: raw.ticketStatus ?? null,
        coordOfferSentAt: raw.coordOfferSentAt ?? null,
        proxyOpenedAt: raw.proxyOpenedAt ?? null,
        proxyClosesAt: raw.proxyClosesAt ?? null,
        proxyClosedAt: raw.proxyClosedAt ?? null,
        venueChangeStatus: raw.venueChangeStatus ?? null,
        partnerFirstName:
          (asA
            ? (asA as { userB?: { firstName: string | null } }).userB?.firstName
            : (asB as { userA?: { firstName: string | null } }).userA?.firstName) ??
          null,
      }
    : null;

  const matchSummary = describeActiveMatch(activeMatch, new Date(), locale, features);

  let pendingRejectionHint = "";
  if (user?.id) {
    const since = new Date(Date.now() - PENDING_REJECTION_WINDOW_MS);
    const pending = await prisma.match.findFirst({
      where: {
        status: { in: ["proposed", "cancelled", "expired"] },
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
    gender: user?.gender ?? "unknown",
    university: user?.universityDomain ?? "unknown",
    status: user?.status ?? "active",
    language: user?.language ?? "en",
    matchSummary,
    nextBatchDate: formatNextBatchDate(new Date(), undefined, locale),
    enabledFeatures,
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
 *   [--- Product Playbook (code-owned, flag-aware) ---]
 *   [--- Operator Knowledge Base (DB, optional) ---]
 *   [--- Current User Context (live, side-resolved match) ---]
 */
export async function buildSystemPrompt(telegramId: bigint): Promise<string> {
  const [knowledge, userCtx] = await Promise.all([
    fetchKnowledgeBase(),
    fetchUserContext(telegramId),
  ]);

  const playbook = buildProductPlaybook(playbookFeatures());

  const pendingSection = userCtx.pendingRejectionHint
    ? `\n\n## Pending Rejection Follow-up
The user recently declined match \`${userCtx.pendingRejectionHint}\` and has not yet given a reason. They may answer as typed text or as a voice note transcript. Naturally steer the conversation toward what specifically didn't click: looks, vibe, interests, or lifestyle. Keep it warm and curious, not interrogative. Once the user gives a concrete answer, call \`record_rejection_feedback\` with \`match_id="${userCtx.pendingRejectionHint}"\` and their reason as a full sentence. If the user clearly refuses to explain ("just didn't click, let's move on"), drop the topic — do not call the tool with vague content.`
    : "";

  const userSection = `## Current User Context
- Name: ${userCtx.firstName}
- Gender: ${userCtx.gender}
- University: ${userCtx.university}
- Account status: ${userCtx.status}
- Preferred language: ${userCtx.language}
- Next match batch: ${userCtx.nextBatchDate}
- Optional features enabled: ${userCtx.enabledFeatures}

### Live match status
${userCtx.matchSummary}

Respond in the user's preferred language (${userCtx.language}) unless they switch.${pendingSection}`;

  // The code-owned playbook is the primary product knowledge; the DB table is
  // optional operator-curated extras, appended only when non-empty.
  const knowledgeSection = knowledge.trim()
    ? `\n\n## Operator Knowledge Base (extra notes)\n${knowledge}`
    : "";

  return `${BASE_PERSONA}

## Product Playbook
${playbook}${knowledgeSection}

${userSection}`;
}
