import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import { isTelegramTarget, toTelegramChatId } from "../utils/telegram-target.js";
import {
  issuePeerWaitDraft,
  peerWaitLabel,
  type PeerWaitVariant,
} from "../services/peer-wait.js";
import { venueChangeSideWaiting, type VenueChangeWaitRow } from "./peer-wait-venue-change.js";

/**
 * Keeps the "waiting on your partner" shimmer alive for the whole wait
 * (PRODUCT_SPEC §3.6b).
 *
 * A `<tg-thinking>` rich draft is ephemeral (~30s), so the only way to show one
 * across a wait measured in hours is to re-issue the same `draft_id` on a
 * wall-clock interval. That is this worker's entire job: every tick it works out
 * which side of which match is currently waiting on the other, and refreshes
 * that side's draft.
 *
 * There is deliberately no "stop" call anywhere. When the partner answers, the
 * match simply stops matching the waiting predicate, the draft stops being
 * re-issued, and it expires on its own within ~30s. The only thing that needs
 * explicit teardown is the fallback line below.
 *
 * Quiet hours do not apply: a draft is not a message and raises no notification,
 * the same reasoning that exempts the pinned status banner and the pitch
 * countdown.
 */

/**
 * Clients that can't render a rich draft get a plain message instead, whose text
 * is rewritten as the wording climbs the tier ladder. An edit is a real API call
 * on a real message (unlike a draft re-issue), so it is budgeted to once a
 * minute — comfortably finer than the narrowest tier (5 minutes), so a tier
 * change is never visibly late on the fallback either.
 */
export const PEER_WAIT_FALLBACK_EDIT_MS = 60_000;

/** Ceiling on Bot API calls per second, mirroring `workers/proposal-countdown.ts`. */
const MAX_CALLS_PER_SECOND = 25;

export type WaitSide = "A" | "B";

/** The columns the waiting predicate reads. Exported so tests can build rows. */
export interface PeerWaitMatchRow extends VenueChangeWaitRow {
  id: string;
  status: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  proposedTimes: Date[];
  availableTimesA: Date[];
  availableTimesB: Date[];
  venueIntentA: unknown;
  venueIntentB: unknown;
  vibeTextA: string | null;
  vibeTextB: string | null;
  vibeLatA: number | null;
  vibeLngA: number | null;
  vibeLatB: number | null;
  vibeLngB: number | null;
}

export interface PeerWaitTickResult {
  scanned: number;
  refreshed: number;
  fallbackSent: number;
  fallbackEdited: number;
  clearedFallback: number;
  errors: number;
}

/** Did this side finish supplying its venue input (V2 intent, or legacy pin+vibe)? */
function venueSideSubmitted(match: PeerWaitMatchRow, side: WaitSide): boolean {
  const intent = side === "A" ? match.venueIntentA : match.venueIntentB;
  if (
    typeof intent === "object" &&
    intent !== null &&
    (intent as { state?: unknown }).state === "confirmed"
  ) {
    return true;
  }
  // Legacy concierge path: a side is done only with BOTH the vibe text and the
  // departure pin — the same four-field gate `tryFinalize` waits on.
  const text = side === "A" ? match.vibeTextA : match.vibeTextB;
  const lat = side === "A" ? match.vibeLatA : match.vibeLatB;
  const lng = side === "A" ? match.vibeLngA : match.vibeLngB;
  return Boolean(text) && lat != null && lng != null;
}

/** Do two slot selections share at least one instant? */
function hasOverlap(mine: Date[], theirs: Date[]): boolean {
  const peerSet = new Set(theirs.map((d) => d.getTime()));
  return mine.some((d) => peerSet.has(d.getTime()));
}

/**
 * Is this side done with its part and now blocked on the partner — and if so,
 * which kind of wait is it? `null` means "not waiting".
 *
 * Exported because it is the whole product decision of this worker and deserves
 * to be tested directly rather than through Prisma.
 */
