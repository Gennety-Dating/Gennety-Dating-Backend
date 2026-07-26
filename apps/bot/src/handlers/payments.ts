import type { BotContext } from "../session.js";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  parseStoreInvoicePayload,
  parseGateInvoicePayload,
  parseVenueInvoicePayload,
  parseSubInvoicePayload,
  parseRematchInvoicePayload,
  ticketBundleFor,
  PREMIUM_SUBSCRIPTION_PERIOD_SECONDS,
} from "@gennety/shared";
import { env } from "../config.js";
import { grantTickets, isUniqueViolation } from "../services/ticket-wallet.js";
import { gateStarsForScope } from "../services/ticket-payment.js";
import { activateOrExtendPremium, formatPremiumUntil } from "../services/premium.js";

/**
 * Telegram Stars (XTR) payment handlers.
 *
 * Three Star surfaces share these trusted handlers, distinguished by the
 * invoice payload that survives the round-trip:
 *   • `store:<count>` — ticket-store top-up; credits the wallet.
 *   • `gate:<matchId>:<scope>` — §3.5b date-gate direct pay; settles ticket
 *     slot(s) on the match (the native replacement for the mock USD pay path).
 *   • `venue:<matchId>:<mode>` — §3.7b venue-change board/express payment;
 *     settles the venue swap.
 *   • `sub:premium` — §Premium recurring Star *subscription* payment; grants /
 *     extends the Gennety Premium entitlement (first charge + auto-renewals).
 *
 * Telegram drives two trusted updates for each:
 *   • `pre_checkout_query` — re-validate the payload + Star amount and approve
 *     within Telegram's 10s window (`handlePreCheckout`).
 *   • `message:successful_payment` — Telegram's confirmation that Stars moved;
 *     THIS is the trust boundary that credits/settles (`handleSuccessfulPayment`).
 *
 * Registered at the top of the router so they fire regardless of onboarding step.
 */

/** Approve/decline a pre-checkout for a Star purchase (store, gate, or venue). */
export async function handlePreCheckout(ctx: BotContext): Promise<void> {
  const query = ctx.preCheckoutQuery;
  if (!query) return;

  let ok = false;
  // Store top-up — payload `store:<count>`.
  const count = parseStoreInvoicePayload(query.invoice_payload);
  const venue = count == null ? parseVenueInvoicePayload(query.invoice_payload) : null;
  const sub =
    count == null && venue == null ? parseSubInvoicePayload(query.invoice_payload) : null;
  const rematch =
    count == null && venue == null && sub == null
      ? parseRematchInvoicePayload(query.invoice_payload)
      : null;
  if (rematch != null) {
    // Rematch — payload `rematch:v1`. Like the venue branch, invoice links are
    // reusable, so we re-validate eligibility here and decline BEFORE any Stars
    // move: a man who acquired a live match, blew his D3 limit, or entered the
    // pre-batch blackout since minting the link is stopped at the door rather
    // than being charged and refunded. That refund path still exists at settle
    // (state can change inside the 10s window), but this keeps it rare.
    if (
      env.REMATCH_FEATURE_ENABLED &&
      query.currency === "XTR" &&
      query.total_amount === env.REMATCH_STARS
    ) {
      const buyer = await prisma.user
        .findUnique({
          where: { telegramId: BigInt(query.from.id) },
          select: { id: true },
        })
        .catch(() => null);
      if (buyer) {
        const { checkRematchEligibility } = await import("../services/rematch.js");
        const eligibility = await checkRematchEligibility(buyer.id).catch(() => null);
        ok = eligibility?.ok === true;
      }
    }
  } else if (count != null) {
    const expectedStars = env.TICKET_BUNDLE_STARS[count];
    ok =
      ticketBundleFor(count) != null &&
      expectedStars != null &&
      query.currency === "XTR" &&
      query.total_amount === expectedStars;
  } else if (sub != null) {
    // Premium subscription — payload `sub:premium`. The amount is the only thing
    // to re-validate here (there's no per-user state to check; the recurring
    // charge is anchored by the subscription itself). A stale/tampered amount is
    // declined before any Stars move.
    ok = query.currency === "XTR" && query.total_amount === env.PREMIUM_STARS;
  } else if (venue != null) {
    // Venue change — payload `venue:<matchId>:<mode>`. Invoice links are
    // reusable, so beyond the amount we also confirm the swap is still
    // awaiting payment: a stale link (already settled / lapsed / reverted
    // express) is declined here, BEFORE any Stars move.
    if (query.currency === "XTR" && query.total_amount === env.VENUE_CHANGE_STARS) {
      const match = await prisma.match
        .findUnique({
          where: { id: venue.matchId },
          select: { venueChangeStatus: true, status: true },
        })
        .catch(() => null);
      ok = match?.status === "scheduled" && match.venueChangeStatus === "agreed";
    }
  } else {
    // Date gate — payload `gate:<matchId>:<scope>`. The participant + male-only
    // checks were enforced at invoice creation and re-enforced at settle time.
    // Beyond the payload shape + Star amount we ALSO re-validate the gate is
    // still open here: invoice links are reusable, so a stale one (the match was
    // cancelled — e.g. the partner was banned/froze — or expired, or the gate is
    // already `completed`) must be declined BEFORE any Stars move. Without this
    // the settle CAS claims nothing and the Stars are consumed with no ticket
    // and no refund. Mirrors the venue branch above.
    const gate = parseGateInvoicePayload(query.invoice_payload);
    if (gate != null) {
      const expectedStars = gateStarsForScope(gate.scope);
      if (
        expectedStars > 0 &&
        query.currency === "XTR" &&
        query.total_amount === expectedStars
      ) {
        const match = await prisma.match
          .findUnique({
            where: { id: gate.matchId },
            select: { status: true, ticketStatus: true },
          })
          .catch(() => null);
        ok = match?.status === "negotiating" && match.ticketStatus !== "completed";
      }
    }
  }

  try {
    if (ok) {
      // Common path — approve fast, no DB/session work (a `pre_checkout_query`
      // has no chat, so `ctx.session` is unavailable here; this handler runs
      // before the session middleware by design).
      await ctx.answerPreCheckoutQuery(true, undefined);
    } else {
      // Rare decline path (tampered/stale payload) — localize the message from
      // the payer's stored language, best-effort.
      const lang = await langForTelegramId(ctx.from?.id);
      await ctx.answerPreCheckoutQuery(false, {
        error_message: t(lang, "ticketStoreCheckoutError"),
      });
    }
  } catch {
    // The 10s answer window may have elapsed; nothing else we can do.
  }
}

