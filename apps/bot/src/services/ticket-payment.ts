import { randomUUID } from "node:crypto";
import { env } from "../config.js";

/**
 * Date Ticket payment provider abstraction.
 *
 * This module is the ONLY place that knows whether payments are real. The
 * rest of the feature (router, gate, cron) talks to these three functions and
 * never imports Stripe directly, so flipping `TICKET_PAYMENT_MODE` from `mock`
 * to `stripe` is a localized change.
 *
 * ── Going live (the production switch) ──────────────────────────────────
 * 1. Add STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY / STRIPE_WEBHOOK_SECRET to
 *    env and uncomment them in config.ts.
 * 2. Set TICKET_PAYMENT_MODE=stripe.
 * 3. Fill the `case "stripe"` branches below with the real Stripe SDK calls.
 * 4. Add the `/v1/webhooks/stripe` raw-body route so `confirm` is driven by a
 *    verified webhook instead of trusting the client.
 * Every such spot is tagged `// TODO: Stripe Production Mode`.
 */

export type TicketScope = "self" | "both";
export type PaymentMode = "mock" | "stripe";

export interface CreatedIntent {
  /** Opaque token the Mini App hands back on confirm. */
  clientSecret: string;
  amountCents: number;
  mode: PaymentMode;
}

/** Cents charged for a given scope at a given per-ticket price. */
export function amountForScope(scope: TicketScope, priceCents: number): number {
  return scope === "both" ? priceCents * 2 : priceCents;
}

/**
 * Create a payment intent for one ticket purchase. In mock mode this is a
 * synthetic id; no money moves. In stripe mode this will create a real
 * PaymentIntent and return its `client_secret`.
 */
export async function createTicketIntent(args: {
  matchId: string;
  scope: TicketScope;
  amountCents: number;
}): Promise<CreatedIntent> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      // Fully simulated — the Mini App renders a fake Payment Element and the
      // confirm endpoint trusts this token. No network call, no credentials.
      return {
        clientSecret: `mock_pi_${randomUUID()}`,
        amountCents: args.amountCents,
        mode,
      };
    case "stripe":
      // TODO: Stripe Production Mode
      // const stripe = new Stripe(env.STRIPE_SECRET_KEY);
      // const intent = await stripe.paymentIntents.create({
      //   amount: args.amountCents,
      //   currency: "usd",
      //   metadata: { matchId: args.matchId, scope: args.scope },
      //   automatic_payment_methods: { enabled: true },
      // });
      // return { clientSecret: intent.client_secret!, amountCents: args.amountCents, mode };
      throw new Error("TICKET_PAYMENT_MODE=stripe not yet implemented");
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown TICKET_PAYMENT_MODE: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Verify that a confirm request corresponds to a real, succeeded payment.
 *
 * Mock mode: we trust any non-empty `mock_pi_*` token (the user "completed"
 * the fake form). Stripe mode: this must NOT be the trust boundary — the
 * source of truth is the `/v1/webhooks/stripe` event. The client confirm in
 * production becomes a poll for the webhook-written paid state.
 */
export async function verifyTicketPayment(args: {
  clientSecret: string;
}): Promise<{ ok: boolean }> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      return { ok: typeof args.clientSecret === "string" && args.clientSecret.startsWith("mock_pi_") };
    case "stripe":
      // TODO: Stripe Production Mode — do NOT trust the client here. The
      // webhook (`payment_intent.succeeded`, HMAC-verified) is the only path
      // allowed to mark a ticket paid. This function should look up the
      // PaymentIntent and return ok only if status === "succeeded".
      throw new Error("TICKET_PAYMENT_MODE=stripe not yet implemented");
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown TICKET_PAYMENT_MODE: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Refund a paid ticket (used by the expiry cron when a `partial` payment
 * lapses). Mock mode is a no-op success. Stripe mode will issue a real refund.
 */
export async function refundTicketPayment(args: {
  matchId: string;
  amountCents: number;
}): Promise<{ ok: boolean }> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      // No money moved in the first place — nothing to reverse.
      return { ok: true };
    case "stripe":
      // TODO: Stripe Production Mode
      // await stripe.refunds.create({ payment_intent: <stored intent id> });
      throw new Error("TICKET_PAYMENT_MODE=stripe not yet implemented");
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown TICKET_PAYMENT_MODE: ${String(_exhaustive)}`);
    }
  }
}
