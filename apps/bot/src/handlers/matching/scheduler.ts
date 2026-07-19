import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, tv, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { startVenueNegotiation } from "./venue-negotiation.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";
import { zonedParts, wallToUtc } from "../../services/profiler-schedule.js";
import {
  sendOrEditPostAcceptMessage,
  type PostAcceptSide,
} from "./post-accept-message.js";

/**
 * Calendar-only scheduler.
 *
 * Once both users have accepted the match the bot DMs each side a button
 * that opens the Calendar Mini App. Each user marks any number of slots
 * they're available; the partner sees those marks live and can either
 * tap one to lock in a compromise or propose alternatives. The earliest
 * non-empty intersection of `availableTimesA` and `availableTimesB`
 * agrees the date and advances to venue negotiation.
 *
 * The legacy three-iteration flow (two rounds of bot inline-keyboard
 * "single slot" picks before falling back to the Mini App) was removed
 * 2026-05-07 — it was strictly worse UX than going straight to a
 * peer-aware calendar.
 *
 * `proposedTimes` is still the server-side allowlist of valid slots
 * (the visible grid in the Mini App). It's the only timestamps that
 * `POST /v1/calendar/pick` will accept, which prevents clients from
 * smuggling in arbitrary timestamps.
 */

export const CALENDAR_DAY_COUNT = 6;

export const CALENDAR_TIME_SLOTS: ReadonlyArray<{ hour: number; minute: number }> = [
  { hour: 13, minute: 0 },
  { hour: 13, minute: 30 },
  { hour: 14, minute: 0 },
  { hour: 14, minute: 30 },
  { hour: 15, minute: 0 },
  { hour: 15, minute: 30 },
  { hour: 16, minute: 0 },
  { hour: 16, minute: 30 },
  { hour: 17, minute: 0 },
  { hour: 17, minute: 30 },
  { hour: 18, minute: 0 },
  { hour: 18, minute: 30 },
  { hour: 19, minute: 0 },
  { hour: 19, minute: 30 },
];

export const CALENDAR_SLOT_COUNT = CALENDAR_DAY_COUNT * CALENDAR_TIME_SLOTS.length;

/**
 * The calendar grid is rendered in the users' LOCAL time — Europe/Kyiv, the
 * product's single scheduling timezone (all current cities are Ukrainian; this
 * mirrors the hardcoded quiet-hours / cron timezone). Deliberately NOT the
 * server's own timezone: the droplet runs in UTC, so a bare `setHours(13)`
 * would write 13:00 UTC (≈16:00 Kyiv) and the "13:00" the user picked would
 * drift. We resolve each Kyiv wall-clock slot to its exact UTC instant instead.
 */
export const CALENDAR_TIME_ZONE = "Europe/Kyiv";

/**
 * Generate the calendar grid: the next `dayCount` consecutive days starting
 * tomorrow (in Europe/Kyiv), with fourteen exact time options per day (every
 * 30 min from 13:00 through 19:30 Kyiv local). No weekday filter — past UX
 * feedback was that skipping Sun/Mon pruned dates users actually preferred
 * (e.g. Sunday brunches, Monday holidays). 6 days is "next week's worth of
 * options"; the Mini App groups the exact DateTime allowlist into date → time
 * steps.
 *
 * Exported so tests can assert the shape — the Mini App reads the grid
 * from the server via `GET /v1/calendar/state`, no client-side mirror.
 */
export function generateProposalSlots(
  now: Date = new Date(),
  dayCount: number = CALENDAR_DAY_COUNT,
): Date[] {
  // Anchor date arithmetic at noon UTC of each Kyiv calendar day so stepping
  // forward never lands on a DST day boundary; `wallToUtc` then resolves each
  // slot's exact instant for that Kyiv date (DST-correct per day).
  const today = zonedParts(now, CALENDAR_TIME_ZONE);
  const anchor = Date.UTC(today.year, today.month - 1, today.day, 12, 0, 0);
  const out: Date[] = [];
  for (let day = 1; day <= dayCount; day++) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() + day); // day = 1 → tomorrow (Kyiv)
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dayOfMonth = d.getUTCDate();
    for (const slot of CALENDAR_TIME_SLOTS) {
      out.push(
        wallToUtc(year, month, dayOfMonth, slot.hour, slot.minute, CALENDAR_TIME_ZONE),
      );
    }
  }
  return out;
}

