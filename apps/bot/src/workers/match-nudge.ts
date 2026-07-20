import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { VOICE_CORE } from "@gennety/shared";
import { env } from "../config.js";
import { openaiFetch } from "../services/openai-fetch.js";
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
 * Quiet hours (23:00–09:00 Europe/Kyiv) block all sends.
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

  const fetchFn = options.fetchFn ?? openaiFetch;
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

  // Fetch proposed matches eligible for at least nudge 1. C-6: use the
  // phase-specific columns so a leftover nudge stamp from a different phase
  // (no longer possible after the split, but kept for clarity) can't gate us.
  const matches = await prisma.match.findMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null, lt: nudge1Cutoff },
      proposalNudge2SentAt: null, // haven't sent the final nudge yet
      NOT: { AND: [{ acceptedByA: true }, { acceptedByB: true }] },
    },
    select: {
      id: true,
      dispatchedAt: true,
      proposalNudge1SentAt: true,
      proposalNudge2SentAt: true,
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
    const isNudge2Eligible =
      dispatched <= nudge2Cutoff && !match.proposalNudge2SentAt;
    const isNudge1Eligible = !match.proposalNudge1SentAt;

    // Determine which nudge index to fire (2 takes priority if both eligible).
    const nudgeIndex = isNudge2Eligible ? 2 : isNudge1Eligible ? 1 : 0;
    if (nudgeIndex === 0) continue;

    const claim = await prisma.match.updateMany({
      where: {
        id: match.id,
        status: "proposed",
        ...(nudgeIndex === 2
          ? { proposalNudge2SentAt: null }
          : { proposalNudge1SentAt: null }),
      },
      data:
        nudgeIndex === 2
          ? { proposalNudge2SentAt: now }
          : { proposalNudge1SentAt: now },
    });
    if (claim.count === 0) continue;

    const targets: Array<{
      telegramId: bigint;
      language: string | null;
      firstName: string | null;
      pitch: string | null;
    }> = [];

    if (!match.acceptedByA && match.userA.telegramId > 0n) {
      targets.push({ ...match.userA, pitch: match.pitchForA });
    }
    if (!match.acceptedByB && match.userB.telegramId > 0n) {
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

  const prompt = `${VOICE_CORE}

Right now you're doing ONE thing: this user got a match proposal and hasn't replied yet. Send a single short nudge back to it — the same voice you'd use in any normal chat, not a "campaign" blast.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- Nudge type: ${urgency}
- ${pitchSnippet}

Write it in ${lang}. 1–2 short sentences, one idea. Reference the pitch lightly if it helps. Understated and warm, never pushy — like texting a friend who forgot to reply. No deadline-as-threat, no "hurry!". Emoji default is ZERO (at most one, only ✨/🍵/🤍, and only if it truly lands).

CRITICAL: Use strictly gender-neutral language. We do NOT know the user's gender. In Russian/Ukrainian/Polish, avoid gendered past-tense verb forms (e.g. do NOT use «ответил/ответила», «відповів/відповіла», "odpowiedział/odpowiedziała"). Use impersonal or infinitive constructions instead (e.g. «ответа пока нет», «нема відповіді», "brak odpowiedzi").

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
        temperature: 0.7,
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

// VOICE.md: understatement over hype — no exclamation-mark hype, no 👀/⏰,
// no deadline-as-threat. Gender-neutral (no gendered past-tense forms), native
// per language, all five covered so de/pl never fall back to English.
function getProposalFallback(name: string, lang: string, nudge: number): string {
  const g = name ? ` ${name}` : "";
  const lead = name ? `${name}, ` : "";
  switch (lang) {
    case "ru":
      return nudge === 1
        ? `эй${g}, нашёл тебе пару — ответа пока нет. глянешь, когда будет минута?`
        : `${lead}матч всё ещё ждёт ответа. без спешки, но окно скоро закроется.`;
    case "uk":
      return nudge === 1
        ? `гей${g}, знайшов тобі пару — відповіді ще немає. глянеш, коли буде хвилинка?`
        : `${lead}матч ще чекає відповіді. без поспіху, але вікно скоро закриється.`;
    case "de":
      return nudge === 1
        ? `hey${g}, hab ein Match für dich — noch keine Antwort. schaust du mal rein?`
        : `${lead}dein Match wartet noch auf eine Antwort. kein Stress, aber das Fenster schließt bald.`;
    case "pl":
      return nudge === 1
        ? `hej${g}, mam dla ciebie dopasowanie — jeszcze bez odpowiedzi. zerkniesz, gdy masz chwilę?`
        : `${lead}twoje dopasowanie wciąż czeka na odpowiedź. bez pośpiechu, ale okno niedługo się zamknie.`;
    default:
      return nudge === 1
        ? `hey${g}, found you a match — no reply yet. want to take a look?`
        : `${lead}your match is still waiting for an answer. no rush, but the window closes soon.`;
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

  // C-6 changes:
  //   1. Use phase-specific schedNudge*SentAt columns so proposal-phase
  //      stamps (now in proposalNudge*SentAt) don't gate us.
  //   2. Anchor on `dispatchedAt` instead of `updatedAt`. `updatedAt` was
  //      bumped each time we wrote a nudge stamp, which reset the 12h cutoff
  //      and broke the documented 6h/12h cadence.
  const matches = await prisma.match.findMany({
    where: {
      status: "negotiating",
      schedNudge2SentAt: null,
      // At least one side hasn't picked a slot yet.
      OR: [{ pickedTimeA: null }, { pickedTimeB: null }],
      dispatchedAt: { not: null, lt: nudge1Cutoff },
    },
    select: {
      id: true,
      dispatchedAt: true,
      schedNudge1SentAt: true,
      schedNudge2SentAt: true,
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
    const dispatched = match.dispatchedAt!;
    const isNudge2 =
      dispatched <= nudge2Cutoff && !match.schedNudge2SentAt;
    const isNudge1 = !match.schedNudge1SentAt;
    const nudgeIndex = isNudge2 ? 2 : isNudge1 ? 1 : 0;
    if (nudgeIndex === 0) continue;

    const claim = await prisma.match.updateMany({
      where: {
        id: match.id,
        status: "negotiating",
        ...(nudgeIndex === 2
          ? { schedNudge2SentAt: null }
          : { schedNudge1SentAt: null }),
      },
      data:
        nudgeIndex === 2
          ? { schedNudge2SentAt: now }
          : { schedNudge1SentAt: now },
    });
    if (claim.count === 0) continue;

    const targets = [
      ...(match.pickedTimeA == null && match.userA.telegramId > 0n ? [match.userA] : []),
      ...(match.pickedTimeB == null && match.userB.telegramId > 0n ? [match.userB] : []),
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

  const prompt = `${VOICE_CORE}

Right now you're doing ONE thing: two people matched and both said yes, but this user hasn't picked a meeting time yet. Send a single short nudge to pick a time — the same voice you'd use in any normal chat.

User info:
- Name: ${name || "unknown"}
- Language: ${lang}
- ${calendarHint}

Write it in ${lang}. 1–2 short sentences, one idea. Understated and warm, never nagging — the time is on them, whenever there's a minute. Emoji default is ZERO (at most one, only ✨/🍵/🤍, and only if it lands).

CRITICAL: Use strictly gender-neutral language (we do NOT know the user's gender). In Russian/Ukrainian/Polish avoid gendered past-tense verb forms — use impersonal or infinitive constructions.

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
        temperature: 0.7,
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

// VOICE.md §9: the nudge is understated, not an imperative with ⏰ — "the time
// is on you". All five languages covered so de/pl never fall back to English.
function getSchedulingFallback(name: string, lang: string): string {
  const g = name ? `${name}, ` : "";
  switch (lang) {
    case "ru":
      return `${g}время всё ещё за тобой — открой календарь, когда будет минута.`;
    case "uk":
      return `${g}час усе ще за тобою — відкрий календар, коли буде хвилинка.`;
    case "de":
      return `${g}die Zeit liegt bei dir — mach den Kalender auf, wenn du kurz Zeit hast.`;
    case "pl":
      return `${g}termin zależy od ciebie — otwórz kalendarz, gdy masz chwilę.`;
    default:
      return `${g}the time's on you — open the calendar whenever there's a minute.`;
  }
}
