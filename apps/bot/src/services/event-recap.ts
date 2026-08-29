/**
 * The morning after (LAUNCH_EVENTS_PRODUCT_SPEC §11).
 *
 * Everything the product does with an event once the room has emptied: open
 * the double-blind thumbs, send one recap, take the feedback that pays for a
 * discount, and turn a mutual `true` into a real date.
 *
 * ── Why the thumbs open two hours AFTER the last round ──────────────────
 *
 * Not so the party can run late — so that nobody is ever visibly rating people
 * they are still standing next to. A phone held at the right angle at a table
 * of four is a leak the blind-decision invariant cannot survive, and it is the
 * one failure mode a purely server-side rule cannot prevent. Two hours is the
 * distance between "in the room" and "in a taxi".
 *
 * ── Blind, on the same terms as §3.4 ────────────────────────────────────
 *
 * A single thumb reveals nothing, and a `false` is never announced — not to
 * the other side, and not as an absence either: the recap card looks identical
 * whether the partner has answered `false` or has not answered at all. That
 * symmetry is the whole guarantee, so any future field added to a recap
 * pairing has to hold it too.
 *
 * ── What is derived rather than stored ──────────────────────────────────
 *
 * "Are the thumbs open" is a pure function of `Event.endsAt` and the clock, so
 * there is no `thumbsOpenedAt` column and no sweep stage to open them — an
 * event cannot get stuck half-open because nothing had to run. What IS stamped
 * is the recap fan-out (`EventTicket.recapSentAt`), because that one sends
 * messages and must not send them twice.
 */
import { InlineKeyboard } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { loadBlockedPairKeys } from "./user-block.js";
import { getActiveDiscount, grantEventFeedbackDiscount } from "./ticket-discount.js";
import { notifyFounderEventSafetyFlag } from "./founder-notify.js";
import { sendPushToUser } from "./push.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { getMainBotApi } from "./main-bot-api.js";
import { buildMiniAppUrl } from "./mini-app-url.js";
import { isTelegramTarget, toTelegramChatId } from "../utils/telegram-target.js";

const LOG_PREFIX = "[event-recap]";

/**
 * How long after the event ends the thumbs become answerable. See the header —
 * this is a privacy distance, not a grace period for a late finish.
 */
export const THUMBS_OPEN_DELAY_MS = 2 * 60 * 60 * 1000;

/**
 * When the recap + feedback ask goes out. Late enough that everyone has slept,
 * early enough that the evening is still the thing they are thinking about.
 */
export const RECAP_DELAY_MS = 18 * 60 * 60 * 1000;

/**
 * How long the mutual sweep keeps trying to turn a mutual into a `matches` row.
 *
 * A mutual pair whose participants are BOTH free becomes a match on the next
 * tick. One who is mid-date with someone else has to wait, and the allocator
 * answers a bare `null` for that exactly as it answers `null` for a pair the
 * lifetime ban makes impossible forever — so the sweep cannot tell "not yet"
 * from "never" and must not spin on either indefinitely.
 *
 * Fourteen days outlives every way a live match can legitimately hold someone
 * (a 24h decision, a 48h planning stall, a date scheduled up to six days out,
 * plus the T+24h close), so a window this long gives up only on pairs that
 * were never going to work.
 */
export const MUTUAL_MATCH_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The three answers the safety question takes. */
export const EVENT_SAFETY_VALUES = ["everything_fine", "uncomfortable", "unsafe"] as const;
export type EventSafety = (typeof EVENT_SAFETY_VALUES)[number];

// ── The attendee's recap ──────────────────────────────────────────────────

export interface RecapPairing {
  pairingId: string;
  partnerFirstName: string | null;
  /** This side's own answer. Null until they give one. */
  myThumb: boolean | null;
  /**
   * True only once BOTH said yes — never on a single yes, and never
   * distinguishable from "they have not answered" when they said no.
   */
  mutual: boolean;
}

