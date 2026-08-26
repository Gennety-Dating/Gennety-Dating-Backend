import { prisma } from "@gennety/db";

/**
 * Unified purchase read model — every real money movement in the product, in
 * one shape.
 *
 * There is deliberately **no `purchases` table**. Money is already recorded,
 * exactly-once, in four places, each with its own unique provider-charge id:
 *
 *   • `ticket_ledger`       — ticket-store top-ups (`store_purchase`) AND the
 *                             §3.5b date-gate slots (`gate_*` zero-delta rows).
 *   • `subscription_ledger` — §3.8 Gennety Premium (first charge + renewals).
 *   • `rematch_purchases`   — §3.11 paid on-demand re-runs.
 *   • `venue_change_purchases` — §3.7b paid venue swaps.
 *
 * A fifth table dual-written alongside them would be a second source of truth
 * that can drift from the one the refund rails actually read. So this module is
 * a **reader**: it normalizes the four into one `PurchaseRow` for the founder
 * feed, the admin list, and the per-user card. Every consumer therefore agrees
 * with the tables that own the refunds by construction.
 *
 * Consumed by `admin/routes/purchases.ts`, `admin/server.ts` (the user card +
 * list), `admin/routes/monetization.ts` (the paying-users conversion) and
 * `services/founder-notify.ts`.
 */

/** What was bought. */
export type PurchaseKind =
  /** Ticket-store bundle top-up (wallet credit). */
  | "tickets"
  /** §3.5b date-gate ticket slot(s) for one match. */
  | "date_ticket"
  /** §3.8 Gennety Premium subscription charge or renewal. */
  | "premium"
  /** §3.11 paid Rematch run. */
  | "rematch"
  /** §3.7b paid venue change. */
  | "venue_change"
  /** Prime Time — one-off pass opening the calendar's evening band for a pair. */
  | "prime_time";

/**
 * Where the row came from. Kept alongside `kind` because a reader chasing a
 * charge id needs to know which table to open.
 */
export type PurchaseSource =
  | "ticket_ledger"
  | "subscription_ledger"
  | "rematch_purchase"
  | "venue_change_purchase"
  | "prime_time_purchase";

/**
 * Normalized lifecycle. Each source spells its own states differently
 * (`gate_refund_pending`, `refunded_race`, `refunded_no_candidate`, …); the
 * raw value is preserved in `rawStatus` so nothing is lost.
 */
export type PurchaseStatus =
  /** Money moved and the thing was delivered. */
  | "settled"
  /** Money moved; delivery still resolving (or the sweep owns it). */
  | "processing"
  /** Money went back to the payer. */
  | "refunded"
  /** A refund was owed and the provider call failed — ops must look. */
  | "refund_failed";

export type PurchaseProvider = "telegram_stars" | "app_store" | "mock" | "unknown";

export interface PurchaseRow {
  /** Stable synthetic id: `<source>:<row id>`. */
  id: string;
  source: PurchaseSource;
  kind: PurchaseKind;
  userId: string;
  provider: PurchaseProvider;
  status: PurchaseStatus;
  /** The source's own status/reason string, unmapped. */
  rawStatus: string;
  /** Telegram Stars charged, when the rail is Stars. */
  amountStars: number | null;
  /** Exact money in cents, when the rail reports it (App Store / mock USD). */
  amountCents: number | null;
  currency: string | null;
  /**
   * Best available money figure in USD cents: exact when `amountCents` is set,
   * otherwise the Stars estimate. `amountIsEstimate` says which.
   */
  usdCents: number | null;
  amountIsEstimate: boolean;
  /** Short human description ("3 tickets", "both slots", "renewal"). */
  detail: string | null;
  matchId: string | null;
  externalPaymentId: string | null;
  createdAt: Date;
}

export interface PurchaseTotals {
  count: number;
  /** Stars across rows that actually moved money (refunds excluded). */
  stars: number;
  /** USD cents across the same rows, Stars converted at `STAR_USD_CENTS`. */
  usdCents: number;
  refundedCount: number;
}

