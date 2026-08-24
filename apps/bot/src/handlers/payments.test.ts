import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn() },
  },
}));
vi.mock("../config.js", () => ({
  env: { TICKET_BUNDLE_STARS: { 1: 350, 3: 830, 6: 1350 }, PREMIUM_STARS: 500 },
}));
vi.mock("../services/ticket-wallet.js", () => ({
  grantTickets: vi.fn(),
  // Real predicate so a `{ code: "P2002" }` rejection is recognised as the
  // duplicate-charge case the handler must swallow.
  isUniqueViolation: (e: unknown) =>
    typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002",
}));
vi.mock("../services/premium.js", () => ({
  activateOrExtendPremium: vi.fn(),
  activatePremiumPackage: vi.fn(),
  formatPremiumUntil: () => "19 August 2026",
}));
// Settled via dynamic import in handleSuccessfulPayment's gate branch.
vi.mock("./matching/ticket-gate.js", () => ({ applyStarsTicketPayment: vi.fn() }));

import { prisma } from "@gennety/db";
import { grantTickets } from "../services/ticket-wallet.js";
import { activateOrExtendPremium, activatePremiumPackage } from "../services/premium.js";
import { applyStarsTicketPayment } from "./matching/ticket-gate.js";
import { handlePreCheckout, handleSuccessfulPayment } from "./payments.js";

const findUnique = prisma.user.findUnique as unknown as ReturnType<typeof vi.fn>;
const matchFindUnique = prisma.match.findUnique as unknown as ReturnType<typeof vi.fn>;
const grant = grantTickets as unknown as ReturnType<typeof vi.fn>;
const activatePremium = activateOrExtendPremium as unknown as ReturnType<typeof vi.fn>;
const activatePackage = activatePremiumPackage as unknown as ReturnType<typeof vi.fn>;
const settleStars = applyStarsTicketPayment as unknown as ReturnType<typeof vi.fn>;

const GATE_UUID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => vi.clearAllMocks());

function preCheckoutCtx(q: {
  invoice_payload: string;
  currency: string;
  total_amount: number;
}) {
  const answerPreCheckoutQuery = vi.fn().mockResolvedValue(true);
  const ctx = {
    preCheckoutQuery: q,
    answerPreCheckoutQuery,
    session: { language: "en" },
  } as unknown as Parameters<typeof handlePreCheckout>[0];
  return { ctx, answerPreCheckoutQuery };
}

function successCtx(payment: {
  invoice_payload: string;
  currency: string;
  total_amount: number;
  telegram_payment_charge_id: string;
}) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    message: { successful_payment: payment },
    from: { id: 111 },
    session: { language: "en" },
    api: {},
    reply,
  } as unknown as Parameters<typeof handleSuccessfulPayment>[0];
  return { ctx, reply };
}

