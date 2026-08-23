import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  claimMatchCancellation,
  deliverCancelledPartnerEffects,
} from "./cancel-in-flight-matches.js";

/**
 * Blocking one user from another (App Store guideline 1.2).
 *
 * The product has no browsing and no user-to-user chat, so there is exactly one
 * way to meet somebody: a match. That makes the match the natural handle — the
 * client blocks "the person on this date", never a user id it was never given.
 *
 * Three things a block does, and one it deliberately does not:
 *
 *  1. **It records the boundary** (`UserBlock`), symmetric in effect and
 *     lasting beyond the match it came from.
 *  2. **It ends the live interaction.** An in-flight match between the two is
 *     cancelled through the same rail a freeze uses, so tickets go back and the
 *     partner gets the ordinary "your date was cancelled" notice. Without this
 *     the button would be a lie: the blocked person would still be standing
 *     outside the venue at eight.
 *  3. **It closes the proxy chat** — for free, because that window is gated on
 *     `status === "scheduled"` and the cancellation above moves it off.
 *
 * What it does NOT do is accuse anyone. Blocking runs no moderation, files no
 * report, touches no Elo, and never reaches the blocked side. That separation
 * is the point: a person who is frightened of their date must be able to make
 * them go away without first making a case.
 *
 * **On matching, the block is belt-and-braces today and load-bearing tomorrow.**
 * The lifetime pair ban (`buildCandidateSql`, `loadHistoricalMatchPairs`)
 * already guarantees two people who have matched are never paired again, so a
 * block filed from a match changes nothing about the pool right now. It is
 * enforced anyway, in both directions, because the ban is a product decision
 * that could be revisited (REMATCH_PRODUCT_SPEC.md circles it every time) while
 * a block is a promise to a user that must survive such a revision.
 */

export type BlockPartnerOutcome =
  | { outcome: "ok"; blockedUserId: string; dateCancelled: boolean }
  | { outcome: "forbidden" };

/**
 * Block the other participant of `matchId` on behalf of `blockerUserId`.
 *
 * `api` is a parameter rather than a lookup so this module stays free of the
 * public Express server (where the injected bot handle lives) and testable
 * without one — the same split `rematch.ts` uses. Pass `null` and the partner's
 * Telegram notice is skipped; their push still goes out.
 */
export async function blockMatchPartner(
  matchId: string,
  blockerUserId: string,
  api: Api<RawApi> | null,
): Promise<BlockPartnerOutcome> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { userAId: true, userBId: true },
  });
  if (!match) return { outcome: "forbidden" };

  const blockedUserId =
    match.userAId === blockerUserId
      ? match.userBId
      : match.userBId === blockerUserId
        ? match.userAId
        : null;
  // 403 rather than 404 for a stranger's match id: the caller learns nothing
  // about whether the id exists, which is the same posture `submitMatchReport`
  // takes.
  if (!blockedUserId) return { outcome: "forbidden" };

  // Row and cancellation in one transaction: a block that recorded but left the
  // date standing is the failure mode worth designing against.
  const cancelled = await prisma.$transaction(async (tx) => {
    await tx.userBlock.upsert({
      // Re-blocking is a no-op, not a second row and not an error — the client
      // may retry a request whose response it never saw.
      where: { blockerId_blockedId: { blockerId: blockerUserId, blockedId: blockedUserId } },
      create: { blockerId: blockerUserId, blockedId: blockedUserId, matchId },
      update: {},
    });
    return claimMatchCancellation(matchId, blockerUserId, tx, { strict: true });
  });

  if (cancelled) {
    // Post-commit, best-effort: refunds and the partner notice are compensation,
    // and neither is worth un-blocking somebody over.
    await deliverCancelledPartnerEffects([cancelled], api);
  }

  return { outcome: "ok", blockedUserId, dateCancelled: cancelled !== null };
}

/**
 * Lift a block. Returns false when there was nothing to lift, so the route can
 * answer 404 instead of pretending it undid something.
 *
 * Unblocking does NOT restore the cancelled date, and cannot: the match row is
 * terminal and the lifetime pair ban keeps the two out of each other's pool
 * regardless. It only removes the record — which matters for the one case the
 * list exists for, a block filed by mistake.
 */
export async function unblockUser(
  blockerUserId: string,
  blockedUserId: string,
): Promise<boolean> {
  const removed = await prisma.userBlock.deleteMany({
    where: { blockerId: blockerUserId, blockedId: blockedUserId },
  });
  return removed.count > 0;
}

export interface BlockedPerson {
  userId: string;
  firstName: string | null;
  blockedAt: Date;
}

/**
 * The blocker's own list, newest first. Shows only people THIS user blocked —
 * never who blocked them, which is the whole reason the row is directional.
 */
export async function listBlockedUsers(
  blockerUserId: string,
): Promise<BlockedPerson[]> {
  const rows = await prisma.userBlock.findMany({
    where: { blockerId: blockerUserId },
    orderBy: { createdAt: "desc" },
    select: {
      blockedId: true,
      createdAt: true,
      blocked: { select: { firstName: true } },
    },
  });
  return rows.map((row) => ({
    userId: row.blockedId,
    firstName: row.blocked.firstName,
    blockedAt: row.createdAt,
  }));
}

/**
 * Every blocked pair touching `userIds`, as `"a:b"` keys in BOTH directions —
 * the same shape and the same both-ways convention as
 * `loadHistoricalMatchPairs`, so the batch can union the two sets and keep one
 * membership test.
 */
export async function loadBlockedPairKeys(
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();

  const blocks = await prisma.userBlock.findMany({
    where: {
      OR: [{ blockerId: { in: userIds } }, { blockedId: { in: userIds } }],
    },
    select: { blockerId: true, blockedId: true },
  });

  const keys = new Set<string>();
  for (const b of blocks) {
    keys.add(`${b.blockerId}:${b.blockedId}`);
    keys.add(`${b.blockedId}:${b.blockerId}`);
  }
  return keys;
}

/** True when either side has blocked the other. */
export async function isPairBlocked(
  userIdA: string,
  userIdB: string,
): Promise<boolean> {
  const found = await prisma.userBlock.findFirst({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA },
      ],
    },
    select: { id: true },
  });
  return found !== null;
}
