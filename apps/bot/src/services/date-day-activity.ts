import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { sendLiveActivityStartToUser, sendLiveActivityUpdateToUser } from "./push.js";

/**
 * The «date day» Live Activity (IOS_APP_ROADMAP §4.1 / iOS task 4.2).
 *
 * Telegram gets the same beats as chat messages; iOS gets them on the lock
 * screen, driven from here. Every function below is a no-op for a user with no
 * registered token, which is the ordinary state for a Telegram-only account —
 * so these calls are safe to sprinkle through the date lifecycle without
 * branching on platform.
 *
 * **Nothing here identifies the partner.** The lock screen is a public surface:
 * anyone who picks the phone up off a table sees it. What it carries is the
 * PLACE and the TIME, which is the whole utility of the card ("where am I
 * going, how long do I have"), and no name, age or photo. Same rule as the
 * decision activity (§4.1), where the answer was to carry nothing at all.
 */

/**
 * The Swift `ActivityAttributes` type name, verbatim. ActivityKit matches a
 * push-to-start payload to a configuration by this string and silently drops
 * anything it cannot resolve, so renaming the struct on the client without
 * changing this constant produces a feature that fails in complete silence.
 */
export const DATE_DAY_ATTRIBUTES_TYPE = "DateDayActivity";

/**
 * Stages, in the order the lifecycle fires them.
 *
 * Two deliberate absences:
 *
 * - **`meeting` is not a stage at all.** The client marks the activity stale
 *   at `agreedTime` and the system re-renders it into the "you're there" look
 *   by itself — no push, so it still happens with the app killed, the network
 *   down and the phone in a pocket. A push for a transition the clock already
 *   describes would be a worse implementation, not a more complete one.
 * - **`chat_open` is declared but never sent yet.** The pre-date proxy chat
 *   exists only on Telegram (iOS task 4.5), so announcing "the chat is open"
 *   on a lock screen the app cannot follow up on would be the dead-button
 *   anti-pattern with extra steps. Wire it from `closeProxies`' sibling in
 *   `services/coordination.ts` when the native chat screen lands.
 */
export type DateDayStage = "icebreakers" | "wingman" | "chat_open";

/** The activity's immutable half — settled by the time it starts. */
interface DateDayAttributes {
  matchId: string;
  /** Unix seconds. The countdown the system runs on its own. */
  startsAt: number;
  venueName: string;
  venueAddress: string;
  /** Deep link straight to Maps. Empty string when the venue has no URI. */
  mapsUrl: string;
}

interface DateDayMatchRow {
  id: string;
  agreedTime: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  venueGoogleMapsUri: string | null;
  userA: { id: string; language: string | null };
  userB: { id: string; language: string | null };
}

const MATCH_SELECT = {
  id: true,
  agreedTime: true,
  venueName: true,
  venueAddress: true,
  venueGoogleMapsUri: true,
  userA: { select: { id: true, language: true } },
  userB: { select: { id: true, language: true } },
} as const;

function attributesFor(match: DateDayMatchRow, startsAt: Date): DateDayAttributes {
  return {
    matchId: match.id,
    startsAt: Math.floor(startsAt.getTime() / 1000),
    venueName: match.venueName ?? "",
    venueAddress: match.venueAddress ?? "",
    mapsUrl: match.venueGoogleMapsUri ?? "",
  };
}

/**
 * Push-to-start both sides' activity at the T-5h gate.
 *
 * Fired from the ice-breaker step, which already claims its own idempotency
 * marker, so this runs exactly once per match. A second start push would
 * anyway be harmless — ActivityKit replaces rather than duplicates — but the
 * user-visible alert would fire twice, which is not.
 */
export async function startDateDayActivities(
  matchId: string,
  now: Date = new Date(),
): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;
  // A date that has already begun gets no card: the activity exists to carry
  // the hours before it, and starting one late would open on the stale look.
  if (match.agreedTime.getTime() <= now.getTime()) return;

  const attributes = attributesFor(match, match.agreedTime);
  const staleDate = Math.floor(match.agreedTime.getTime() / 1000);

  await Promise.all(
    [match.userA, match.userB].map((user) => {
      const lang = (user.language ?? "en") as Language;
      return sendLiveActivityStartToUser(user.id, "date_day", {
        attributesType: DATE_DAY_ATTRIBUTES_TYPE,
        attributes: attributes as unknown as Record<string, unknown>,
        contentState: { stage: "icebreakers" satisfies DateDayStage },
        alert: {
          title: t(lang, "dateDayActivityStartTitle"),
          body: t(lang, "dateDayActivityStartBody"),
        },
        staleDate,
      }).catch(() => false);
    }),
  );
}

/** Move both sides' card to a later stage. Silent for anyone not running one. */
export async function advanceDateDayActivities(
  matchId: string,
  stage: DateDayStage,
): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match?.agreedTime) return;
  const staleDate = Math.floor(match.agreedTime.getTime() / 1000);

  await Promise.all(
    [match.userA, match.userB].map((user) =>
      sendLiveActivityUpdateToUser(user.id, "date_day", {
        event: "update",
        contentState: { stage },
        staleDate,
      }).catch(() => false),
    ),
  );
}

/**
 * Take the card down. Sent as a plain `end` with no dismissal date, so it
 * leaves the lock screen immediately rather than lingering in the Notification
 * Centre — the date is over and there is nothing left to act on.
 *
 * Deliberately carries no idempotency marker: ending an activity that is
 * already gone is a no-op, so the sweep that calls this can use a time window
 * instead of a column.
 */
export async function endDateDayActivities(matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({ where: { id: matchId }, select: MATCH_SELECT });
  if (!match) return;

  await Promise.all(
    [match.userA, match.userB].map((user) =>
      sendLiveActivityUpdateToUser(user.id, "date_day", { event: "end" }).catch(() => false),
    ),
  );
}
