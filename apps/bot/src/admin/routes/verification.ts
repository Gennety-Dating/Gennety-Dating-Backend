import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isoWeekKey, summarise, histogram } from "../utils/buckets.js";
import { getOrCompute } from "../utils/cache.js";

export const verificationRouter: Router = Router();

const STUCK_PENDING_REVIEW_DAYS = 7;

verificationRouter.get(
  "/admin/analytics/verification",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("verification:v1", 600, async () => {
        const [users, reports] = await Promise.all([
          prisma.user.findMany({
            select: {
              id: true,
              verificationStatus: true,
              verificationSkippedAt: true,
              verifiedAt: true,
              faceMatchScore: true,
              faceMatchedAt: true,
              updatedAt: true,
              firstName: true,
              telegramId: true,
            },
          }),
          prisma.report.findMany({
            select: {
              tier: true,
              adminReviewed: true,
              createdAt: true,
              reportedId: true,
              reported: { select: { status: true } },
            },
          }),
        ]);

        // ── 1. Verification funnel
        const funnel: Record<string, number> = {
          unverified: 0,
          pending: 0,
          pending_review: 0,
          verified: 0,
          rejected: 0,
        };
        for (const u of users) {
          funnel[u.verificationStatus] = (funnel[u.verificationStatus] ?? 0) + 1;
        }

        // ── 2. faceMatchScore histogram
        const scores = users
          .map((u) => u.faceMatchScore)
          .filter((s): s is number => s !== null && Number.isFinite(s));
        const faceMatchScoreHistogram = histogram(scores, 0, 1, 10);
        const faceMatchSummary = summarise(scores);

        // ── 3. Skip rate
        const skipped = users.filter((u) => u.verificationSkippedAt !== null).length;
        const skipRate = users.length > 0 ? +(skipped / users.length).toFixed(4) : 0;

        // ── 4. Stuck pending_review (>7 days)
        const stuckThreshold = new Date(Date.now() - STUCK_PENDING_REVIEW_DAYS * 86_400_000);
        const stuckPendingReview = users
          .filter(
            (u) =>
              u.verificationStatus === "pending_review" && u.updatedAt < stuckThreshold,
          )
          .map((u) => ({
            id: u.id,
            telegramId: u.telegramId.toString(),
            firstName: u.firstName,
            faceMatchScore: u.faceMatchScore,
            stuckSince: u.updatedAt,
            daysStuck: Math.floor((Date.now() - u.updatedAt.getTime()) / 86_400_000),
          }))
          .sort((a, b) => b.daysStuck - a.daysStuck);

        // ── 5. Reports — weekly trend by tier
        const weeklyReports = new Map<string, { tier1: number; tier2: number; tier3: number }>();
        const tierTotals = { 1: 0, 2: 0, 3: 0 };
        const processingDaysByTier: Record<number, number[]> = { 1: [], 2: [], 3: [] };
        let falsePositiveProxy = 0;
        let reviewedTotal = 0;

        for (const r of reports) {
          const wk = isoWeekKey(r.createdAt);
          let bucket = weeklyReports.get(wk);
          if (!bucket) {
            bucket = { tier1: 0, tier2: 0, tier3: 0 };
            weeklyReports.set(wk, bucket);
          }
          if (r.tier === 1) bucket.tier1++;
          else if (r.tier === 2) bucket.tier2++;
          else if (r.tier === 3) bucket.tier3++;
          tierTotals[r.tier as 1 | 2 | 3] = (tierTotals[r.tier as 1 | 2 | 3] ?? 0) + 1;

          if (r.adminReviewed) {
            reviewedTotal++;
            // Processing time approx = now - createdAt (we don't store
            // reviewedAt). Future schema change: add a column.
            const days = (Date.now() - r.createdAt.getTime()) / 86_400_000;
            if (Number.isFinite(days)) processingDaysByTier[r.tier]?.push(days);
            // False-positive proxy: reviewed AND reported user is still
            // active (not suspended/banned). Imperfect but informative.
            if (
              r.reported.status !== "suspended" &&
              r.reported.status !== "banned"
            ) {
              falsePositiveProxy++;
            }
          }
        }

        const reportsWeekly = Array.from(weeklyReports.entries())
          .map(([week, c]) => ({ week, ...c }))
          .sort((a, b) => a.week.localeCompare(b.week));

        const processingTime = {
          tier1: summarise(processingDaysByTier[1]!),
          tier2: summarise(processingDaysByTier[2]!),
          tier3: summarise(processingDaysByTier[3]!),
        };

        const falsePositiveRate =
          reviewedTotal > 0 ? +(falsePositiveProxy / reviewedTotal).toFixed(4) : null;

        return {
          funnel,
          totalUsers: users.length,
          faceMatchScoreHistogram,
          faceMatchSummary,
          skipped,
          skipRate,
          stuckPendingReview,
          stuckThresholdDays: STUCK_PENDING_REVIEW_DAYS,
          reportsWeekly,
          tierTotals,
          processingTime,
          falsePositiveProxy,
          falsePositiveRate,
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] verification error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
