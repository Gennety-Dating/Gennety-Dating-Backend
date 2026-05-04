import { prisma, type MatchStatus } from "@gennety/db";
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

export async function resolveWeeklyStatusForUser(
  userId: string,
  now: Date = new Date(),
): Promise<WeeklyStatusSnapshot> {
  const [profile, activeMatch] = await Promise.all([
    prisma.profile.findUnique({
      where: { userId },
      select: {
        standbyCount: true,
        lastMissedAt: true,
      },
    }),
    prisma.match.findFirst({
      where: {
        status: { in: ACTIVE_MATCH_STATUSES },
        OR: [{ userAId: userId }, { userBId: userId }],
      },
      select: { id: true },
    }),
  ]);

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