/** Short, language-aware slot label. Used by the stale-callback fallback. */
export function formatSlotLabel(slot: Date, lang: Language): string {
  const locale =
    lang === "ru"
      ? "ru-RU"
      : lang === "uk"
        ? "uk-UA"
        : lang === "de"
          ? "de-DE"
          : lang === "pl"
            ? "pl-PL"
            : "en-US";
  return slot.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Open-the-Mini-App button. */
export function buildCalendarKeyboard(
  webAppUrl: string,
  lang: Language,
): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().webApp(t(lang, "matchScheduleBtnCalendar"), webAppUrl);
  return { inline_keyboard: kb.inline_keyboard };
}

/**
 * Begin scheduling for a match that has just entered `negotiating`.
 * Generates the slot allowlist once per match (so both users see the
 * same grid) and DMs the calendar button to whichever side is
 * Telegram-resident. The Calendar card is a SEPARATE message from the
 * persistent ticket card (when the Date Ticket gate is on) — it follows it
 * rather than replacing it, so the ticket entry stays re-openable
 * (PRODUCT_SPEC §3.5b / §3.6).
 */
export async function startScheduling(
  api: Api<RawApi>,
  matchId: string,
  opts?: { afterTicketGate?: boolean; skipSide?: "A" | "B" },
): Promise<void> {
  // When the Calendar follows the persistent ticket card (ticket gate on), the
  // ticket card already celebrated the match — so the Calendar card uses a
  // plain "now pick your time" caption instead of repeating "It's mutual 🔥".
  // The no-ticket flow (Calendar is the first/only post-accept message) keeps
  // the celebratory caption. PRODUCT_SPEC §3.5b.
  const captionKey = opts?.afterTicketGate
    ? "matchScheduleAfterTicket"
    : "matchScheduleIter3";
  const slots = generateProposalSlots();
  await prisma.match.update({
    where: { id: matchId },
    data: {
      // Iteration tracking is legacy but retained until the cleanup
      // migration drops it; pinning to 3 keeps any code path that still
      // reads the column from interpreting the match as "iter-1 inline
      // keyboard" mid-deploy.
      schedulingIteration: 3,
      proposedTimes: slots,
      availableTimesA: [],
      availableTimesB: [],
    },
  });

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      calendarMessageIdA: true,
      calendarMessageIdB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;

  const sends: Array<Promise<unknown>> = [];
  if (opts?.skipSide !== "A") {
    sends.push(
      replaceCalendarMessage(
        api,
        matchId,
        "A",
        match.userA.telegramId,
        match.calendarMessageIdA,
        t(langA, captionKey),
        langA,
      ),
    );
  }
  if (opts?.skipSide !== "B") {
    sends.push(
      replaceCalendarMessage(
        api,
        matchId,
        "B",
        match.userB.telegramId,
        match.calendarMessageIdB,
        t(langB, captionKey),
        langB,
      ),
    );
  }
  await Promise.all(sends);
}

/**
 * Deliver (or refresh) the Calendar card for a SINGLE side. Used to hand the
 * covered partner her Calendar only after she's opened the "he paid your ticket
 * ❤️" reveal — `completeTicketGateAndUnlockScheduling` withholds her card via
 * `skipSide` and this delivers it later. The slot grid is already set by
 * `startScheduling`, so this only sends the card and never resets
 * `proposedTimes` / `availableTimes*` (the payer may have already picked times).
 */
export async function sendCalendarCard(
  api: Api<RawApi>,
  matchId: string,
  side: "A" | "B",
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      calendarMessageIdA: true,
      calendarMessageIdB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;
  const user = side === "A" ? match.userA : match.userB;
  const existingMsgId = side === "A" ? match.calendarMessageIdA : match.calendarMessageIdB;
  const lang = (user.language ?? "en") as Language;
  await replaceCalendarMessage(
    api,
    matchId,
    side,
    user.telegramId,
    existingMsgId,
    t(lang, "matchScheduleAfterTicket"),
    lang,
  );
}

function calendarUrl(matchId: string, lang: Language): string {
  return `${env.WEBAPP_URL}?match=${matchId}&lang=${lang}`;
}

/**
 * Keep one live post-accept CTA card per participant. The same message can
 * move from "accepted, waiting" → ticket gate → Calendar instead of stacking
 * separate status DMs in the chat.
 */
