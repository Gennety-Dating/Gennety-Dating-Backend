import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  env: {
    TICKET_PAYMENT_MODE: "mock",
  },
}));

const {
  createStoreIntent,
  createTicketIntent,
  resetMockPaymentIntentsForTests,
  verifyStorePayment,
  verifyTicketPayment,
} = await import("./ticket-payment.js");

beforeEach(() => {
  resetMockPaymentIntentsForTests();
});

describe("mock ticket payment intents", () => {
  it("binds a date intent to its payer, match, scope, and amount and consumes it once", async () => {
    const intent = await createTicketIntent({
      payerId: "user-1",
      matchId: "match-1",
      scope: "self",
      amountCents: 699,
    });

    await expect(
      verifyTicketPayment({
        clientSecret: intent.clientSecret,
        payerId: "user-2",
        matchId: "match-1",
        scope: "self",
        amountCents: 699,
      }),
    ).resolves.toEqual({ ok: false });

    await expect(
      verifyTicketPayment({
        clientSecret: intent.clientSecret,
        payerId: "user-1",
        matchId: "match-1",
        scope: "self",
        amountCents: 699,
      }),
    ).resolves.toEqual({ ok: true });

    await expect(
      verifyTicketPayment({
        clientSecret: intent.clientSecret,
        payerId: "user-1",
        matchId: "match-1",
        scope: "self",
        amountCents: 699,
      }),
    ).resolves.toEqual({ ok: false });
  });

  it("rejects forged and replayed store confirmations", async () => {
    await expect(
      verifyStorePayment({
        clientSecret: "mock_store_pi_forged",
        userId: "user-1",
        count: 5,
        amountCents: 2499,
      }),
    ).resolves.toEqual({ ok: false });

    const intent = await createStoreIntent({
      userId: "user-1",
      count: 5,
      amountCents: 2499,
    });

    await expect(
      verifyStorePayment({
        clientSecret: intent.clientSecret,
        userId: "user-1",
        count: 5,
        amountCents: 2499,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyStorePayment({
        clientSecret: intent.clientSecret,
        userId: "user-1",
        count: 5,
        amountCents: 2499,
      }),
    ).resolves.toEqual({ ok: false });
  });
});