export interface EventRecapState {
  /** Whether the thumbs are answerable yet. */
  open: boolean;
  /** When they open. Null once they have. */
  opensAt: string | null;
  eventTitle: string;
  /**
   * People this attendee actually found at the party. The recap lists ONLY
   * met-confirmed pairings (founder default, §11) — a list of people you never
   * managed to find is a list of small failures.
   */
  pairings: RecapPairing[];
  /** Whether the feedback form has already been answered. */
  feedbackSubmitted: boolean;
  /** The discount currently in the slot, whatever put it there. */
  discount: { pct: number; expiresAt: string } | null;
}

export type RecapResult =
  | { ok: true; state: EventRecapState }
  | { ok: false; reason: "unknown_event" | "not_attended" };

/**
 * What the recap screen shows.
 *
 * Gated on `checkedInAt`, not on holding a ticket: someone who claimed a place
 * and never came has nobody to rate and no evening to describe. Same gate as
 * the live screen, same reasoning.
 */
export async function getEventRecap(
  userId: string,
  eventId: string,
  now: Date = new Date(),
): Promise<RecapResult> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, title: true, endsAt: true },
  });
  if (!event) return { ok: false, reason: "unknown_event" };

  const ticket = await prisma.eventTicket.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { checkedInAt: true },
  });
  if (!ticket?.checkedInAt) return { ok: false, reason: "not_attended" };

  const opensAt = new Date(event.endsAt.getTime() + THUMBS_OPEN_DELAY_MS);
  const open = now >= opensAt;

  const [rows, blocked, feedback, discount] = await Promise.all([
    prisma.eventRoundPairing.findMany({
      where: {
        eventId,
        OR: [{ userAId: userId }, { userBId: userId }],
        // Met-confirmed on BOTH sides. A one-sided tap means one of them never
        // found the other, so the pair is not a memory either of them has.
        metConfirmedA: { not: null },
        metConfirmedB: { not: null },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        userAId: true,
        userBId: true,
        thumbsA: true,
        thumbsB: true,
        userA: { select: { firstName: true } },
        userB: { select: { firstName: true } },
      },
    }),
    loadBlockedPairKeys([userId]),
    prisma.eventFeedback.findUnique({
      where: { eventId_userId: { eventId, userId } },
      select: { id: true },
    }),
    getActiveDiscount(userId, now),
  ]);

  const pairings: RecapPairing[] = [];
  for (const row of rows) {
    const isA = row.userAId === userId;
    const partnerId = isA ? row.userBId : row.userAId;
    // A block filed mid-event hides each from the other's recap (§10). Server
    // side, both directions — the blocker must not have to see them either.
    if (blocked.has(`${userId}:${partnerId}`)) continue;
    pairings.push({
      pairingId: row.id,
      partnerFirstName: (isA ? row.userB : row.userA).firstName,
      myThumb: isA ? row.thumbsA : row.thumbsB,
      mutual: row.thumbsA === true && row.thumbsB === true,
    });
  }

  return {
    ok: true,
    state: {
      open,
      opensAt: open ? null : opensAt.toISOString(),
      eventTitle: event.title,
      pairings,
      feedbackSubmitted: feedback !== null,
      discount: discount
        ? { pct: discount.pct, expiresAt: discount.expiresAt.toISOString() }
        : null,
    },
  };
}

// ── The thumb ─────────────────────────────────────────────────────────────

export type ThumbResult =
  | {
      ok: true;
      /** Only ever true for a caller who has themselves said yes. */
      mutual: boolean;
      /** The peer to reveal it to — set ONLY on the tap that completed it. */
      revealTo: string | null;
    }
  | { ok: false; reason: "unknown_pairing" | "not_participant" | "not_open" };

/**
 * Record this side's verdict.
 *
 * **The first answer is final**, exactly as a pitch decision is (§3.4): a
 * thumb can create a `matches` row, and letting someone take one back after
 * that would mean cancelling a date the other person has already been offered.
 * A repeat tap is therefore idempotent rather than refused — it answers with
 * the state the caller already committed to, which is theirs to see.
 *
 * **The exactly-once mutual signal is a two-step claim**, not a
 * read-then-write. Under read-committed, two people answering at the same
 * instant would each read the other's column as still null and each conclude
 * "not mutual" — the mutual would be lost with nothing failing. So the first
 * write attempted is the one that requires the peer to be ALREADY true: at
 * most one caller can win it, and that caller is the completer.
 */
