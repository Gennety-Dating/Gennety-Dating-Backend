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
 * Gennety Premium (§Premium) recurring-subscription Star payment payload. A
 * single flat monthly price (env `PREMIUM_STARS`) sold via a native Telegram
 * Star *subscription* invoice (`subscription_period: 2592000`). The payer is
 * identified from `ctx.from`, so the payload carries no per-user data — just the
 * product tag. Format: `sub:premium`. Recurring renewals redeliver a
 * `successful_payment` with this same payload and `is_recurring: true`.
 */
export const SUB_INVOICE_PREFIX = "sub:";

/** The only subscription product today. */
export type SubInvoiceProduct = "premium";

/** Build the invoice payload for a Premium subscription Star payment. */
export function buildSubInvoicePayload(product: SubInvoiceProduct = "premium"): string {
  return `${SUB_INVOICE_PREFIX}${product}`;
}

/**
 * Parse a subscription invoice payload back into `{ product }`. Returns null for
 * any non-subscription, malformed, or unknown-product payload — so a foreign or
 * tampered invoice never grants Premium. The Star-amount check remains the trust
 * boundary in the pre-checkout / successful-payment handlers.
 */
export function parseSubInvoicePayload(
  payload: string | null | undefined,
): { product: SubInvoiceProduct } | null {
  if (!payload || !payload.startsWith(SUB_INVOICE_PREFIX)) return null;
  const product = payload.slice(SUB_INVOICE_PREFIX.length);
  if (product !== "premium") return null;
  return { product };
}