/**
 * Telegram's Stars→USD rate is not exposed by any API, so a founder-facing
 * dollar figure has to come from a documented constant. This is the ticket
 * rate the product already prices against ($6.99 / 350⭐), and every figure
 * derived from it is labelled an estimate — small Star packs bill nearer
 * $0.024/⭐, so this is the conservative end.
 */
export const STAR_USD_CENTS = 2;

export function starsToUsdCents(stars: number): number {
  return stars * STAR_USD_CENTS;
}

/** Human label for a kind — shared by the founder DM and the dashboard. */
export function purchaseKindLabel(kind: PurchaseKind): string {
  switch (kind) {
    case "tickets":
      return "Ticket store";
    case "date_ticket":
      return "Date ticket";
    case "premium":
      return "Gennety Premium";
    case "rematch":
      return "Rematch";
    case "venue_change":
      return "Venue change";
    case "prime_time":
      return "Prime Time";
  }
}

/** `$16.60` / `$9.99` from cents. */
export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * One-line money string for a row: the charged amount first, then the USD
 * figure, marked `≈` when it is the Stars estimate rather than a real price.
 */
export function formatPurchaseAmount(row: {
  amountStars: number | null;
  amountCents: number | null;
  currency: string | null;
  usdCents: number | null;
  amountIsEstimate: boolean;
}): string {
  if (row.amountStars != null) {
    const usd = row.usdCents != null ? ` (≈ ${formatUsdCents(row.usdCents)})` : "";
    return `${row.amountStars} ⭐${usd}`;
  }
  if (row.amountCents != null) {
    const currency = row.currency && row.currency !== "USD" ? ` ${row.currency}` : "";
    return `${formatUsdCents(row.amountCents)}${currency}`;
  }
  return "amount unknown";
}

// ───────────────────────────────────────────────────────────────────────────
// Normalizers — pure, so they can be unit-tested without a database.
// ───────────────────────────────────────────────────────────────────────────

/** `store_purchase` and the `gate_*` family are the only paid ledger reasons. */
export const PAID_TICKET_REASONS = [
  "store_purchase",
  "gate_payment",
  "gate_processing",
  "gate_settled",
  "gate_surplus_pending",
  "gate_refund_pending",
  "gate_refunded",
] as const;

const GATE_STATUS: Record<string, PurchaseStatus> = {
  gate_payment: "processing",
  gate_processing: "processing",
  // A surplus row means the slot was claimed and the overpayment became a
  // pending wallet credit — the purchase itself landed.
  gate_surplus_pending: "settled",
  gate_settled: "settled",
  gate_refund_pending: "refund_failed",
  gate_refunded: "refunded",
};

export interface RawTicketLedgerRow {
  id: string;
  userId: string;
  reason: string;
  delta: number;
  matchId: string | null;
  amountCents: number | null;
  amountStars: number | null;
  bundleSize: number | null;
  externalPaymentId: string | null;
  createdAt: Date;
}

/**
 * `true` when the ledger row is a real purchase rather than a bonus, a spend,
 * or a wallet reversal.
 *
 * The REASON alone decides it: every free grant has a reason of its own
 * (`welcome_gift`, `student_bonus`, `referral_milestone`, `promo`, …) and
 * every reversal is a `refund`, so `store_purchase` + the `gate_*` family are
 * exactly the paid set. Deliberately NOT gated on `externalPaymentId` — the
 * mock rail writes a real `store_purchase` row with a price and no charge id,
 * and dropping it would hide purchases on a mock-configured deployment.
 */
export function isPaidTicketRow(row: { reason: string }): boolean {
  return PAID_TICKET_REASONS.includes(row.reason as (typeof PAID_TICKET_REASONS)[number]);
}

