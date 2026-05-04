import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isoWeekKey, summarise } from "../utils/buckets.js";
import { getOrCompute } from "../utils/cache.js";

export const genderRouter: Router = Router();

const STALE_ACTIVE_DAYS = 21; // >3 weeks active without a match

/**
 * Gender-balance dashboard. Multiple distinct queries — each is cheap on
 * its own, so we issue them in parallel inside a single getOrCompute.
 */
genderRouter.get(
  "/admin/analytics/gender",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("gender:v1", 600, async () => {
        const [allUsers, matchEvents, allMatches, noMatchNotices] = await Promise.all([
          prisma.user.findMany({
            select: {
              id: true,
              gender: true,
              preference: true,
              status: true,
              universityDomain: true,
              createdAt: true,
            },
          }),
          // Earliest ACCEPTED/DECLINED event per user → "first match" timestamp.
          // Cheaper than recomputing per row inside the loop.
          prisma.matchEvent.findMany({
            where: { actionType: { in: ["ACCEPTED", "DECLINED"] } },
            select: { actorId: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          }),
          prisma.match.findMany({ select: { userAId: true, userBId: true, createdAt: true } }),
          prisma.noMatchNotice.findMany({
            select: { userId: true, sentAt: true },
            orderBy: { sentAt: "desc" },
          }),
        ]);

        // ── 1. Weekly registrations by gender
        const weeklyReg = new Map<string, { male: number; female: number; unknown: number }>();
        for (const u of allUsers) {
          const wk = isoWeekKey(u.createdAt);
          let bucket = weeklyReg.get(wk);
          if (!bucket) {
            bucket = { male: 0, female: 0, unknown: 0 };
            weeklyReg.set(wk, bucket);
          }
          if (u.gender === "male") bucket.male++;
          else if (u.gender === "female") bucket.female++;
          else bucket.unknown++;
        }
        const weeklyRegistrations = Array.from(weeklyReg.entries())
          .map(([week, counts]) => ({ week, ...counts }))
          .sort((a, b) => a.week.localeCompare(b.week));

        // ── 2. Conversion funnel by gender
        const funnelTemplate = () => ({ onboarding: 0, active: 0, gotMatch: 0 });
        const funnel = {
          male: funnelTemplate(),
          female: funnelTemplate(),
          unknown: funnelTemplate(),
        };
        const matchedUserIds = new Set<string>();
        for (const m of allMatches) {
          matchedUserIds.add(m.userAId);
          matchedUserIds.add(m.userBId);
        }
        for (const u of allUsers) {
          const key = (u.gender ?? "unknown") as keyof typeof funnel;
          if (u.status === "onboarding") funnel[key].onboarding++;
          if (u.status === "active") funnel[key].active++;
          if (matchedUserIds.has(u.id)) funnel[key].gotMatch++;
        }

        // ── 3. Wait-time distribution (median) — censored count for those still waiting
        const firstDecisionByUser = new Map<string, Date>();
        for (const e of matchEvents) {
          if (!firstDecisionByUser.has(e.actorId)) {
            firstDecisionByUser.set(e.actorId, e.createdAt);
          }
        }
        const now = new Date();
        const waitDaysByGender: Record<string, number[]> = { male: [], female: [], unknown: [] };
        const censoredByGender: Record<string, number> = { male: 0, female: 0, unknown: 0 };
        for (const u of allUsers) {
          if (u.status !== "active" && u.status !== "onboarding") continue;
          const key = (u.gender ?? "unknown") as keyof typeof waitDaysByGender;
          const decided = firstDecisionByUser.get(u.id);
          if (decided) {
            const days = (decided.getTime() - u.createdAt.getTime()) / 86_400_000;
            waitDaysByGender[key]!.push(days);
          } else if (u.status === "active") {
            const days = (now.getTime() - u.createdAt.getTime()) / 86_400_000;
            if (days > 0) {
              censoredByGender[key]!++;
            }
          }
        }
        const waitTime = {
          male: { ...summarise(waitDaysByGender.male!), censored: censoredByGender.male },
          female: { ...summarise(waitDaysByGender.female!), censored: censoredByGender.female },
          unknown: { ...summarise(waitDaysByGender.unknown!), censored: censoredByGender.unknown },
        };

        // ── 4. % no-match by gender (NoMatchNotice)
        const noticeUserIds = new Set<string>(noMatchNotices.map((n) => n.userId));
        const noMatchPctByGender = { male: 0, female: 0, unknown: 0 };
        const totalByGender = { male: 0, female: 0, unknown: 0 };
        const noticeCountByGender = { male: 0, female: 0, unknown: 0 };
        for (const u of allUsers) {
          if (u.status !== "active") continue;
          const key = (u.gender ?? "unknown") as keyof typeof totalByGender;
          totalByGender[key]++;
          if (noticeUserIds.has(u.id)) noticeCountByGender[key]++;
        }
        for (const k of ["male", "female", "unknown"] as const) {
          noMatchPctByGender[k] =
            totalByGender[k] > 0
              ? +(noticeCountByGender[k] / totalByGender[k]).toFixed(4)
              : 0;
        }

        // ── 5. Preference effectiveness — what each cohort is actually looking for
        const preferenceMatrix = {
          male: { men: 0, women: 0, both: 0, unknown: 0 },
          female: { men: 0, women: 0, both: 0, unknown: 0 },
          unknown: { men: 0, women: 0, both: 0, unknown: 0 },
        };
        for (const u of allUsers) {
          const g = (u.gender ?? "unknown") as keyof typeof preferenceMatrix;
          const p = u.preference ?? "unknown";
          preferenceMatrix[g][p as keyof typeof preferenceMatrix.male]++;
        }

        // ── 6. Skewed universities (>70% one gender, with N >= 10)
        const uniBreakdown = new Map<string, { male: number; female: number; total: number }>();
        for (const u of allUsers) {
          if (!u.universityDomain) continue;
          let bucket = uniBreakdown.get(u.universityDomain);
          if (!bucket) {
            bucket = { male: 0, female: 0, total: 0 };
            uniBreakdown.set(u.universityDomain, bucket);
          }
          bucket.total++;
          if (u.gender === "male") bucket.male++;
          else if (u.gender === "female") bucket.female++;
        }
        const skewedUniversities = Array.from(uniBreakdown.entries())
          .map(([domain, c]) => ({
            domain,
            male: c.male,
            female: c.female,
            total: c.total,
            malePct: c.total > 0 ? +(c.male / c.total).toFixed(4) : 0,
          }))
          .filter((u) => u.total >= 10 && (u.malePct >= 0.7 || u.malePct <= 0.3))
          .sort((a, b) => b.total - a.total);

        // ── 7. Stale-active cohort (active >21 days without any match)
        const staleThreshold = new Date(Date.now() - STALE_ACTIVE_DAYS * 86_400_000);
        const staleActive = { male: 0, female: 0, unknown: 0 };
        for (const u of allUsers) {
          if (u.status !== "active") continue;
          if (matchedUserIds.has(u.id)) continue;
          if (u.createdAt > staleThreshold) continue;
          const key = (u.gender ?? "unknown") as keyof typeof staleActive;
          staleActive[key]++;
        }

        return {
          weeklyRegistrations,
          funnel,
          waitTime,
          noMatchPctByGender,
          preferenceMatrix,
          skewedUniversities,
          staleActive,
          staleActiveThresholdDays: STALE_ACTIVE_DAYS,
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] gender error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
