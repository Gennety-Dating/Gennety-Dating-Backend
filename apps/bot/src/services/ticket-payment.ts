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

/**
 * Which ticket(s) a single gate action settles:
 *   self    — the actor's own ticket (1 ticket)
 *   both    — the actor's + the partner's ticket in one action (2 tickets, male-only)
 *   partner — only the partner's ticket, after the actor already covered their
 *             own (1 ticket, male-only); lets a male with a single ticket use it
 *             for himself and still pay for his date afterwards.
 */
export type TicketScope = "self" | "both" | "partner";
export type PaymentMode = "mock" | "stripe";

export interface CreatedIntent {
  /** Opaque token the Mini App hands back on confirm. */
  clientSecret: string;
  amountCents: number;
  mode: PaymentMode;
}

const MOCK_INTENT_TTL_MS = 15 * 60 * 1000;
const MAX_MOCK_INTENTS = 10_000;

type MockIntent =
  | {
      kind: "date";
      payerId: string;
      matchId: string;
      scope: TicketScope;
      amountCents: number;
      expiresAt: number;
    }
  | {
      kind: "store";
      userId: string;
      count: number;
      amountCents: number;
      expiresAt: number;
    };

type MockIntentInput =
  | Omit<Extract<MockIntent, { kind: "date" }>, "expiresAt">
  | Omit<Extract<MockIntent, { kind: "store" }>, "expiresAt">;

const mockIntents = new Map<string, MockIntent>();

function pruneMockIntents(now = Date.now()): void {
  for (const [token, intent] of mockIntents) {
    if (intent.expiresAt <= now) mockIntents.delete(token);
  }
  while (mockIntents.size >= MAX_MOCK_INTENTS) {
    const oldest = mockIntents.keys().next().value as string | undefined;
    if (!oldest) break;
    mockIntents.delete(oldest);
  }
}

function createMockIntent(intent: MockIntentInput): string {
  pruneMockIntents();
  const prefix = intent.kind === "store" ? "mock_store_pi_" : "mock_pi_";
  const token = `${prefix}${randomUUID()}`;
  mockIntents.set(token, { ...intent, expiresAt: Date.now() + MOCK_INTENT_TTL_MS } as MockIntent);
  return token;
}

function consumeMockIntent(
  clientSecret: string,
  matches: (intent: MockIntent) => boolean,
): boolean {
  pruneMockIntents();
  const intent = mockIntents.get(clientSecret);
  if (!intent || !matches(intent)) return false;
  mockIntents.delete(clientSecret);
  return true;
}

export function resetMockPaymentIntentsForTests(): void {
  mockIntents.clear();
}

/** Number of tickets a scope settles (1 for self/partner, 2 for both). */
export function ticketsForScope(scope: TicketScope): number {
  return scope === "both" ? 2 : 1;
}

/** Cents charged for a given scope at a given per-ticket price. */
export function amountForScope(scope: TicketScope, priceCents: number): number {
  return priceCents * ticketsForScope(scope);
}

/**
 * Telegram Stars (XTR) charged for a date-gate scope. The per-ticket Star
 * price is the 1-ticket store bundle entry (`TICKET_BUNDLE_STARS[1]`), so the
 * gate and the store stay in sync; `both` costs 2×. Used by the native
 * `WebApp.openInvoice` gate path (`POST /stars-invoice`) and re-validated in
 * the `pre_checkout_query` handler. Only meaningful when `TICKET_STARS_ENABLED`.
 */
export function gateStarsForScope(scope: TicketScope): number {
  const perTicket = env.TICKET_BUNDLE_STARS[1] ?? 0;
  return perTicket * ticketsForScope(scope);
}

/**
 * Create a payment intent for one ticket purchase. In mock mode this is a
 * synthetic id; no money moves. In stripe mode this will create a real
 * PaymentIntent and return its `client_secret`.
 */
export async function createTicketIntent(args: {
  payerId: string;
  matchId: string;
  scope: TicketScope;
  amountCents: number;
}): Promise<CreatedIntent> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      // Fully simulated — the Mini App renders a fake Payment Element and the
      // server later consumes this exact, context-bound token once.
      return {
        clientSecret: createMockIntent({
          kind: "date",
          payerId: args.payerId,
          matchId: args.matchId,
          scope: args.scope,
          amountCents: args.amountCents,
        }),
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
 * Mock mode: consume the exact server-issued intent for this payer and match.
 * Stripe mode: this must NOT be the trust boundary — the source of truth is
 * the `/v1/webhooks/stripe` event. The client confirm in production becomes a
 * poll for the webhook-written paid state.
 */
export async function verifyTicketPayment(args: {
  clientSecret: string;
  payerId: string;
  matchId: string;
  scope: TicketScope;
  amountCents: number;
}): Promise<{ ok: boolean }> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      return {
        ok: consumeMockIntent(
          args.clientSecret,
          (intent) =>
            intent.kind === "date" &&
            intent.payerId === args.payerId &&
            intent.matchId === args.matchId &&
            intent.scope === args.scope &&
            intent.amountCents === args.amountCents,
        ),
      };
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

export interface CreatedStoreIntent {
  clientSecret: string;
  amountCents: number;
  count: number;
  mode: PaymentMode;
}

/**
 * Create a payment intent for a ticket-bundle purchase in the store Mini App
 * (pre-purchase, not tied to a match). Same mock/stripe abstraction as the
 * date-gate intent; the mock token is prefixed `mock_store_pi_` so the store
 * confirm can't be satisfied by a date-gate token and vice versa.
 */
export async function createStoreIntent(args: {
  userId: string;
  count: number;
  amountCents: number;
}): Promise<CreatedStoreIntent> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      return {
        clientSecret: createMockIntent({
          kind: "store",
          userId: args.userId,
          count: args.count,
          amountCents: args.amountCents,
        }),
        amountCents: args.amountCents,
        count: args.count,
        mode,
      };
    case "stripe":
      // TODO: Stripe Production Mode — mirror createTicketIntent.
      throw new Error("TICKET_PAYMENT_MODE=stripe not yet implemented");
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown TICKET_PAYMENT_MODE: ${String(_exhaustive)}`);
    }
  }
}

/** Verify and consume a context-bound store-purchase intent. */
export async function verifyStorePayment(args: {
  clientSecret: string;
  userId: string;
  count: number;
  amountCents: number;
}): Promise<{ ok: boolean }> {
  const mode = env.TICKET_PAYMENT_MODE;
  switch (mode) {
    case "mock":
      return {
        ok: consumeMockIntent(
          args.clientSecret,
          (intent) =>
            intent.kind === "store" &&
            intent.userId === args.userId &&
            intent.count === args.count &&
            intent.amountCents === args.amountCents,
        ),
      };
    case "stripe":
      // TODO: Stripe Production Mode — defer to the HMAC webhook.
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
