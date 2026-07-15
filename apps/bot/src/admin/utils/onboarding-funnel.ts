import { percentile } from "./buckets.js";

/**
 * Pure aggregation for the onboarding drop-off / hesitation funnel.
 *
 * Kept side-effect-free (no Prisma, no clock) so it is unit-testable in
 * isolation, mirroring `computeCityDistribution`. The route layer fetches
 * `OnboardingStepEvent` rows + the set of users who never finished onboarding
 * and hands both to `computeOnboardingFunnel`.
 *
 * Two founder-facing signals come out of it:
 *   - **drop-off** — `stuckHere`: still-onboarding users whose furthest-reached
 *     step is this one (they got here and stopped);
 *   - **hesitation** — `dwellMsMedian` / `dwellMsP90`: how long users sat on the
 *     step before answering/skipping it.
 */

export interface StepEventLite {
  userId: string;
  step: string;
  kind: "asked" | "answered" | "skipped";
  dwellMs: number | null;
}

export interface StepFunnelRow {
  step: string;
  /** Position in the canonical order (0-based). */
  order: number;
  /** Distinct users who ever reached this step (any event kind). */
  reached: number;
  /** Distinct users who answered it. */
  answered: number;
  /** Distinct users who explicitly skipped it. */
  skipped: number;
  /**
   * Distinct users who moved on to a later step (answered/skipped and
   * advanced). `reached - advanced` is the raw stall at this step.
   */
  advanced: number;
  /** Still-onboarding users whose furthest-reached step is exactly this one. */
  stuckHere: number;
  /** Share of reachers who did NOT advance past this step, 0..1 (2 dp). */
  dropOffRate: number;
  /** Hesitation on this step, in ms, over answered/skipped rows. */
  dwellSamples: number;
  dwellMsMedian: number | null;
  dwellMsP90: number | null;
}

export interface OnboardingFunnel {
  /** Distinct users with at least one recorded step event. */
  usersEntered: number;
  /** Distinct users still in `onboarding` status among those (derived). */
  usersStillOnboarding: number;
  /** Ordered per-step breakdown. */
  steps: StepFunnelRow[];
  /**
   * The steps with the most stuck users, most-stuck first — the "where do they
   * bail" shortlist a founder should look at first.
   */
  topDropOffSteps: Array<{ step: string; stuckHere: number; dropOffRate: number }>;
  /**
   * The steps users hesitate on longest (by median dwell), longest first — the
   * "where do they agonise" shortlist.
   */
  slowestSteps: Array<{ step: string; dwellMsMedian: number | null; dwellSamples: number }>;
}

function furthestIndexByUser(
  events: StepEventLite[],
  indexOf: Map<string, number>,
): Map<string, number> {
  const furthest = new Map<string, number>();
  for (const e of events) {
    const idx = indexOf.get(e.step);
    if (idx === undefined) continue;
    const prev = furthest.get(e.userId);
    if (prev === undefined || idx > prev) furthest.set(e.userId, idx);
  }
  return furthest;
}

export function computeOnboardingFunnel(
  events: StepEventLite[],
  order: readonly string[],
  incompleteUserIds: ReadonlySet<string>,
): OnboardingFunnel {
  const indexOf = new Map<string, number>();
  order.forEach((step, i) => indexOf.set(step, i));

  const furthest = furthestIndexByUser(events, indexOf);

  // Per-step distinct-user sets and dwell samples.
  const reachedUsers = order.map(() => new Set<string>());
  const answeredUsers = order.map(() => new Set<string>());
  const skippedUsers = order.map(() => new Set<string>());
  const dwellByStep = order.map<number[]>(() => []);

  for (const e of events) {
    const idx = indexOf.get(e.step);
    if (idx === undefined) continue;
    reachedUsers[idx]!.add(e.userId);
    if (e.kind === "answered") answeredUsers[idx]!.add(e.userId);
    if (e.kind === "skipped") skippedUsers[idx]!.add(e.userId);
    if ((e.kind === "answered" || e.kind === "skipped") && e.dwellMs !== null) {
      dwellByStep[idx]!.push(e.dwellMs);
    }
  }

  // Stuck-here: still-onboarding users whose furthest reached step is this one.
  const stuckByStep = order.map(() => 0);
  let usersStillOnboarding = 0;
  for (const [userId, idx] of furthest) {
    if (!incompleteUserIds.has(userId)) continue;
    usersStillOnboarding += 1;
    stuckByStep[idx] = (stuckByStep[idx] ?? 0) + 1;
  }

  const steps: StepFunnelRow[] = order.map((step, i) => {
    const reached = reachedUsers[i]!.size;
    // "advanced" = reachers whose furthest step is strictly beyond i.
    let advanced = 0;
    for (const userId of reachedUsers[i]!) {
      const f = furthest.get(userId);
      if (f !== undefined && f > i) advanced += 1;
    }
    const dwell = [...dwellByStep[i]!].sort((a, b) => a - b);
    const dropOffRate = reached > 0 ? +(1 - advanced / reached).toFixed(2) : 0;
    return {
      step,
      order: i,
      reached,
      answered: answeredUsers[i]!.size,
      skipped: skippedUsers[i]!.size,
      advanced,
      stuckHere: stuckByStep[i] ?? 0,
      dropOffRate,
      dwellSamples: dwell.length,
      dwellMsMedian: percentile(dwell, 0.5),
      dwellMsP90: percentile(dwell, 0.9),
    };
  });

  const topDropOffSteps = [...steps]
    .filter((s) => s.stuckHere > 0)
    .sort((a, b) => b.stuckHere - a.stuckHere || b.dropOffRate - a.dropOffRate)
    .slice(0, 5)
    .map((s) => ({ step: s.step, stuckHere: s.stuckHere, dropOffRate: s.dropOffRate }));

  const slowestSteps = [...steps]
    .filter((s) => s.dwellMsMedian !== null)
    .sort((a, b) => (b.dwellMsMedian ?? 0) - (a.dwellMsMedian ?? 0))
    .slice(0, 5)
    .map((s) => ({
      step: s.step,
      dwellMsMedian: s.dwellMsMedian,
      dwellSamples: s.dwellSamples,
    }));

  const usersEntered = new Set(events.map((e) => e.userId)).size;

  return {
    usersEntered,
    usersStillOnboarding,
    steps,
    topDropOffSteps,
    slowestSteps,
  };
}
