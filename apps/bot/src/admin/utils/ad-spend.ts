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

import type { PayerIndexEntry } from "../../services/purchases.js";

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
}

export interface AcquisitionCostInput {
  spend: readonly AdSpendEntryInput[];
  users: readonly AcquisitionCostUserInput[];
  /** All-time payer index (`services/purchases.ts` → `loadPayerIndex()`). */
  payers: ReadonlyMap<string, Pick<PayerIndexEntry, "firstPaidAt" | "usdCents">>;
  now: Date;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

export interface ChannelAcquisitionCostRow {
  channel: string;
  spendUsdCents: number;
  signups: number;
  newPayers: number;
  newActive: number;
  cplUsdCents: number | null;
  cacPerPayingUsdCents: number | null;
  /** True once every attributable entry's window has fully elapsed. */
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
      /** false the moment ANY attributable entry has not matured yet. */
      matured: boolean;
      /** true once this channel has at least one attributable (windowed) entry. */
      hasAttributableEntry: boolean;
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
        matured: true,
        hasAttributableEntry: false,
      };
      byChannel.set(channel, row);
    }
    return row;
  };

  for (const entry of spend) {
    // Unattributed spend contributes to the P&L total only — nothing can ever
    // match this channel string, so it never gets a byChannel row at all.
    if (entry.channel === UNATTRIBUTED_CHANNEL) continue;

    const row = rowFor(entry.channel);
    row.spendUsdCents += entry.amountUsdCents;

    const windowEnd = windowEndOf(entry);
    if (windowEnd === null) continue; // no signal — spend counted, cohort not.
    row.hasAttributableEntry = true;
    if (now.getTime() < windowEnd.getTime()) row.matured = false;

    for (const user of users) {
      if (user.channel !== entry.channel) continue;
      if (user.createdAt.getTime() < entry.periodStart.getTime()) continue;
      if (user.createdAt.getTime() > entry.periodEnd.getTime()) continue;

      row.signupIds.add(user.id);
      if (user.status === "active" && user.verificationStatus === "verified") {
        row.activeIds.add(user.id);
      }
      const payer = payers.get(user.id);
      if (payer?.firstPaidAt && payer.firstPaidAt.getTime() <= windowEnd.getTime()) {
        row.payerIds.add(user.id);
      }
    }
  }

  const byChannelRows: ChannelAcquisitionCostRow[] = Array.from(byChannel.entries())
    .map(([channel, r]) => ({
      channel,
      spendUsdCents: r.spendUsdCents,
      signups: r.signupIds.size,
      newPayers: r.payerIds.size,
      newActive: r.activeIds.size,
      cplUsdCents: divCents(r.spendUsdCents, r.signupIds.size),
      cacPerPayingUsdCents: divCents(r.spendUsdCents, r.payerIds.size),
      matured: r.matured,
    }))
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
  };
}
