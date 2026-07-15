/**
 * Pure aggregation for the growth / acquisition view. Side-effect-free (no
 * prisma, no clock) so it is unit-testable, mirroring `computeCityDistribution`
 * and `computeOnboardingFunnel`. The route layer fetches users + the set of
 * user ids that ever appeared in a match and hands them here.
 *
 * The point of this view (growth stage): a signup is a vanity number — what
 * matters is which acquisition channel brings users who actually *finish
 * onboarding, activate, and get matched*. A channel with 50 signups and 2
 * activations is worse than one with 10 signups and 6 activations.
 */

export interface GrowthUserInput {
  referralSource: string | null;
  /** OnboardingStep value; `completed` = cleared the conversational funnel. */
  onboardingStep: string;
  /** UserStatus value; `active` = in the matching pool. */
  status: string;
  /** Whether this user ever appeared in a match row (as A or B). */
  matched: boolean;
}

export interface AcquisitionRow {
  channel: string;
  signups: number;
  completedOnboarding: number;
  active: number;
  matched: number;
  /** completedOnboarding / signups, 0..1 (2 dp). */
  completionRate: number;
  /** active / signups, 0..1 (2 dp) — the channel's true yield. */
  activationRate: number;
}

export interface AcquisitionSummary {
  bySource: AcquisitionRow[];
  /** Share of signups with no attribution (organic/direct), 0..1 (2 dp). */
  organicShare: number;
}

/**
 * Collapse a raw `referralSource` into a coarse acquisition channel.
 * Formats in the wild: `tg:<campaign>` (Telegram deep-link start_param),
 * `mobile:utm=…`, `web:<purpose>`, or null (organic/direct). A Telegram
 * user-referral link carries `referral` in its token.
 */
export function normalizeChannel(src: string | null): string {
  if (!src || src.trim() === "") return "organic";
  const s = src.trim();
  const lower = s.toLowerCase();
  if (lower.includes("referral")) return "referral";
  if (lower.startsWith("web:")) return lower;
  if (lower.startsWith("mobile")) return "mobile";
  // `tg:<campaign>` — keep the campaign token so channels stay distinguishable.
  return s;
}

const rate = (num: number, den: number): number =>
  den > 0 ? +(num / den).toFixed(2) : 0;

export function computeAcquisition(users: GrowthUserInput[]): AcquisitionSummary {
  const byChannel = new Map<
    string,
    { signups: number; completed: number; active: number; matched: number }
  >();
  let organic = 0;

  for (const u of users) {
    const channel = normalizeChannel(u.referralSource);
    if (channel === "organic") organic += 1;
    let row = byChannel.get(channel);
    if (!row) {
      row = { signups: 0, completed: 0, active: 0, matched: 0 };
      byChannel.set(channel, row);
    }
    row.signups += 1;
    if (u.onboardingStep === "completed") row.completed += 1;
    if (u.status === "active") row.active += 1;
    if (u.matched) row.matched += 1;
  }

  const bySource: AcquisitionRow[] = Array.from(byChannel.entries())
    .map(([channel, r]) => ({
      channel,
      signups: r.signups,
      completedOnboarding: r.completed,
      active: r.active,
      matched: r.matched,
      completionRate: rate(r.completed, r.signups),
      activationRate: rate(r.active, r.signups),
    }))
    .sort((a, b) => b.signups - a.signups);

  return {
    bySource,
    organicShare: rate(organic, users.length),
  };
}
