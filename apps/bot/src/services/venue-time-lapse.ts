import type { Api, RawApi } from "grammy";
import { prisma, type Prisma } from "@gennety/db";
import {
  t,
  VENUE_FINALIZE_MIN_LEAD_MS,
  VENUE_LAPSE_SWEEP_BATCH,
  type Language,
} from "@gennety/shared";
import { telegramReachable } from "./telegram-reach.js";
import { toTelegramChatId } from "../utils/telegram-target.js";
import { sendPushToUser } from "./push.js";

/**
 * The venue stage outliving its own date (A13-H5).
 *
 * `negotiating_venue` has no deadline, and the only past-time guard used to sit
 * where the time is LOCKED (`startVenueNegotiation`). Every finalizer checked
 * merely that an `agreedTime` existed, so a pair that locked 13:30 at noon and
 * confirmed their venue at 14:00 was `scheduled` for a date that had already
 * happened: no pre-date rails (they all filter `agreedTime > now`), a "how did
 * it go?" a day later, and tickets that are never refunded because nothing was
 * ever cancelled.
 *
 * The outcome is the one the calendar would have given them had it known: back
 * to picking a time, with a fresh grid. Not a cancellation — both people are
 * still in, they simply ran out of clock.
 */

/** Is there still enough runway to lock a venue for this date? */
export function venueSlotStillAhead(agreedTime: Date, now: Date = new Date()): boolean {
  return agreedTime.getTime() > now.getTime() + VENUE_FINALIZE_MIN_LEAD_MS;
}

/** The latest `agreedTime` that no longer leaves enough runway. */
export function venueLapseThreshold(now: Date = new Date()): Date {
  return new Date(now.getTime() + VENUE_FINALIZE_MIN_LEAD_MS);
}

/**
 * A confirmed Venue Intent V2 snapshot turned back into a draft, or undefined
 * when there is nothing to demote.
 *
 * Kept rather than wiped: the origin and chips are still true of these two
 * people, and the Mini App restores a draft on reopen — so re-entering the venue
 * stage costs one Confirm, not the whole form. Demoted rather than left
 * confirmed, because a confirmation is the trigger for selection: a row that
 * re-enters the stage already "confirmed" by both would never be finalized by
 * anyone, and the stall chain would read it as nobody owing anything.
 */
function demoteConfirmedIntent(value: Prisma.JsonValue | null): Prisma.InputJsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (value.state !== "confirmed") return undefined;
  return { ...value, state: "draft", confirmedAt: null };
}

const PARTICIPANT_SELECT = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
} as const;

/**
 * Send a `negotiating_venue` match whose time has run out back to the calendar.
 * Returns whether THIS call moved it.
 *
 * Compare-and-set on the status AND on the exact lapsed `agreedTime` it read, so
 * a venue lock, a cancellation or a second sweep racing it wins or loses
 * cleanly, and only the winner messages anyone.
 *
 * The write clears everything the venue stage collected on the legacy columns
 * (both write paths mirror onto them, and they are what "this side still owes
 * a submission" is read from), demotes V2 intents to drafts, resets the retry
 * state and the one-shot reminder stamps of both phases, and EMPTIES the grid:
 * `startScheduling` opens a fresh one only on an empty `proposedTimes`, and it
 * is what stamps the new `schedulingOpenedAt` the stall chain counts from.
 *
 * Needs the Bot API, because the pair must be handed a calendar in the same
 * breath. Without one it moves nothing and returns false — the periodic sweep,
 * which always has it, picks the row up on its next tick.
 */