export function resolvePeerWaitVariant(
  match: PeerWaitMatchRow,
  side: WaitSide,
): PeerWaitVariant | null {
  const isA = side === "A";
  switch (match.status) {
    case "proposed": {
      // Only an ACCEPT waits. A decline is irreversible (§3.2 lifetime pair
      // ban) and the decliner's next screen is the "what was the main reason?"
      // prompt, so they are not waiting on anything they can act on.
      const mine = isA ? match.acceptedByA : match.acceptedByB;
      const theirs = isA ? match.acceptedByB : match.acceptedByA;
      return mine === true && theirs === null ? "default" : null;
    }
    case "negotiating": {
      // `negotiating` also covers the Date Ticket gate, whose live waiting state
      // is owned by its Mini App by design. `proposedTimes` is written by
      // `startScheduling`, which runs only once the gate has settled (or is off
      // entirely) — so a non-empty grid is exactly "the calendar is open".
      // NB: deliberately not gated on `ticketStatus`, which defaults to
      // "pending" even when the ticket feature is disabled.
      if (match.proposedTimes.length === 0) return null;
      const mine = isA ? match.availableTimesA : match.availableTimesB;
      const theirs = isA ? match.availableTimesB : match.availableTimesA;
      if (mine.length === 0) return null;
      if (theirs.length === 0) return "default";
      // Both picked. A shared slot auto-locks the date (`scheduler.ts`), so if
      // we are still here there is none — and BOTH sides are genuinely blocked
      // on the other widening their selection. This used to read as "nobody is
      // waiting": the shimmer vanished for whoever picked first and never
      // appeared for whoever picked second, while `handleSchedulingNudges`
      // skips a pair where both have picked, leaving the state completely
      // silent until the §3.5c 24h check-in.
      return hasOverlap(mine, theirs) ? null : "no_overlap";
    }
    case "negotiating_venue":
      return venueSideSubmitted(match, side) && !venueSideSubmitted(match, isA ? "B" : "A")
        ? "default"
        : null;
    case "scheduled":
      // The §3.7b venue-change board — see `peer-wait-venue-change.ts`.
      return venueChangeSideWaiting(match, side) ? "default" : null;
    default:
      return null;
  }
}

/** Boolean view of {@link resolvePeerWaitVariant}. */
export function isSideWaitingOnPeer(match: PeerWaitMatchRow, side: WaitSide): boolean {
  return resolvePeerWaitVariant(match, side) !== null;
}