async function replaceCalendarMessage(
  api: Api<RawApi>,
  matchId: string,
  side: PostAcceptSide,
  telegramId: bigint,
  previousMessageId: number | null,
  text: string,
  lang: Language,
  resend = false,
): Promise<void> {
  if (!isTelegramTarget(telegramId)) return;

  const options = {
    reply_markup: buildCalendarKeyboard(calendarUrl(matchId, lang), lang),
  };

  await sendOrEditPostAcceptMessage({
    api,
    matchId,
    side,
    telegramId,
    previousMessageId,
    text,
    options,
    forceResend: resend,
  });
}

async function deleteCalendarMessages(
  api: Api<RawApi>,
  targets: ReadonlyArray<{ telegramId: bigint; messageId: number | null }>,
): Promise<void> {
  await Promise.all(
    targets.map(async ({ telegramId, messageId }) => {
      if (messageId === null || !isTelegramTarget(telegramId)) return;
      await api.deleteMessage(Number(telegramId), messageId).catch(() => {});
    }),
  );
}

export type CalendarPickResult =
  | {
      ok: false;
      reason:
        | "invalid-iso"
        | "match-not-found"
        | "wrong-state"
        | "invalid-slot"
        | "user-not-found"
        | "not-participant";
    }
  | {
      ok: true;
      mySlots: string[];
      peerSlots: string[];
      agreedTime: string | null;
      /**
       * Set when the post-update intersection has *more than one* shared
       * slot. The Mini App shows a "pick the final one" confirm card to
       * the actor; tapping a slot triggers a re-POST with that single
       * iso, which collapses the intersection to size 1 and auto-locks.
       * Empty / single-element intersections never produce candidates
       * (the empty case has nothing to confirm; the single case auto-locks).
       */
      overlapCandidates: string[];
      bothPicked: boolean;
    };

/**
 * Apply a calendar update for one side. Replaces that side's
 * availability set with `pickedIsos` and routes on the post-update
 * intersection size:
 *
 *   - **0 overlaps**: nothing locks. If this was the actor's first
 *     non-empty submission and the peer hasn't picked yet, DM the peer
 *     once with the calendar button. If both sides now have non-empty
 *     sets that don't intersect, DM both about the miss so neither
 *     stays in the dark waiting.
 *   - **1 overlap**: auto-lock that slot and advance to venue
 *     negotiation (the "instant agree" fast path).
 *   - **>1 overlaps**: do NOT auto-lock — return `overlapCandidates`
 *     so the Mini App can show a confirm card. The actor picks the
 *     final slot (single re-POST), which collapses to a 1-overlap and
 *     hits the lock path. The asymmetry "initiator offers, responder
 *     decides" is a deliberate UX rule (PRODUCT_SPEC.md §3.6).
 *
 * Empty `pickedIsos` is allowed — that's the user clearing their
 * availability before reopening the picker.
 */
