import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { VOICE_CORE, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { openaiFetch } from "../services/openai-fetch.js";
import { PROPOSAL_TTL_MS } from "../utils/countdown-plate.js";
import { PAIR_NOT_BOTH_ACCEPTED } from "../utils/match-filters.js";
import { buildLocationMapKeyboard } from "../handlers/matching/venue-negotiation.js";
import {
  STALL_MATCH_SELECT,
  VENUE_NUDGE1_MS,
  VENUE_NUDGE2_MS,
  buildStallCheckInKeyboard,
  cancelStalledMatch,
  sideOwesAction,
  stallCheckInAskedAt,
  stallCheckInDueAt,
  stallDeadlineAt,
  stallPhaseOf,
  stallReachableFor,
  type MatchSide,
} from "../services/match-stall.js";
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
/**
 * Lead time before the 24h proposal TTL at which the deadline nudge fires.
 * With the hourly cron this 2h window guarantees at least one tick lands
 * inside `[deadline - 2h, deadline)`, so the "window closing" heads-up
 * always goes out to a still-undecided side before the row expires.
 */
export const PROPOSAL_DEADLINE_NUDGE_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface NudgeOptions {
  fetchFn?: typeof fetch;
  now?: Date;
  batchSize?: number;
}

export interface NudgeResult {
  proposalNudges: number;
  schedNudges: number;
  deadlineNudges: number;
  venueNudges: number;
  stallCheckIns: number;
  stallTimeouts: number;
}

const EMPTY_RESULT: NudgeResult = {
  proposalNudges: 0,
  schedNudges: 0,
  deadlineNudges: 0,
  venueNudges: 0,
  stallCheckIns: 0,
  stallTimeouts: 0,
};

export async function matchNudgeTick(
  api: Api<RawApi>,
  options: NudgeOptions = {},
): Promise<NudgeResult> {
  const now = options.now ?? new Date();
  // Quiet hours suppress the stall chain too, including the 48h cancellation:
  // that outcome is a real notification, so it waits for 09:00 like every other
  // one. A few hours of extra grace on a two-day deadline costs nothing.
  if (isQuietHours(now)) return { ...EMPTY_RESULT };

  const fetchFn = options.fetchFn ?? openaiFetch;
  const batchSize = options.batchSize ?? 50;

  const [proposalNudges, schedNudges, deadlineNudges, venueNudges, stall] = await Promise.all([
    handleProposalNudges(api, now, fetchFn, batchSize),
    handleSchedulingNudges(api, now, fetchFn, batchSize),
    handleDeadlineNudges(api, now, batchSize),
    handleVenueNudges(api, now, batchSize),
    handleStallChain(api, now, batchSize),
  ]);

  return {
    proposalNudges,
    schedNudges,
    deadlineNudges,
    venueNudges,
    stallCheckIns: stall.checkIns,
    stallTimeouts: stall.timeouts,
  };
}

// ---------------------------------------------------------------------------
// C) Deadline nudge — one heads-up ~2h before the 24h proposal TTL expires,
//    to any side that still hasn't decided. Anchored to the DEADLINE, not to
//    dispatch (unlike the 3h/10h proposal nudges above), so a user who lets
//    the window drift toward expiry gets a final, clearly-timed prompt. Copy
//    is static i18n (not LLM) so the "in ~Xh" number stays accurate.
// ---------------------------------------------------------------------------

async function handleDeadlineNudges(
  api: Api<RawApi>,
  now: Date,
  batchSize: number,
): Promise<number> {
  // dispatchedAt must sit in (now - TTL, now - TTL + lead]: newer than that
  // and the deadline is still >lead away; older and the row has expired (left
  // to the expiry job, which owns the terminal state + message overwrite).
  const earliestDispatch = new Date(now.getTime() - PROPOSAL_TTL_MS);
  const latestDispatch = new Date(
    now.getTime() - PROPOSAL_TTL_MS + PROPOSAL_DEADLINE_NUDGE_LEAD_MS,
  );

  const matches = await prisma.match.findMany({
    where: {
      status: "proposed",
      proposalDeadlineNudgeSentAt: null,
      dispatchedAt: { gt: earliestDispatch, lte: latestDispatch },
      // Null-safe "not both accepted" — a `NOT: { AND: [...] }` here would
      // drop precisely the silent pairs this nudge exists for. See
      // `utils/match-filters.ts`.
      ...PAIR_NOT_BOTH_ACCEPTED,
    },
    select: {
      id: true,
      dispatchedAt: true,
      acceptedByA: true,
      acceptedByB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    // One-shot claim so overlapping ticks can't double-send.
    const claim = await prisma.match.updateMany({
      where: {
        id: match.id,
        status: "proposed",
        proposalDeadlineNudgeSentAt: null,
      },
      data: { proposalDeadlineNudgeSentAt: now },
    });
    if (claim.count === 0) continue;

    const deadline = new Date(match.dispatchedAt!.getTime() + PROPOSAL_TTL_MS);
    const hoursLeft = Math.max(
      1,
      Math.round((deadline.getTime() - now.getTime()) / (60 * 60 * 1000)),
    );

    // Target only genuinely undecided Telegram sides. A side that already
    // declined committed irreversibly (row stays `proposed` under the blind
    // rule) — never nag them; an accepted side is done too.
    const targets: Array<{ telegramId: bigint; language: string | null }> = [];
    if (match.acceptedByA == null && match.userA.telegramId > 0n) {
      targets.push(match.userA);
    }
    if (match.acceptedByB == null && match.userB.telegramId > 0n) {
      targets.push(match.userB);
    }

    for (const target of targets) {
      const lang: Language = (target.language as Language) ?? "en";
      try {
        await api.sendMessage(
          Number(target.telegramId),
          t(lang, "pitchDeadlineNudge", { hours: hoursLeft }),
        );
        count++;
      } catch (err) {
        console.warn(
          `[match-nudge] deadline send failed for ${target.telegramId}:`,
          (err as Error).message,
        );
      }
    }
  }

  return count;
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
      // Null-safe "not both accepted" (see `utils/match-filters.ts`).
      ...PAIR_NOT_BOTH_ACCEPTED,
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
        model: MODELS.fast,
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
      // `negotiating` also covers the §3.5b Date Ticket gate, where the
      // Calendar has NOT been sent yet — nudging "pick a time" there points at
      // a screen the user doesn't have. Only `completed`/`refunded`/`expired`
      // mean scheduling is actually open.
      //
      // The flag guard is load-bearing, not defensive: `ticketStatus` defaults
      // to "pending" in the schema, and with TICKET_FEATURE_ENABLED off
      // `decision.ts` calls startScheduling directly and never advances it — so
      // an unconditional filter here would silently kill EVERY scheduling nudge.
      ...(env.TICKET_FEATURE_ENABLED
        ? { ticketStatus: { notIn: ["pending", "partial", "refund_pending"] } }
        : {}),
      // Two independent OR groups (availability + anchor), so they have to be
      // AND-ed explicitly — a second bare `OR` key would overwrite the first.
      AND: [
        // At least one side hasn't marked any availability yet. (`pickedTime*` is
        // the dead pre-2026-05 column — nothing writes it, so keying off it made
        // this always fire at BOTH sides, including one who had already picked.)
        { OR: [{ availableTimesA: { isEmpty: true } }, { availableTimesB: { isEmpty: true } }] },
        // Anchor on when the Calendar actually opened, not on dispatch. A pair
        // that accepted at hour 23 of the 24h decision window was already "6h
        // past dispatch", so the first nudge could land right behind the
        // Calendar card itself. Rows predating `schedulingOpenedAt` keep the old
        // dispatch anchor — a slightly early nudge beats none at all.
        {
          OR: [
            { schedulingOpenedAt: { lt: nudge1Cutoff } },
            { schedulingOpenedAt: null, dispatchedAt: { not: null, lt: nudge1Cutoff } },
          ],
        },
      ],
    },
    select: {
      id: true,
      dispatchedAt: true,
      schedulingOpenedAt: true,
      schedNudge1SentAt: true,
      schedNudge2SentAt: true,
      availableTimesA: true,
      availableTimesB: true,
      schedulingIteration: true,
      userA: { select: { telegramId: true, language: true, firstName: true } },
      userB: { select: { telegramId: true, language: true, firstName: true } },
    },
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    const anchor = match.schedulingOpenedAt ?? match.dispatchedAt!;
    const isNudge2 = anchor <= nudge2Cutoff && !match.schedNudge2SentAt;
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
      ...(match.availableTimesA.length === 0 && match.userA.telegramId > 0n ? [match.userA] : []),
      ...(match.availableTimesB.length === 0 && match.userB.telegramId > 0n ? [match.userB] : []),
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
        model: MODELS.fast,
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

// ---------------------------------------------------------------------------
// D) Venue nudges — the mirror of (B) for the departure-point + vibe step,
//    which had no reminder of any kind. Anchored on `venuePromptAskedAt`, the
//    moment the concierge actually asked, at the same 6h/12h cadence.
//
//    Static copy rather than an LLM line, because the useful part of this
//    message is the Mini App button next to it: the departure point can only be
//    marked on the map, so a generated sentence with no entry point would just
//    describe a screen the user can't reach from the chat.
// ---------------------------------------------------------------------------

async function handleVenueNudges(
  api: Api<RawApi>,
  now: Date,
  batchSize: number,
): Promise<number> {
  const nudge1Cutoff = new Date(now.getTime() - VENUE_NUDGE1_MS);
  const nudge2Cutoff = new Date(now.getTime() - VENUE_NUDGE2_MS);

  const matches = await prisma.match.findMany({
    where: {
      status: "negotiating_venue",
      venueNudge2SentAt: null,
      venuePromptAskedAt: { not: null, lt: nudge1Cutoff },
    },
    select: STALL_MATCH_SELECT,
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    const asked = match.venuePromptAskedAt!;
    const isNudge2 = asked <= nudge2Cutoff && !match.venueNudge2SentAt;
    const isNudge1 = !match.venueNudge1SentAt;
    const nudgeIndex = isNudge2 ? 2 : isNudge1 ? 1 : 0;
    if (nudgeIndex === 0) continue;

    const targets = (["A", "B"] as MatchSide[])
      .filter((side) => sideOwesAction(match, side))
      .map((side) => (side === "A" ? match.userA : match.userB))
      .filter((user) => stallReachableFor(user.telegramId));
    if (targets.length === 0) continue;

    const claim = await prisma.match.updateMany({
      where: {
        id: match.id,
        status: "negotiating_venue",
        ...(nudgeIndex === 2 ? { venueNudge2SentAt: null } : { venueNudge1SentAt: null }),
      },
      data: nudgeIndex === 2 ? { venueNudge2SentAt: now } : { venueNudge1SentAt: now },
    });
    if (claim.count === 0) continue;

    for (const target of targets) {
      const lang = (target.language ?? "en") as Language;
      try {
        await api.sendMessage(Number(target.telegramId), t(lang, "stallVenueNudge"), {
          reply_markup: buildLocationMapKeyboard(match.id, lang, target.theme),
        });
        count++;
      } catch (err) {
        console.warn(
          `[match-nudge] venue send failed for ${target.telegramId}:`,
          (err as Error).message,
        );
      }
    }
  }

  return count;
}

// ---------------------------------------------------------------------------
// E) Stall chain — the "still in?" check-in at 24h and the cancellation at 48h
//    for the two phases that otherwise never end (PRODUCT_SPEC §3.5c).
//
//    Both phases are handled in one pass because the question, the deadline and
//    the ownership predicate are identical; only the anchor and the wording
//    differ. Timeouts are evaluated BEFORE check-ins so a match already past
//    its deadline is never handed a fresh question on its way out.
// ---------------------------------------------------------------------------

async function handleStallChain(
  api: Api<RawApi>,
  now: Date,
  batchSize: number,
): Promise<{ checkIns: number; timeouts: number }> {
  const matches = await prisma.match.findMany({
    where: { status: { in: ["negotiating", "negotiating_venue"] } },
    select: STALL_MATCH_SELECT,
    orderBy: { createdAt: "asc" },
    take: batchSize,
  });

  let checkIns = 0;
  let timeouts = 0;

  for (const match of matches) {
    const phase = stallPhaseOf(match);
    // `negotiating` with no slots yet means the Date Ticket gate is still open;
    // its own expiry worker owns that wait, so there is nothing to stall on.
    if (!phase) continue;

    const owing = (["A", "B"] as MatchSide[]).filter((side) => sideOwesAction(match, side));
    if (owing.length === 0) continue;

    // Past the deadline on any owing side → the match ends here. The service
    // re-reads the row and re-checks reachability, so it is safe to just ask.
    const expired = owing.some((side) => {
      const deadline = stallDeadlineAt(match, side);
      return deadline !== null && deadline <= now;
    });
    if (expired) {
      const outcome = await cancelStalledMatch(api, match.id, now);
      if (outcome.cancelled) timeouts++;
      continue;
    }

    for (const side of owing) {
      const user = side === "A" ? match.userA : match.userB;
      // A side that cannot receive an inline keyboard is never asked, and
      // (see `cancelStalledMatch`) never timed out either.
      if (!stallReachableFor(user.telegramId)) continue;

      // Phase-scoped: a stamp left over from the scheduling step must not
      // suppress the venue step's question (see `stallCheckInAskedAt`).
      if (stallCheckInAskedAt(match, side)) continue;

      const due = stallCheckInDueAt(match, side);
      if (!due || due > now) continue;

      const claim = await prisma.match.updateMany({
        where: {
          id: match.id,
          status: match.status,
          ...(side === "A" ? { stallCheckInSentAtA: null } : { stallCheckInSentAtB: null }),
        },
        data: side === "A" ? { stallCheckInSentAtA: now } : { stallCheckInSentAtB: now },
      });
      if (claim.count === 0) continue;

      const partner = side === "A" ? match.userB : match.userA;
      const lang = (user.language ?? "en") as Language;
      const partnerLabel = partner.firstName ?? t(lang, "stallPartnerFallbackName");

      try {
        await api.sendMessage(
          Number(user.telegramId),
          t(lang, phase === "venue" ? "stallCheckInVenue" : "stallCheckInScheduling", {
            name: partnerLabel,
          }),
          { reply_markup: buildStallCheckInKeyboard(match.id, lang) },
        );
        checkIns++;
      } catch (err) {
        console.warn(
          `[match-nudge] stall check-in failed for ${user.telegramId}:`,
          (err as Error).message,
        );
        continue;
      }

      // Tell the side that DID their part that something is happening. This is
      // the whole reason the check-in exists: without it, doing everything right
      // and then waiting days is indistinguishable from the product being
      // broken. Skipped when both sides are quiet — nobody is owed an update on
      // a wait they are themselves causing.
      const partnerOwes = sideOwesAction(match, side === "A" ? "B" : "A");
      if (partnerOwes || !stallReachableFor(partner.telegramId)) continue;

      const partnerLang = (partner.language ?? "en") as Language;
      const askedLabel = user.firstName ?? t(partnerLang, "stallPartnerFallbackName");
      try {
        await api.sendMessage(
          Number(partner.telegramId),
          t(partnerLang, "stallPeerAsked", { name: askedLabel }),
        );
      } catch (err) {
        console.warn(
          `[match-nudge] stall peer notice failed for ${partner.telegramId}:`,
          (err as Error).message,
        );
      }
    }
  }

  return { checkIns, timeouts };
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
