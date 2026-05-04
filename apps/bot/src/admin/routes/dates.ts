import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { summarise, histogram } from "../utils/buckets.js";
import {
  detectFeedbackSentiment,
  FEEDBACK_SENTIMENT_VALUES,
} from "../utils/psych-scan.js";
import { getOrCompute } from "../utils/cache.js";

export const datesRouter: Router = Router();

datesRouter.get(
  "/admin/analytics/dates",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("dates:v1", 600, async () => {
        const [matches, chemistryEvents, profiles] = await Promise.all([
          prisma.match.findMany({
            where: {
              status: { in: ["scheduled", "completed", "cancelled"] },
            },
            select: {
              status: true,
              agreedTime: true,
              createdAt: true,
              feedbackByA: true,
              feedbackByB: true,
            },
          }),
          prisma.matchEvent.groupBy({
            by: ["actionType"],
            _count: { _all: true },
            where: {
              actionType: { in: ["CHEMISTRY_POSITIVE", "CHEMISTRY_NEGATIVE"] },
            },
          }),
          prisma.profile.findMany({
            select: { silentIgnoreCount: true },
          }),
        ]);

        // ── 1. scheduled → completed conversion
        const scheduled = matches.filter((m) => m.status === "scheduled" || m.status === "completed").length;
        const completed = matches.filter((m) => m.status === "completed").length;
        const cancelled = matches.filter((m) => m.status === "cancelled").length;
        const completionRate = scheduled > 0 ? +(completed / scheduled).toFixed(4) : 0;

        // ── 2. Match → date interval (days from match creation to agreedTime)
        const matchToDateDays: number[] = [];
        for (const m of matches) {
          if (m.agreedTime) {
            const days = (m.agreedTime.getTime() - m.createdAt.getTime()) / 86_400_000;
            if (Number.isFinite(days) && days >= 0) matchToDateDays.push(days);
          }
        }
        const matchToDate = summarise(matchToDateDays);

        // ── 3. Feedback sentiment (keyword-scan)
        const sentimentCounts = Object.fromEntries(
          FEEDBACK_SENTIMENT_VALUES.map((s) => [s, 0]),
        ) as Record<string, number>;
        for (const m of matches) {
          if (m.feedbackByA) sentimentCounts[detectFeedbackSentiment(m.feedbackByA)]++;
          if (m.feedbackByB) sentimentCounts[detectFeedbackSentiment(m.feedbackByB)]++;
        }
        const feedbackSentiment = FEEDBACK_SENTIMENT_VALUES.map((s) => ({
          sentiment: s,
          count: sentimentCounts[s] ?? 0,
        }));

        // ── 4. Chemistry events
        const chemistry = {
          positive: 0,
          negative: 0,
          ratio: null as number | null,
        };
        for (const c of chemistryEvents) {
          if (c.actionType === "CHEMISTRY_POSITIVE") chemistry.positive = c._count._all;
          else if (c.actionType === "CHEMISTRY_NEGATIVE") chemistry.negative = c._count._all;
        }
        const chemTotal = chemistry.positive + chemistry.negative;
        chemistry.ratio = chemTotal > 0 ? +(chemistry.positive / chemTotal).toFixed(4) : null;

        // ── 5. Silent-ignore distribution
        const silentIgnoreVals = profiles.map((p) => p.silentIgnoreCount);
        const silentIgnoreHistogram = histogram(silentIgnoreVals, 0, 10, 11);

        return {
          scheduledCount: scheduled,
          completedCount: completed,
          cancelledCount: cancelled,
          completionRate,
          matchToDate,
          feedbackSentiment,
          chemistry,
          silentIgnoreHistogram,
          totalSilentIgnores: silentIgnoreVals.reduce((a, b) => a + b, 0),
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] dates error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
