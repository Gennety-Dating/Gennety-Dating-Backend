/**
 * Acquisition-spend tracking — pure aggregation, no Prisma, no clock reads
 * beyond what is handed in. Mirrors `growth.ts` / `monetization.ts`: a route
 * fetches the rows, this module turns them into CAC/CPL/ROAS/LTV:CAC.
 *
 * See `AD_SPEND_TRACKING_DESIGN.md` for the two decisions that shape this
 * file, restated briefly because they explain almost every choice below:
 *
 * 1. CHANNEL is the attribution key and needs no new tracking — it is exactly
 *    `normalizeChannel(User.referralSource)` (`growth.ts`), the same string
 *    already used to bucket signups. A digital ad and a QR code at a physical
 *    event both resolve to a `tg:<slug>` deep link, so an offline event is not
 *    a special case here — it is a channel with a longer CATEGORY window.
 *
 * 2. CATEGORY is the spend TYPE, and it — not the channel — decides the
 *    attribution window: how many days past the spend period a conversion is
 *    still counted before the entry is treated as "matured". Performance ads
 *    convert in hours; an offline event's word of mouth trickles in for
 *    weeks. A fixed calendar-week bucket cannot express both, so spend now
 *    carries a free `[periodStart, periodEnd]` range instead.
 */

import { PURCHASE_KINDS, type PayerIndexEntry, type PurchaseKind } from "../../services/purchases.js";

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export const AD_SPEND_CATEGORIES = [
  "performance_ads",
  "influencer",
  "offline_event",
  "content_production",
  "agency",
  "other",
] as const;

export type AdSpendCategory = (typeof AD_SPEND_CATEGORIES)[number];

/**
 * Days past `periodEnd` a conversion is still attributed to this entry.
 * `null` = this category buys no trackable acquisition at all (a retainer, a
 * production shoot) and is excluded from every per-channel/CAC computation —
 * it still counts toward `totalMarketingSpendUsdCents`, the founder's own P&L
 * figure, but never toward "did this spend bring anyone in".
 *
 * Tunable defaults, not permanent — same status `COHORT_MATURITY_DAYS` carries
 * in `monetization.ts`: there is no real conversion-lag curve yet because
 * there are (as of writing) zero real payers to build one from.
 */
export const AD_SPEND_ATTRIBUTION_WINDOW_DAYS: Record<AdSpendCategory, number | null> = {
  performance_ads: 3,
  influencer: 14,
  offline_event: 28,
  content_production: null,
  agency: null,
  other: 7,
};

/**
 * Spend with no channel to attribute at all — agency retainers, footage
 * production, anything that does not buy a trackable acquisition. A real
 * `referralSource` can never normalize to this string, so it is safe as a
 * sentinel: nothing in `signups`/`newPayers` can ever match it, which is the
 * whole point — such spend counts only toward the P&L total.
 */
export const UNATTRIBUTED_CHANNEL = "unattributed";

/** `content_production` / `agency` have no window, so they must be logged
 * against `UNATTRIBUTED_CHANNEL` — enforced here so the route (not just the
 * dashboard form) refuses a channel-with-no-signal combination. */
export function categoryRequiresUnattributed(category: AdSpendCategory): boolean {
  return AD_SPEND_ATTRIBUTION_WINDOW_DAYS[category] === null;
}

export function isAdSpendCategory(value: string): value is AdSpendCategory {
  return (AD_SPEND_CATEGORIES as readonly string[]).includes(value);
}

const ISO_4217_RE = /^[A-Z]{3}$/;
export function isValidCurrency(value: string): boolean {
  return ISO_4217_RE.test(value);
}

/**
 * A channel is valid only if it is already the OUTPUT of `normalizeChannel`,
 * i.e. re-normalizing it is a no-op. This is what stops the founder typing a
 * channel that no signup can ever match ("Instagram ads" instead of
 * "tg:insta_promo") without hard-coding a second copy of the normalization
 * rule here — the caller passes in the real `normalizeChannel` so this module
 * never imports `growth.ts` and stays a leaf.
 */
