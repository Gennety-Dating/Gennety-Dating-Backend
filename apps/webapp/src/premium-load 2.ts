/**
 * What the Premium page draws, and what a Subscribe tap is answered with.
 *
 * Its own module for the same reason as `premium-cta-label.ts`: `premium.ts`
 * runs on import, so nothing in it can be unit tested, and both rules below
 * decide whether someone can be charged twice.
 *
 * THE LOAD RULE. The sales screen is drawn ONLY from a state the server
 * actually returned. A failed `/v1/premium/state` (a timeout, a 5xx, a stale
 * initData) used to fall through to the offer with placeholder prices — so a
 * subscriber on a bad connection was shown "Subscribe" and could start a
 * second recurring Stars subscription that buys nothing and renews every
 * month. Not knowing is its own screen, with a retry.
 *
 * THE INVOICE RULE. The server refuses to mint a recurring invoice for someone
 * whose subscription is already active (409 `premium-already-active`). That is
 * not a failure to report — it means this screen is stale, so the answer is to
 * re-read the state, which lands on the active plate.
 */

/** The three screens the page can settle on after the state request. */
export type PremiumScreen = "active" | "offer" | "error";

/** How the state request ended: a parsed body, or no usable answer at all. */
export type PremiumStateResult = { ok: true; active: boolean } | { ok: false };

export function premiumScreenFor(result: PremiumStateResult): PremiumScreen {
  if (!result.ok) return "error";
  return result.active ? "active" : "offer";
}

/** The error code the server answers a duplicate recurring invoice with. */
export const PREMIUM_ALREADY_ACTIVE = "premium-already-active";

export type InvoiceOutcome =
  | { kind: "link"; link: string }
  /** Already subscribed — refresh the page instead of charging again. */
  | { kind: "already-active" }
  | { kind: "failed" };

/**
 * Classify a `/v1/premium/stars-invoice` response. `body` is whatever JSON
 * came back (or null when there was none).
 */
export function invoiceOutcomeFor(status: number, body: unknown): InvoiceOutcome {
  if (typeof body !== "object" || body === null) return { kind: "failed" };
  if (status === 409 && "error" in body && body.error === PREMIUM_ALREADY_ACTIVE) {
    return { kind: "already-active" };
  }
  if (status >= 200 && status < 300 && "link" in body) {
    const link = body.link;
    if (typeof link === "string" && link) return { kind: "link", link };
  }
  // A 2xx without a link would open an invoice for "undefined"; say it failed.
  return { kind: "failed" };
}
