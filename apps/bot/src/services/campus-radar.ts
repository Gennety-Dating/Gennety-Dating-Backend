import { prisma } from "@gennety/db";

import { env } from "../config.js";
import { getNextBatchDate } from "./next-batch.js";
import { createProposedMatch, previewDropBatch } from "./match-engine.js";

/**
 * Campus Radar and the Bonus Campus Drop (PRODUCT_SPEC §Campus Radar).
 *
 * A university that suddenly verifies a dozen students has a pool the product
 * cannot use until Thursday. This watches for that and runs one extra drop,
 * scoped to that campus.
 *
 * **It reuses the real allocator rather than pairing anyone itself.** Same
 * eligibility predicate, same lifetime pair ban, same scorer, same greedy
 * allocation — the only difference is the id set it plans over
 * (`previewDropBatch(ids)`). A second pairing implementation would be a second
 * definition of what a good match is, and the two would diverge silently.
 *
 * **Three things bound it, and each answers a different way it could hurt:**
 *
 *   1. A **cooldown**, so one campus cannot be dropped repeatedly. Derived from
 *      the newest `campus` match for that domain rather than from a counter —
 *      the row IS the record of the last drop, and a counter would be a second
 *      source of truth about it.
 *   2. A **pre-batch blackout**, because a single-cohort run can take a
 *      candidate the globally-optimal Thursday batch needed. Exactly the
 *      protection `REMATCH_PRE_BATCH_BLACKOUT_HOURS` exists to give, for
 *      exactly the same reason.
 *   3. A **growth threshold**, so it fires on a campus push rather than on two
 *      friends signing up together.
 *
 * Inert without `CAMPUS_DROP_ENABLED`: the worker is not scheduled at all, so
 * a production without the flag pays nothing and cannot be surprised by it.
 */

const HOUR_MS = 60 * 60 * 1000;

export interface CampusGrowth {
  /** `Profile.universityDomain` — `kpi.ua`, `knu.ua`, `ukma.edu.ua`, … */
  domain: string;
  /** Students who verified inside the window. */
  newlyVerified: number;
  /** The whole verified cohort, for the log line and for judging the number. */
  totalVerified: number;
}

export interface CampusDropDecision {
  domain: string;
  /** Why this campus is being skipped, when it is. */
  skipped?: "below-threshold" | "cooling-down" | "batch-imminent";
}

// ---------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------

/**
 * Whether a campus has earned a drop.
 *
 * Pure and separated for the usual reason: the three bounds are the whole
 * mechanism, and every one of them is a number someone will want to re-tune
 * against a real campus launch. Re-tuning a rule nothing tests is how a
 * blackout quietly becomes zero.
 */
export function decideCampusDrop(input: {
  growth: CampusGrowth;
  lastDropAt: Date | null;
  nextBatchAt: Date;
  now: Date;
  threshold: number;
  cooldownHours: number;
  blackoutHours: number;
}): CampusDropDecision {
  const { growth, lastDropAt, nextBatchAt, now } = input;

  if (growth.newlyVerified < input.threshold) {
    return { domain: growth.domain, skipped: "below-threshold" };
  }

  if (lastDropAt && now.getTime() - lastDropAt.getTime() < input.cooldownHours * HOUR_MS) {
    return { domain: growth.domain, skipped: "cooling-down" };
  }

  // A blackout of 0 disables the check outright rather than making every run
  // "imminent" — the same shape `REMATCH_PRE_BATCH_BLACKOUT_HOURS` uses.
  if (
    input.blackoutHours > 0 &&
    nextBatchAt.getTime() - now.getTime() <= input.blackoutHours * HOUR_MS
  ) {
    return { domain: growth.domain, skipped: "batch-imminent" };
  }

  return { domain: growth.domain };
}

// ---------------------------------------------------------------------------
// Reading the radar
// ---------------------------------------------------------------------------

/**
 * Verified students per campus, and how many of them are new.
 *
 * **Growth needs no baseline table**, which is why there is none: "verified
 * inside the window" IS the growth, and it is a `verifiedAt` range on rows we
 * already keep. A stored baseline would be a second fact about the same
 * cohort, and the first restart that missed a tick would leave it wrong with
 * nothing to notice.
 *
 * Only university-domain accounts count. A general-track user has no campus,
 * and inventing one for them would make the radar measure the product's own
 * growth rather than any campus's.
 */