export interface PeerWaitTickOptions {
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface SideWork {
  matchId: string;
  side: WaitSide;
  chatId: number;
  lang: Language;
  partnerName: string | null;
  fallbackMessageId: number | null;
  fallbackEditedAt: Date | null;
  /** Null when this side is not waiting; otherwise which ladder to render. */
  variant: PeerWaitVariant | null;
  /** Anchor the tier is measured from; null until this tick stamps it. */
  startedAt: Date | null;
}

export async function peerWaitShimmerTick(
  api: Api<RawApi>,
  options: PeerWaitTickOptions = {},
): Promise<PeerWaitTickResult> {
  const now = options.now ?? new Date();
  const sleep = options.sleep ?? defaultSleep;

  const matches = await prisma.match.findMany({
    where: {
      OR: [
        { status: { in: ["proposed", "negotiating", "negotiating_venue"] } },
        // The §3.7b venue-change board runs on a `scheduled` match. Narrowed to
        // rows with a live board so the tick doesn't scan every scheduled date.
        { status: "scheduled", venueChangeStatus: { in: ["liking", "agreed"] } },
        // Rows that already left a waiting state but still carry a fallback
        // line, so the teardown below can reach them.
        { peerWaitMessageIdA: { not: null } },
        { peerWaitMessageIdB: { not: null } },
      ],
    },
    select: {
      id: true,
      status: true,
      acceptedByA: true,
      acceptedByB: true,
      proposedTimes: true,
      availableTimesA: true,
      availableTimesB: true,
      venueIntentA: true,
      venueIntentB: true,
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
      venueChangeStatus: true,
      venueChangeProposerId: true,
      venueLikesA: true,
      venueLikesB: true,
      venueChangeOfferPaySentAt: true,
      venueChangeExpressAt: true,
      venueChangePaidAt: true,
      peerWaitMessageIdA: true,
      peerWaitMessageIdB: true,
      peerWaitEditedAtA: true,
      peerWaitEditedAtB: true,
      peerWaitStartedAtA: true,
      peerWaitStartedAtB: true,
      userA: { select: { id: true, telegramId: true, language: true, firstName: true, gender: true } },
      userB: { select: { id: true, telegramId: true, language: true, firstName: true, gender: true } },
    },
  });

  const result: PeerWaitTickResult = {
    scanned: matches.length,
    refreshed: 0,
    fallbackSent: 0,
    fallbackEdited: 0,
    clearedFallback: 0,
    errors: 0,
  };

  // Build the work list first, so the pacer below only throttles real calls.
  const work: SideWork[] = [];
  for (const match of matches) {
    for (const side of ["A", "B"] as const) {
      const isA = side === "A";
      const me = isA ? match.userA : match.userB;
      const peer = isA ? match.userB : match.userA;
      const fallbackMessageId = isA ? match.peerWaitMessageIdA : match.peerWaitMessageIdB;
      const startedAt = isA ? match.peerWaitStartedAtA : match.peerWaitStartedAtB;
      const variant = resolvePeerWaitVariant(match as PeerWaitMatchRow, side);

      if (variant === null && fallbackMessageId === null && startedAt === null) continue;
      if (!isTelegramTarget(me.telegramId)) continue;

      work.push({
        matchId: match.id,
        side,
        chatId: toTelegramChatId(me.telegramId),
        lang: (me.language ?? "en") as Language,
        partnerName: peer.firstName,
        fallbackMessageId,
        fallbackEditedAt: isA ? match.peerWaitEditedAtA : match.peerWaitEditedAtB,
        variant,
        startedAt,
      });
    }
  }

  let callsThisSecond = 0;
  let windowStart = Date.now();
  const pace = async (): Promise<void> => {
    if (callsThisSecond >= MAX_CALLS_PER_SECOND) {
      const elapsed = Date.now() - windowStart;
      if (elapsed < 1000) await sleep(1000 - elapsed);
      callsThisSecond = 0;
      windowStart = Date.now();
    }
    callsThisSecond++;
  };

  for (const item of work) {
    try {
      if (item.variant === null) {
        await endWait(api, item, result);
        continue;
      }

      // First tick that sees this side waiting owns the anchor the tier ladder
      // is measured from. Stamped here rather than by the action handlers so the
      // column has exactly one writer (see the schema comment); the ≤20s lag is
      // immaterial against a 5-minute first boundary, and `item.startedAt` is
      // set locally so THIS tick already renders against the right instant.
      if (item.startedAt === null) {
        await stampWaitStart(item.matchId, item.side, now);
        item.startedAt = now;
      }

      // Once a side is on the fallback it stays there: retrying the rich draft
      // every tick would be a guaranteed failing call every 20s forever.
      if (item.fallbackMessageId !== null) {
        const due =
          item.fallbackEditedAt === null ||
          now.getTime() - item.fallbackEditedAt.getTime() >= PEER_WAIT_FALLBACK_EDIT_MS;
        if (!due) continue;
        await pace();
        await editFallback(api, item, now, result);
        continue;
      }

      await pace();
      try {
        await issuePeerWaitDraft(api, {
          chatId: item.chatId,
          matchId: item.matchId,
          side: item.side,
          lang: item.lang,
          partnerName: item.partnerName,
          startedAt: item.startedAt,
          now,
          variant: item.variant,
        });
        result.refreshed++;
      } catch (err) {
        if (isUnreachableChat(err)) throw err;
        // Rich drafts unsupported on this client — establish the plain line and
        // never try a draft for this side again.
        await pace();
        await sendFallback(api, item, now, result);
      }
    } catch (err) {
      result.errors++;
      logSideError(item, err);
    }
  }

  return result;
}

/**
 * The wait is over: drop the fallback line if there is one, and release the
 * anchor so a LATER wait on the same match starts its ladder from zero rather
 * than inheriting a stale "waiting since" and opening at tier 5.
 */
async function endWait(
  api: Api<RawApi>,
  item: SideWork,
  result: PeerWaitTickResult,
): Promise<void> {
  if (item.fallbackMessageId !== null) {
    // Best-effort delete — a message Telegram won't let us remove (older than
    // 48h) is still forgotten, so we stop touching it.
    await api.deleteMessage(item.chatId, item.fallbackMessageId).catch(() => {});
  }
  await forgetWait(item.matchId, item.side);
  if (item.fallbackMessageId !== null) result.clearedFallback++;
}

async function stampWaitStart(matchId: string, side: WaitSide, now: Date): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: side === "A" ? { peerWaitStartedAtA: now } : { peerWaitStartedAtB: now },
  });
}