export function normalizeTicketLedgerRow(
  row: RawTicketLedgerRow,
  opts: { refunded?: boolean } = {},
): PurchaseRow {
  const isGate = row.reason.startsWith("gate_");
  // No charge id ⇒ the mock rail (its confirm route writes a priced
  // `store_purchase` row and nothing else); `appstore:` ⇒ StoreKit.
  const provider: PurchaseProvider = row.externalPaymentId?.startsWith("appstore:")
    ? "app_store"
    : row.externalPaymentId == null
      ? "mock"
      : "telegram_stars";
  const status: PurchaseStatus = isGate
    ? (GATE_STATUS[row.reason] ?? "processing")
    : opts.refunded
      ? "refunded"
      : "settled";

  const amountCents = row.amountCents;
  const amountStars = row.amountStars;
  const usdCents =
    amountCents != null ? amountCents : amountStars != null ? starsToUsdCents(amountStars) : null;

  const slots = row.bundleSize ?? 0;
  return {
    id: `ticket_ledger:${row.id}`,
    source: "ticket_ledger",
    kind: isGate ? "date_ticket" : "tickets",
    userId: row.userId,
    provider,
    status,
    rawStatus: row.reason,
    amountStars,
    amountCents,
    currency: amountCents != null ? "USD" : amountStars != null ? "XTR" : null,
    usdCents,
    amountIsEstimate: amountCents == null && amountStars != null,
    detail: isGate
      ? slots > 1
        ? `${slots} slots (paid for both)`
        : "1 slot"
      : `${row.delta || slots} ticket${(row.delta || slots) === 1 ? "" : "s"}`,
    matchId: row.matchId,
    externalPaymentId: row.externalPaymentId,
    createdAt: row.createdAt,
  };
}

export interface RawSubscriptionLedgerRow {
  id: string;
  userId: string;
  provider: string;
  event: string;
  amount: number | null;
  currency: string | null;
  periodEnd: Date | null;
  externalPaymentId: string | null;
  createdAt: Date;
}

/** Only a charge is a purchase — `cancelled`/`expired` rows are lifecycle. */
export function isPaidSubscriptionRow(row: { event: string; provider: string }): boolean {
  if (row.event !== "started" && row.event !== "renewed") return false;
  // `referral` / `promo` are complimentary comp grants, not money.
  return row.provider === "telegram_stars" || row.provider === "app_store";
}

export function normalizeSubscriptionRow(
  row: RawSubscriptionLedgerRow,
  opts: { refunded?: boolean } = {},
): PurchaseRow {
  const isStars = (row.currency ?? "").toUpperCase() === "XTR";
  const amountStars = isStars ? row.amount : null;
  const amountCents = isStars ? null : row.amount;
  const usdCents =
    amountCents != null ? amountCents : amountStars != null ? starsToUsdCents(amountStars) : null;

  return {
    id: `subscription_ledger:${row.id}`,
    source: "subscription_ledger",
    kind: "premium",
    userId: row.userId,
    provider: row.provider === "app_store" ? "app_store" : "telegram_stars",
    status: opts.refunded ? "refunded" : "settled",
    rawStatus: row.event,
    amountStars,
    amountCents,
    currency: row.currency,
    usdCents,
    amountIsEstimate: amountCents == null && amountStars != null,
    detail: row.event === "renewed" ? "monthly renewal" : "first month",
    matchId: null,
    externalPaymentId: row.externalPaymentId,
    createdAt: row.createdAt,
  };
}

export interface RawRematchPurchaseRow {
  id: string;
  userId: string;
  status: string;
  amountStars: number;
  amountCents: number | null;
  resultMatchId: string | null;
  externalPaymentId: string;
  createdAt: Date;
}

export interface RawVenueChangePurchaseRow {
  id: string;
  userId: string;
  matchId: string;
  status: string;
  amountStars: number;
  externalPaymentId: string;
  createdAt: Date;
}

/** `refunded_no_candidate` / `refunded_race` / … → `refunded`. */
export function normalizePurchaseTableStatus(raw: string): PurchaseStatus {
  if (raw === "settled") return "settled";
  if (raw === "refund_failed") return "refund_failed";
  if (raw.startsWith("refunded")) return "refunded";
  return "processing";
}

export function normalizeRematchRow(row: RawRematchPurchaseRow): PurchaseRow {
  const usdCents = row.amountCents ?? starsToUsdCents(row.amountStars);
  return {
    id: `rematch_purchase:${row.id}`,
    source: "rematch_purchase",
    kind: "rematch",
    userId: row.userId,
    provider: "telegram_stars",
    status: normalizePurchaseTableStatus(row.status),
    rawStatus: row.status,
    amountStars: row.amountStars,
    amountCents: row.amountCents,
    currency: "XTR",
    usdCents,
    amountIsEstimate: row.amountCents == null,
    detail: row.resultMatchId ? "match delivered" : "no match delivered",
    matchId: row.resultMatchId,
    externalPaymentId: row.externalPaymentId,
    createdAt: row.createdAt,
  };
}

