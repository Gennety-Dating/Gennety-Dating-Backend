/**
 * The scheduled half of the post-event loop (LAUNCH_EVENTS §11).
 *
 * Two stages, deliberately in one tick over one window of events:
 *
 *  1. **The recap fan-out at T+18h** — one message per attendee who actually
 *     walked through the door, stamped per ticket so an unreachable phone
 *     neither strands the rest nor makes the event look delivered.
 *  2. **The mutual sweep** — every pairing where both said yes and no
 *     `matches` row exists yet.
 *
 * ── Why the mutual is a sweep rather than a write on the second thumb ────
 *
 * Because the allocator is allowed to say no. `createProposedMatch` refuses a
 * pair when either side already holds a live match, and that refusal is
 * correct: someone with a date on Friday must not be double-booked because
 * they liked a stranger at a party on Wednesday. So the mutual has to be able
 * to WAIT, which means it has to be retried, which means a sweep — and once
 * the sweep exists, doing it inline on the thumb as well would be two code
 * paths for one act. The reveal is what the user actually cares about and that
 * IS immediate; the row arriving minutes later is invisible.
 *
 * ── Why "opened" is not a stage ─────────────────────────────────────────
 *
 * Thumbs open at `endsAt + 2h` by arithmetic, not by a worker flipping a
 * column, so there is no third stage here and no way for an event to get stuck
 * half-open because a tick did not run.
 */
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { createProposedMatch } from "./match-engine.js";
import { loadBlockedPairKeys } from "./user-block.js";
import { sendPushToUser } from "./push.js";
import { telegramReachable, pushReachable } from "./telegram-reach.js";
import { getMainBotApi } from "./main-bot-api.js";
import { buildMiniAppUrl } from "./mini-app-url.js";
import { isTelegramTarget, toTelegramChatId } from "../utils/telegram-target.js";
import { RECAP_DELAY_MS, THUMBS_OPEN_DELAY_MS, MUTUAL_MATCH_WINDOW_MS } from "./event-recap.js";
// Service → handler, which is the direction this repo already takes for
// exactly this function: `public/matches-service.ts` imports it so the gate
// deadline has ONE definition rather than three that can disagree. The gate
// and the Calendar are imported for the same reason — an event mutual joins
// the ordinary product at the same seam a weekly mutual accept does.
import { sendTicketOffer, ticketGateDeadline } from "../handlers/matching/ticket-gate.js";
import { startScheduling } from "../handlers/matching/scheduler.js";
import { InlineKeyboard } from "grammy";

const LOG_PREFIX = "[event-recap]";

export interface EventRecapNotification {
  eventId: string;
  eventTitle: string;
  /** Met-confirmed people, after blocks. Zero switches the copy, not the send. */
  metCount: number;
  language: string | null;
}

export interface EventRecapDeps {
  /** Injected so the tick is testable without Telegram or APNs. */
  notify?: (userId: string, payload: EventRecapNotification) => Promise<void>;
  /**
   * What to do once a mutual has become a real match: the §3.5b ticket gate,
   * or the Calendar when tickets are off. Injected rather than called directly
   * so a test never reaches the handler layer, and defaulted so `index.ts`
   * needs no wiring.
   */
  onMatchCreated?: (matchId: string) => Promise<void>;
}

export interface EventRecapTickResult {
  eventsScanned: number;
  recapsSent: number;
  recapsFailed: number;
  matchesCreated: number;
  /** Mutuals the allocator refused this time round — retried next tick. */
  matchesDeferred: number;
  /** Mutuals a block rules out. Counted apart from `deferred`: this one never
   *  becomes a match, so reporting it as "not yet" would misdescribe it. */
  matchesBlocked: number;
}

export async function runEventRecapTick(
  now: Date = new Date(),
  deps: EventRecapDeps = {},
): Promise<EventRecapTickResult> {
  const result: EventRecapTickResult = {
    eventsScanned: 0,
    recapsSent: 0,
    recapsFailed: 0,
    matchesCreated: 0,
    matchesDeferred: 0,
    matchesBlocked: 0,
  };

  // One window covers both stages: from "old enough that the thumbs are open"
  // back to "young enough that a mutual is still worth trying".
  const events = await prisma.event.findMany({
    where: {
      // A cancelled or draft event never happened; sending its attendees a
      // recap would be the product remembering an evening they did not have.
      status: { in: ["live", "concluded"] },
      endsAt: {
        lte: new Date(now.getTime() - THUMBS_OPEN_DELAY_MS),
        gte: new Date(now.getTime() - MUTUAL_MATCH_WINDOW_MS),
      },
    },
    select: { id: true, title: true, endsAt: true },
  });
  result.eventsScanned = events.length;
  if (events.length === 0) return result;

  for (const event of events) {
    if (now.getTime() >= event.endsAt.getTime() + RECAP_DELAY_MS) {
      const sent = await sendRecaps(event, deps, now);
      result.recapsSent += sent.sent;
      result.recapsFailed += sent.failed;
    }
    const mutual = await sweepMutuals(event.id, deps);
    result.matchesCreated += mutual.created;
    result.matchesDeferred += mutual.deferred;
    result.matchesBlocked += mutual.blocked;
  }

  return result;
}

