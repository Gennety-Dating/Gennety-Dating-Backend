import type { Api, RawApi } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma, type Theme } from "@gennety/db";
import {
  DATE_TERMINAL_INVITE_LEAD_MINUTES,
  DATE_TERMINAL_REMINDER_GRACE_MINUTES,
  dateTerminalBeatFor,
  t,
  type DateTerminalBeat,
  type Language,
} from "@gennety/shared";
import { DEMO_MODE_ENABLED } from "../demo/config.js";
import { buildMiniAppUrl } from "./mini-app-url.js";
import { telegramReachable } from "./telegram-reach.js";
import { venueCoordinatesOf } from "./venue-location.js";

/**
 * The Date Terminal's two Telegram messages — the bot's way INTO the terminal
 * Mini App (`date-terminal.html`).
 *
 *   - **invite, T-45m** — the moment the radar starts: the terminal opens on
 *     "how far am I from the place", with Contact Sync still locked.
 *   - **reminder, T-15m** — the moment the sync (the Date Bump) starts being
 *     accepted: the terminal now unlocks inside 100 m of the venue.
 *
 * Both carry one inline `web_app` button for the pair's own match. The windows
 * and why they are disjoint live in `dateTerminalBeatFor` (`@gennety/shared`).
 *
 * **Exactly once, by claim.** Each message has its own idempotency column and
 * is claimed with a compare-and-set BEFORE the send, the same shape as the
 * ice-breakers' `icebreakersSentAt`: these are visible bubbles with a button,
 * so a duplicate is a second message in the chat, not an invisible no-op, and
 * the two-minute tick overlapping itself or a restart must not produce one. A
 * failed send is therefore not retried — one missed bubble is the cheaper
 * failure than two.
 *
 * **Telegram only.** The native app has its own date-day surfaces (the Live
 * Activity's spotter beat, its own canvas), and a push saying "open the
 * terminal" would point an app user at a Mini App they cannot open.
 *
 * **Not in the demo.** The terminal reads `/v1/date/state` on the REAL clock,
 * while the demo replays the lifecycle on a shifted one with the date a day
 * away — so the button would open a terminal that can only say "not yet". Same
 * structural limit that already keeps the Date Bump itself out of the demo
 * (DEMO_MODE.md → "The Date Bump is unreachable here").
 */

const MINUTE_MS = 60_000;

const RECIPIENT_SELECT = {
  id: true,
  telegramId: true,
  platform: true,
  language: true,
  theme: true,
} as const;

interface Recipient {
  id: string;
  telegramId: bigint;
  platform: string;
  language: Language | null;
  theme: Theme | null;
}

/**
 * Send whatever Date Terminal message each upcoming date is owed at `now`.
 * Returns how many matches had a message claimed this tick.
 */
export async function sendDateTerminalBeats(api: Api<RawApi>, now: Date): Promise<number> {
  if (DEMO_MODE_ENABLED) return 0;

  // Every row that could owe either message: from the end of the reminder's
  // grace behind us to the invite's lead ahead of us. The exact window per
  // message is decided by the pure function, not by this query.
  const from = new Date(now.getTime() - DATE_TERMINAL_REMINDER_GRACE_MINUTES * MINUTE_MS);
  const to = new Date(now.getTime() + DATE_TERMINAL_INVITE_LEAD_MINUTES * MINUTE_MS);
  const rows = await prisma.match.findMany({
    where: {
      status: "scheduled",
      agreedTime: { gt: from, lte: to },
      OR: [{ terminalInviteSentAt: null }, { terminalReminderSentAt: null }],
    },
    select: {
      id: true,
      agreedTime: true,
      venueName: true,
      venueLat: true,
      venueLng: true,
      venueMidpointLat: true,
      terminalInviteSentAt: true,
      terminalReminderSentAt: true,
      bumpSession: { select: { isVerified: true } },
      userA: { select: RECIPIENT_SELECT },
      userB: { select: RECIPIENT_SELECT },
    },
  });

  let claimed = 0;
  for (const match of rows) {
    if (!match.agreedTime) continue;
    // The terminal's whole job is a 100 m gate around the venue. On a legacy
    // row the coordinates are the route midpoint (`venue-location.ts`), so the
    // terminal could only ever say "too far" — better not to open it at all.
    if (venueCoordinatesOf(match) === null) continue;

    const beat = dateTerminalBeatFor(match.agreedTime, now, {
      invite: match.terminalInviteSentAt !== null,
      reminder: match.terminalReminderSentAt !== null,
    });
    if (!beat) continue;

    const claim = await prisma.match.updateMany({
      where:
        beat === "invite"
          ? { id: match.id, status: "scheduled", terminalInviteSentAt: null }
          : { id: match.id, status: "scheduled", terminalReminderSentAt: null },
      data: beat === "invite" ? { terminalInviteSentAt: now } : { terminalReminderSentAt: now },
    });
    if (claim.count === 0) continue;
    claimed += 1;

    // A pair that already synced inside the reminder's grace tail has nothing
    // to be reminded of. The column is still claimed above, so the row stops
    // coming back every tick.
    if (beat === "reminder" && match.bumpSession?.isVerified) continue;

    await Promise.all(
      [match.userA, match.userB].map((user) =>
        deliver(api, user, match.id, match.venueName, beat),
      ),
    );
  }
  return claimed;
}

async function deliver(
  api: Api<RawApi>,
  user: Recipient,
  matchId: string,
  venueName: string | null,
  beat: DateTerminalBeat,
): Promise<void> {
  if (!telegramReachable(user)) return;
  const lang: Language = user.language ?? "en";
  const text = t(lang, beat === "invite" ? "dateTerminalInvite" : "dateTerminalReminder", {
    venue: venueName ?? "",
    minutes: DATE_TERMINAL_INVITE_LEAD_MINUTES,
  });
  const keyboard: InlineKeyboardMarkup = {
    inline_keyboard: [
      [
        {
          text: t(lang, "dateTerminalBtn"),
          web_app: {
            url: buildMiniAppUrl("date-terminal", {
              lang,
              theme: user.theme ?? "dark",
              query: { match: matchId },
            }),
          },
        },
      ],
    ],
  };
  await api
    .sendMessage(Number(user.telegramId), text, { reply_markup: keyboard })
    .catch((err: unknown) => {
      console.warn(
        `[date-terminal] ${beat} failed for ${user.id}:`,
        err instanceof Error ? err.message : err,
      );
    });
}
