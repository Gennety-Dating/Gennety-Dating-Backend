import { prisma, type MatchStatus, type Prisma } from "@gennety/db";
import type { WeeklyMatchStatus } from "@gennety/shared";
import { getNextBatchDate, getPreviousBatchDate } from "./next-batch.js";

const ACTIVE_MATCH_STATUSES: MatchStatus[] = [
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
];

export interface WeeklyStatusSnapshot {
  weeklyStatus: WeeklyMatchStatus;
  standbyCount: number;
  priorityBoosted: boolean;
  resolvedAt: string | null;
}

/**
 * The profile columns the weekly status is built from. The caller reads them:
 * `/v1/countdown` folds them into the one profile read it already makes for the
 * city counter and the calibration window, instead of reading the row three
 * times per poll.
 */
export const WEEKLY_STATUS_PROFILE_SELECT = {
  standbyCount: true,
  lastMissedAt: true,
} as const satisfies Prisma.ProfileSelect;

export type WeeklyStatusProfile = Prisma.ProfileGetPayload<{
  select: typeof WEEKLY_STATUS_PROFILE_SELECT;
}>;

/** `profile` is the user's row read with `WEEKLY_STATUS_PROFILE_SELECT`, null when there is none. */
export async function resolveWeeklyStatusForUser(
  userId: string,
  profile: WeeklyStatusProfile | null,
  now: Date = new Date(),
): Promise<WeeklyStatusSnapshot> {
  const activeMatch = await prisma.match.findFirst({
    where: {
      status: { in: ACTIVE_MATCH_STATUSES },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
    select: { id: true },
  });

  const standbyCount = profile?.standbyCount ?? 0;
  const lastMissedAt = profile?.lastMissedAt ?? null;

  if (activeMatch) {
    return {
      weeklyStatus: "matched",
      standbyCount,
      priorityBoosted: false,
      resolvedAt: null,
    };
  }

  const previousBatchAt = getPreviousBatchDate(now);
  const nextBatchAt = getNextBatchDate(now);
  const priorityBoosted =
    standbyCount > 0 &&
    lastMissedAt !== null &&
    lastMissedAt >= previousBatchAt &&
    lastMissedAt < nextBatchAt;

  return {
    weeklyStatus: priorityBoosted ? "standby" : "pending",
    standbyCount,
    priorityBoosted,
    resolvedAt: lastMissedAt?.toISOString() ?? null,
  };
}