// ── Stage 1: the recap ────────────────────────────────────────────────────

async function sendRecaps(
  event: { id: string; title: string },
  deps: EventRecapDeps,
  now: Date,
): Promise<{ sent: number; failed: number }> {
  const tickets = await prisma.eventTicket.findMany({
    where: { eventId: event.id, checkedInAt: { not: null }, recapSentAt: null },
    select: { id: true, userId: true, user: { select: { language: true } } },
  });
  if (tickets.length === 0) return { sent: 0, failed: 0 };

  const attendees = tickets.map((t2) => t2.userId);
  const [pairings, blocked] = await Promise.all([
    prisma.eventRoundPairing.findMany({
      where: {
        eventId: event.id,
        metConfirmedA: { not: null },
        metConfirmedB: { not: null },
      },
      select: { userAId: true, userBId: true },
    }),
    loadBlockedPairKeys(attendees),
  ]);

  const metCounts = new Map<string, number>();
  for (const p of pairings) {
    if (blocked.has(`${p.userAId}:${p.userBId}`)) continue;
    metCounts.set(p.userAId, (metCounts.get(p.userAId) ?? 0) + 1);
    metCounts.set(p.userBId, (metCounts.get(p.userBId) ?? 0) + 1);
  }

  const notify = deps.notify ?? sendRecapMessage;
  let sent = 0;
  let failed = 0;

  for (const ticket of tickets) {
    try {
      await notify(ticket.userId, {
        eventId: event.id,
        eventTitle: event.title,
        metCount: metCounts.get(ticket.userId) ?? 0,
        language: ticket.user.language,
      });
      // Stamped only AFTER a successful send: a delivery that threw is worth
      // retrying next tick, and this is the one message the whole post-event
      // loop hangs off. A repeat is bounded by the stamp landing on the retry.
      await prisma.eventTicket.updateMany({
        where: { id: ticket.id, recapSentAt: null },
        data: { recapSentAt: now },
      });
      sent += 1;
    } catch (err) {
      failed += 1;
      console.error(`${LOG_PREFIX} recap failed for ${ticket.userId}:`, err);
    }
  }

  return { sent, failed };
}

/**
 * Both rails, chosen by `platform` rather than by `telegramId > 0` — the test
 * that has cost this product nine separate fan-out bugs. A `both` account
 * hears once on each; an account reachable on neither is simply skipped.
 */
async function sendRecapMessage(userId: string, n: EventRecapNotification): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { telegramId: true, platform: true, language: true, theme: true },
  });
  if (!user) return;

  const language = (n.language ?? user.language ?? "en") as Language;
  const title = t(language, "eventRecapTitle");
  const body =
    n.metCount > 0
      ? t(language, "eventRecapBody", { count: String(n.metCount) })
      : t(language, "eventRecapBodyNone");

  const sends: Array<Promise<unknown>> = [];

  if (telegramReachable(user) && isTelegramTarget(user.telegramId)) {
    const api = getMainBotApi();
    if (api) {
      const url = buildMiniAppUrl("event", {
        lang: language,
        theme: user.theme,
        query: { eventId: n.eventId, view: "recap" },
      });
      // A non-HTTPS `WEBAPP_URL` (dev without a tunnel) makes Telegram reject a
      // web_app button outright, so the message goes out without one rather
      // than not at all — the recap is the message, the button is the shortcut.
      const keyboard = url.startsWith("https://")
        ? new InlineKeyboard().webApp(t(language, "eventRecapButton"), url)
        : undefined;
      sends.push(
        api.sendMessage(toTelegramChatId(user.telegramId), `${title}\n\n${body}`, {
          ...(keyboard ? { reply_markup: keyboard } : {}),
        }),
      );
    }
  }

  if (pushReachable(user)) {
    sends.push(
      sendPushToUser(userId, {
        title,
        body,
        // NOT time-sensitive. A question about last night is the definition of
        // something that can wait for the next time someone looks at a screen.
        data: { type: "event.recap", eventId: n.eventId },
      }),
    );
  }

  // One rail failing must not lose the other, and neither failing may stamp.
  const settled = await Promise.allSettled(sends);
  if (settled.length === 0) return; // reachable on neither — nothing owed
  if (settled.every((s) => s.status === "rejected")) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }
}

// ── Stage 2: mutual → match ───────────────────────────────────────────────