async function sendFallback(
  api: Api<RawApi>,
  item: SideWork,
  now: Date,
  result: PeerWaitTickResult,
): Promise<void> {
  const sent = await api.sendMessage(
    item.chatId,
    peerWaitLabel(item.lang, item.partnerName, item.startedAt, now, item.variant ?? "default"),
  );
  await prisma.match.update({
    where: { id: item.matchId },
    data:
      item.side === "A"
        ? { peerWaitMessageIdA: sent.message_id, peerWaitEditedAtA: now }
        : { peerWaitMessageIdB: sent.message_id, peerWaitEditedAtB: now },
  });
  result.fallbackSent++;
}

async function editFallback(
  api: Api<RawApi>,
  item: SideWork,
  now: Date,
  result: PeerWaitTickResult,
): Promise<void> {
  try {
    await api.editMessageText(
      item.chatId,
      item.fallbackMessageId!,
      peerWaitLabel(item.lang, item.partnerName, item.startedAt, now, item.variant ?? "default"),
    );
    result.fallbackEdited++;
  } catch (err) {
    if (isNotModified(err)) {
      // Nothing to do, but still stamp so we don't retry every tick.
      result.fallbackEdited++;
    } else if (isUnreachableChat(err) || isMessageGone(err)) {
      // The line is gone (user deleted it, or the chat is closed) — forget it so
      // the next tick starts clean instead of editing into the void forever.
      await forgetFallback(item.matchId, item.side);
      result.clearedFallback++;
      return;
    } else {
      throw err;
    }
  }
  await prisma.match.update({
    where: { id: item.matchId },
    data: item.side === "A" ? { peerWaitEditedAtA: now } : { peerWaitEditedAtB: now },
  });
}

/**
 * Forget the fallback line only — the side is STILL waiting, its message just
 * isn't there any more (deleted by the user, or too old to edit). The anchor is
 * deliberately preserved so the ladder keeps climbing from the real start.
 */
async function forgetFallback(matchId: string, side: WaitSide): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data:
      side === "A"
        ? { peerWaitMessageIdA: null, peerWaitEditedAtA: null }
        : { peerWaitMessageIdB: null, peerWaitEditedAtB: null },
  });
}

/** Release everything for a wait that has ended: fallback line AND anchor. */
async function forgetWait(matchId: string, side: WaitSide): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data:
      side === "A"
        ? { peerWaitMessageIdA: null, peerWaitEditedAtA: null, peerWaitStartedAtA: null }
        : { peerWaitMessageIdB: null, peerWaitEditedAtB: null, peerWaitStartedAtB: null },
  });
}

function description(err: unknown): string {
  return err instanceof GrammyError ? err.description.toLowerCase() : "";
}

function isNotModified(err: unknown): boolean {
  return description(err).includes("message is not modified");
}

function isMessageGone(err: unknown): boolean {
  const desc = description(err);
  return (
    desc.includes("message to edit not found") ||
    desc.includes("message can't be edited") ||
    desc.includes("message_id_invalid")
  );
}

/** Blocked bot / deleted chat — no point falling back to a plain message either. */
function isUnreachableChat(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  return err.error_code === 403 || description(err).includes("chat not found");
}

function logSideError(item: SideWork, err: unknown): void {
  console.warn(
    `[peer-wait] matchId=${item.matchId} side=${item.side}:`,
    (err as Error).message,
  );
}
