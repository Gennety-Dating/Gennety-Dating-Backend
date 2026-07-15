import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { getOrCompute } from "../utils/cache.js";
import {
  computeOnboardingFunnel,
  type StepEventLite,
} from "../utils/onboarding-funnel.js";
import { ONBOARDING_QUESTIONS } from "../../services/onboarding-collector.js";

export const onboardingFunnelRouter: Router = Router();

// Canonical conversational step order = the collector's question list minus the
// terminal `complete` sentinel, with the post-finalize `verification` CTA
// appended so the funnel spans the full journey the user can bail on. Kept in
// sync automatically by deriving from `ONBOARDING_QUESTIONS`.
const STEP_ORDER: readonly string[] = [
  ...ONBOARDING_QUESTIONS.filter((q) => q !== "complete"),
  "verification",
];

const WEEK_MS = 7 * 86_400_000;

// ---------------------------------------------------------------------------
// GET /admin/analytics/onboarding-funnel
// Per-step drop-off + hesitation, plus the verification tail from user status.
// ---------------------------------------------------------------------------
onboardingFunnelRouter.get(
  "/admin/analytics/onboarding-funnel",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("onboarding_funnel:v1", 900, async () => {
        const [events, users] = await Promise.all([
          prisma.onboardingStepEvent.findMany({
            select: { userId: true, step: true, kind: true, dwellMs: true },
          }),
          prisma.user.findMany({
            select: {
              id: true,
              status: true,
              onboardingStep: true,
              verificationStatus: true,
            },
          }),
        ]);

        // A user is still inside the conversational funnel until they reach the
        // `completed` onboarding step — only those can be "stuck" at a step.
        const incomplete = new Set(
          users.filter((u) => u.onboardingStep !== "completed").map((u) => u.id),
        );

        const funnel = computeOnboardingFunnel(
          events as StepEventLite[],
          STEP_ORDER,
          incomplete,
        );

        // Verification tail derived from durable user status (no extra events).
        const finalized = users.filter((u) => u.onboardingStep === "completed");
        const tail = {
          finalizedOnboarding: finalized.length,
          verified: finalized.filter((u) => u.verificationStatus === "verified").length,
          pendingVerification: finalized.filter((u) =>
            u.verificationStatus === "pending" || u.verificationStatus === "unverified",
          ).length,
          rejectedOrReview: finalized.filter((u) =>
            u.verificationStatus === "rejected" || u.verificationStatus === "pending_review",
          ).length,
          active: users.filter((u) => u.status === "active").length,
        };

        return { generatedAt: new Date().toISOString(), ...funnel, tail };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] onboarding-funnel error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/founder-digest
// This-week vs last-week headline numbers for the weekly founder report.
// ---------------------------------------------------------------------------
onboardingFunnelRouter.get(
  "/admin/analytics/founder-digest",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("founder_digest:v1", 900, async () => {
        const now = Date.now();
        const weekAgo = new Date(now - WEEK_MS);
        const twoWeeksAgo = new Date(now - 2 * WEEK_MS);

        const [
          newThisWeek,
          newLastWeek,
          completedThisWeek,
          activeTotal,
          usersTotal,
          matchStatusGroups,
          matchesThisWeek,
          matchesLastWeek,
          noMatchThisWeek,
          verificationGroups,
        ] = await Promise.all([
          prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
          prisma.user.count({
            where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } },
          }),
          prisma.user.count({
            where: {
              onboardingStep: "completed",
              updatedAt: { gte: weekAgo },
            },
          }),
          prisma.user.count({ where: { status: "active" } }),
          prisma.user.count(),
          prisma.match.groupBy({ by: ["status"], _count: { _all: true } }),
          prisma.match.count({ where: { createdAt: { gte: weekAgo } } }),
          prisma.match.count({
            where: { createdAt: { gte: twoWeeksAgo, lt: weekAgo } },
          }),
          prisma.noMatchNotice.count({ where: { sentAt: { gte: weekAgo } } }),
          prisma.user.groupBy({
            by: ["verificationStatus"],
            where: { onboardingStep: "completed" },
            _count: { _all: true },
          }),
        ]);

        const matchByStatus: Record<string, number> = {};
        for (const g of matchStatusGroups) matchByStatus[g.status] = g._count._all;
        const accepted =
          (matchByStatus.negotiating ?? 0) +
          (matchByStatus.negotiating_venue ?? 0) +
          (matchByStatus.scheduled ?? 0) +
          (matchByStatus.completed ?? 0);
        const proposedTotal = Object.values(matchByStatus).reduce((a, b) => a + b, 0);

        const verifByStatus: Record<string, number> = {};
        for (const g of verificationGroups) verifByStatus[g.verificationStatus] = g._count._all;
        const verifiedCount = verifByStatus.verified ?? 0;
        const verifDecided =
          verifiedCount + (verifByStatus.rejected ?? 0) + (verifByStatus.pending_review ?? 0);

        const growthPct = (cur: number, prev: number): number | null =>
          prev > 0 ? +(((cur - prev) / prev) * 100).toFixed(1) : null;

        return {
          generatedAt: new Date().toISOString(),
          window: "rolling 7-day windows (thisWeek vs lastWeek)",
          users: {
            total: usersTotal,
            active: activeTotal,
            newThisWeek,
            newLastWeek,
            newGrowthPct: growthPct(newThisWeek, newLastWeek),
            completedOnboardingThisWeek: completedThisWeek,
          },
          matches: {
            byStatus: matchByStatus,
            createdThisWeek: matchesThisWeek,
            createdLastWeek: matchesLastWeek,
            createdGrowthPct: growthPct(matchesThisWeek, matchesLastWeek),
            acceptedTotal: accepted,
            acceptanceRate:
              proposedTotal > 0 ? +(accepted / proposedTotal).toFixed(3) : 0,
            noMatchNoticesThisWeek: noMatchThisWeek,
          },
          verification: {
            finalizedUsers: verifByStatus,
            verifiedPassRate:
              verifDecided > 0 ? +(verifiedCount / verifDecided).toFixed(3) : null,
          },
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] founder-digest error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