export async function processCalendarSlotsUpdate(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  pickedIsos: string[],
): Promise<CalendarPickResult> {
  const picks: Date[] = [];
  for (const iso of pickedIsos) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { ok: false, reason: "invalid-iso" };
    picks.push(d);
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      status: true,
      proposedTimes: true,
      availableTimesA: true,
      availableTimesB: true,
      calendarMessageIdA: true,
      calendarMessageIdB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return { ok: false, reason: "match-not-found" };
  if (match.status !== "negotiating") return { ok: false, reason: "wrong-state" };

  const allowed = new Set(match.proposedTimes.map((d) => d.getTime()));
  for (const p of picks) {
    if (!allowed.has(p.getTime())) return { ok: false, reason: "invalid-slot" };
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return { ok: false, reason: "user-not-found" };

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  // Deduplicate + sort ascending so the array on disk is stable and the
  // "earliest common slot" rule is straight-forward downstream.
  const dedupedSorted = Array.from(
    new Map(picks.map((d) => [d.getTime(), d])).values(),
  ).sort((a, b) => a.getTime() - b.getTime());

  const actorPrev = isA ? match.availableTimesA : match.availableTimesB;
  const wasMineEmpty = actorPrev.length === 0;
  await prisma.match.update({
    where: { id: match.id },
    data: isA
      ? { availableTimesA: dedupedSorted }
      : { availableTimesB: dedupedSorted },
  });

  // Re-read the peer side after our write. The initial row may be stale if
  // both users saved concurrently; using it can miss a real overlap and
  // leave the match stuck until somebody saves again.
  const current = await prisma.match.findUnique({
    where: { id: match.id },
    select: {
      status: true,
      availableTimesA: true,
      availableTimesB: true,
    },
  });
  if (!current || current.status !== "negotiating") {
    return { ok: false, reason: "wrong-state" };
  }

  const peerArr = isA ? current.availableTimesB : current.availableTimesA;
  const peerSet = new Set(peerArr.map((d) => d.getTime()));
  const intersection = dedupedSorted
    .filter((d) => peerSet.has(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  const peerLang = ((isA ? match.userB.language : match.userA.language) ?? "en") as Language;
  const peerTelegramId = isA ? match.userB.telegramId : match.userA.telegramId;
  const actorLang = (user.language ?? "en") as Language;
  const actorTelegramId = telegramId;

  if (intersection.length === 1) {
    const agreed = intersection[0]!;
    await startVenueNegotiation(api, match.id, agreed);
    await deleteCalendarMessages(api, [
      {
        telegramId: match.userA.telegramId,
        messageId: match.calendarMessageIdA,
      },
      {
        telegramId: match.userB.telegramId,
        messageId: match.calendarMessageIdB,
      },
    ]);
    return {
      ok: true,
      mySlots: dedupedSorted.map((d) => d.toISOString()),
      peerSlots: peerArr.map((d) => d.toISOString()),
      agreedTime: agreed.toISOString(),
      overlapCandidates: [],
      bothPicked: true,
    };
  }

  if (intersection.length > 1) {
    // Multiple shared slots — let the actor pick the final one via the
    // Mini App confirm card. Don't DM yet; the actor is still in the
    // Mini App and the next POST will resolve to a single overlap.
    return {
      ok: true,
      mySlots: dedupedSorted.map((d) => d.toISOString()),
      peerSlots: peerArr.map((d) => d.toISOString()),
      agreedTime: null,
      overlapCandidates: intersection.map((d) => d.toISOString()),
      bothPicked: true,
    };
  }

  // intersection.length === 0
  if (
    wasMineEmpty &&
    dedupedSorted.length > 0 &&
    peerArr.length === 0
  ) {
    // Actor's first non-empty submission AND peer hasn't picked yet.
    // Ping peer once with the calendar button + send the actor a
    // confirmation receipt that lands behind the (still-open) Mini App
    // so it's visible the moment they close it. Subsequent updates rely
    // on the Mini App's polling + the match-nudge cron.
    const sends: Array<Promise<unknown>> = [];
    if (isTelegramTarget(peerTelegramId)) {
      sends.push(
        replaceCalendarMessage(
          api,
          matchId,
          isA ? "B" : "A",
          peerTelegramId,
          isA ? match.calendarMessageIdB : match.calendarMessageIdA,
          t(peerLang, "matchSchedulePeerProposed"),
          peerLang,
          true, // delete old card + send fresh so the peer is actually notified
        ).catch(() => {}),
      );
    }
    if (isTelegramTarget(actorTelegramId)) {
      sends.push(
        api
          .sendMessage(
            Number(actorTelegramId),
            tv(actorLang, "matchScheduleSavedConfirmation"),
          )
          .catch(() => {}),
      );
    }
    await Promise.all(sends);
  } else if (
    dedupedSorted.length > 0 &&
    peerArr.length > 0 &&
    !sameSet(dedupedSorted, actorPrev)
  ) {
    // Idempotency note: re-saving the *same* set after a prior no-overlap
    // state would otherwise re-DM the peer on every redundant Save tap.
    // Gate on actor's set actually changing.
    // Both sides have submitted, but no shared slot exists. The actor
    // sees the counter-proposal state inside the Mini App; the peer needs
    // the Telegram nudge because their partner changed the negotiation.
    const sends: Array<Promise<unknown>> = [];
    if (isTelegramTarget(peerTelegramId)) {
      sends.push(
        replaceCalendarMessage(
          api,
          matchId,
          isA ? "B" : "A",
          peerTelegramId,
          isA ? match.calendarMessageIdB : match.calendarMessageIdA,
          t(peerLang, "matchSchedulePeerSuggestedAlternative"),
          peerLang,
          true, // delete old card + send fresh so the peer is actually notified
        ).catch(() => {}),
      );
    }
    await Promise.all(sends);
  }

  return {
    ok: true,
    mySlots: dedupedSorted.map((d) => d.toISOString()),
    peerSlots: peerArr.map((d) => d.toISOString()),
    agreedTime: null,
    overlapCandidates: [],
    bothPicked: peerArr.length > 0 && dedupedSorted.length > 0,
  };
}

/** Treat two `Date[]` as set-equal under `getTime()` semantics. */
function sameSet(a: Date[], b: Date[]): boolean {
  if (a.length !== b.length) return false;
  const ai = new Set(a.map((d) => d.getTime()));
  for (const d of b) if (!ai.has(d.getTime())) return false;
  return true;
}

/**
 * Read calendar state for the Mini App's GET /v1/calendar/state endpoint.
 * Returns the slot allowlist plus *both* sides' selections so the Mini
 * App can render peer-only / mine / overlap visuals and decide whether
 * to show the "your partner suggested times" banner.
 */
export type CalendarStateResult =
  | { ok: false; reason: "match-not-found" | "wrong-state" | "user-not-found" | "not-participant" }
  | {
      ok: true;
      proposedTimes: string[];
      mySlots: string[];
      peerSlots: string[];
      agreedTime: string | null;
      isFirstMover: boolean;
    };

export async function getCalendarState(
  telegramId: bigint,
  matchId: string,
): Promise<CalendarStateResult> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userAId: true,
      userBId: true,
      status: true,
      proposedTimes: true,
      availableTimesA: true,
      availableTimesB: true,
      agreedTime: true,
    },
  });
  if (!match) return { ok: false, reason: "match-not-found" };

  // Reading is allowed for `negotiating` (the active state) and the
  // brief moment after agreement before the venue flow lands. Anything
  // beyond that — completed, cancelled, expired — surfaces as
  // wrong-state so the Mini App shows "calendar closed".
  if (
    match.status !== "negotiating" &&
    match.status !== "negotiating_venue" &&
    match.status !== "scheduled"
  ) {
    return { ok: false, reason: "wrong-state" };
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true },
  });
  if (!user) return { ok: false, reason: "user-not-found" };

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  const mine = isA ? match.availableTimesA : match.availableTimesB;
  const peer = isA ? match.availableTimesB : match.availableTimesA;

  return {
    ok: true,
    proposedTimes: match.proposedTimes.map((d) => d.toISOString()),
    mySlots: mine.map((d) => d.toISOString()),
    peerSlots: peer.map((d) => d.toISOString()),
    agreedTime: match.agreedTime?.toISOString() ?? null,
    isFirstMover: peer.length === 0,
  };
}

