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
  premiumPlanById,
  premiumPlanStars,
  PREMIUM_SUBSCRIPTION_PERIOD_SECONDS,
  type PremiumPlan,
} from "@gennety/shared";
import { env } from "../config.js";
import { grantTickets, isUniqueViolation } from "../services/ticket-wallet.js";
import { gateStarsForScope } from "../services/ticket-payment.js";
import { recordChatEventForChat } from "../services/chat-events.js";
import {
  activateOrExtendPremium,
  activatePremiumPackage,
  formatPremiumUntil,
} from "../services/premium.js";
import { notifyFounderPurchase } from "../services/founder-notify.js";
import { runStatusSequence, NEVER_CUT_SHORT } from "../services/ai-stream.js";
import { rematchSearchSteps } from "../services/analysis-status.js";

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
    // Premium — payload `sub:premium` (recurring monthly) or `sub:premium3` /
    // `sub:premium6` (one-time packages). The amount is the only thing to
    // re-validate here: there is no per-user state to check, since a package
    // stacks onto whatever the user already has and the recurring charge is
    // anchored by the subscription itself.
    //
    // The expected amount is DERIVED from the plan rather than compared against
    // a stored price, so a link minted before a repricing is declined here
    // instead of settling months at yesterday's rate — the same reason the gate
    // and venue branches re-derive theirs.
    const plan = premiumPlanById(sub.plan);
    ok =
      plan != null &&
      query.currency === "XTR" &&
      query.total_amount === premiumPlanStars(plan, env.PREMIUM_STARS);
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

  // Chat timeline. Recorded here rather than by the inbound middleware because
  // this handler is registered ahead of it (Telegram's 10s pre-checkout window)
  // and terminates the update. Money moving is exactly the kind of thing a user
  // asks a follow-up question about.
  if (ctx.chat?.id !== undefined && ctx.chat.id > 0) {
    void recordChatEventForChat(ctx.chat.id, {
      direction: "in",
      kind: "payment",
      summary: `paid ${payment.total_amount} Telegram Stars (${payment.invoice_payload})`,
    });
  }

  const count = parseStoreInvoicePayload(payment.invoice_payload);
  if (count == null || ticketBundleFor(count) == null) {
    // Not a store bundle — try §Premium subscription, then the §3.7b venue
    // change, then the §3.5b date gate, before giving up so a foreign payload
    // still credits nothing.
    const sub = parseSubInvoicePayload(payment.invoice_payload);
    if (sub != null) {
      const plan = premiumPlanById(sub.plan);
      // An unknown plan cannot be priced or granted; leave it unsettled rather
      // than guessing a length. `parseSubInvoicePayload` already refuses foreign
      // tags, so this only fires if the catalog and the payload map diverge.
      if (!plan) return;
      if (plan.recurring) await handlePremiumSuccessfulPayment(ctx, payment);
      else await handlePremiumPackagePayment(ctx, plan, payment);
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
      amountStars: payment.total_amount,
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

  // Founder ops feed. Fired after the exactly-once credit landed, so the
  // duplicate return above means a redelivery never re-announces the sale.
  void notifyFounderPurchase({
    userId: user.id,
    kind: "tickets",
    provider: "telegram_stars",
    amountStars: payment.total_amount,
    detail: `${count} ticket${count === 1 ? "" : "s"} · баланс ${balance}`,
    externalPaymentId: payment.telegram_payment_charge_id,
  });

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
 * §3.8 Premium PACKAGE Star payment (payload `sub:premium3` / `sub:premium6`).
 *
 * A one-time purchase of a fixed block of months. Three things separate it from
 * the recurring branch above, and each one is a place the obvious code is wrong:
 *
 *  1. **There is no `subscription_expiration_date`.** Telegram only sends that
 *     for a subscription invoice, so the period end cannot be read off the
 *     payment — it is computed from the plan's month count, stacked onto
 *     whatever the user already has (`activatePremiumPackage`).
 *  2. **It must not claim the recurring head.** Writing `premiumAutoRenew`,
 *     `premiumProvider` or `premiumExternalId` here would either invent a
 *     renewal that Telegram will never make, or overwrite a live monthly
 *     subscriber's cancellation anchor with a charge id that cannot cancel
 *     anything.
 *  3. **Every charge is a first period.** There are no silent renewals to
 *     suppress, so unlike the monthly branch this always DMs — the whole point
 *     of a fixed block is that the user knows how long they bought.
 *
 * Exactly-once is the shared `SubscriptionLedger.externalPaymentId`: a
 * redelivered `successful_payment` returns `applied: false` and neither grants
 * months again nor re-DMs.
 */
async function handlePremiumPackagePayment(
  ctx: BotContext,
  plan: PremiumPlan,
  payment: { total_amount: number; telegram_payment_charge_id: string },
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return;

  console.info(
    `[stars] premium package user=${user.id} plan=${plan.id} months=${plan.months} ` +
      `stars=${payment.total_amount} charge=${payment.telegram_payment_charge_id}`,
  );

  const result = await activatePremiumPackage({
    userId: user.id,
    months: plan.months,
    externalPaymentId: payment.telegram_payment_charge_id,
    provider: "telegram_stars",
    amount: payment.total_amount,
    currency: "XTR",
    detail: `пакет ${plan.months} мес.`,
  });
  // Duplicate redelivery, or an unknown user — nothing to announce.
  if (!result.applied) return;

  const lang = (user.language ?? "en") as Language;
  const text = t(lang, "premiumPackageWelcomeDm", {
    months: plan.months,
    date: formatPremiumUntil(result.premiumUntil, lang),
  });
  try {
    await ctx.reply(text, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply(text.replace(/[*_`[\]]/g, "")).catch(() => {});
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

  const {
    runRematch,
    REMATCH_PROCESSING,
    REMATCH_SETTLED,
    REMATCH_REFUNDED_UNDELIVERED,
  } = await import("../services/rematch.js");
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

  // Founder ops feed. Announced here — after the durable pre-transaction row,
  // before the engine runs — because THIS is the moment money moved. A run
  // that delivers nothing is refunded below and announced as a refund, so the
  // feed never silently carries a sale that came back.
  void notifyFounderPurchase({
    userId: user.id,
    kind: "rematch",
    provider: "telegram_stars",
    amountStars: payment.total_amount,
    externalPaymentId: payment.telegram_payment_charge_id,
  });

  // (2) Re-validate + run, covered by the §3.11 search animation.
  //
  // The engine starts FIRST and the shimmer is laid over it, so the ten seconds
  // are spent on work rather than in front of it.
  //
  // `NEVER_CUT_SHORT` is what makes the ten-second floor hold in the COMMON
  // case, not the rare one: `runRematch` usually answers in a second or two, and
  // the default `until` behaviour would then cut the script to half of its first
  // beat — the exact "status looks broken" failure that flag was introduced for.
  // With it, `until` may only ever hold the LAST beat longer.
  //
  // The animation deliberately does NOT extend over `dispatchMatches` below.
  // The pitch carries its own rich compose stream (§3.3), so covering it too
  // would put two drafts in one chat competing for the same space, and the
  // pitch's own arrival would collapse ours instead of tearing it down cleanly.
  const runPromise = runRematch(user.id);
  // Mark handled so a rejection mid-animation is not an unhandledRejection. The
  // real throw is re-raised at the await below, where the existing contract
  // holds unchanged: the row stays `processing` and the hourly sweep refunds it.
  runPromise.catch(() => {});

  // A decorative status may never cost a paid match, so this swallows its own
  // failures — same rule the venue-change banner push follows at its call site.
  await runStatusSequence(ctx.api, Number(telegramId), rematchSearchSteps(lang), {
    rich: true,
    until: runPromise,
    untilFromStepIndex: NEVER_CUT_SHORT,
  }).catch((err) => {
    console.warn("[rematch] search status failed:", err);
  });

  const run = await runPromise;

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

  // The payoff at the end of the search animation, and the only celebratory
  // beat this flow has. The effect ships inert (empty env) — see config.ts for
  // why it is here and not on the offer card that asks for the money.
  const foundEffectId = env.MESSAGE_EFFECT_REMATCH_ID;
  await ctx
    .reply(
      t(lang, "rematchFound", {}),
      foundEffectId ? { message_effect_id: foundEffectId } : {},
    )
    .catch(() => {});

  const { dispatchMatches } = await import("../services/dispatch-queue.js");
  const delivery = await dispatchMatches(ctx.api, [run.matchId]).catch((err) => {
    // The queue itself threw, so we do not know what was delivered. Leave the
    // purchase `settled` and surface it for ops: refunding on an unknown
    // outcome could reverse a pitch the partner is looking at right now.
    console.error(`[rematch] dispatch failed match=${run.matchId}:`, err);
    return null;
  });

  // (3c) Delivered to NOBODY → refund (§3.11, founder decision 2026-08-21).
  //
  // A pitch that reached one side is a delivered pitch and is never refunded —
  // a decline or a ghost after that is explicitly his risk, and the offer copy
  // says so. This branch is the opposite case: he paid for an introduction that
  // was never shown to anyone, so the thing he bought did not happen. That is a
  // stronger claim than "the engine found nobody", which already refunds.
  //
  // `disposeUndeliveredMatch` has already retired the pair, so the slot is free
  // and the refund also frees his weekly cap (it counts `settled` rows only).
  // What he does NOT get back is the candidate: the lifetime pair ban (§3.2
  // filter 6) is written at creation, so she is spent for him even unseen —
  // which is the argument for returning the Stars rather than only the slot.
  if (delivery?.undelivered.includes(run.matchId)) {
    console.error(
      `[rematch] pitch reached nobody match=${run.matchId} purchase=${purchase.id} — refunding`,
    );
    const refunded = await refundRematchPurchase(
      ctx.api,
      // The row is `settled` by now; the refund helper is status-agnostic on
      // input and a failure parks it in `refund_failed`, which the hourly sweep
      // already retries.
      { ...purchase, status: REMATCH_SETTLED },
      telegramId,
      REMATCH_REFUNDED_UNDELIVERED,
    );
    await ctx
      .reply(
        t(lang, refunded ? "rematchUndelivered" : "rematchUndeliveredPending", {}),
      )
      .catch(() => {});
  }
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
