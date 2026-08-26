import type { PremiumPlanId } from "./premium-plans.js";

/**
 * Telegram Stars (XTR) ticket-store helpers.
 *
 * Stars top up the Date Ticket wallet: a store bundle (1/3/6 tickets) is sold
 * via a native Telegram Star invoice. The invoice's `payload` is the only thing
 * that survives the round-trip into the `pre_checkout_query` and
 * `successful_payment` updates, so it carries the bundle size. These are pure
 * encode/decode helpers (no env, no Telegram) so the trust-boundary handlers can
 * be unit-tested; the Star price per bundle lives in config (env-overridable).
 */

/** Invoice `payload` prefix that marks a ticket-store Star purchase. */
export const STORE_INVOICE_PREFIX = "store:";

/** Build the invoice payload for a store bundle of `count` tickets. */
export function buildStoreInvoicePayload(count: number): string {
  return `${STORE_INVOICE_PREFIX}${count}`;
}

/**
 * Parse a store invoice payload back into the bundle size. Returns null for any
 * non-store, malformed, or non-positive-integer payload — so an unrelated
 * invoice (or a tampered payload) never credits tickets.
 */
export function parseStoreInvoicePayload(
  payload: string | null | undefined,
): number | null {
  if (!payload || !payload.startsWith(STORE_INVOICE_PREFIX)) return null;
  const raw = payload.slice(STORE_INVOICE_PREFIX.length);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Date-gate (§3.5b) Star payment payload. Unlike the store (which credits the
 * wallet), a gate Star payment settles ticket slot(s) on a specific match, so
 * the payload carries both the match id and the scope (`self`/`both`/`partner`).
 * Format: `gate:<matchId>:<scope>`.
 */
export const GATE_INVOICE_PREFIX = "gate:";

/** The three gate scopes a Star invoice can settle (mirror of `TicketScope`). */
export type GateInvoiceScope = "self" | "both" | "partner";

const GATE_PAYLOAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build the invoice payload for a date-gate Star payment. */
export function buildGateInvoicePayload(matchId: string, scope: GateInvoiceScope): string {
  return `${GATE_INVOICE_PREFIX}${matchId}:${scope}`;
}

/**
 * Parse a date-gate invoice payload back into `{ matchId, scope }`. Returns null
 * for any non-gate, malformed, bad-UUID, or unknown-scope payload — so a foreign
 * or tampered invoice never settles a ticket. The match-participant + male-only
 * checks remain the trust boundary in `applyTicketPayment`.
 */
export function parseGateInvoicePayload(
  payload: string | null | undefined,
): { matchId: string; scope: GateInvoiceScope } | null {
  if (!payload || !payload.startsWith(GATE_INVOICE_PREFIX)) return null;
  const rest = payload.slice(GATE_INVOICE_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const matchId = rest.slice(0, sep);
  const scope = rest.slice(sep + 1);
  if (!GATE_PAYLOAD_UUID.test(matchId)) return null;
  if (scope !== "self" && scope !== "both" && scope !== "partner") return null;
  return { matchId, scope };
}

/**
 * Venue-change (§3.7b v2) Star payment payload. One flat 150⭐ price (env
 * `VENUE_CHANGE_STARS`) settles the venue swap on a specific match. Two modes:
 *   • `agreed`  — pays for the venue both sides converged on via the board
 *     (the venueChange* fields already hold the agreed venue).
 *   • `express` — the female's unilateral instant swap; the express pick was
 *     stamped onto the venueChange* fields when the invoice was minted.
 * Format: `venue:<matchId>:<mode>`.
 */
export const VENUE_INVOICE_PREFIX = "venue:";

/** The two venue-change Star payment modes. */
export type VenueInvoiceMode = "agreed" | "express";

/** Build the invoice payload for a venue-change Star payment. */
export function buildVenueInvoicePayload(matchId: string, mode: VenueInvoiceMode): string {
  return `${VENUE_INVOICE_PREFIX}${matchId}:${mode}`;
}

/**
 * Parse a venue-change invoice payload back into `{ matchId, mode }`. Returns
 * null for any non-venue, malformed, bad-UUID, or unknown-mode payload — so a
 * foreign or tampered invoice never swaps a venue. Participant/payer checks
 * remain the trust boundary in the settle handler.
 */
export function parseVenueInvoicePayload(
  payload: string | null | undefined,
): { matchId: string; mode: VenueInvoiceMode } | null {
  if (!payload || !payload.startsWith(VENUE_INVOICE_PREFIX)) return null;
  const rest = payload.slice(VENUE_INVOICE_PREFIX.length);
  const sep = rest.lastIndexOf(":");
  if (sep <= 0) return null;
  const matchId = rest.slice(0, sep);
  const mode = rest.slice(sep + 1);
  if (!GATE_PAYLOAD_UUID.test(matchId)) return null;
  if (mode !== "agreed" && mode !== "express") return null;
  return { matchId, mode };
}

/**
 * Prime Time (PRIME_TIME_PRODUCT_SPEC.md) Star payment payload.
 *
 * One product, one match: the pass opens the calendar's evening band for the
 * PAIR, so the payload needs nothing but the match id. Format:
 * `prime:<matchId>`.
 *
 * There is deliberately no scope segment the way the date gate has one. The
 * band cannot be bought "for me only" — a slot locks when both sides' sets
 * intersect, so a one-sided unlock would buy nothing.
 */
export const PRIME_INVOICE_PREFIX = "prime:";

export function buildPrimeInvoicePayload(matchId: string): string {
  return `${PRIME_INVOICE_PREFIX}${matchId}`;
}

/**
 * Parse a Prime Time payload back into the match id. Null for anything foreign,
 * malformed, or carrying a non-UUID — participant checks stay the trust
 * boundary in the settle handler, exactly as they do for the venue rail.
 */
export function parsePrimeInvoicePayload(
  payload: string | null | undefined,
): { matchId: string } | null {
  if (!payload || !payload.startsWith(PRIME_INVOICE_PREFIX)) return null;
  const matchId = payload.slice(PRIME_INVOICE_PREFIX.length);
  if (!GATE_PAYLOAD_UUID.test(matchId)) return null;
  return { matchId };
}

/**
 * Gennety Premium (§3.8) Star payment payload.
 *
 * One entitlement, three products, distinguished ONLY by this payload:
 *
 *   • `sub:premium`  — the recurring monthly subscription
 *                      (`subscription_period: 2592000`). Auto-renewals
 *                      redeliver a `successful_payment` with this exact same
 *                      payload and `is_recurring: true`, which is why the tag
 *                      must never be repurposed.
 *   • `sub:premium3` — a ONE-TIME purchase of 3 months (15% off).
 *   • `sub:premium6` — a ONE-TIME purchase of 6 months (30% off).
 *
 * The payer is identified from `ctx.from`, so the payload carries no per-user
 * data — just the product tag. The Star-amount check in the pre-checkout /
 * successful-payment handlers remains the trust boundary; this only says WHICH
 * product a charge is for, and an unknown tag parses to null so a foreign or
 * tampered invoice can never grant Premium.
 */
export const SUB_INVOICE_PREFIX = "sub:";

/** The subscription/package products in circulation. */
export type SubInvoiceProduct = "premium" | "premium3" | "premium6";

/**
 * Product tag ↔ plan id. Two vocabularies exist on purpose: the tag is a wire
 * format frozen by every invoice already minted (`premium` predates packages
 * and must keep meaning "monthly"), while the plan id is the internal catalog
 * key. Renaming either alone is what would silently mis-price a redelivered
 * charge, so the mapping lives here, once.
 */
const PRODUCT_TO_PLAN: Record<SubInvoiceProduct, PremiumPlanId> = {
  premium: "monthly",
  premium3: "months3",
  premium6: "months6",
};

const PLAN_TO_PRODUCT: Record<PremiumPlanId, SubInvoiceProduct> = {
  monthly: "premium",
  months3: "premium3",
  months6: "premium6",
};

/** The invoice-payload product tag for a plan. */
export function subProductForPlan(plan: PremiumPlanId): SubInvoiceProduct {
  return PLAN_TO_PRODUCT[plan];
}

/** Build the invoice payload for a Premium subscription/package Star payment. */
export function buildSubInvoicePayload(product: SubInvoiceProduct = "premium"): string {
  return `${SUB_INVOICE_PREFIX}${product}`;
}

/**
 * Parse a subscription invoice payload back into its product and the plan it
 * buys. Returns null for any non-subscription, malformed, or unknown-product
 * payload.
 */
export function parseSubInvoicePayload(
  payload: string | null | undefined,
): { product: SubInvoiceProduct; plan: PremiumPlanId } | null {
  if (!payload || !payload.startsWith(SUB_INVOICE_PREFIX)) return null;
  const product = payload.slice(SUB_INVOICE_PREFIX.length) as SubInvoiceProduct;
  const plan = PRODUCT_TO_PLAN[product];
  if (!plan) return null;
  return { product, plan };
}

/**
 * Rematch (REMATCH_PRODUCT_SPEC.md) Star payment payload. A one-off purchase
 * that re-runs the matching engine for the buyer alone.
 *
 * Like `sub:premium` — and unlike `gate:`/`venue:` — the payload carries NO
 * per-user or per-match data: there is no match yet at invoice time, and the
 * buyer is identified from `ctx.from` at the trust boundary. The version tag
 * exists so a payload minted before a future pricing/semantics change can be
 * recognised (and refunded) rather than silently settled under new rules.
 * Format: `rematch:v1`.
 */
export const REMATCH_INVOICE_PREFIX = "rematch:";

/** The only rematch payload version in circulation. */
export type RematchInvoiceVersion = "v1";

/** Build the invoice payload for a rematch Star payment. */
export function buildRematchInvoicePayload(
  version: RematchInvoiceVersion = "v1",
): string {
  return `${REMATCH_INVOICE_PREFIX}${version}`;
}

/**
 * Parse a rematch invoice payload back into `{ version }`. Returns null for any
 * non-rematch, malformed, or unknown-version payload — so a foreign or tampered
 * invoice never triggers a rematch run. Eligibility, D3 limits, and the
 * male-only rule remain the trust boundary in the settle handler.
 */
export function parseRematchInvoicePayload(
  payload: string | null | undefined,
): { version: RematchInvoiceVersion } | null {
  if (!payload || !payload.startsWith(REMATCH_INVOICE_PREFIX)) return null;
  const version = payload.slice(REMATCH_INVOICE_PREFIX.length);
  if (version !== "v1") return null;
  return { version };
}