/**
 * Stale-callback fallback. Pre-2026-05 `negotiating` matches were sent
 * inline-keyboard buttons with `sched:pick:*` callback data. Rather
 * than silently swallowing taps from in-flight matches mid-deploy, we
 * acknowledge the click and re-deliver the calendar Mini App button.
 */
export async function handleSchedulePick(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("sched:pick:")) return;
  await ctx.answerCallbackQuery();

  const matchId = data.split(":")[2];
  if (!matchId) return;

  const lang = ctx.session.language;
  await ctx.reply(t(lang, "matchScheduleIter3"), {
    reply_markup: buildCalendarKeyboard(calendarUrl(matchId, lang), lang),
  });
}

/**
 * Legacy `web_app_data` consumer. Mini Apps opened from a reply
 * keyboard or inline mode deliver picks via this channel; the
 * production launch path (InlineKeyboardButton's `web_app` field)
 * uses the HTTP endpoint instead because `Telegram.WebApp.sendData`
 * is silently a no-op there. Kept for forward compatibility.
 */
export async function handleCalendarWebAppData(ctx: BotContext): Promise<void> {
  const dataStr = ctx.message?.web_app_data?.data;
  if (!dataStr) return;
  if (!ctx.from?.id) return;

  let parsed: { matchId?: string; pickedIsos?: string[]; pickedIso?: string };
  try {
    parsed = JSON.parse(dataStr);
  } catch {
    return;
  }
  if (!parsed.matchId) return;

  // Accept either the new array shape or a single ISO from older
  // Mini App bundles still in the wild.
  const isos = Array.isArray(parsed.pickedIsos)
    ? parsed.pickedIsos
    : typeof parsed.pickedIso === "string"
      ? [parsed.pickedIso]
      : null;
  if (!isos) return;

  await processCalendarSlotsUpdate(
    ctx.api,
    BigInt(ctx.from.id),
    parsed.matchId,
    isos,
  );
}
