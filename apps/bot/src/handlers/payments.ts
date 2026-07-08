import type { BotContext } from "../session.js";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  parseStoreInvoicePayload,
  parseGateInvoicePayload,
  ticketBundleFor,
} from "@gennety/shared";
import { env } from "../config.js";
import { grantTickets, isUniqueViolation } from "../services/ticket-wallet.js";
import { gateStarsForScope } from "../services/ticket-payment.js";

/**
 * Telegram Stars (XTR) payment handlers.
 *
 * Two Star surfaces share these trusted handlers, distinguished by the invoice
 * payload that survives the round-trip:
 *   • `store:<count>` — ticket-store top-up; credits the wallet.
 *   • `gate:<matchId>:<scope>` — §3.5b date-gate direct pay; settles ticket
 *     slot(s) on the match (the native replacement for the mock USD pay path).
 *
 * Telegram drives two trusted updates for each:
 *   • `pre_checkout_query` — re-validate the payload + Star amount and approve
 *     within Telegram's 10s window (`handlePreCheckout`).
 *   • `message:successful_payment` — Telegram's confirmation that Stars moved;
 *     THIS is the trust boundary that credits/settles (`handleSuccessfulPayment`).
 *
 * Registered at the top of the router so they fire regardless of onboarding step.
 */

/** Approve/decline a pre-checkout for a ticket Star purchase (store or gate). */
export async function handlePreCheckout(ctx: BotContext): Promise<void> {
  const query = ctx.preCheckoutQuery;
  if (!query) return;

  let ok = false;
  // Store top-up — payload `store:<count>`.
  const count = parseStoreInvoicePayload(query.invoice_payload);
  if (count != null) {
    const expectedStars = env.TICKET_BUNDLE_STARS[count];
    ok =
      ticketBundleFor(count) != null &&
      expectedStars != null &&
      query.currency === "XTR" &&
      query.total_amount === expectedStars;
  } else {
    // Date gate — payload `gate:<matchId>:<scope>`. The participant + male-only
    // checks were enforced at invoice creation and re-enforced at settle time;
    // here we only confirm the payload shape + Star amount match.
    const gate = parseGateInvoicePayload(query.invoice_payload);
    if (gate != null) {
      const expectedStars = gateStarsForScope(gate.scope);
      ok =
        expectedStars > 0 &&
        query.currency === "XTR" &&
        query.total_amount === expectedStars;
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
    // Not a store bundle — try the §3.5b date gate before giving up so a foreign
    // payload still credits nothing.
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
  // The gate is settled by an atomic CAS on the still-null `ticketPaid*` slot
  // (see `settleTicket`), so a redelivered `successful_payment` is already a
  // no-op — no charge-id dedupe column is needed here (unlike the store top-up,
  // which credits a counter and therefore uses `TicketLedger.externalPaymentId`).
  // Log the charge id for manual reconciliation.
  console.info(
    `[stars] gate payment user=${telegramId} match=${gate.matchId} scope=${gate.scope} ` +
      `stars=${payment.total_amount} charge=${payment.telegram_payment_charge_id}`,
  );

  // Dynamic import keeps the heavy gate/scheduler graph out of this handler's
  // static module graph (so the store handlers stay unit-testable in isolation).
  const { applyStarsTicketPayment } = await import("./matching/ticket-gate.js");
  const result = await applyStarsTicketPayment(ctx.api, telegramId, gate.matchId, gate.scope);
  if (!result.ok) {
    console.error(
      `[stars] gate settle failed user=${telegramId} match=${gate.matchId} ` +
        `scope=${gate.scope} reason=${result.reason}`,
    );
  }
}
