import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { isQuietHours } from "./quiet-hours.js";

/**
 * Match nudge worker — proactively reminds users who haven't responded.
 *
 * Two scenarios are handled in one tick:
 *
 * A) PROPOSAL nudges (status = 'proposed'):
 *    - Nudge 1: ≥3h after dispatchedAt, nudge1SentAt is null → first reminder.
 *    - Nudge 2: ≥10h after dispatchedAt, nudge2SentAt is null → second reminder.
 *    Only the user(s) who haven't yet accepted are messaged.
 *    The pitch they received is passed as context to OpenAI.
 *
 * B) SCHEDULING nudges (status = 'negotiating', both accepted, slot not yet agreed):
 *    - Nudge 1: ≥6h since last update, nudge1SentAt is null.
 *    - Nudge 2: ≥12h since last update, nudge2SentAt is null.
 *
 * Quiet hours (23:00–09:00 UTC) block all sends.
 */

export const PROPOSAL_NUDGE1_MS = 3 * 60 * 60 * 1000;   //  3 hours
export const PROPOSAL_NUDGE2_MS = 10 * 60 * 60 * 1000;  // 10 hours
export const SCHED_NUDGE1_MS   = 6 * 60 * 60 * 1000;   //  6 hours
export const SCHED_NUDGE2_MS   = 12 * 60 * 60 * 1000;  // 12 hours

export interface NudgeOptions {
  fetchFn?: typeof fetch;
  now?: Date;
  batchSize?: number;
}

export interface NudgeResult {
  proposalNudges: number;
  schedNudges: number;
}

export async function matchNudgeTick(
  api: Api<RawApi>,
  options: NudgeOptions = {},
): Promise<NudgeResult> {
  const now = options.now ?? new Date();
  if (isQuietHours(now)) return { proposalNudges: 0, schedNudges: 0 };

  const fetchFn = options.fetchFn ?? fetch;
  const batchSize = options.batchSize ?? 50;

  const [proposalNudges, schedNudges] = await Promise.all([
    handleProposalNudges(api, now, fetchFn, batchSize),
    handleSchedulingNudges(api, now, fetchFn, batchSize),
  ]);

  return { proposalNudges, schedNudges };
}

// ---------------------------------------------------------------------------
// A) Proposal nudges
// ---------------------------------------------------------------------------

async function handleProposalNudges(
  api: Api<RawApi>,
  now: Date,
  fetchFn: typeof fetch,
  batchSize: number,
): Promise<number> {
  const nudge1Cutoff = new Date(now.getTime() - PROPOSAL_NUDGE1_MS);
  const nudge2Cutoff = new Date(now.getTime() - PROPOSAL_NUDGE2_MS);

  // Fetch proposed matches eligible for at least nudge 1.
  const matches = await prisma.match.findMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null, lt: nudge1Cutoff },
      nudge2SentAt: null, // haven't sent the final nudge yet
      NOT: { AND: [{ acceptedByA: true }, { acceptedByB: true }] },
    },
    select: {
      id: true,
      dispatchedAt: true,
      nudge1SentAt: true,
      nudge2SentAt: true,
      acceptedByA: true,
      acceptedByB: true,
      pitchForA: true,
      pitchForB: true,
      userA: { select: { telegramId: true, language: true, firstName: true } },
      userB: { select: { telegramId: true, language: true, firstName: true } },
    },
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    const dispatched = match.dispatchedAt!;
    const isNudge2Eligible = dispatched <= nudge2Cutoff && !match.nudge2SentAt;
    const isNudge1Eligible = !match.nudge1SentAt;

    // Determine which nudge index to fire (2 takes priority if both eligible).
    const nudgeIndex = isNudge2Eligible ? 2 : isNudge1Eligible ? 1 : 0;
    if (nudgeIndex === 0) continue;

    const targets: Array<{
      telegramId: bigint;
      language: string | null;
      firstName: string | null;
      pitch: string | null;
    }> = [];

    if (!match.acceptedByA) {
      targets.push({ ...match.userA, pitch: match.pitchForA });
    }
    if (!match.acceptedByB) {
      targets.push({ ...match.userB, pitch: match.pitchForB });
    }

    for (const target of targets) {
      try {
        const text = await generateProposalNudge(
          { ...target, nudgeIndex },
          fetchFn,
        );
        await api.sendMessage(Number(target.telegramId), text, {
          parse_mode: "Markdown",
        });
        count++;
      } catch (err) {
        console.warn(
          `[match-nudge] proposal send failed for ${target.telegramId}:`,
          (err as Error).message,
        );
      }
    }

    // Stamp whichever nudge we just sent.
    await prisma.match.update({
      where: { id: match.id },
      data:
        nudgeIndex === 2
          ? { nudge2SentAt: now }
          : { nudge1SentAt: now },
    });
  }

  return count;
}