export async function measureCampusGrowth(
  now: Date,
  windowHours: number,
): Promise<CampusGrowth[]> {
  const since = new Date(now.getTime() - windowHours * HOUR_MS);

  const [totals, recent] = await Promise.all([
    prisma.user.groupBy({
      by: ["universityDomain"],
      where: {
        verificationStatus: "verified",
        universityDomain: { not: null },
        status: "active",
      },
      _count: { _all: true },
    }),
    prisma.user.groupBy({
      by: ["universityDomain"],
      where: {
        verificationStatus: "verified",
        universityDomain: { not: null },
        status: "active",
        verifiedAt: { gte: since },
      },
      _count: { _all: true },
    }),
  ]);

  const newByDomain = new Map<string, number>();
  for (const row of recent) {
    if (row.universityDomain) newByDomain.set(row.universityDomain, row._count._all);
  }

  return totals
    .filter((row): row is typeof row & { universityDomain: string } =>
      Boolean(row.universityDomain),
    )
    .map((row) => ({
      domain: row.universityDomain,
      newlyVerified: newByDomain.get(row.universityDomain) ?? 0,
      totalVerified: row._count._all,
    }))
    .sort((a, b) => b.newlyVerified - a.newlyVerified);
}

/**
 * When this campus last had a bonus drop, read off the matches themselves.
 *
 * The pair's own `universityDomain` is what scopes it — the product's
 * hyper-local rule already means both sides of a campus pair share one.
 */
export async function lastCampusDropAt(domain: string): Promise<Date | null> {
  const row = await prisma.match.findFirst({
    where: { source: "campus", userA: { universityDomain: domain } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

export interface CampusDropResult {
  domain: string;
  eligible: number;
  pairs: number;
  matchIds: string[];
}

/**
 * Run one campus's bonus drop.
 *
 * Deliberately does NOT touch starvation counters. `standbyCount` measures how
 * many ordinary drops a person has been passed over by; a bonus run that
 * incremented it would punish everyone it failed to pair for having a lively
 * campus, and one that reset it would hand a whole university a priority
 * advantage in the next Thursday batch.
 */
export async function runCampusDrop(domain: string): Promise<CampusDropResult> {
  const cohort = await prisma.user.findMany({
    where: {
      universityDomain: domain,
      verificationStatus: "verified",
      status: "active",
    },
    select: { id: true },
  });

  if (cohort.length < 2) {
    return { domain, eligible: cohort.length, pairs: 0, matchIds: [] };
  }

  const plan = await previewDropBatch(cohort.map((u) => u.id));

  const matchIds: string[] = [];
  for (const pair of plan.finalPairs) {
    const match = await createProposedMatch(
      pair.userAId,
      pair.userBId,
      pair.breakdown,
      pair.allocationFingerprints,
      { source: "campus" },
    );
    if (match) matchIds.push(match.id);
  }

  return { domain, eligible: plan.eligible, pairs: matchIds.length, matchIds };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface CampusRadarTickResult {
  scanned: number;
  dropped: string[];
  matchIds: string[];
}

export async function campusRadarTick(now = new Date()): Promise<CampusRadarTickResult> {
  const growth = await measureCampusGrowth(now, env.CAMPUS_DROP_WINDOW_HOURS);
  const nextBatchAt = getNextBatchDate(now);

  const dropped: string[] = [];
  const matchIds: string[] = [];

  for (const campus of growth) {
    // The free gate first, and it has to be here rather than only inside
    // `decideCampusDrop`. That function checks it on its own first line — but
    // `lastDropAt` is an ARGUMENT, so it is evaluated before the function is
    // entered at all, and `lastCampusDropAt` is a join into `users` on an
    // unindexed `universityDomain` plus an unindexed `source`. Every campus,
    // every hour, to feed a check that (as the log branch below says) is almost
    // never reached. The pure function keeps its own copy of the test so it
    // stays correct standalone; nothing observable changes, because the
    // `below-threshold` branch was already deliberately silent.
    if (campus.newlyVerified < env.CAMPUS_DROP_GROWTH_THRESHOLD) continue;

    const decision = decideCampusDrop({
      growth: campus,
      lastDropAt: await lastCampusDropAt(campus.domain),
      nextBatchAt,
      now,
      threshold: env.CAMPUS_DROP_GROWTH_THRESHOLD,
      cooldownHours: env.CAMPUS_DROP_COOLDOWN_HOURS,
      blackoutHours: env.CAMPUS_DROP_PRE_BATCH_BLACKOUT_HOURS,
    });
    // `below-threshold` is the state of essentially every campus on essentially
    // every tick, so it is not worth a line. The other two are: they mean a
    // campus DID earn a drop and something else withheld it.
    if (decision.skipped) {
      if (decision.skipped !== "below-threshold") {
        console.log(
          `[campus-radar] ${campus.domain} earned a drop but is ${decision.skipped} ` +
            `(new=${campus.newlyVerified} total=${campus.totalVerified})`,
        );
      }
      continue;
    }

    try {
      const result = await runCampusDrop(campus.domain);
      dropped.push(campus.domain);
      matchIds.push(...result.matchIds);
      console.log(
        `[campus-radar] bonus drop ${campus.domain}: new=${campus.newlyVerified} ` +
          `eligible=${result.eligible} pairs=${result.pairs}`,
      );
    } catch (err) {
      console.error(`[campus-radar] drop failed for ${campus.domain}:`, err);
    }
  }

  return { scanned: growth.length, dropped, matchIds };
}