export async function recordThumb(
  userId: string,
  pairingId: string,
  value: boolean,
  now: Date = new Date(),
): Promise<ThumbResult> {
  const pairing = await prisma.eventRoundPairing.findUnique({
    where: { id: pairingId },
    select: { id: true, eventId: true, userAId: true, userBId: true },
  });
  if (!pairing) return { ok: false, reason: "unknown_pairing" };

  const isA = pairing.userAId === userId;
  const isB = pairing.userBId === userId;
  if (!isA && !isB) return { ok: false, reason: "not_participant" };

  // A second read rather than a relation on `eventId`: that column is
  // denormalized precisely so the recap needs no join, and declaring a
  // relation for one non-hot lookup would add a foreign key to the migration
  // for nothing this path can feel.
  const event = await prisma.event.findUnique({
    where: { id: pairing.eventId },
    select: { endsAt: true },
  });
  if (!event) return { ok: false, reason: "unknown_pairing" };
  if (now < new Date(event.endsAt.getTime() + THUMBS_OPEN_DELAY_MS)) {
    return { ok: false, reason: "not_open" };
  }

  const peerId = isA ? pairing.userBId : pairing.userAId;

  // Step 1 — the completing write. Only reachable on a `true`, and only wins
  // when the peer's `true` is already committed.
  if (value) {
    const completed = await prisma.eventRoundPairing.updateMany({
      where: isA
        ? { id: pairingId, thumbsA: null, thumbsB: true }
        : { id: pairingId, thumbsB: null, thumbsA: true },
      data: isA ? { thumbsA: true } : { thumbsB: true },
    });
    if (completed.count === 1) {
      return { ok: true, mutual: true, revealTo: peerId };
    }
  }

  // Step 2 — the ordinary first (or only) answer. A no-op when this side has
  // already answered, which is what makes a repeat tap idempotent.
  await prisma.eventRoundPairing.updateMany({
    where: isA ? { id: pairingId, thumbsA: null } : { id: pairingId, thumbsB: null },
    data: isA ? { thumbsA: value } : { thumbsB: value },
  });

  // Re-read rather than reasoning from the CAS count: the peer may have
  // answered in between, and learning of a mutual a beat late is the harmless
  // direction. Never `revealTo` here — this call did not complete anything, so
  // announcing would either duplicate the completer's reveal or fire on a tap
  // that changed nothing.
  const after = await prisma.eventRoundPairing.findUnique({
    where: { id: pairingId },
    select: { thumbsA: true, thumbsB: true },
  });
  return {
    ok: true,
    mutual: after?.thumbsA === true && after?.thumbsB === true,
    revealTo: null,
  };
}

/**
 * Tell the side that answered FIRST that it was mutual.
 *
 * Only they need telling: the person whose tap completed it is looking at the
 * screen that already says so. Sent at the tap rather than left to the match's
 * own "It's mutual 🤍" ticket card, because a mutual whose participants are
 * mid-date with other people waits days for that card — and "you both felt it"
 * is a fact about them, not about a booking.
 *
 * Best-effort by rule: a reveal that fails to send must not cost the thumb,
 * which is the durable thing.
 */
