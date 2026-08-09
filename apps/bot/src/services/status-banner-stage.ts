import { prisma, type MatchStatus } from "@gennety/db";
import type { StatusBannerStage } from "./status-banner-view.js";
import {
  ACTIVE_MATCH_STATUSES,
  pickCurrentMatch,
} from "./active-match-priority.js";
import { minutesLeftFromDispatch } from "../utils/countdown-plate.js";

/** The match columns {@link resolveBannerStage} reads. */
export interface BannerStageMatch {
  status: MatchStatus;
  agreedTime: Date | null;
  venueName: string | null;
  dispatchedAt: Date | null;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
}

/**
 * Map one live match to the banner stage its participant should see
 * (PRODUCT_SPEC §2.1). `undefined` means no stage applies and the ordinary
 * next-drop countdown is the honest thing to show.
 *
 * Pure — the whole product decision lives here, so it is unit-tested without
 * Prisma or grammY.
 *
 * Lives in the service layer rather than in `workers/status-timer.ts` because
 * the once-a-minute tick is no longer the only caller: a venue change pushes
 * the banner immediately (`services/status-banner-refresh.ts`), and both must
 * resolve the stage identically or the push and the poll would fight over the
 * same message.
 */
export function resolveBannerStage(
  match: BannerStageMatch,
  side: "A" | "B",
  now: Date,
): StatusBannerStage | undefined {
  if (match.status === "scheduled") {
    // A date that already happened is over. The row lingers until the T+24h
    // feedback flow closes it, and by then the next drop is genuinely the
    // relevant thing again — so fall back to the drop countdown.
    if (!match.agreedTime || match.agreedTime <= now) return undefined;
    return { kind: "date", at: match.agreedTime, venueName: match.venueName };
  }

  if (match.status === "proposed") {
    const decided = side === "A" ? match.acceptedByA : match.acceptedByB;
    // A first decider leaves the row `proposed` either way (§3.4), so both
    // verdicts land here and they mean opposite things.
    if (decided === false) {
      // They passed. Nothing is being planned and nothing is owed — the row
      // just waits out the peer or the TTL. Anything else here would be a
      // banner about a date they declined.
      return undefined;
    }
    if (decided === true) {
      // Accepted, peer still silent. Deliberately says only that something is
      // in flight: the copy must never assert what the partner chose
      // (blind-decision invariant §3.4).
      return { kind: "planning" };
    }
    if (!match.dispatchedAt) return undefined;
    const minutesLeft = minutesLeftFromDispatch(match.dispatchedAt, now);
    // Past the TTL the expiry cron owns the row (it runs every 15 min), so
    // claiming there is still time to answer would be false.
    if (minutesLeft <= 0) return undefined;
    return { kind: "decision", minutesLeft };
  }

  // negotiating / negotiating_venue — the date is being arranged.
  return { kind: "planning" };
}

/**
 * Resolve every given user's banner stage in one query. A user holds at most
 * one live match (§3.2 filter 8), but legacy/corrupt rows can break that, so
 * the winner is chosen by `pickCurrentMatch` (product progression) rather than
 * by enum order — see ARCHITECTURE.md.
 */
export async function loadBannerStages(
  userIds: string[],
  now: Date,
): Promise<Map<string, StatusBannerStage>> {
  const stages = new Map<string, StatusBannerStage>();
  if (userIds.length === 0) return stages;

  const live = await prisma.match.findMany({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: { in: userIds } }, { userBId: { in: userIds } }],
    },
    // `pickCurrentMatch` breaks ties by input order, so the newest row within
    // a status has to come first.
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      userAId: true,
      userBId: true,
      agreedTime: true,
      venueName: true,
      dispatchedAt: true,
      acceptedByA: true,
      acceptedByB: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
    },
  });

  const wanted = new Set(userIds);
  const candidates = new Map<
    string,
    { status: MatchStatus; match: BannerStageMatch; side: "A" | "B" }[]
  >();

  for (const match of live) {
    for (const side of ["A", "B"] as const) {
      const userId = side === "A" ? match.userAId : match.userBId;
      if (!wanted.has(userId)) continue;
      // A proposed match becomes visible to each side only once that side's
      // own pitch was actually delivered — the same rule the My Date row uses
      // (services/active-match.ts), so the banner can't announce a match
      // mid-dispatch or one that only reached the partner.
      if (match.status === "proposed") {
        const delivered =
          side === "A" ? match.pitchMessageIdA : match.pitchMessageIdB;
        if (delivered === null) continue;
      }
      const entry = { status: match.status, match, side };
      const bucket = candidates.get(userId);
      if (bucket) bucket.push(entry);
      else candidates.set(userId, [entry]);
    }
  }

  for (const [userId, entries] of candidates) {
    const current = pickCurrentMatch(entries);
    if (!current) continue;
    const stage = resolveBannerStage(current.match, current.side, now);
    if (stage) stages.set(userId, stage);
  }

  return stages;
}
