import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isoWeekKey } from "../utils/buckets.js";
import { getOrCompute } from "../utils/cache.js";

export const retentionRouter: Router = Router();

const WEEK_MS = 7 * 86_400_000;
const COHORT_OFFSETS = [1, 2, 4, 8] as const;

retentionRouter.get(
  "/admin/analytics/retention",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("retention:v1", 1800, async () => {
        const now = new Date();

        // Per-user activity proxy: lastMessageAt OR last MatchEvent timestamp.
        // We pull both and merge — `lastMessageAt` covers bot interaction,
        // MatchEvent covers users who only act on weekly proposals.
        const [users, lastEvents] = await Promise.all([
          prisma.user.findMany({
            select: {
              id: true,
              createdAt: true,
              status: true,
              lastMessageAt: true,
              platform: true,
              referralSource: true,
              reEngagementStep: true,
            },
          }),
          prisma.matchEvent.groupBy({
            by: ["actorId"],
            _max: { createdAt: true },
          }),
        ]);

        const lastEventByUser = new Map<string, Date>();
        for (const r of lastEvents) {
          if (r._max.createdAt) lastEventByUser.set(r.actorId, r._max.createdAt);
        }

        const lastActivity = (u: (typeof users)[number]): Date => {
          const a = u.lastMessageAt ?? u.createdAt;
          const b = lastEventByUser.get(u.id);
          if (b && b > a) return b;
          return a;
        };

        // ── 1. Cohort retention matrix (weekly cohort × W+1/2/4/8)
        type CohortRow = {
          cohort: string;
          size: number;
          retained: Record<number, number | null>;
        };
        const cohortMap = new Map<string, { size: number; users: Array<{ created: Date; last: Date }> }>();
        for (const u of users) {
          const key = isoWeekKey(u.createdAt);
          let bucket = cohortMap.get(key);
          if (!bucket) {
            bucket = { size: 0, users: [] };
            cohortMap.set(key, bucket);
          }
          bucket.size++;
          bucket.users.push({ created: u.createdAt, last: lastActivity(u) });
        }
        const cohorts: CohortRow[] = Array.from(cohortMap.entries())
          .map(([cohort, { size, users: us }]) => {
            const retained: Record<number, number | null> = {};
            for (const offset of COHORT_OFFSETS) {
              // Only meaningful if `offset` weeks have elapsed since the
              // *latest* cohort member registered. Otherwise we'd be
              // dividing by an incomplete denominator.
              const minAgeMs = offset * WEEK_MS;
              const cohortStart = us.reduce(
                (earliest, u) => (u.created < earliest ? u.created : earliest),
                us[0]!.created,
              );
              if (now.getTime() - cohortStart.getTime() < minAgeMs) {
                retained[offset] = null;
                continue;
              }
              let n = 0;
              for (const u of us) {
                const cutoff = new Date(u.created.getTime() + minAgeMs);
                if (u.last >= cutoff) n++;
              }
              retained[offset] = +(n / size).toFixed(4);
            }
            return { cohort, size, retained };
          })
          .sort((a, b) => a.cohort.localeCompare(b.cohort));

        // ── 2. Status breakdown
        const statusBreakdown: Record<string, number> = {};
        for (const u of users) {
          statusBreakdown[u.status] = (statusBreakdown[u.status] ?? 0) + 1;
        }

        // ── 3. Avg matches per user
        const matchEvents = await prisma.matchEvent.groupBy({
          by: ["actorId"],
          _count: { _all: true },
          where: { actionType: { in: ["ACCEPTED", "DECLINED"] } },
        });
        const totalDecisions = matchEvents.reduce((acc, r) => acc + r._count._all, 0);
        const avgMatchesPerUser =
          users.length > 0 ? +(totalDecisions / users.length).toFixed(2) : 0;

        // ── 4. Re-engagement step funnel
        const reEngagement: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        for (const u of users) {
          const step = Math.min(Math.max(u.reEngagementStep, 0), 5);
          reEngagement[step] = (reEngagement[step] ?? 0) + 1;
        }

        // ── 5. Weekly registrations (overall)
        const weeklyRegMap = new Map<string, number>();
        for (const u of users) {
          const k = isoWeekKey(u.createdAt);
          weeklyRegMap.set(k, (weeklyRegMap.get(k) ?? 0) + 1);
        }
        const weeklyRegistrations = Array.from(weeklyRegMap.entries())
          .map(([week, count]) => ({ week, count }))
          .sort((a, b) => a.week.localeCompare(b.week));

        // ── 6. Platform split + retention proxy (active rate)
        const platformStats: Record<string, { total: number; active: number }> = {
          telegram: { total: 0, active: 0 },
          mobile: { total: 0, active: 0 },
          both: { total: 0, active: 0 },
        };
        for (const u of users) {
          const p = u.platform;
          if (!platformStats[p]) platformStats[p] = { total: 0, active: 0 };
          platformStats[p]!.total++;
          if (u.status === "active") platformStats[p]!.active++;
        }
        const platformSplit = Object.entries(platformStats).map(([platform, s]) => ({
          platform,
          total: s.total,
          active: s.active,
          activeRate: s.total > 0 ? +(s.active / s.total).toFixed(4) : 0,
        }));

        // ── 7. Top referral sources
        const referralCounts = new Map<string, number>();
        for (const u of users) {
          if (!u.referralSource) continue;
          referralCounts.set(
            u.referralSource,
            (referralCounts.get(u.referralSource) ?? 0) + 1,
          );
        }
        const topReferralSources = Array.from(referralCounts.entries())
          .map(([source, count]) => ({ source, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);
        const referralUnknown = users.filter((u) => !u.referralSource).length;

        return {
          totalUsers: users.length,
          cohorts,
          statusBreakdown,
          avgMatchesPerUser,
          reEngagementFunnel: reEngagement,
          weeklyRegistrations,
          platformSplit,
          topReferralSources,
          referralUnknown,
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] retention error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
