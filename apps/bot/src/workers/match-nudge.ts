import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { CADENCE, VOICE_CORE, t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { MODELS } from "../models.js";
import { openaiFetch } from "../services/openai-fetch.js";
import { deadlineFor } from "../services/proposal-deadline.js";
import { sendPushToUser } from "../services/push.js";
import { pushReachable, telegramReachable } from "../services/telegram-reach.js";
import { PAIR_NOT_BOTH_ACCEPTED } from "../utils/match-filters.js";
import { buildLocationMapKeyboard } from "../handlers/matching/venue-negotiation.js";
import { buildCalendarCta } from "../handlers/matching/scheduler.js";
import {
  STALL_MATCH_SELECT,
  VENUE_NUDGE1_MS,
  VENUE_NUDGE2_MS,
  buildStallCheckInKeyboard,
  cancelStalledMatch,
  schedulingOwedKind,
  sideOwesAction,
  stallCheckInAskedAt,
  stallCheckInDueAt,
  stallDeadlineAt,
  stallPhaseOf,
  stallReachableFor,
  type MatchSide,
  type SchedulingOwed,
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
 *    - Nudge 1: ≥6h after the Calendar opened, schedNudge1SentAt is null.
 *    - Nudge 2: ≥12h after it, schedNudge2SentAt is null.
 *    Sent to whichever side still owes the move — either it never opened the
 *    calendar, or both picked and nothing lines up (`schedulingOwedKind`). The
 *    second case is why this is a reminder rather than the §3.6b shimmer: when
 *    the next move is the user's own, a "we're coordinating" status tells them
 *    to sit still while the flow is blocked on them.
 *
 * Quiet hours (23:00–09:00 Europe/Kyiv) block all sends — **including the
 * pushes**. These reminders are ordinary notifications with no claim on
 * someone's night, so the guard sits at the top of the tick, before any query.
 *
 * All three cadences reach BOTH surfaces. Until then each of them collected its
 * recipients with `telegramId > 0n`, which is two separate questions collapsed
 * into one filter: WHO is owed the reminder (whose move is it) and WHICH RAIL
 * reaches them. That collapse is the defect §5.4 fixed on the safety brief — a
 * person living in the app was dropped entirely, and a person who signed in
 * through Telegram (a REAL positive id on an account the bot cannot message,
 * §1.1) was dropped on a rail that reported success. The predicates deciding
 * whose move it is are untouched here; only the rail is.
 */

/**
 * Nudge offsets, sourced from the active `CADENCE` profile (weekly values
 * below are unchanged from the old hardcoded constants: 3h/10h proposal,
 * 6h/12h scheduling; daily halves both to keep the same "roughly a third and
 * two-thirds of the way to the deadline" shape over a shorter window).
 */
export const PROPOSAL_NUDGE1_MS = CADENCE.proposalNudgeOffsetsMs[0];
export const PROPOSAL_NUDGE2_MS = CADENCE.proposalNudgeOffsetsMs[1];
export const SCHED_NUDGE1_MS = CADENCE.schedNudgeOffsetsMs[0];
export const SCHED_NUDGE2_MS = CADENCE.schedNudgeOffsetsMs[1];
/**
 * Lead time before the reply deadline at which the deadline nudge fires.
 * With the hourly cron this window guarantees at least one tick lands
 * inside `[deadline - lead, deadline)`, so the "window closing" heads-up
 * always goes out to a still-undecided side before the row expires.
 */
export const PROPOSAL_DEADLINE_NUDGE_LEAD_MS = CADENCE.proposalDeadlineNudgeLeadMs;

/**
 * Push types for the three reminder cadences. These match the client's
 * `PushPayload` type strings, and the type is also what `buildAlertPayload`
 * derives the APNs category from — so it is contract, not a label.
 *
 * **None of them is time-sensitive** (`TIME_SENSITIVE_PUSH_TYPES`, which stays a
 * closed set of two): a reminder inside a day-long decision window is not
 * urgency, and under a daily cadence it would pierce Focus every evening.
 * **None of them carries an action button** either — the next step is "open the
 * app", which an ordinary notification already is.
 */
export const MATCH_NUDGE_PUSH_TYPE = "match.nudge";
export const PLANNING_NUDGE_PUSH_TYPE = "match.planning";
export const DEADLINE_NUDGE_PUSH_TYPE = "match.deadline";

/**
 * Run one recipient's rails and report whether ANY of them landed.
 *
 * Each leg catches its own failure, so a blocked Telegram chat can never take
 * the push down with it — and neither can take down the idempotency stamp,
 * which was claimed before any of this ran.
 *
 * The boolean is what all three counters are denominated in: **people told, not
 * messages sent**. A `both` user is one reminder delivered twice, not two
 * reminders; counting legs would double them and quietly break comparison with
 * every day before this change, which is the only thing these numbers are for.
 */
async function anyRailLanded(legs: Array<Promise<boolean>>): Promise<boolean> {
  if (legs.length === 0) return false;
  return (await Promise.all(legs)).some(Boolean);
}

export interface NudgeOptions {
  fetchFn?: typeof fetch;
  now?: Date;
  batchSize?: number;
}

export interface NudgeResult {
  /**
   * The three two-rail cadences count **people reminded**, not messages sent —
   * a `both` user who got a DM and a push is one. A recipient whose every rail
   * failed counts as zero, exactly as a failed DM always did. `venueNudges` and
   * the stall counters are single-rail and unchanged.
   */
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
  // Deadline isn't a fixed offset from dispatchedAt under every cadence
  // profile (services/proposal-deadline.ts), so it can't be pushed into a
  // single dispatchedAt range filter the way "TTL - lead .. TTL" could. Filter
  // by status only (a `proposed` row is naturally bounded by the live pool —
  // see the identical reasoning in match-expiry.ts's expireStaleMatches) and
  // check `deadlineFor` per candidate in memory.
  const matches = await prisma.match.findMany({
    where: {
      status: "proposed",
      proposalDeadlineNudgeSentAt: null,
      dispatchedAt: { not: null },
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
      // `id` is the internal `User.id` that `sendPushToUser` takes (never the
      // telegramId), and `platform` is the rail. Neither was selected while
      // this cadence only ever produced a DM.
      userA: { select: { id: true, telegramId: true, platform: true, language: true } },
      userB: { select: { id: true, telegramId: true, platform: true, language: true } },
    },
  });

  let count = 0;
  let matchesProcessed = 0;

  for (const match of matches) {
    const deadline = deadlineFor(match.dispatchedAt!);
    // Due when the deadline is still ahead but within the lead window —
    // newer (>lead away) is too early; already past is the expiry job's job.
    const dueSoon =
      deadline.getTime() > now.getTime() &&
      deadline.getTime() <= now.getTime() + PROPOSAL_DEADLINE_NUDGE_LEAD_MS;
    if (!dueSoon) continue;
    if (matchesProcessed >= batchSize) break;
    matchesProcessed++;

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

    const hoursLeft = Math.max(
      1,
      Math.round((deadline.getTime() - now.getTime()) / (60 * 60 * 1000)),
    );

    // Target only genuinely undecided sides. A side that already declined
    // committed irreversibly (row stays `proposed` under the blind rule) —
    // never nag them; an accepted side is done too. That is WHO; the rail each
    // of them is told on is the separate question answered per leg below.
    const targets: Array<{
      id: string;
      telegramId: bigint;
      platform: string | null;
      language: string | null;
    }> = [];
    if (match.acceptedByA == null) targets.push(match.userA);
    if (match.acceptedByB == null) targets.push(match.userB);

    for (const target of targets) {
      const lang: Language = (target.language as Language) ?? "en";
      const legs: Promise<boolean>[] = [];

      if (telegramReachable(target)) {
        legs.push(
          api
            .sendMessage(
              Number(target.telegramId),
              t(lang, "pitchDeadlineNudge", { hours: hoursLeft }),
            )
            .then(() => true)
            .catch((err: unknown) => {
              console.warn(
                `[match-nudge] deadline send failed for ${target.telegramId}:`,
                err instanceof Error ? err.message : err,
              );
              return false;
            }),
        );
      }

      if (pushReachable(target)) {
        legs.push(
          sendPushToUser(target.id, {
            title: t(lang, "deadlineNudgePushTitle"),
            // The same figure the DM quotes. One deadline, one number — a push
            // and a DM disagreeing about how long is left is worse than either
            // alone.
            body: t(lang, "deadlineNudgePushBody", { hours: hoursLeft }),
            data: { type: DEADLINE_NUDGE_PUSH_TYPE, matchId: match.id },
          }).catch((err: unknown) => {
            console.warn(
              `[match-nudge] deadline push failed for ${target.id}:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }),
        );
      }

      if (await anyRailLanded(legs)) count++;
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
      // `id` (the internal `User.id` `sendPushToUser` takes) and `platform`
      // (the rail) — neither was selected while this cadence was DM-only.
      userA: {
        select: { id: true, telegramId: true, platform: true, language: true, firstName: true },
      },
      userB: {
        select: { id: true, telegramId: true, platform: true, language: true, firstName: true },
      },
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
      id: string;
      telegramId: bigint;
      platform: string | null;
      language: string | null;
      firstName: string | null;
      pitch: string | null;
    }> = [];

    // Not having accepted is WHO is owed the reminder — unchanged. The rail is
    // decided per leg below; folding `telegramId > 0n` in here is what dropped
    // every app-side recipient of this cadence.
    if (!match.acceptedByA) targets.push({ ...match.userA, pitch: match.pitchForA });
    if (!match.acceptedByB) targets.push({ ...match.userB, pitch: match.pitchForB });

    for (const target of targets) {
      const lang: Language = (target.language as Language) ?? "en";
      const legs: Promise<boolean>[] = [];

      if (telegramReachable(target)) {
        legs.push(
          (async () => {
            const text = await generateProposalNudge({ ...target, nudgeIndex }, fetchFn);
            await api.sendMessage(Number(target.telegramId), text, {
              parse_mode: "Markdown",
            });
            return true;
          })().catch((err: unknown) => {
            console.warn(
              `[match-nudge] proposal send failed for ${target.telegramId}:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }),
        );
      }

      if (pushReachable(target)) {
        // Static copy on this rail, deliberately: the generated line is written
        // for a chat the reader is already in, and a lock screen is public.
        legs.push(
          sendPushToUser(target.id, {
            title: t(lang, "matchNudgePushTitle"),
            body: t(lang, "matchNudgePushBody"),
            data: { type: MATCH_NUDGE_PUSH_TYPE, matchId: match.id },
          }).catch((err: unknown) => {
            console.warn(
              `[match-nudge] proposal push failed for ${target.id}:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }),
        );
      }

      if (await anyRailLanded(legs)) count++;
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

  // C-6: phase-specific schedNudge*SentAt columns, so a proposal-phase stamp
  // (now in proposalNudge*SentAt) can't gate us. The anchor moved off
  // `updatedAt` in the same pass — writing a nudge stamp bumped it, which reset
  // the 12h cutoff and broke the documented 6h/12h cadence.
  const matches = await prisma.match.findMany({
    where: {
      status: "negotiating",
      schedNudge2SentAt: null,
      // Anchor on when the Calendar actually opened, not on dispatch. A pair
      // that accepted at hour 23 of the 24h decision window was already "6h
      // past dispatch", so the first nudge could land right behind the
      // Calendar card itself. Rows predating `schedulingOpenedAt` keep the old
      // dispatch anchor — a slightly early nudge beats none at all.
      OR: [
        { schedulingOpenedAt: { lt: nudge1Cutoff } },
        { schedulingOpenedAt: null, dispatchedAt: { not: null, lt: nudge1Cutoff } },
      ],
    },
    // Same select the stall chain uses, so "whose move is it" is answered by
    // ONE predicate (`sideOwesAction`) across the reminder, the check-in and
    // the cancellation instead of three queries with three ideas about it.
    select: {
      ...STALL_MATCH_SELECT,
      // Widened locally, additively, on top of the shared select: `platform` is
      // the rail and this cadence now has two of them. `STALL_MATCH_SELECT`
      // itself is NOT edited — the check-in and the 48h cancellation read it
      // too — and the extra field changes nothing for `stallPhaseOf` /
      // `schedulingOwedKind`, which never look at the participants.
      userA: { select: { ...STALL_MATCH_SELECT.userA.select, platform: true } },
      userB: { select: { ...STALL_MATCH_SELECT.userB.select, platform: true } },
      schedulingIteration: true,
      schedNudge1SentAt: true,
      schedNudge2SentAt: true,
    },
    take: batchSize,
  });

  let count = 0;

  for (const match of matches) {
    // `negotiating` also covers the §3.5b Date Ticket gate, where the Calendar
    // has NOT been sent yet — nudging "pick a time" there points at a screen
    // the user doesn't have. `stallPhaseOf` discriminates on `proposedTimes`,
    // which `startScheduling` writes when (and only when) the Calendar opens;
    // `ticketStatus` cannot be used, since it defaults to "pending" even with
    // the ticket feature switched off entirely.
    if (stallPhaseOf(match) !== "scheduling") continue;

    const owing = (["A", "B"] as MatchSide[])
      .map((side) => ({ side, owed: schedulingOwedKind(match, side) }))
      .filter((entry): entry is { side: MatchSide; owed: SchedulingOwed } => entry.owed !== null)
      .map((entry) => ({ ...entry, user: entry.side === "A" ? match.userA : match.userB }))
      // NOT `stallReachableFor`. That predicate is right for the stall chain,
      // whose question is an inline keyboard in a Telegram chat that an app user
      // has nothing to answer with — but a reminder is just a reminder, and it
      // reaches the app perfectly well. `schedulingOwedKind` above already said
      // whose move it is; this only drops someone no rail can reach at all.
      .filter(({ user }) => telegramReachable(user) || pushReachable(user));
    // Nobody reachable → no claim, so the stamp is not spent on a reminder that
    // was never sent and the next tick re-evaluates. Deliberately unlike the
    // two proposal-phase cadences, whose claim is upstream of their recipient
    // list; both orderings are pre-existing and neither is changed here.
    if (owing.length === 0) continue;

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

    for (const { owed, user } of owing) {
      const lang = (user.language ?? "en") as Language;
      const legs: Promise<boolean>[] = [];

      if (telegramReachable(user)) {
        legs.push(
          (async () => {
            if (owed === "no-overlap") {
              // Static copy + the way in, exactly like the venue nudge. A
              // generated "pick a time" line would be flatly wrong here — this
              // person DID pick; what they need is to widen the selection or
              // take one of the partner's slots, and the Calendar card scrolled
              // away hours ago.
              await api.sendMessage(Number(user.telegramId), t(lang, "matchScheduleNoOverlapYet"), {
                reply_markup: buildCalendarCta(match.id, lang, user.theme),
              });
            } else {
              const text = await generateSchedulingNudge(
                { ...user, nudgeIndex, iteration: match.schedulingIteration },
                fetchFn,
              );
              await api.sendMessage(Number(user.telegramId), text, { parse_mode: "Markdown" });
            }
            return true;
          })().catch((err: unknown) => {
            console.warn(
              `[match-nudge] scheduling send failed for ${user.telegramId}:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }),
        );
      }

      if (pushReachable(user)) {
        // ONE copy for both `owed` branches, and that is a constraint on the
        // copy rather than a shortcut: it has to be true whether the calendar
        // was never opened or both picked and nothing lined up. So it says
        // "open the calendar", never "pick a time".
        legs.push(
          sendPushToUser(user.id, {
            title: t(lang, "planningNudgePushTitle"),
            body: t(lang, "planningNudgePushBody"),
            data: { type: PLANNING_NUDGE_PUSH_TYPE, matchId: match.id },
          }).catch((err: unknown) => {
            console.warn(
              `[match-nudge] scheduling push failed for ${user.id}:`,
              err instanceof Error ? err.message : err,
            );
            return false;
          }),
        );
      }

      if (await anyRailLanded(legs)) count++;
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
