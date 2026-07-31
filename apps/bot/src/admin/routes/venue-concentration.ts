import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { getOrCompute } from "../utils/cache.js";
import {
  CONCENTRATION_ROW_LIMIT,
  computeVenueConcentration,
  parsePoolSizes,
  type SelectionLogRow,
} from "../utils/venue-concentration.js";

// ---------------------------------------------------------------------------
// GET /admin/analytics/venue-concentration?days=7
// ---------------------------------------------------------------------------
// Is the venue engine spreading dates across the catalog, or has one place
// quietly taken the city again? (VENUE_ENGINE_IMPROVEMENT_PLAN part 6.)
//
// Reads `venue_selection_logs`, which has always carried the winner and the
// failure reason — nothing looked at them in aggregate, which is why a pool
// collapse could only be found by hand.
// ---------------------------------------------------------------------------

const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

export const venueConcentrationRouter: Router = Router();

venueConcentrationRouter.get(
  "/admin/analytics/venue-concentration",
  async (req: Request, res: Response) => {
    try {
      const requested = Number(req.query.days);
      const days = Number.isFinite(requested)
        ? Math.min(MAX_DAYS, Math.max(1, Math.floor(requested)))
        : DEFAULT_DAYS;

      const data = await getOrCompute(
        `venue-concentration:v1:${days}`,
        900,
        async () => {
          const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
          const rows = await prisma.venueSelectionLog.findMany({
            // Shadow runs assign nothing and reach no user, so counting them
            // would dilute every share with dates that never happened.
            where: { mode: "live", createdAt: { gte: since } },
            select: {
              cityKey: true,
              selectedPlaceId: true,
              failureReason: true,
              topCandidates: true,
            },
            orderBy: { createdAt: "desc" },
            take: CONCENTRATION_ROW_LIMIT,
          });

          const parsed: SelectionLogRow[] = rows.map((row) => ({
            cityKey: row.cityKey,
            selectedPlaceId: row.selectedPlaceId,
            failureReason: row.failureReason,
            poolSizes: parsePoolSizes(row.topCandidates),
          }));

          const cities = computeVenueConcentration(parsed);
          return {
            windowDays: days,
            since: since.toISOString(),
            runs: parsed.length,
            truncated: rows.length === CONCENTRATION_ROW_LIMIT,
            cities,
          };
        },
        { req, res },
      );

      res.json(data);
    } catch (error) {
      console.error("[admin] venue-concentration failed:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);