/** Best-effort stored language for a Telegram id (defaults to `en`). Used only
 *  off the hot path (the pre-checkout decline message). */
async function langForTelegramId(telegramId: number | undefined): Promise<Language> {
  if (telegramId == null) return "en";
  const user = await prisma.user
    .findUnique({ where: { telegramId: BigInt(telegramId) }, select: { language: true } })
    .catch(() => null);
  return (user?.language ?? "en") as Language;
}

/** Credit the wallet / settle the gate once Telegram confirms Stars moved. */
export async function handleSuccessfulPayment(ctx: BotContext): Promise<void> {
  const payment = ctx.message?.successful_payment;
  if (!payment) return;

  const count = parseStoreInvoicePayload(payment.invoice_payload);
  if (count == null || ticketBundleFor(count) == null) {
    // Not a store bundle — try §Premium subscription, then the §3.7b venue
    // change, then the §3.5b date gate, before giving up so a foreign payload
    // still credits nothing.
    const sub = parseSubInvoicePayload(payment.invoice_payload);
    if (sub != null) {
      await handlePremiumSuccessfulPayment(ctx, payment);
      return;
    }
    const venue = parseVenueInvoicePayload(payment.invoice_payload);
    if (venue != null) {
      await handleVenueSuccessfulPayment(ctx, venue.matchId, payment);
      return;
    }
    const rematch = parseRematchInvoicePayload(payment.invoice_payload);
    if (rematch != null) {
      await handleRematchSuccessfulPayment(ctx, payment);
      return;
    }
    await handleGateSuccessfulPayment(ctx, payment);
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return;

  // Log the Telegram charge id for manual reconciliation.
  console.info(
    `[stars] store purchase user=${user.id} count=${count} stars=${payment.total_amount} ` +
      `charge=${payment.telegram_payment_charge_id}`,
  );

  // Exactly-once credit: the charge id is written to the unique
  // `TicketLedger.externalPaymentId`, so a redelivered `successful_payment`
  // (Telegram retry / crash before grammY's offset-commit) throws P2002 and the
  // credit rolls back. Treat that as an idempotent no-op — the first delivery
  // already credited the wallet and DM'd the confirmation, so we neither
  // re-credit nor send a second confirmation here.
  let balance: number;
  try {
    balance = await grantTickets({
      userId: user.id,
      count,
      reason: "store_purchase",
      bundleSize: count,
      externalPaymentId: payment.telegram_payment_charge_id,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.info(
        `[stars] store purchase duplicate ignored user=${user.id} ` +
          `charge=${payment.telegram_payment_charge_id}`,
      );
      return;
    }
    throw err;
  }

  const lang = (user.language ?? "en") as Language;
  const text = t(lang, "ticketStorePurchased", { count, balance });
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text.replace(/[*_`[\]]/g, "")).catch(() => {});
  }
}

/**
 * §Premium recurring Star payment (payload `sub:premium`). Telegram fires this
 * on the first charge AND on every 30-day auto-renewal (`is_recurring: true`).
 * Each charge carries its own `telegram_payment_charge_id`, so the entitlement
 * service dedupes redelivery via the unique ledger id. The authoritative expiry
 * is Telegram's `subscription_expiration_date`; we advance `premiumUntil` to it.
 */
async function handlePremiumSuccessfulPayment(
  ctx: BotContext,
  payment: {
    total_amount: number;
    telegram_payment_charge_id: string;
    subscription_expiration_date?: number;
    is_recurring?: boolean;
    is_first_recurring?: boolean;
  },
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return;

  // Prefer Telegram's authoritative expiry; fall back to now + 30d defensively
  // (a subscription payment should always carry it).
  const periodEnd = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : new Date(Date.now() + PREMIUM_SUBSCRIPTION_PERIOD_SECONDS * 1000);
  const isFirst = payment.is_first_recurring ?? !payment.is_recurring;

  console.info(
    `[stars] premium sub user=${user.id} recurring=${payment.is_recurring ?? false} ` +
      `first=${isFirst} stars=${payment.total_amount} ` +
      `charge=${payment.telegram_payment_charge_id} until=${periodEnd.toISOString()}`,
  );

  const result = await activateOrExtendPremium({
    userId: user.id,
    provider: "telegram_stars",
    periodEnd,
    externalPaymentId: payment.telegram_payment_charge_id,
    event: isFirst ? "started" : "renewed",
    amount: payment.total_amount,
    currency: "XTR",
  });
  // Duplicate redelivery, or an unknown user — nothing to announce.
  if (!result.applied) return;

  // DM only on the first period; auto-renewals settle silently.
  if (isFirst) {
    const lang = (user.language ?? "en") as Language;
    const text = t(lang, "premiumWelcomeDm", {
      date: formatPremiumUntil(periodEnd, lang),
    });
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(text.replace(/[*_`[\]]/g, "")).catch(() => {});
    }
  }
}