export function isSelfNormalizedChannel(
  channel: string,
  normalizeChannel: (src: string | null) => string,
): boolean {
  if (channel === UNATTRIBUTED_CHANNEL) return true;
  if (channel.trim() === "") return false;
  return normalizeChannel(channel) === channel;
}

export function isValidPeriod(periodStart: Date, periodEnd: Date): boolean {
  return periodEnd.getTime() >= periodStart.getTime();
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface AdSpendEntryInput {
  channel: string;
  category: string;
  periodStart: Date;
  periodEnd: Date;
  amountUsdCents: number;
}

/** A real (non-test, non-synthetic) user, already reduced to what CAC needs. */
export interface AcquisitionCostUserInput {
  id: string;
  /** Already `normalizeChannel(referralSource)` — this module does not import growth.ts. */
  channel: string;
  createdAt: Date;
  status: string;
  verificationStatus: string;
  /** OnboardingStep value; `completed` = cleared the conversational funnel. */
  onboardingStep: string;
  gender: string | null;
  /**
   * Whether this user ever appeared in a `Match` row (as A or B). Deriving it
   * costs a full `Match` scan, so it is OPTIONAL: a caller unwilling to pay
   * for that scan (`/admin/dashboard`, checked live and uncached) simply
   * omits it, and this module counts it as "not measured here" rather than
   * "zero matched" — the same null-not-zero rule `divCents` already applies,
   * one level up. Only callers that supply it (the cached
   * `/admin/analytics/acquisition-cost` route) get a real `byChannel.matched`.
   */
  matched?: boolean;
}

export interface AcquisitionCostInput {
  spend: readonly AdSpendEntryInput[];
  users: readonly AcquisitionCostUserInput[];
  /** All-time payer index (`services/purchases.ts` → `loadPayerIndex()`). */
  payers: ReadonlyMap<string, PayerIndexEntry>;
  now: Date;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export interface ChannelAcquisitionCostRow {
  channel: string;
  spendUsdCents: number;
  signups: number;
  /** Signups (in this channel's own attribution window) who finished onboarding. */
  completedOnboarding: number;
  newPayers: number;
  newActive: number;
  /** Signups who ever appeared in a `Match` row. `0` when `matched` was not
   * supplied on any input user for this run — see `AcquisitionCostUserInput`. */
  matched: number;
  /** `unknown` is implicit: `signups − genderKnown.male − genderKnown.female`. */
  genderKnown: { male: number; female: number };
  cplUsdCents: number | null;
  cacPerPayingUsdCents: number | null;
  /**
   * Same formula as the blended `ltvCac`/`roas` below, scoped to this
   * channel's own attributed payers — the per-channel payback read.
   */
  ltvCac: number | null;
  roas: number | null;
  /**
   * Days since this channel's EARLIEST attributable spend entry started.
   * A confidence gate for `ltvCac`/`roas` above, not a correctness check —
   * `ltvCac: 0.4` after 3 days and `ltvCac: 0.4` after 90 days are different
   * claims, and this is what tells them apart. `null` when the channel has
   * no attributable entry at all.
   */
  daysSinceFirstAttributableSpend: number | null;
  /** This channel's attributed payers' lifetime revenue, split by product —
   * zero-filled per `PURCHASE_KINDS`, so "never bought this" reads as `0`. */
  revenueByKind: Record<PurchaseKind, number>;
  /** True once every attributable entry's window has fully elapsed. */
  matured: boolean;
}

/**
 * One row per `AdSpend` entry — the CAC-over-time trend a single blended
 * snapshot can't show. Only entries with a real channel + attribution window
 * appear here (the same entries that get a `byChannel` row); a
 * `content_production`/`agency` entry logged against `UNATTRIBUTED_CHANNEL`
 * carries no signal to trend and is excluded, exactly like `byChannel`.
 */
export interface AcquisitionCostEntryRow {
  channel: string;
  category: string;
  periodStart: string;
  periodEnd: string;
  spendUsdCents: number;
  signups: number;
  newPayers: number;
  cplUsdCents: number | null;
  cacPerPayingUsdCents: number | null;
  matured: boolean;
}

export interface AcquisitionCostSummary {
  /** Every AdSpend row, every category — the founder's own P&L figure. */
  totalMarketingSpendUsdCents: number;
  /** Spend whose category has a window AND whose channel is trackable. */
  attributableSpendUsdCents: number;
  newPayers: number;
  newActive: number;
  cacPerPayingUsdCents: number | null;
  cacPerActiveUsdCents: number | null;
  /**
   * Cohort lifetime revenue (payers' full `usdCents`, not only what they paid
   * inside the window) ÷ blended CAC. Deliberately NOT `monetization.ts`'s
   * "revenue in window" rule: that rule protects a WEEKLY revenue bucket from
   * repeat-purchase contamination; this cohort is defined by an ACQUISITION
   * event, not a purchase-timing bucket, so once a user is attributed to it,
   * the value they have brought in since is exactly the question "was this
   * spend worth it" is asking.
   */
  ltvCac: number | null;
  /** Cohort lifetime revenue ÷ attributable spend — same revenue basis as `ltvCac`. */
  roas: number | null;
  matured: boolean;
  byChannel: ChannelAcquisitionCostRow[];
  /** One row per `AdSpend` entry, sorted by `periodStart` — the CAC-over-time trend. */
  byEntry: AcquisitionCostEntryRow[];
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function windowDaysFor(category: string): number | null {
  return isAdSpendCategory(category) ? AD_SPEND_ATTRIBUTION_WINDOW_DAYS[category] : null;
}

function windowEndOf(entry: AdSpendEntryInput): Date | null {
  const days = windowDaysFor(entry.category);
  if (days === null) return null;
  return new Date(entry.periodEnd.getTime() + days * DAY_MS);
}

function avgUsdCents(ids: ReadonlySet<string>, payers: AcquisitionCostInput["payers"]): number | null {
  if (ids.size === 0) return null;
  let total = 0;
  let counted = 0;
  for (const id of ids) {
    const entry = payers.get(id);
    if (!entry) continue;
    total += entry.usdCents;
    counted += 1;
  }
  return counted > 0 ? total : null;
}

function divCents(numerator: number, denominator: number): number | null {
  if (denominator <= 0 || numerator <= 0) return null;
  return Math.round(numerator / denominator);
}

/**
 * One payer set's lifetime revenue, split by product — zero-filled per
 * `PURCHASE_KINDS`, so "this cohort never bought Premium" reads as `0`, not
 * an absent key a consumer has to guess about.
 */
function revenueByKindFor(
  ids: ReadonlySet<string>,
  payers: AcquisitionCostInput["payers"],
): Record<PurchaseKind, number> {
  const totals = Object.fromEntries(PURCHASE_KINDS.map((kind) => [kind, 0])) as Record<
    PurchaseKind,
    number
  >;
  for (const id of ids) {
    const entry = payers.get(id);
    if (!entry) continue;
    for (const kind of PURCHASE_KINDS) totals[kind] += entry.byKind[kind].usdCents;
  }
  return totals;
}

/**
 * Channel-scoped payback — the SAME two formulas the blended
 * `ltvCac`/`roas` below use, just over one channel's own attributed payers
 * and spend rather than every channel's pooled together. `avgUsdCents`
 * returns the cohort's SUMMED lifetime `usdCents` (see its own comment); the
 * per-payer LTV used for `ltvCac` is derived from that sum here exactly as
 * the blended computation already does it.
 */
function channelPayback(
  payerIds: ReadonlySet<string>,
  cacPerPayingUsdCents: number | null,
  spendUsdCents: number,
  payers: AcquisitionCostInput["payers"],
): { ltvCac: number | null; roas: number | null } {
  const cohortRevenueUsdCents = avgUsdCents(payerIds, payers);
  const ltvCents =
    payerIds.size > 0 && cohortRevenueUsdCents !== null
      ? Math.round(cohortRevenueUsdCents / payerIds.size)
      : null;
  return {
    ltvCac:
      ltvCents !== null && cacPerPayingUsdCents !== null && cacPerPayingUsdCents > 0
        ? +(ltvCents / cacPerPayingUsdCents).toFixed(2)
        : null,
    roas:
      cohortRevenueUsdCents !== null && spendUsdCents > 0
        ? +(cohortRevenueUsdCents / spendUsdCents).toFixed(2)
        : null,
  };
}

export function computeAcquisitionCost(input: AcquisitionCostInput): AcquisitionCostSummary {
  const { spend, users, payers, now } = input;

  const totalMarketingSpendUsdCents = spend.reduce((sum, e) => sum + e.amountUsdCents, 0);

  const byChannel = new Map<
    string,
    {
      spendUsdCents: number;
      signupIds: Set<string>;
      payerIds: Set<string>;
      activeIds: Set<string>;
      completedOnboardingIds: Set<string>;
      matchedIds: Set<string>;
      maleIds: Set<string>;
      femaleIds: Set<string>;
      /** false the moment ANY attributable entry has not matured yet. */
      matured: boolean;
      /** true once this channel has at least one attributable (windowed) entry. */
      hasAttributableEntry: boolean;
      /** Earliest `periodStart` among this channel's attributable entries —
       * what `daysSinceFirstAttributableSpend` is measured from. */
      earliestAttributablePeriodStart: Date | null;
    }
  >();

  const rowFor = (channel: string) => {
    let row = byChannel.get(channel);
    if (!row) {
      row = {
        spendUsdCents: 0,
        signupIds: new Set(),
        payerIds: new Set(),
        activeIds: new Set(),
        completedOnboardingIds: new Set(),
        matchedIds: new Set(),
        maleIds: new Set(),
        femaleIds: new Set(),
        matured: true,
        hasAttributableEntry: false,
        earliestAttributablePeriodStart: null,
      };
      byChannel.set(channel, row);
    }
    return row;
  };

  // One row per spend entry, in ADDITION to the channel roll-up below — the
  // CAC-over-time trend a single blended (or even a per-channel) snapshot
  // cannot show, since two entries on the same channel can have very
  // different CAC and only the trend says which direction it's moving.
  const byEntryRows: AcquisitionCostEntryRow[] = [];

  for (const entry of spend) {
    // Unattributed spend contributes to the P&L total only — nothing can ever
    // match this channel string, so it never gets a byChannel row at all.
    if (entry.channel === UNATTRIBUTED_CHANNEL) continue;

    const row = rowFor(entry.channel);
    row.spendUsdCents += entry.amountUsdCents;

    const windowEnd = windowEndOf(entry);
    if (windowEnd === null) continue; // no signal — spend counted, cohort not.
    row.hasAttributableEntry = true;
    const entryMatured = now.getTime() >= windowEnd.getTime();
    if (!entryMatured) row.matured = false;
    if (
      row.earliestAttributablePeriodStart === null ||
      entry.periodStart.getTime() < row.earliestAttributablePeriodStart.getTime()
    ) {
      row.earliestAttributablePeriodStart = entry.periodStart;
    }

    // Scoped to THIS entry alone — separate from the channel-wide sets below,
    // which is what makes byEntryRows a real per-entry trend rather than a
    // running channel total repeated on every row.
    const entrySignupIds = new Set<string>();
    const entryPayerIds = new Set<string>();

    for (const user of users) {
      if (user.channel !== entry.channel) continue;
      if (user.createdAt.getTime() < entry.periodStart.getTime()) continue;
      if (user.createdAt.getTime() > entry.periodEnd.getTime()) continue;

      row.signupIds.add(user.id);
      entrySignupIds.add(user.id);
      if (user.status === "active" && user.verificationStatus === "verified") {
        row.activeIds.add(user.id);
      }
      if (user.onboardingStep === "completed") row.completedOnboardingIds.add(user.id);
      if (user.matched === true) row.matchedIds.add(user.id);
      if (user.gender === "male") row.maleIds.add(user.id);
      else if (user.gender === "female") row.femaleIds.add(user.id);

      const payer = payers.get(user.id);
      if (payer?.firstPaidAt && payer.firstPaidAt.getTime() <= windowEnd.getTime()) {
        row.payerIds.add(user.id);
        entryPayerIds.add(user.id);
      }
    }

    byEntryRows.push({
      channel: entry.channel,
      category: entry.category,
      periodStart: entry.periodStart.toISOString(),
      periodEnd: entry.periodEnd.toISOString(),
      spendUsdCents: entry.amountUsdCents,
      signups: entrySignupIds.size,
      newPayers: entryPayerIds.size,
      cplUsdCents: divCents(entry.amountUsdCents, entrySignupIds.size),
      cacPerPayingUsdCents: divCents(entry.amountUsdCents, entryPayerIds.size),
      matured: entryMatured,
    });
  }

  byEntryRows.sort((a, b) => a.periodStart.localeCompare(b.periodStart));

  const byChannelRows: ChannelAcquisitionCostRow[] = Array.from(byChannel.entries())
    .map(([channel, r]) => {
      const cacPerPayingUsdCents = divCents(r.spendUsdCents, r.payerIds.size);
      const { ltvCac, roas } = channelPayback(r.payerIds, cacPerPayingUsdCents, r.spendUsdCents, payers);
      return {
        channel,
        spendUsdCents: r.spendUsdCents,
        signups: r.signupIds.size,
        completedOnboarding: r.completedOnboardingIds.size,
        newPayers: r.payerIds.size,
        newActive: r.activeIds.size,
        matched: r.matchedIds.size,
        genderKnown: { male: r.maleIds.size, female: r.femaleIds.size },
        cplUsdCents: divCents(r.spendUsdCents, r.signupIds.size),
        cacPerPayingUsdCents,
        ltvCac,
        roas,
        daysSinceFirstAttributableSpend:
          r.earliestAttributablePeriodStart !== null
            ? Math.floor((now.getTime() - r.earliestAttributablePeriodStart.getTime()) / DAY_MS)
            : null,
        revenueByKind: revenueByKindFor(r.payerIds, payers),
        matured: r.matured,
      };
    })
    .sort((a, b) => b.spendUsdCents - a.spendUsdCents);

  // Blended totals over channels that actually had an attributable entry —
  // a channel with only `content_production`/`agency` spend contributes to
  // the P&L sum above and nothing here.
  let attributableSpendUsdCents = 0;
  const allPayerIds = new Set<string>();
  const allActiveIds = new Set<string>();
  let allMatured = true;
  for (const row of byChannel.values()) {
    if (!row.hasAttributableEntry) continue;
    attributableSpendUsdCents += row.spendUsdCents;
    for (const id of row.payerIds) allPayerIds.add(id);
    for (const id of row.activeIds) allActiveIds.add(id);
    if (!row.matured) allMatured = false;
  }

  const cohortRevenueUsdCents = avgUsdCents(allPayerIds, payers);
  const ltvCents =
    allPayerIds.size > 0 && cohortRevenueUsdCents !== null
      ? Math.round(cohortRevenueUsdCents / allPayerIds.size)
      : null;
  const cacPerPayingUsdCents = divCents(attributableSpendUsdCents, allPayerIds.size);
  const cacPerActiveUsdCents = divCents(attributableSpendUsdCents, allActiveIds.size);

  return {
    totalMarketingSpendUsdCents,
    attributableSpendUsdCents,
    newPayers: allPayerIds.size,
    newActive: allActiveIds.size,
    cacPerPayingUsdCents,
    cacPerActiveUsdCents,
    ltvCac:
      ltvCents !== null && cacPerPayingUsdCents !== null && cacPerPayingUsdCents > 0
        ? +(ltvCents / cacPerPayingUsdCents).toFixed(2)
        : null,
    roas:
      cohortRevenueUsdCents !== null && attributableSpendUsdCents > 0
        ? +(cohortRevenueUsdCents / attributableSpendUsdCents).toFixed(2)
        : null,
    matured: allMatured,
    byChannel: byChannelRows,
    byEntry: byEntryRows,
  };
}