export function normalizeVenueChangeRow(row: RawVenueChangePurchaseRow): PurchaseRow {
  return {
    id: `venue_change_purchase:${row.id}`,
    source: "venue_change_purchase",
    kind: "venue_change",
    userId: row.userId,
    provider: "telegram_stars",
    status: normalizePurchaseTableStatus(row.status),
    rawStatus: row.status,
    amountStars: row.amountStars,
    amountCents: null,
    currency: "XTR",
    usdCents: starsToUsdCents(row.amountStars),
    amountIsEstimate: true,
    detail: "venue swap",
    matchId: row.matchId,
    externalPaymentId: row.externalPaymentId,
    createdAt: row.createdAt,
  };
}

export interface RawPrimeTimePurchaseRow {
  id: string;
  userId: string;
  matchId: string;
  status: string;
  amountStars: number;
  externalPaymentId: string;
  createdAt: Date;
}

export function normalizePrimeTimeRow(row: RawPrimeTimePurchaseRow): PurchaseRow {
  return {
    id: `prime_time_purchase:${row.id}`,
    source: "prime_time_purchase",
    kind: "prime_time",
    userId: row.userId,
    provider: "telegram_stars",
    status: normalizePurchaseTableStatus(row.status),
    rawStatus: row.status,
    amountStars: row.amountStars,
    amountCents: null,
    currency: "XTR",
    usdCents: starsToUsdCents(row.amountStars),
    amountIsEstimate: true,
    detail: "evening calendar band",
    matchId: row.matchId,
    externalPaymentId: row.externalPaymentId,
    createdAt: row.createdAt,
  };
}

/**
 * Totals over an already-normalized set. Refunded rows are counted separately
 * and excluded from the revenue figures — a refunded purchase is money the
 * business does not have, and a total that includes it is simply wrong.
 * `refund_failed` IS counted as revenue: the money is still with us (that is
 * exactly what makes the state an ops alarm).
 */
export function summarizePurchases(rows: readonly PurchaseRow[]): PurchaseTotals {
  let stars = 0;
  let usdCents = 0;
  let refundedCount = 0;
  for (const row of rows) {
    if (row.status === "refunded") {
      refundedCount += 1;
      continue;
    }
    stars += row.amountStars ?? 0;
    usdCents += row.usdCents ?? 0;
  }
  return { count: rows.length, stars, usdCents, refundedCount };
}