/**
 * §3.7b venue-change Star payment (payload `venue:<matchId>:<mode>`). Telegram
 * has confirmed the Stars moved, so this settles the venue swap: the handler's
 * status CAS makes a redelivered payment a no-op, and a genuinely lost
 * parallel-pay race (both her and his invoices were open) is refunded inside
 * `settleVenuePayment`. All settle-time DMs (updated cards, reveal, express
 * surprise) live in the venue-change module.
 */
async function handleVenueSuccessfulPayment(
  ctx: BotContext,
  matchId: string,
  payment: { total_amount: number; telegram_payment_charge_id: string },
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  console.info(
    `[stars] venue-change payment user=${telegramId} match=${matchId} ` +
      `stars=${payment.total_amount} charge=${payment.telegram_payment_charge_id}`,
  );

  // Dynamic import keeps the venue board's module graph out of this handler's
  // static graph (mirrors the gate import below).
  const { settleVenuePayment } = await import("./matching/venue-change.js");
  const result = await settleVenuePayment(
    ctx.api,
    telegramId,
    matchId,
    payment.telegram_payment_charge_id,
  );
  if (!result.ok) {
    console.error(
      `[stars] venue-change settle failed user=${telegramId} match=${matchId} ` +
        `reason=${result.reason}`,
    );
  }
}

/**
 * Rematch Star payment (payload `rematch:v1`) — REMATCH_PRODUCT_SPEC.md.
 *
 * THE money-critical path. Telegram has confirmed the Stars moved, so from here
 * exactly one of two things must become true and stay true: he gets a match, or
 * he gets his Stars back. The order below is what guarantees that:
 *
 *   1. Write the purchase row FIRST, keyed by the unique charge id. A P2002 is a
 *      redelivered `successful_payment` (Telegram retry / crash before grammY
 *      committed the offset) → idempotent no-op. Writing before the run means a
 *      crash mid-run still leaves a durable record that money was taken, which
 *      the hourly sweep refunds.
 *   2. Re-validate + run. Invoice links are reusable and state moves, so
 *      pre-checkout's answer is not trusted here.
 *   3. Commit the outcome: dispatch + `settled`, or refund + a refunded status.
 *      A refund that fails is parked in `refund_failed` and NOT announced.
 */