export async function sendMutualReveal(
  peerId: string,
  otherUserId: string,
  eventId: string,
): Promise<void> {
  const [peer, other] = await Promise.all([
    prisma.user.findUnique({
      where: { id: peerId },
      select: { telegramId: true, platform: true, language: true, theme: true },
    }),
    prisma.user.findUnique({ where: { id: otherUserId }, select: { firstName: true } }),
  ]);
  if (!peer) return;

  const language = (peer.language ?? "en") as Language;
  const title = t(language, "eventMutualTitle");
  const body = t(language, "eventMutualBody", {
    name: other?.firstName ?? t(language, "eventMutualSomeone"),
  });

  const sends: Array<Promise<unknown>> = [];
  if (telegramReachable(peer) && isTelegramTarget(peer.telegramId)) {
    const api = getMainBotApi();
    if (api) {
      const url = buildMiniAppUrl("event", {
        lang: language,
        theme: peer.theme,
        query: { eventId, view: "recap" },
      });
      const keyboard = url.startsWith("https://")
        ? new InlineKeyboard().webApp(t(language, "eventRecapButton"), url)
        : undefined;
      sends.push(
        api.sendMessage(toTelegramChatId(peer.telegramId), `${title}\n\n${body}`, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      );
    }
  }
  if (pushReachable(peer)) {
    sends.push(
      sendPushToUser(peerId, {
        title,
        body,
        data: { type: "event.mutual", eventId },
      }),
    );
  }

  const settled = await Promise.allSettled(sends);
  for (const s of settled) {
    if (s.status === "rejected") console.error(`${LOG_PREFIX} mutual reveal failed:`, s.reason);
  }
}

// ── Feedback ──────────────────────────────────────────────────────────────

export interface EventFeedbackInput {
  rating?: number | null;
  safety?: string | null;
  text?: string | null;
}

export type FeedbackResult =
  | {
      ok: true;
      /** The discount now in the slot — new or pre-existing. Never null-on-success. */
      discount: { pct: number; expiresAt: string } | null;
      /** Whether THIS submission is what put it there. */
      granted: boolean;
    }
  | { ok: false; reason: "unknown_event" | "not_attended" | "empty" | "bad_rating" };

/** Free text is bounded so one submission cannot become a document. */
export const FEEDBACK_TEXT_MAX = 2000;

/**
 * Answer the post-event form.
 *
 * Upsert on `(event, user)` — the founder default is one row per attendee, and
 * a second submission is a correction rather than a second opinion. The
 * incentive is granted at most once because the discount write itself is
 * `onlyIfFree`; re-submitting cannot mint a second one.
 */
export async function submitEventFeedback(
  userId: string,
  eventId: string,
  input: EventFeedbackInput,
  now: Date = new Date(),
): Promise<FeedbackResult> {
  const rating =
    input.rating === undefined || input.rating === null ? null : Math.trunc(input.rating);
  if (rating !== null && (!Number.isFinite(rating) || rating < 1 || rating > 10)) {
    return { ok: false, reason: "bad_rating" };
  }

  const safety = (EVENT_SAFETY_VALUES as readonly string[]).includes(input.safety ?? "")
    ? (input.safety as EventSafety)
    : null;
  const text = typeof input.text === "string" ? input.text.trim().slice(0, FEEDBACK_TEXT_MAX) : "";

  // An empty submission is not an answer, and writing one would spend the
  // incentive on nothing and mark the form done for a user who said nothing.
  if (rating === null && safety === null && text === "") {
    return { ok: false, reason: "empty" };
  }

  const ticket = await prisma.eventTicket.findUnique({
    where: { eventId_userId: { eventId, userId } },
    select: { checkedInAt: true },
  });
  if (!ticket) return { ok: false, reason: "unknown_event" };
  if (!ticket.checkedInAt) return { ok: false, reason: "not_attended" };

  const data = { rating, safety, text: text || null };
  await prisma.eventFeedback.upsert({
    where: { eventId_userId: { eventId, userId } },
    create: { eventId, userId, ...data },
    update: data,
  });

  // `unsafe` leaves the table immediately. The row is the queue entry, but a
  // queue nobody is told about is not a queue — and this is the one answer
  // where a day's delay is the wrong outcome.
  if (safety === "unsafe") {
    // try/catch rather than `.catch`, and the difference is not style: the row
    // is already written by the time we get here, so nothing the notifier does
    // — including returning something that is not a promise — may turn a
    // recorded safety report into an error the user is asked to retry.
    try {
      await notifyFounderEventSafetyFlag({ eventId, userId, text: text || null });
    } catch (err) {
      console.error(`${LOG_PREFIX} safety alert failed:`, err);
    }
  }

  const grant = await grantEventFeedbackDiscount(userId, now);
  // Report the slot's ACTUAL contents either way. A user who already holds a
  // famine discount is told what they have rather than shown an empty reward.
  const active = grant.granted
    ? { pct: grant.pct as number, expiresAt: (grant.expiresAt as Date).toISOString() }
    : await getActiveDiscount(userId, now).then((d) =>
        d ? { pct: d.pct, expiresAt: d.expiresAt.toISOString() } : null,
      );

  return { ok: true, discount: active, granted: grant.granted };
}
