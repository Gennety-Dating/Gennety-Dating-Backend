import { prisma } from "@gennety/db";
import { LAST_MATCH_OUTCOME_WINDOW_MS } from "@gennety/shared";

/**
 * How the caller's most recent match ended — `lastOutcome` on
 * `/v1/matches/current`.
 *
 * The app reads only that endpoint for Today, and the endpoint returns active
 * matches only, so the moment a pair ended (expired, declined, cancelled) the
 * screen silently fell back to "searching". Telegram tells both sides what
 * happened; this is the app's half of the same news, derived from columns that
 * already exist — no schema change.
 *
 * **Blind decision invariant.** Every kind here is a FINAL outcome: the row is
 * `expired` or `cancelled`, so nobody can still decide. A partner's decline is
 * named only when BOTH sides decided (`declined_by_partner` requires the
 * caller's own answer on the row) — exactly when Telegram sends the reveal
 * (`outcomeRevealKey`). A partner's yes is named only to a side that stayed
 * silent until expiry (`expired_missed_date`), mirroring
 * `matchExpiredYouMissedDate`. Any other cancellation says only "cancelled".
 */
export type MatchOutcomeKind =
  /** The caller never answered; the window closed. */
  | "expired_you_silent"
  /** Same, and the partner had said yes (Telegram's "missed date" card). */
  | "expired_missed_date"
  /** The caller said yes; the partner never answered. */
  | "expired_peer_silent"
  /** The caller passed; the partner never answered. */
  | "expired_you_declined"
  /** Both decided, the caller said yes, the partner passed. */
  | "declined_by_partner"
  /** Both decided and the caller passed. */
  | "declined_by_you"
  /** The partner cancelled after the mutual yes. */
  | "cancelled_by_partner"
  /** The caller cancelled after the mutual yes. */
  | "cancelled_by_you"
  /** Ended by the system (no venue in time, ticket gate, account change…). */
  | "cancelled";

export interface LastMatchOutcome {
  matchId: string;
  kind: MatchOutcomeKind;
  /** The silent side's rating was lowered (second offence). Only ever true on
   *  the two `expired_*silent*` kinds, and only when the expiry recorded it. */
  penalized: boolean;
  at: string;
}

export interface OutcomeRow {
  status: string;
  userAId: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  emergencyCancelledBy: string | null;
}

/** Pure classification — the tests pin the blind rule here. */
export function classifyMatchOutcome(row: OutcomeRow, userId: string): MatchOutcomeKind | null {
  const isA = row.userAId === userId;
  const mine = isA ? row.acceptedByA : row.acceptedByB;
  const theirs = isA ? row.acceptedByB : row.acceptedByA;

  if (row.status === "expired") {
    if (mine === null) return theirs === true ? "expired_missed_date" : "expired_you_silent";
    if (mine === false) return "expired_you_declined";
    return "expired_peer_silent";
  }
  if (row.status !== "cancelled") return null;

  // A decision outcome only once BOTH answers are on the row.
  if (mine !== null && theirs !== null && !(mine && theirs)) {
    return mine ? "declined_by_partner" : "declined_by_you";
  }
  if (row.emergencyCancelledBy === userId) return "cancelled_by_you";
  // Someone cancelled and it was not the caller — on a two-person row, the
  // partner. Only after the mutual yes is this column ever written.
  if (row.emergencyCancelledBy && mine === true && theirs === true) return "cancelled_by_partner";
  return "cancelled";
}

function metadataPenalised(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).penalised === true
  );
}

/**
 * The caller's most recently ended match inside the window, or null. Only
 * pairs the caller was actually shown (`dispatchedAt` set): a row cancelled
 * before its pitch went out is nothing this person ever heard of.
 */
export async function lastMatchOutcomeFor(
  userId: string,
  now: Date = new Date(),
): Promise<LastMatchOutcome | null> {
  const row = await prisma.match.findFirst({
    where: {
      status: { in: ["expired", "cancelled"] },
      dispatchedAt: { not: null },
      updatedAt: { gte: new Date(now.getTime() - LAST_MATCH_OUTCOME_WINDOW_MS) },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      status: true,
      userAId: true,
      acceptedByA: true,
      acceptedByB: true,
      emergencyCancelledBy: true,
      updatedAt: true,
    },
  });
  if (!row) return null;

  const kind = classifyMatchOutcome(row, userId);
  if (!kind) return null;

  let penalized = false;
  if (kind === "expired_you_silent" || kind === "expired_missed_date") {
    // Written by `match-expiry.ts` since 2026-11-15; an older row has no
    // metadata and reads as the warning — never claim a penalty not recorded.
    const event = await prisma.matchEvent.findFirst({
      where: { matchId: row.id, actorId: userId, actionType: "EXPIRED_SILENT" },
      select: { metadata: true },
    });
    penalized = metadataPenalised(event?.metadata);
  }

  return { matchId: row.id, kind, penalized, at: row.updatedAt.toISOString() };
}