async function handleRematchSuccessfulPayment(
  ctx: BotContext,
  payment: {
    invoice_payload: string;
    total_amount: number;
    telegram_payment_charge_id: string;
  },
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return;
  const lang = (user.language ?? "en") as Language;

  const { runRematch, REMATCH_PROCESSING, REMATCH_SETTLED } = await import(
    "../services/rematch.js"
  );
  const { refundRematchPurchase, refundStatusForReason } = await import(
    "../services/rematch-refund.js"
  );

  console.info(
    `[stars] rematch purchase user=${user.id} stars=${payment.total_amount} ` +
      `charge=${payment.telegram_payment_charge_id}`,
  );

  // (1) Durable pre-transaction record. Unique charge id ⇒ exactly-once.
  let purchase: { id: string; externalPaymentId: string; status: string };
  try {
    purchase = await prisma.rematchPurchase.create({
      data: {
        userId: user.id,
        status: REMATCH_PROCESSING,
        externalPaymentId: payment.telegram_payment_charge_id,
        amountStars: payment.total_amount,
        amountCents: null,
      },
      select: { id: true, externalPaymentId: true, status: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.info(
        `[stars] rematch duplicate ignored user=${user.id} ` +
          `charge=${payment.telegram_payment_charge_id}`,
      );
      return;
    }
    throw err;
  }

  // (2) Re-validate + run. Any throw leaves the row `processing`, which the
  // hourly sweep refunds — never a silent loss.
  const run = await runRematch(user.id);

  // (3a) Nothing delivered → refund (D1). This is the ONLY refundable class:
  // a decline or a ghost later on is explicitly not refunded, and the offer copy
  // says so before payment.
  if (!run.ok || !run.matchId) {
    const refunded = await refundRematchPurchase(
      ctx.api,
      purchase,
      telegramId,
      refundStatusForReason(run.reason),
    );
    await ctx
      .reply(t(lang, refunded ? "rematchNoCandidate" : "rematchRefundPending", {}))
      .catch(() => {});
    return;
  }

  // (3b) Delivered. Mark settled BEFORE dispatching: the match already exists,
  // so if dispatch throws we must not let the sweep refund a live pair.
  await prisma.rematchPurchase.update({
    where: { id: purchase.id },
    data: {
      status: REMATCH_SETTLED,
      resolvedAt: new Date(),
      resultMatchId: run.matchId,
      framing: run.framing ?? null,
    },
  });

  await ctx.reply(t(lang, "rematchFound", {})).catch(() => {});

  const { dispatchMatches } = await import("../services/dispatch-queue.js");
  await dispatchMatches(ctx.api, [run.matchId]).catch((err) => {
    // The pair exists and is stamped; the pitch failing to render is a delivery
    // problem, not a payment problem. Surfaced loudly for ops rather than
    // reversed — reversing would strand an already-created live match.
    console.error(`[rematch] dispatch failed match=${run.matchId}:`, err);
  });
}

/**
 * §3.5b date-gate Star payment (payload `gate:<matchId>:<scope>`). Telegram has
 * confirmed the Stars moved, so this settles the ticket slot(s) — the trusted
 * native replacement for the mock confirm route. The gate's own machinery sends
 * the follow-up (calendar unlock / partner-paid surprise re-derived in the Mini
 * App), so no extra DM is needed here. No-op for any non-gate payload.
 */
async function handleGateSuccessfulPayment(
  ctx: BotContext,
  payment: { invoice_payload: string; total_amount: number; telegram_payment_charge_id: string },
): Promise<void> {
  const gate = parseGateInvoicePayload(payment.invoice_payload);
  if (!gate) return; // foreign payload — credit/settle nothing

  const telegramId = BigInt(ctx.from!.id);
  // The charge id is durably recorded before the atomic slot CAS. That makes a
  // redelivered `successful_payment` idempotent, preserves the provider key for
  // expiry refunds, and dedupes any wallet credit for a `both` overpayment.
  console.info(
    `[stars] gate payment user=${telegramId} match=${gate.matchId} scope=${gate.scope} ` +
      `stars=${payment.total_amount} charge=${payment.telegram_payment_charge_id}`,
  );

  // Dynamic import keeps the heavy gate/scheduler graph out of this handler's
  // static module graph (so the store handlers stay unit-testable in isolation).
  const { applyStarsTicketPayment } = await import("./matching/ticket-gate.js");
  const result = await applyStarsTicketPayment(
    ctx.api,
    telegramId,
    gate.matchId,
    gate.scope,
    payment.telegram_payment_charge_id,
  );
  if (!result.ok) {
    console.error(
      `[stars] gate settle failed user=${telegramId} match=${gate.matchId} ` +
        `scope=${gate.scope} reason=${result.reason}`,
    );
  }
}