/** Newest first; ties broken by id so the order is stable across pages. */
export function sortPurchases(rows: PurchaseRow[]): PurchaseRow[] {
  return rows.sort((a, b) => {
    const delta = b.createdAt.getTime() - a.createdAt.getTime();
    return delta !== 0 ? delta : a.id.localeCompare(b.id);
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Loaders
// ───────────────────────────────────────────────────────────────────────────

export interface PurchaseFilter {
  userId?: string;
  /** Batch variant of `userId` — the admin list's per-page spend column. */
  userIds?: readonly string[];
  kind?: PurchaseKind;
  status?: PurchaseStatus;
  since?: Date;
  until?: Date;
}

/**
 * Hard ceiling on how many rows are pulled from each source for one page.
 * The four sources are merged in memory (no cross-table SQL union), so the
 * page window has to be bounded — `offset + limit` per source is exactly what
 * a correct merge needs, and this caps a pathological `offset`.
 */
const SOURCE_FETCH_CAP = 2000;

/**
 * The same ceiling for the whole-base payer index, which is not a page and so
 * cannot be bounded by `offset + limit`.
 *
 * It is a hard limit rather than an unbounded scan because this feeds a cached
 * analytics endpoint, and an unbounded merge of four tables in memory is the
 * kind of thing that is fine at 0 rows and not fine later. Hitting it is
 * REPORTED (`PayerIndex.truncated`) rather than silently truncating a
 * conversion rate — the same contract `classifyAllUsers` already uses.
 */
const PAYER_INDEX_FETCH_CAP = 20_000;

function dateFilter(filter: PurchaseFilter): { gte?: Date; lte?: Date } | undefined {
  if (!filter.since && !filter.until) return undefined;
  return {
    ...(filter.since ? { gte: filter.since } : {}),
    ...(filter.until ? { lte: filter.until } : {}),
  };
}

/**
 * Load every purchase matching `filter`, newest first.
 *
 * Fetches a bounded window from each of the four sources, normalizes, merges
 * and sorts. `kind` is pushed down to skip whole sources; `status` cannot be
 * (each source spells it differently) so it is applied after normalization —
 * which is also why the returned `total` is the count of the merged set rather
 * than a sum of SQL counts.
 *
 * `truncated` is true when any single source came back exactly full, i.e. the
 * ceiling may have cut rows off. The paginated callers ignore it (a page is
 * bounded by construction); the payer index reports it, because a conversion
 * rate computed over a truncated set is wrong rather than merely incomplete.
 */
async function loadPurchases(
  filter: PurchaseFilter,
  cap: number,
  ceiling: number = SOURCE_FETCH_CAP,
): Promise<{ rows: PurchaseRow[]; truncated: boolean }> {
  const take = Math.min(cap, ceiling);
  const createdAt = dateFilter(filter);
  const owner = filter.userId
    ? { userId: filter.userId }
    : filter.userIds
      ? { userId: { in: [...filter.userIds] } }
      : {};
  const wantsTickets = !filter.kind || filter.kind === "tickets" || filter.kind === "date_ticket";
  const wantsPremium = !filter.kind || filter.kind === "premium";
  const wantsRematch = !filter.kind || filter.kind === "rematch";
  const wantsVenue = !filter.kind || filter.kind === "venue_change";
  const wantsPrime = !filter.kind || filter.kind === "prime_time";

  const [ticketRows, subscriptionRows, rematchRows, venueRows, primeRows] = await Promise.all([
    wantsTickets
      ? prisma.ticketLedger.findMany({
          where: {
            ...owner,
            ...(createdAt ? { createdAt } : {}),
            reason: { in: [...PAID_TICKET_REASONS] },
            ...(filter.kind === "tickets" ? { reason: "store_purchase" } : {}),
            ...(filter.kind === "date_ticket"
              ? { reason: { in: PAID_TICKET_REASONS.filter((r) => r.startsWith("gate_")) } }
              : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            userId: true,
            reason: true,
            delta: true,
            matchId: true,
            amountCents: true,
            amountStars: true,
            bundleSize: true,
            externalPaymentId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    wantsPremium
      ? prisma.subscriptionLedger.findMany({
          where: {
            ...owner,
            ...(createdAt ? { createdAt } : {}),
            event: { in: ["started", "renewed"] },
            provider: { in: ["telegram_stars", "app_store"] },
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            userId: true,
            provider: true,
            event: true,
            amount: true,
            currency: true,
            periodEnd: true,
            externalPaymentId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    wantsRematch
      ? prisma.rematchPurchase.findMany({
          where: {
            ...owner,
            ...(createdAt ? { createdAt } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            userId: true,
            status: true,
            amountStars: true,
            amountCents: true,
            resultMatchId: true,
            externalPaymentId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    wantsVenue
      ? prisma.venueChangePurchase.findMany({
          where: {
            ...owner,
            ...(createdAt ? { createdAt } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            userId: true,
            matchId: true,
            status: true,
            amountStars: true,
            externalPaymentId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    wantsPrime
      ? prisma.primeTimePurchase.findMany({
          where: {
            ...owner,
            ...(createdAt ? { createdAt } : {}),
          },
          orderBy: { createdAt: "desc" },
          take,
          select: {
            id: true,
            userId: true,
            matchId: true,
            status: true,
            amountStars: true,
            externalPaymentId: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
  ]);

  // An App Store ticket credit that Apple later revoked is clawed back with a
  // compensating `appstore:<txId>:refund` row rather than a status column, so
  // the refund has to be looked up before a credit can be called `settled`.
  const refundedIds = await loadAppStoreRefundIds(
    ticketRows
      .map((row) => row.externalPaymentId)
      .filter((id): id is string => id != null && id.startsWith("appstore:")),
  );

  const rows: PurchaseRow[] = [
    ...ticketRows
      .filter(isPaidTicketRow)
      .map((row) =>
        normalizeTicketLedgerRow(row, {
          refunded: row.externalPaymentId != null && refundedIds.has(row.externalPaymentId),
        }),
      ),
    ...subscriptionRows.filter(isPaidSubscriptionRow).map((row) => normalizeSubscriptionRow(row)),
    ...rematchRows.map(normalizeRematchRow),
    ...venueRows.map(normalizeVenueChangeRow),
    ...primeRows.map(normalizePrimeTimeRow),
  ];

  const filtered = filter.status ? rows.filter((row) => row.status === filter.status) : rows;
  const truncated = [ticketRows, subscriptionRows, rematchRows, venueRows, primeRows].some(
    (source) => source.length >= take,
  );
  return { rows: sortPurchases(filtered), truncated };
}

async function loadAppStoreRefundIds(creditIds: string[]): Promise<Set<string>> {
  if (creditIds.length === 0) return new Set();
  const refunds = await prisma.ticketLedger.findMany({
    where: { externalPaymentId: { in: creditIds.map((id) => `${id}:refund`) } },
    select: { externalPaymentId: true },
  });
  return new Set(
    refunds
      .map((row) => row.externalPaymentId?.replace(/:refund$/, ""))
      .filter((id): id is string => id != null),
  );
}

export interface PurchasePage {
  rows: PurchaseRow[];
  total: number;
  totals: PurchaseTotals;
  byKind: Array<{ kind: PurchaseKind; count: number; stars: number; usdCents: number }>;
}

/** One page of the purchase list, plus totals over the WHOLE filtered set. */
export async function listPurchases(
  filter: PurchaseFilter,
  page: { limit: number; offset: number },
): Promise<PurchasePage> {
  const { rows: all } = await loadPurchases(
    filter,
    page.offset + page.limit + SOURCE_FETCH_CAP,
  );
  return {
    rows: all.slice(page.offset, page.offset + page.limit),
    total: all.length,
    totals: summarizePurchases(all),
    byKind: PURCHASE_KINDS
      .map((kind) => {
        const totals = summarizePurchases(all.filter((row) => row.kind === kind));
        return { kind, count: totals.count, stars: totals.stars, usdCents: totals.usdCents };
      })
      .filter((entry) => entry.count > 0),
  };
}

export interface UserPurchaseSummary {
  count: number;
  stars: number;
  usdCents: number;
  refundedCount: number;
  lastPurchaseAt: Date | null;
}

/** Every purchase by one user, newest first, plus their spend summary. */
export async function purchasesForUser(
  userId: string,
  limit = 100,
): Promise<{ rows: PurchaseRow[]; summary: UserPurchaseSummary }> {
  const { rows: all } = await loadPurchases({ userId }, limit + SOURCE_FETCH_CAP);
  return { rows: all.slice(0, limit), summary: summarizeForUser(all) };
}

function summarizeForUser(rows: readonly PurchaseRow[]): UserPurchaseSummary {
  const totals = summarizePurchases(rows);
  return {
    ...totals,
    lastPurchaseAt: rows.length > 0 ? (rows[0]?.createdAt ?? null) : null,
  };
}

/**
 * Spend summary for a batch of users — the admin list's per-user column.
 * One query set for the whole page rather than N per row.
 */
export async function purchaseSummariesForUsers(
  userIds: readonly string[],
): Promise<Map<string, UserPurchaseSummary>> {
  const result = new Map<string, UserPurchaseSummary>();
  if (userIds.length === 0) return result;

  const ids = new Set(userIds);
  const { rows: all } = await loadPurchases({ userIds: [...ids] }, SOURCE_FETCH_CAP);
  for (const userId of ids) {
    const rows = all.filter((row) => row.userId === userId);
    if (rows.length === 0) continue;
    result.set(userId, summarizeForUser(rows));
  }
  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Payer index — who paid, rather than what was paid
// ───────────────────────────────────────────────────────────────────────────

/** One product's totals for one payer. */
export interface PayerKindTotals {
  purchases: number;
  stars: number;
  usdCents: number;
}

/**
 * Zero-filled so a product this payer never bought reads as `0`, never
 * `undefined` — the same rule `/admin/stats` applies to its counter maps.
 */
export type PayerKindBreakdown = Record<PurchaseKind, PayerKindTotals>;

/** One payer, collapsed from all of their purchase rows. */
export interface PayerIndexEntry {
  userId: string;
  /** Purchases that actually moved money (refunded rows excluded). */
  purchases: number;
  refundedCount: number;
  stars: number;
  usdCents: number;
  /** First and last purchase that moved money. Null only for a refunded-only payer. */
  firstPaidAt: Date | null;
  lastPaidAt: Date | null;
  /**
   * Per-product totals, so "which product actually makes money" needs no
   * second pass over the rows — the aggregate would otherwise have to choose
   * between counting payers per kind and summing money per kind.
   */
  byKind: PayerKindBreakdown;
  /**
   * `true` when every purchase this user ever made came back to them. They are
   * deliberately NOT a paying user — nothing they bought is revenue — but they
   * are also not nobody, so the analytics reports them separately rather than
   * letting them vanish between the two.
   */
  refundedOnly: boolean;
}

/** Every kind, in a stable order — also the zero-fill key set. */
export const PURCHASE_KINDS: readonly PurchaseKind[] = [
  "tickets",
  "date_ticket",
  "premium",
  "rematch",
  "venue_change",
  "prime_time",
];

function emptyKindBreakdown(): PayerKindBreakdown {
  return Object.fromEntries(
    PURCHASE_KINDS.map((kind) => [kind, { purchases: 0, stars: 0, usdCents: 0 }]),
  ) as PayerKindBreakdown;
}

export interface PayerIndex {
  byUser: Map<string, PayerIndexEntry>;
  /** A source hit the fetch ceiling — every figure derived from this is partial. */
  truncated: boolean;
}

/**
 * Every user who has ever been charged, keyed by user id.
 *
 * Deliberately built on the SAME `loadPurchases` path the ledger and the user
 * card use, rather than counting rows straight out of the four tables: the
 * "is this row actually a purchase" rules (`isPaidTicketRow` skipping free
 * grants, `isPaidSubscriptionRow` skipping comp'd Premium, the App Store
 * claw-back lookup) live there, and a second implementation of them would drift
 * into quietly counting a welcome gift as a sale.
 */
export async function loadPayerIndex(
  filter: Pick<PurchaseFilter, "since" | "until"> = {},
): Promise<PayerIndex> {
  const { rows, truncated } = await loadPurchases(
    filter,
    PAYER_INDEX_FETCH_CAP,
    PAYER_INDEX_FETCH_CAP,
  );

  const byUser = new Map<string, PayerIndexEntry>();
  for (const row of rows) {
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.userId,
        purchases: 0,
        refundedCount: 0,
        stars: 0,
        usdCents: 0,
        firstPaidAt: null,
        lastPaidAt: null,
        byKind: emptyKindBreakdown(),
        refundedOnly: false,
      };
      byUser.set(row.userId, entry);
    }

    if (row.status === "refunded") {
      entry.refundedCount += 1;
      continue;
    }

    const stars = row.amountStars ?? 0;
    const usdCents = row.usdCents ?? 0;
    entry.purchases += 1;
    entry.stars += stars;
    entry.usdCents += usdCents;

    const kind = entry.byKind[row.kind];
    kind.purchases += 1;
    kind.stars += stars;
    kind.usdCents += usdCents;

    // `rows` is newest-first, so the first row seen is the latest purchase and
    // the last one seen is the earliest.
    entry.lastPaidAt ??= row.createdAt;
    entry.firstPaidAt = row.createdAt;
  }

  for (const entry of byUser.values()) {
    entry.refundedOnly = entry.purchases === 0;
  }

  return { byUser, truncated };
}
