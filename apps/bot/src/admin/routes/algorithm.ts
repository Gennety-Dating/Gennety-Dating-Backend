import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import {
  SYNERGY_BUCKETS,
  synergyBucket,
  LENGTH_BUCKETS,
  lengthBucket,
  histogram,
  type SynergyBucket,
  type LengthBucket,
} from "../utils/buckets.js";
import { wordFrequency } from "../utils/psych-scan.js";
import { getOrCompute } from "../utils/cache.js";

export const algorithmRouter: Router = Router();

/**
 * Score-component diagnostics. Cached 30 min — these aggregate over
 * thousands of historical match events and don't need to be live.
 */
algorithmRouter.get(
  "/admin/analytics/algorithm",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("algorithm:v1", 1800, async () => {
        // ── 1. Matches with side decisions for accept-rate calculations
        const matches = await prisma.match.findMany({
          select: {
            id: true,
            synergyScore: true,
            acceptedByA: true,
            acceptedByB: true,
            rejectionReasonA: true,
            rejectionReasonB: true,
            pitchForA: true,
            pitchForB: true,
            scoreLog: {
              select: {
                scoreExplicit: true,
                scoreResearch: true,
                scoreLeague: true,
                scorePenalty: true,
                scoreTotal: true,
                embeddingDistance: true,
              },
            },
          },
        });

        // ── 2. Synergy calibration (bucket → accept rate per side decision)
        const synergyCalibration: Record<SynergyBucket, { decisions: number; accepts: number }> = {
          "70-79": { decisions: 0, accepts: 0 },
          "80-89": { decisions: 0, accepts: 0 },
          "90-99": { decisions: 0, accepts: 0 },
        };

        // ── 3. Pitch length × accept rate (per-side)
        const pitchByLength: Record<LengthBucket, { decisions: number; accepts: number }> = {
          "<200": { decisions: 0, accepts: 0 },
          "200-400": { decisions: 0, accepts: 0 },
          "400-600": { decisions: 0, accepts: 0 },
          "600-800": { decisions: 0, accepts: 0 },
          ">800": { decisions: 0, accepts: 0 },
        };

        // ── 4. Score component values (for histograms / boxplots)
        const explicitVals: number[] = [];
        const researchVals: number[] = [];
        const leagueVals: number[] = [];
        const penaltyVals: number[] = [];
        const distanceVals: number[] = [];

        // ── 5. Component vs accept correlation (via bucket)
        const componentByAccept = {
          explicit: { acceptedSum: 0, acceptedN: 0, declinedSum: 0, declinedN: 0 },
          research: { acceptedSum: 0, acceptedN: 0, declinedSum: 0, declinedN: 0 },
          league: { acceptedSum: 0, acceptedN: 0, declinedSum: 0, declinedN: 0 },
          penalty: { acceptedSum: 0, acceptedN: 0, declinedSum: 0, declinedN: 0 },
        };

        const rejectionTexts: string[] = [];

        for (const m of matches) {
          // Per-side decisions: each side that has decided contributes one
          // (accepted | declined) data point. Pending sides are ignored —
          // including them would deflate accept rates as in `acceptanceRate`.
          const decisions: Array<{ accepted: boolean; pitch: string | null }> = [];
          if (m.acceptedByA !== null) {
            decisions.push({ accepted: m.acceptedByA, pitch: m.pitchForA });
          }
          if (m.acceptedByB !== null) {
            decisions.push({ accepted: m.acceptedByB, pitch: m.pitchForB });
          }

          for (const d of decisions) {
            // Synergy calibration
            if (m.synergyScore !== null) {
              const bucket = synergyBucket(m.synergyScore);
              if (bucket) {
                synergyCalibration[bucket].decisions++;
                if (d.accepted) synergyCalibration[bucket].accepts++;
              }
            }
            // Pitch length × accept
            if (d.pitch) {
              const bucket = lengthBucket(d.pitch.length);
              pitchByLength[bucket].decisions++;
              if (d.accepted) pitchByLength[bucket].accepts++;
            }
            // Component correlation
            if (m.scoreLog) {
              const lg = m.scoreLog;
              if (d.accepted) {
                componentByAccept.explicit.acceptedSum += lg.scoreExplicit;
                componentByAccept.explicit.acceptedN++;
                componentByAccept.research.acceptedSum += lg.scoreResearch;
                componentByAccept.research.acceptedN++;
                componentByAccept.league.acceptedSum += lg.scoreLeague;
                componentByAccept.league.acceptedN++;
                componentByAccept.penalty.acceptedSum += lg.scorePenalty;
                componentByAccept.penalty.acceptedN++;
              } else {
                componentByAccept.explicit.declinedSum += lg.scoreExplicit;
                componentByAccept.explicit.declinedN++;
                componentByAccept.research.declinedSum += lg.scoreResearch;
                componentByAccept.research.declinedN++;
                componentByAccept.league.declinedSum += lg.scoreLeague;
                componentByAccept.league.declinedN++;
                componentByAccept.penalty.declinedSum += lg.scorePenalty;
                componentByAccept.penalty.declinedN++;
              }
            }
          }

          if (m.scoreLog) {
            explicitVals.push(m.scoreLog.scoreExplicit);
            researchVals.push(m.scoreLog.scoreResearch);
            leagueVals.push(m.scoreLog.scoreLeague);
            penaltyVals.push(m.scoreLog.scorePenalty);
            if (m.scoreLog.embeddingDistance !== null) {
              distanceVals.push(m.scoreLog.embeddingDistance);
            }
          }

          if (m.rejectionReasonA) rejectionTexts.push(m.rejectionReasonA);
          if (m.rejectionReasonB) rejectionTexts.push(m.rejectionReasonB);
        }

        // ── 6. Time-of-day matrix (day-of-week × hour) for ACCEPTED/DECLINED
        const events = await prisma.matchEvent.findMany({
          where: { actionType: { in: ["ACCEPTED", "DECLINED"] } },
          select: { actionType: true, createdAt: true },
        });

        const dowHour: Array<Array<{ accept: number; decline: number }>> =
          Array.from({ length: 7 }, () =>
            Array.from({ length: 24 }, () => ({ accept: 0, decline: 0 })),
          );
        for (const e of events) {
          const d = e.createdAt;
          const dow = d.getUTCDay();
          const hr = d.getUTCHours();
          if (e.actionType === "ACCEPTED") dowHour[dow]![hr]!.accept++;
          else dowHour[dow]![hr]!.decline++;
        }

        // ── 7. Word frequency for rejection reasons
        const topRejectionWords = wordFrequency(rejectionTexts, 30);

        return {
          synergyCalibration: SYNERGY_BUCKETS.map((b) => ({
            bucket: b,
            decisions: synergyCalibration[b].decisions,
            accepts: synergyCalibration[b].accepts,
            acceptRate:
              synergyCalibration[b].decisions > 0
                ? +(synergyCalibration[b].accepts / synergyCalibration[b].decisions).toFixed(4)
                : null,
          })),
          pitchLengthCalibration: LENGTH_BUCKETS.map((b) => ({
            bucket: b,
            decisions: pitchByLength[b].decisions,
            accepts: pitchByLength[b].accepts,
            acceptRate:
              pitchByLength[b].decisions > 0
                ? +(pitchByLength[b].accepts / pitchByLength[b].decisions).toFixed(4)
                : null,
          })),
          componentMeans: {
            explicit: {
              accepted: avg(componentByAccept.explicit.acceptedSum, componentByAccept.explicit.acceptedN),
              declined: avg(componentByAccept.explicit.declinedSum, componentByAccept.explicit.declinedN),
            },
            research: {
              accepted: avg(componentByAccept.research.acceptedSum, componentByAccept.research.acceptedN),
              declined: avg(componentByAccept.research.declinedSum, componentByAccept.research.declinedN),
            },
            league: {
              accepted: avg(componentByAccept.league.acceptedSum, componentByAccept.league.acceptedN),
              declined: avg(componentByAccept.league.declinedSum, componentByAccept.league.declinedN),
            },
            penalty: {
              accepted: avg(componentByAccept.penalty.acceptedSum, componentByAccept.penalty.acceptedN),
              declined: avg(componentByAccept.penalty.declinedSum, componentByAccept.penalty.declinedN),
            },
          },
          componentHistograms: {
            explicit: histogram(explicitVals, 0, 1, 10),
            research: histogram(researchVals, 0, 1, 10),
            league: histogram(leagueVals, 0, 1, 10),
            penalty: histogram(penaltyVals, 0, 1, 10),
            embeddingDistance: histogram(distanceVals, 0, 2, 10),
          },
          responseHeatmap: dowHour,
          topRejectionWords,
          totalScoreLogged: explicitVals.length,
          totalMatches: matches.length,
        };
      });

      res.json(data);
    } catch (err) {
      console.error("[admin] algorithm error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

function avg(sum: number, n: number): number | null {
  return n > 0 ? +(sum / n).toFixed(4) : null;
}