describe("handlePreCheckout", () => {
  it("approves a valid store bundle at the correct Star amount", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "store:3",
      currency: "XTR",
      total_amount: 830,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(true, undefined);
  });

  it("approves without touching ctx.session (chat-less pre_checkout_query)", async () => {
    // Regression: a `pre_checkout_query` has no chat, so grammY's session getter
    // throws on access. The handler runs BEFORE the session middleware and must
    // never read `ctx.session`, or the pre-checkout is never answered and
    // Telegram silently cancels the payment.
    const answerPreCheckoutQuery = vi.fn().mockResolvedValue(true);
    const ctx = {
      preCheckoutQuery: { invoice_payload: "store:1", currency: "XTR", total_amount: 350 },
      answerPreCheckoutQuery,
      get session(): never {
        throw new Error("Cannot access session data: session key is undefined");
      },
    } as unknown as Parameters<typeof handlePreCheckout>[0];
    await expect(handlePreCheckout(ctx)).resolves.toBeUndefined();
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(true, undefined);
  });

  it("declines when the Star amount doesn't match the bundle", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "store:3",
      currency: "XTR",
      total_amount: 999,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(
      false,
      expect.objectContaining({ error_message: expect.any(String) }),
    );
  });

  it("declines a non-XTR currency", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "store:3",
      currency: "USD",
      total_amount: 830,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("declines a foreign / unknown payload", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "ref_whatever",
      currency: "XTR",
      total_amount: 830,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("approves a valid gate payment at the correct Star amount (both = 700) while the gate is open", async () => {
    matchFindUnique.mockResolvedValue({ status: "negotiating", ticketStatus: "pending" });
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: `gate:${GATE_UUID}:both`,
      currency: "XTR",
      total_amount: 700,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(true, undefined);
  });

  it("declines a gate payment whose Star amount doesn't match the scope", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: `gate:${GATE_UUID}:self`,
      currency: "XTR",
      total_amount: 700, // self should be 350
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
    // Amount mismatch is rejected before any DB read.
    expect(matchFindUnique).not.toHaveBeenCalled();
  });

  it("declines a gate payment when the match is no longer negotiating (M1: stale reusable invoice on a cancelled match)", async () => {
    matchFindUnique.mockResolvedValue({ status: "cancelled", ticketStatus: "pending" });
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: `gate:${GATE_UUID}:both`,
      currency: "XTR",
      total_amount: 700,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("declines a gate payment when the gate is already completed", async () => {
    matchFindUnique.mockResolvedValue({ status: "negotiating", ticketStatus: "completed" });
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: `gate:${GATE_UUID}:self`,
      currency: "XTR",
      total_amount: 350,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("declines a gate payment when the match no longer exists", async () => {
    matchFindUnique.mockResolvedValue(null);
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: `gate:${GATE_UUID}:self`,
      currency: "XTR",
      total_amount: 350,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });
});

describe("handleSuccessfulPayment", () => {
  it("credits the wallet and confirms on a valid store payment", async () => {
    findUnique.mockResolvedValue({ id: "u1", language: "en" });
    grant.mockResolvedValue(5);
    const { ctx, reply } = successCtx({
      invoice_payload: "store:3",
      currency: "XTR",
      total_amount: 830,
      telegram_payment_charge_id: "charge_1",
    });

    await handleSuccessfulPayment(ctx);

    expect(grant).toHaveBeenCalledWith({
      userId: "u1",
      count: 3,
      reason: "store_purchase",
      bundleSize: 3,
      // Star prices are env-tunable, so what was actually charged is frozen on
      // the row rather than re-derived from `bundleSize` by a later reader.
      amountStars: 830,
      externalPaymentId: "charge_1",
    });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(String(reply.mock.calls[0]![0])).toContain("5");
  });

  it("is idempotent: a redelivered charge (P2002) credits once and sends no second DM", async () => {
    findUnique.mockResolvedValue({ id: "u1", language: "en" });
    // The unique `externalPaymentId` rolled back the duplicate credit, so
    // grantTickets rejects with Prisma's P2002. The handler must swallow it.
    grant.mockRejectedValue(Object.assign(new Error("Unique constraint failed"), { code: "P2002" }));
    const { ctx, reply } = successCtx({
      invoice_payload: "store:3",
      currency: "XTR",
      total_amount: 830,
      telegram_payment_charge_id: "charge_dup",
    });

    await expect(handleSuccessfulPayment(ctx)).resolves.toBeUndefined();
    expect(grant).toHaveBeenCalledTimes(1);
    expect(reply).not.toHaveBeenCalled();
  });

  it("ignores a payment whose payload isn't one of our bundles", async () => {
    const { ctx, reply } = successCtx({
      invoice_payload: "store:99", // 99 is not a real bundle
      currency: "XTR",
      total_amount: 9999,
      telegram_payment_charge_id: "charge_2",
    });
    await handleSuccessfulPayment(ctx);
    expect(grant).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });

  it("settles the date gate on a valid gate payload (no wallet credit)", async () => {
    settleStars.mockResolvedValue({ ok: true, state: {} });
    const { ctx } = successCtx({
      invoice_payload: `gate:${GATE_UUID}:both`,
      currency: "XTR",
      total_amount: 700,
      telegram_payment_charge_id: "charge_g",
    });
    await handleSuccessfulPayment(ctx);
    // The charge id rides along so the gate can return an overpaid `both` slot
    // (she settled hers first) as a wallet ticket, exactly once.
    expect(settleStars).toHaveBeenCalledWith(ctx.api, 111n, GATE_UUID, "both", "charge_g");
    expect(grant).not.toHaveBeenCalled();
  });

  it("ignores a foreign payload (neither store nor gate)", async () => {
    const { ctx } = successCtx({
      invoice_payload: "ref_whatever",
      currency: "XTR",
      total_amount: 100,
      telegram_payment_charge_id: "charge_x",
    });
    await handleSuccessfulPayment(ctx);
    expect(settleStars).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
});

describe("premium subscription (sub:premium)", () => {
  it("approves a pre-checkout at the correct Star amount", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 500,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(true, undefined);
  });

  it("declines a pre-checkout at the wrong Star amount", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 350,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("grants premium and DMs the welcome on the first charge", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePremium.mockResolvedValueOnce({ applied: true, premiumUntil: new Date() });
    const { ctx, reply } = successCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 500,
      telegram_payment_charge_id: "charge_sub_1",
    });
    (ctx.message!.successful_payment as unknown as Record<string, unknown>).is_first_recurring = true;
    (ctx.message!.successful_payment as unknown as Record<string, unknown>).subscription_expiration_date =
      Math.floor(Date.now() / 1000) + 2_592_000;
    await handleSuccessfulPayment(ctx);
    expect(activatePremium).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        provider: "telegram_stars",
        externalPaymentId: "charge_sub_1",
        event: "started",
      }),
    );
    expect(reply).toHaveBeenCalled();
  });

  it("extends silently on an auto-renewal (no DM)", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePremium.mockResolvedValueOnce({ applied: true, premiumUntil: new Date() });
    const { ctx, reply } = successCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 500,
      telegram_payment_charge_id: "charge_sub_2",
    });
    (ctx.message!.successful_payment as unknown as Record<string, unknown>).is_recurring = true;
    (ctx.message!.successful_payment as unknown as Record<string, unknown>).is_first_recurring = false;
    await handleSuccessfulPayment(ctx);
    expect(activatePremium).toHaveBeenCalledWith(expect.objectContaining({ event: "renewed" }));
    expect(reply).not.toHaveBeenCalled();
  });

  it("does not re-DM on a duplicate redelivery (applied: false)", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePremium.mockResolvedValueOnce({ applied: false, premiumUntil: new Date() });
    const { ctx, reply } = successCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 500,
      telegram_payment_charge_id: "charge_sub_1",
    });
    (ctx.message!.successful_payment as unknown as Record<string, unknown>).is_first_recurring = true;
    await handleSuccessfulPayment(ctx);
    expect(reply).not.toHaveBeenCalled();
  });
});