async function sweepMutuals(
  eventId: string,
  deps: EventRecapDeps,
): Promise<{ created: number; deferred: number; blocked: number }> {
  const pending = await prisma.eventRoundPairing.findMany({
    where: { eventId, thumbsA: true, thumbsB: true, matchId: null },
    select: { id: true, userAId: true, userBId: true },
  });
  if (pending.length === 0) return { created: 0, deferred: 0, blocked: 0 };

  // Blocks are absolute (§2), and this is the THIRD path that can put two
  // people together — after the round allocator and the recap screen, both of
  // which already honour them (`loadExcludedPairs` unions the ban with the
  // blocks; `sendRecaps` and `getEventRecap` filter on the same set). It is
  // the only one of the three that produces a date, and it was the only one
  // enforcing nothing.
  //
  // Not left to the lifetime pair ban inside `createProposedMatch`, even
  // though that ban does catch it today: a block can only be filed against a
  // MATCH, so a blocked pair necessarily has a `matches` row and the ban
  // refuses them. PRODUCT_SPEC §Blocking keeps the block's own enforcement
  // redundant for exactly this reason — the ban is a product decision under
  // periodic review, and a block is a promise to a user that has to survive
  // its revision. Resting the promise on an unrelated invariant is what makes
  // it quietly untrue the day that invariant changes.
  //
  // It also stops a pair that can NEVER become a match being handed to the
  // allocator — two row locks and a transaction — every five minutes for the
  // whole fourteen-day window.
  const blocked = await loadBlockedPairKeys(
    Array.from(new Set(pending.flatMap((p) => [p.userAId, p.userBId]))),
  );

  const handoff = deps.onMatchCreated ?? defaultMatchHandoff;
  let created = 0;
  let deferred = 0;
  let blockedCount = 0;

  for (const pairing of pending) {
    // `loadBlockedPairKeys` carries both directions, so one lookup covers
    // "either of them blocked the other".
    if (blocked.has(`${pairing.userAId}:${pairing.userBId}`)) {
      blockedCount += 1;
      continue;
    }
    // No `breakdown`, so no `match_score_logs` row — nothing was scored. Two
    // people said yes, which is a stronger signal than the formula produces
    // and not a value on its scale; writing one would put a made-up number
    // into the table the weekly A/B reads.
    const match = await createProposedMatch(pairing.userAId, pairing.userBId, undefined, undefined, {
      source: "event",
      preAccepted: true,
      ...(env.TICKET_FEATURE_ENABLED ? { ticketGateExpiresAt: ticketGateDeadline() } : {}),
    });

    if (!match) {
      // The allocator answers a bare null for "one of them is mid-date" and
      // for "the lifetime ban makes this pair impossible" alike. Neither is an
      // error and neither is distinguishable here — the window is what ends
      // the retry, for both.
      deferred += 1;
      continue;
    }

    const linked = await prisma.eventRoundPairing.updateMany({
      where: { id: pairing.id, matchId: null },
      data: { matchId: match.id },
    });
    if (linked.count === 0) {
      // Structurally unreachable — a second `createProposedMatch` for the same
      // pair is refused by the lifetime-ban check against the row just made —
      // but if it ever happens the match is real and live, so the product
      // state is right and only the link is missing. Say so rather than
      // cancelling a date two people are about to be offered.
      console.error(`${LOG_PREFIX} pairing ${pairing.id} already linked; match ${match.id} orphaned`);
    }

    created += 1;
    try {
      await handoff(match.id);
    } catch (err) {
      // A failed handoff normally costs the pair their card, not their match:
      // with tickets ON the gate deadline was armed inside the create, so the
      // hourly ticket sweep owns the row; with tickets off `startScheduling`
      // writes `proposedTimes` as its FIRST statement, before it can reach
      // Telegram, so a send that throws still leaves the §3.5c chain owning it.
      //
      // The one gap left is narrow and worth naming rather than papering over:
      // tickets off AND that write itself failing (a DB blip) leaves a
      // `negotiating` row with neither anchor, which the ticket sweep filters
      // out (`ticketExpiresAt: { not: null }`) and the stall chain exempts
      // (`stallPhaseOf` returns null on empty `proposedTimes`) — the §3.5b
      // hole. Deliberately not closed by widening that exemption: DECISIONS
      // 2026-08-20 weighed and rejected it, because a predicate error there
      // cancels live paid dates hourly across every match, against a hole that
      // needs a throw in a one-statement window.
      console.error(`${LOG_PREFIX} handoff failed for match ${match.id}:`, err);
    }
  }

  return { created, deferred, blocked: blockedCount };
}

/**
 * Where an event match joins the ordinary product: the Date Ticket gate, or
 * the Calendar when tickets are off — byte-identical to what a mutual accept
 * on a weekly pitch does (§3.4), because from here on it IS that.
 */
async function defaultMatchHandoff(matchId: string): Promise<void> {
  const api = getMainBotApi();
  if (!api) return;
  if (env.TICKET_FEATURE_ENABLED) {
    await sendTicketOffer(api, matchId);
  } else {
    await startScheduling(api, matchId);
  }
}