async function generateProposalNudge(
  params: {
    firstName: string | null;
    language: string | null;
    pitch: string | null;
    nudgeIndex: number;
  },
  fetchFn: typeof fetch,
): Promise<string> {
  const lang = params.language ?? "en";
  const name = params.firstName ?? "";
  const pitchSnippet = params.pitch
    ? `What we told them about their match: "${params.pitch.slice(0, 300)}"`
    : "(pitch not available)";

  const urgency =
    params.nudgeIndex === 1
      ? "casual first check-in"
      : "gentle second reminder — they still haven't replied";

  const prompt = `You are Gennety Dating's assistant. A user received a match proposal but hasn't responded.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- Nudge type: ${urgency}
- ${pitchSnippet}

Write a SHORT message (1-2 sentences) reminding them to check their match. Reference the pitch context if it helps. 1 emoji max. Write in ${lang}.

Tone: warm, curious, never pushy. Like texting a friend who forgot to reply.

CRITICAL: Use strictly gender-neutral language. We do NOT know the user's gender. In Russian/Ukrainian, avoid gendered past-tense verb forms (e.g. do NOT use «ответил/ответила», «відповів/відповіла» etc.). Use impersonal or infinitive constructions instead (e.g. «ответа ещё нет», «нема відповіді»).

Output ONLY the message text.`;

  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_completion_tokens: 120,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return (
      json.choices?.[0]?.message?.content?.trim() ??
      getProposalFallback(name, lang, params.nudgeIndex)
    );
  } catch {
    return getProposalFallback(name, lang, params.nudgeIndex);
  }
}

function getProposalFallback(name: string, lang: string, nudge: number): string {
  const greeting = name ? `${lang === "ru" ? "Эй" : lang === "uk" ? "Гей" : "Hey"}, ${name}!` : (lang === "ru" ? "Эй!" : lang === "uk" ? "Гей!" : "Hey!");
  switch (lang) {
    case "ru":
      return nudge === 1
        ? `${greeting} Мы нашли для тебя пару — ответа пока нет 👀`
        : `${greeting} Не забудь — мэтч всё ещё ждёт. Загляни, пока не истёк срок!`;
    case "uk":
      return nudge === 1
        ? `${greeting} Ми знайшли для тебе пару — відповіді ще немає 👀`
        : `${greeting} Не забудь — мэтч досі чекає. Зазирни, поки не закінчився термін!`;
    default:
      return nudge === 1
        ? `${greeting} We found you a match — no response yet 👀`
        : `${greeting} Just a reminder — your match is still waiting. Don't let it expire!`;
  }
}

// ---------------------------------------------------------------------------
// B) Scheduling nudges
// ---------------------------------------------------------------------------

async function handleSchedulingNudges(
  api: Api<RawApi>,
  now: Date,
  fetchFn: typeof fetch,
  batchSize: number,
): Promise<number> {
  const nudge1Cutoff = new Date(now.getTime() - SCHED_NUDGE1_MS);
  const nudge2Cutoff = new Date(now.getTime() - SCHED_NUDGE2_MS);

  const matches = await prisma.match.findMany({
    where: {
      status: "negotiating",
      nudge2SentAt: null,
      // At least one side hasn't picked a slot yet.
      OR: [{ pickedTimeA: null }, { pickedTimeB: null }],
      updatedAt: { lt: nudge1Cutoff },
    },
    select: {
      id: true,
      updatedAt: true,
      nudge1SentAt: true,
      nudge2SentAt: true,
      pickedTimeA: true,
      pickedTimeB: true,
      schedulingIteration: true,
      userA: { select: { telegramId: true, language: true, firstName: true } },
      userB: { select: { telegramId: true, language: true, firstName: true } },
    },
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    const isNudge2 = match.updatedAt <= nudge2Cutoff && !match.nudge2SentAt;
    const isNudge1 = !match.nudge1SentAt;
    const nudgeIndex = isNudge2 ? 2 : isNudge1 ? 1 : 0;
    if (nudgeIndex === 0) continue;

    const targets = [
      ...(match.pickedTimeA == null ? [match.userA] : []),
      ...(match.pickedTimeB == null ? [match.userB] : []),
    ];

    for (const target of targets) {
      try {
        const text = await generateSchedulingNudge(
          { ...target, nudgeIndex, iteration: match.schedulingIteration },
          fetchFn,
        );
        await api.sendMessage(Number(target.telegramId), text, {
          parse_mode: "Markdown",
        });
        count++;
      } catch (err) {
        console.warn(
          `[match-nudge] scheduling send failed for ${target.telegramId}:`,
          (err as Error).message,
        );
      }
    }

    await prisma.match.update({
      where: { id: match.id },
      data: nudgeIndex === 2 ? { nudge2SentAt: now } : { nudge1SentAt: now },
    });
  }

  return count;
}

async function generateSchedulingNudge(
  params: {
    firstName: string | null;
    language: string | null;
    nudgeIndex: number;
    iteration: number;
  },
  fetchFn: typeof fetch,
): Promise<string> {
  const lang = params.language ?? "en";
  const name = params.firstName ?? "";
  const calendarHint =
    params.iteration >= 3
      ? "They need to open the calendar in the Mini App to pick a time."
      : "They need to pick one of the proposed time slots.";

  const prompt = `You are Gennety Dating's assistant. Two people matched and accepted each other, but one hasn't picked a meeting time yet.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- ${calendarHint}

Write a SHORT nudge (1-2 sentences) reminding them to pick a time. Friendly, not nagging. 1 emoji max. Write in ${lang}.

Output ONLY the message text.`;

  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.8,
        max_completion_tokens: 100,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI ${res.status}`);

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    return (
      json.choices?.[0]?.message?.content?.trim() ??
      getSchedulingFallback(name, lang)
    );
  } catch {
    return getSchedulingFallback(name, lang);
  }
}

function getSchedulingFallback(name: string, lang: string): string {
  const g = name ? `${name}, ` : "";
  switch (lang) {
    case "ru":
      return `${g}не забудь выбрать время для встречи ⏰`;
    case "uk":
      return `${g}не забудь обрати час для зустрічі ⏰`;
    default:
      return `${g}don't forget to pick a meeting time ⏰`;
  }
}