describe("premium packages (sub:premium3 / sub:premium6)", () => {
  // PREMIUM_STARS is mocked at 500 above, so: 3mo = floor(500×3×0.85) = 1275,
  // 6mo = floor(500×6×0.70) = 2100. Derived here exactly as the handler derives
  // it — a hardcoded expectation would still pass if the handler stopped
  // pricing by plan and started comparing against the monthly price.
  it("approves a pre-checkout at the plan's derived price", async () => {
    for (const [payload, stars] of [
      ["sub:premium3", 1275],
      ["sub:premium6", 2100],
    ] as const) {
      const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
        invoice_payload: payload,
        currency: "XTR",
        total_amount: stars,
      });
      await handlePreCheckout(ctx);
      expect(answerPreCheckoutQuery).toHaveBeenCalledWith(true, undefined);
    }
  });

  it("declines a package invoice carrying the MONTHLY price", async () => {
    // The failure a single shared amount check would let through: a stale link,
    // or a hand-edited one, buying six months for one month's Stars.
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "sub:premium6",
      currency: "XTR",
      total_amount: 500,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("declines an unknown product tag outright", async () => {
    const { ctx, answerPreCheckoutQuery } = preCheckoutCtx({
      invoice_payload: "sub:premium12",
      currency: "XTR",
      total_amount: 2100,
    });
    await handlePreCheckout(ctx);
    expect(answerPreCheckoutQuery).toHaveBeenCalledWith(false, expect.anything());
  });

  it("grants the package additively and always DMs", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePackage.mockResolvedValueOnce({ applied: true, premiumUntil: new Date() });
    const { ctx, reply } = successCtx({
      invoice_payload: "sub:premium6",
      currency: "XTR",
      total_amount: 2100,
      telegram_payment_charge_id: "charge_pkg_6",
    });
    await handleSuccessfulPayment(ctx);

    expect(activatePackage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        months: 6,
        externalPaymentId: "charge_pkg_6",
        amount: 2100,
        currency: "XTR",
      }),
    );
    // A package has no silent renewals to suppress: every charge is a first
    // period, so the user is always told how long they just bought.
    expect(reply).toHaveBeenCalled();
    // And it must NEVER take the subscription path, which would read a
    // `subscription_expiration_date` that a one-time invoice does not carry.
    expect(activatePremium).not.toHaveBeenCalled();
  });

  it("does not re-DM on a redelivered package charge", async () => {
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePackage.mockResolvedValueOnce({ applied: false, premiumUntil: new Date() });
    const { ctx, reply } = successCtx({
      invoice_payload: "sub:premium3",
      currency: "XTR",
      total_amount: 1275,
      telegram_payment_charge_id: "charge_pkg_dup",
    });
    await handleSuccessfulPayment(ctx);
    expect(reply).not.toHaveBeenCalled();
  });

  it("keeps `sub:premium` on the RECURRING path", async () => {
    // The wire tag every existing subscriber's auto-renewal redelivers. If it
    // ever routed to the package handler, each renewal would grant a fresh
    // month additively AND stop claiming the recurring head.
    findUnique.mockResolvedValueOnce({ id: "u1", language: "en" });
    activatePremium.mockResolvedValueOnce({ applied: true, premiumUntil: new Date() });
    const { ctx } = successCtx({
      invoice_payload: "sub:premium",
      currency: "XTR",
      total_amount: 500,
      telegram_payment_charge_id: "charge_monthly",
    });
    await handleSuccessfulPayment(ctx);
    expect(activatePremium).toHaveBeenCalled();
    expect(activatePackage).not.toHaveBeenCalled();
  });
});
