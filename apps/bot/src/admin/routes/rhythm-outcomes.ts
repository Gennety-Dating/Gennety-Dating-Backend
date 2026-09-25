import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { getOrCompute } from "../utils/cache.js";

/**
 * GET /admin/analytics/rhythm-outcomes — does life-rhythm similarity predict
 * how a match goes? (Tempo Sync, decision journal 2026-09-24.)
 *
 * The ONLY analytics surface for rhythm, and it is aggregate by construction:
 *   - pairs are counted per similarity bucket — never listed, never keyed by
 *     a match or user id;
 *   - a bucket with fewer than `MIN_CELL` pairs is suppressed (rates null), so
 *     a small city cannot be read back to a person — the Hermes agent and the
 *     dashboard see only cells big enough to be statistics;
 *   - nobody's own tags are read here at all, only the pair number the scorer
 *     already logged (`MatchScoreLog.rhythmSimilarity`).
 * Per-person rhythm has no admin read, export or founder DM, by design.
 *
 * Weekly-source pairs only, like `/admin/analytics/algorithm`: rematch,
 * synthetic and campus pairs come from different allocations.
 */
export const rhythmOutcomesRouter: Router = Router();

/** Smallest bucket whose rates are published. */
export const MIN_CELL = 20;

export const RHYTHM_BUCKETS = ["none", "low", "mid", "high"] as const;
export type RhythmBucket = (typeof RHYTHM_BUCKETS)[number];

/** `none` = at least one side had no fresh profile when the pair was scored. */
export function rhythmBucket(similarity: number | null): RhythmBucket {
  if (similarity === null || !Number.isFinite(similarity)) return "none";
  if (similarity < 0.4) return "low";
  if (similarity < 0.75) return "mid";
  return "high";
}

export interface RhythmOutcomeRow {
  rhythmSimilarity: number | null;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  status: string;
}

export interface RhythmOutcomeCell {
  /** Exact count, or `"<20"` when the cell is suppressed. */
  pairs: number | string;
  /** Share of pairs where both said yes; null when suppressed. */
  mutualAcceptRate: number | null;
  /** Share of pairs whose date actually took place; null when suppressed. */
  completedRate: number | null;
}

/** Pure: bucket, count, suppress. Exported for tests. */
export function summarizeRhythmOutcomes(
  rows: readonly RhythmOutcomeRow[],
  minCell: number = MIN_CELL,
): Record<RhythmBucket, RhythmOutcomeCell> {
  const tallies = Object.fromEntries(
    RHYTHM_BUCKETS.map((bucket) => [bucket, { pairs: 0, mutual: 0, completed: 0 }]),
  ) as Record<RhythmBucket, { pairs: number; mutual: number; completed: number }>;
  for (const row of rows) {
    const tally = tallies[rhythmBucket(row.rhythmSimilarity)];
    tally.pairs += 1;
    if (row.acceptedByA === true && row.acceptedByB === true) tally.mutual += 1;
    if (row.status === "completed") tally.completed += 1;
  }
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return Object.fromEntries(
    RHYTHM_BUCKETS.map((bucket) => {
      const { pairs, mutual, completed } = tallies[bucket];
      if (pairs < minCell) {
        return [bucket, { pairs: `<${minCell}`, mutualAcceptRate: null, completedRate: null }];
      }
      return [
        bucket,
        { pairs, mutualAcceptRate: round(mutual / pairs), completedRate: round(completed / pairs) },
      ];
    }),
  ) as Record<RhythmBucket, RhythmOutcomeCell>;
}

rhythmOutcomesRouter.get(
  "/admin/analytics/rhythm-outcomes",
  async (_req: Request, res: Response) => {
    try {
      const data = await getOrCompute("rhythm-outcomes:v1", 1800, async () => {
        const matches = await prisma.match.findMany({
          where: { source: "weekly", scoreLog: { isNot: null } },
          select: {
            acceptedByA: true,
            acceptedByB: true,
            status: true,
            scoreLog: { select: { rhythmSimilarity: true } },
          },
        });
        const rows: RhythmOutcomeRow[] = matches.map((match) => ({
          rhythmSimilarity: match.scoreLog?.rhythmSimilarity ?? null,
          acceptedByA: match.acceptedByA,
          acceptedByB: match.acceptedByB,
          status: match.status,
        }));
        return {
          minCell: MIN_CELL,
          buckets: {
            none: "at least one side had no life rhythm",
            low: "similarity < 0.4",
            mid: "0.4 ≤ similarity < 0.75",
            high: "similarity ≥ 0.75",
          },
          outcomes: summarizeRhythmOutcomes(rows),
        };
      });
      res.json(data);
    } catch (error) {
      console.error("[admin] rhythm-outcomes failed:", error instanceof Error ? error.message : error);
      res.status(500).json({ error: "rhythm-outcomes failed" });
    }
  },
);