export async function returnLapsedVenueStageToCalendar(
  matchId: string,
  options: { api?: Api<RawApi> | null; now?: Date } = {},
): Promise<boolean> {
  const now = options.now ?? new Date();
  const api =
    options.api !== undefined ? options.api : (await import("../public/server.js")).getBotApi();
  if (!api) return false;

  const row = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      agreedTime: true,
      venueIntentA: true,
      venueIntentB: true,
      userAId: true,
      userBId: true,
      userA: { select: PARTICIPANT_SELECT },
      userB: { select: PARTICIPANT_SELECT },
    },
  });
  if (!row || row.status !== "negotiating_venue" || !row.agreedTime) return false;
  if (venueSlotStillAhead(row.agreedTime, now)) return false;

  const demotedA = demoteConfirmedIntent(row.venueIntentA);
  const demotedB = demoteConfirmedIntent(row.venueIntentB);
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating_venue", agreedTime: row.agreedTime },
    data: {
      status: "negotiating",
      agreedTime: null,
      venuePromptAskedAt: null,
      vibeTextA: null,
      vibeTextB: null,
      vibeLatA: null,
      vibeLngA: null,
      vibeLatB: null,
      vibeLngB: null,
      vibeAddressA: null,
      vibeAddressB: null,
      parsedCategoryA: null,
      parsedCategoryB: null,
      ...(demotedA ? { venueIntentA: demotedA } : {}),
      ...(demotedB ? { venueIntentB: demotedB } : {}),
      venueSelectionAttempts: 0,
      venueSelectionError: null,
      venueSelectionNextRetryAt: null,
      venueNudge1SentAt: null,
      venueNudge2SentAt: null,
      schedNudge1SentAt: null,
      schedNudge2SentAt: null,
      proposedTimes: [],
      availableTimesA: [],
      availableTimesB: [],
      calendarMessageIdA: null,
      calendarMessageIdB: null,
    },
  });
  if (claim.count === 0) return false;

  console.warn(
    `[venue-time-lapse] ${matchId}: agreedTime ${row.agreedTime.toISOString()} ran out during venue selection — back to the calendar`,
  );

  // The explanation lands BEFORE the calendar card, so the card reads as the
  // answer to it rather than as the flow inexplicably starting over.
  await Promise.all(
    [row.userA, row.userB].map(async (user) => {
      const text = t((user.language ?? "en") as Language, "venueTimeLapsedBackToCalendar");
      if (telegramReachable(user)) {
        await api.sendMessage(toTelegramChatId(user.telegramId), text).catch((err: unknown) => {
          console.warn(`[venue-time-lapse] notice failed for ${matchId}:`, err);
        });
      }
      if (user.platform === "mobile" || user.platform === "both") {
        await sendPushToUser(user.id, {
          title: "Gennety",
          body: text,
          data: { type: "match.both_accepted", matchId },
        }).catch(() => false);
      }
    }),
  );

  // Dynamic: the scheduler imports the venue-negotiation handler, which imports
  // this module — a static import would close that cycle.
  const { startScheduling } = await import("../handlers/matching/scheduler.js");
  await startScheduling(api, matchId, { afterTicketGate: true }).catch((err: unknown) => {
    console.error(`[venue-time-lapse] reopening the calendar failed for ${matchId}:`, err);
  });
  const { refreshStatusBanners } = await import("./status-banner-refresh.js");
  await refreshStatusBanners(api, [row.userAId, row.userBId]).catch(() => undefined);
  return true;
}

/**
 * The sweep for pairs nobody is acting on: a `negotiating_venue` row whose time
 * ran out while one side never confirmed, or while a retry was still pending,
 * would otherwise be noticed only by a finalizer that never runs again. Oldest
 * date first. Registered on the date-lifecycle tick (`index.ts`).
 */
export async function sweepLapsedVenueNegotiations(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<number> {
  const due = await prisma.match.findMany({
    where: { status: "negotiating_venue", agreedTime: { lte: venueLapseThreshold(now) } },
    orderBy: { agreedTime: "asc" },
    take: VENUE_LAPSE_SWEEP_BATCH,
    select: { id: true },
  });
  let returned = 0;
  for (const row of due) {
    try {
      if (await returnLapsedVenueStageToCalendar(row.id, { api, now })) returned += 1;
    } catch (err) {
      // One row's failure must not strand the rest of the batch behind it.
      console.error(`[venue-time-lapse] sweep failed for ${row.id}:`, err);
    }
  }
  return returned;
}
