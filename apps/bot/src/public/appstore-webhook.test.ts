/**
 * App Store Server Notifications routing — what goes where on a refund.
 *
 * Pinned because a Prime Time refund used to fall through to the ticket
 * ledger, find nothing, and be acknowledged without a trace (R6).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  env: { PREMIUM_APPSTORE_PRODUCT_ID: "premium_monthly", PRIME_TIME_APPSTORE_PRODUCT_ID: "prime_time_pass" },
}));

const {
  getVerifiedTransaction,
  refundAppStoreTransaction,
  refundPrimeTimeAppStoreTransaction,
  refundVenueChangeAppStoreTransaction,
  getSubscriptionAutoRenew,
  syncAppStorePremiumAutoRenew,
  handleAppStorePremiumNotification,
} = vi.hoisted(() => ({
  getVerifiedTransaction: vi.fn(),
  refundAppStoreTransaction: vi.fn(),
  refundPrimeTimeAppStoreTransaction: vi.fn(),
  refundVenueChangeAppStoreTransaction: vi.fn(),
  getSubscriptionAutoRenew: vi.fn(),
  syncAppStorePremiumAutoRenew: vi.fn(),
  handleAppStorePremiumNotification: vi.fn(),
}));
vi.mock("../services/appstore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/appstore.js")>();
  return {
    decodeJwsPayload: actual.decodeJwsPayload,
    isPremiumProduct: actual.isPremiumProduct,
    appStoreConfigured: () => true,
    getVerifiedTransaction: (...a: unknown[]) => getVerifiedTransaction(...a),
    getSubscriptionAutoRenew: (...a: unknown[]) => getSubscriptionAutoRenew(...a),
  };
});

vi.mock("../services/appstore-venue-change.js", () => ({
  isVenueChangeProduct: (id: string | null) => id?.split(".").pop() === "venue_change",
  refundVenueChangeAppStoreTransaction: (...a: unknown[]) =>
    refundVenueChangeAppStoreTransaction(...a),
}));

vi.mock("../services/appstore-tickets.js", () => ({
  refundAppStoreTransaction: (...a: unknown[]) => refundAppStoreTransaction(...a),
}));

vi.mock("../services/appstore-prime-time.js", () => ({
  refundPrimeTimeAppStoreTransaction: (...a: unknown[]) => refundPrimeTimeAppStoreTransaction(...a),
}));

vi.mock("../services/appstore-premium.js", () => ({
  handleAppStorePremiumNotification: (...a: unknown[]) => handleAppStorePremiumNotification(...a),
  syncAppStorePremiumAutoRenew: (...a: unknown[]) => syncAppStorePremiumAutoRenew(...a),
  PREMIUM_RENEW_NOTIFICATIONS: ["DID_RENEW"],
}));

vi.mock("../services/prime-time.js", () => ({
  isPrimeTimeProduct: (id: string | null) => id?.split(".").pop() === "prime_time_pass",
}));

const { appStoreWebhookRouter } = await import("./routes/appstore-webhook.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/webhooks/appstore", appStoreWebhookRouter);
  return app;
}

const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jws = (o: unknown) => `${part({ alg: "ES256" })}.${part(o)}.sig`;

function notification(type: string, productId: string) {
  return {
    signedPayload: jws({
      notificationType: type,
      data: { signedTransactionInfo: jws({ transactionId: "2000000999", productId }) },
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  refundAppStoreTransaction.mockResolvedValue({ status: "no_credit" });
  refundPrimeTimeAppStoreTransaction.mockResolvedValue({ status: "recorded" });
});

describe("POST /v1/webhooks/appstore — refunds", () => {
  it("routes a Prime Time pass refund to its own handler, by Apple's product id", async () => {
    const transaction = { transactionId: "2000000999", productId: "com.gennety.ios.prime_time_pass" };
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction });

    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("REFUND", "com.gennety.ios.prime_time_pass"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, result: "recorded" });
    expect(refundPrimeTimeAppStoreTransaction).toHaveBeenCalledWith(transaction);
    expect(refundAppStoreTransaction).not.toHaveBeenCalled();
  });

  it("still sends a ticket refund to the ticket ledger", async () => {
    const transaction = { transactionId: "2000000999", productId: "ticket_3" };
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction });

    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("REFUND", "ticket_3"));

    expect(res.status).toBe(200);
    expect(refundAppStoreTransaction).toHaveBeenCalledWith(transaction);
    expect(refundPrimeTimeAppStoreTransaction).not.toHaveBeenCalled();
  });

  it("trusts Apple's product id over the notification's own", async () => {
    // The untrusted payload claims a ticket; Apple says it was the pass.
    const transaction = { transactionId: "2000000999", productId: "prime_time_pass" };
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction });

    await request(buildApp()).post("/v1/webhooks/appstore").send(notification("REVOKE", "ticket_1"));

    expect(refundPrimeTimeAppStoreTransaction).toHaveBeenCalled();
    expect(refundAppStoreTransaction).not.toHaveBeenCalled();
  });

  it("routes a venue-change refund to its own handler instead of the ticket ledger", async () => {
    const transaction = { transactionId: "2000000999", productId: "com.gennety.ios.venue_change" };
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction });
    refundVenueChangeAppStoreTransaction.mockResolvedValue({ status: "recorded" });

    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("REFUND", "com.gennety.ios.venue_change"));

    expect(res.body).toEqual({ ok: true, result: "recorded" });
    expect(refundVenueChangeAppStoreTransaction).toHaveBeenCalledWith(transaction);
    expect(refundAppStoreTransaction).not.toHaveBeenCalled();
  });

  it("asks Apple to retry when the lookup is unavailable rather than acking", async () => {
    getVerifiedTransaction.mockResolvedValue({ status: "unavailable" });
    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("REFUND", "ticket_3"));
    expect(res.status).toBe(500);
    expect(refundAppStoreTransaction).not.toHaveBeenCalled();
  });
});

describe("POST /v1/webhooks/appstore — DID_CHANGE_RENEWAL_STATUS", () => {
  const transaction = {
    transactionId: "2000000999",
    originalTransactionId: "1000000111",
    productId: "premium_monthly",
  };

  beforeEach(() => {
    getVerifiedTransaction.mockResolvedValue({ status: "ok", transaction });
    handleAppStorePremiumNotification.mockResolvedValue({ status: "already_processed" });
    syncAppStorePremiumAutoRenew.mockResolvedValue({ status: "updated" });
  });

  it("mirrors Apple's verified autoRenewStatus onto the subscriber", async () => {
    getSubscriptionAutoRenew.mockResolvedValue({ status: "ok", autoRenew: false });

    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("DID_CHANGE_RENEWAL_STATUS", "premium_monthly"));

    expect(res.status).toBe(200);
    expect(getSubscriptionAutoRenew).toHaveBeenCalledWith("1000000111");
    expect(syncAppStorePremiumAutoRenew).toHaveBeenCalledWith(transaction, false);
  });

  it("asks Apple to retry when the renewal info cannot be read", async () => {
    getSubscriptionAutoRenew.mockResolvedValue({ status: "unavailable" });

    const res = await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("DID_CHANGE_RENEWAL_STATUS", "premium_monthly"));

    expect(res.status).toBe(500);
    expect(syncAppStorePremiumAutoRenew).not.toHaveBeenCalled();
  });

  it("leaves autoRenew alone on other premium notifications", async () => {
    await request(buildApp())
      .post("/v1/webhooks/appstore")
      .send(notification("DID_RENEW", "premium_monthly"));
    expect(getSubscriptionAutoRenew).not.toHaveBeenCalled();
  });
});
