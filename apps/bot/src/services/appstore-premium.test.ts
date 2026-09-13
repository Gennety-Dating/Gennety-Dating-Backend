import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreTransaction } from "./appstore.js";

const userFindFirst = vi.fn();
const ledgerFindFirst = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findFirst: userFindFirst },
    subscriptionLedger: { findFirst: ledgerFindFirst },
  },
}));
vi.mock("../config.js", () => ({
  env: { APPSTORE_BUNDLE_ID: "com.gennety.ios", PREMIUM_APPSTORE_PRODUCT_ID: "premium_monthly" },
}));
const activateOrExtendPremium = vi.fn();
const revokePremium = vi.fn(async () => {});
const recordPremiumLapse = vi.fn(async () => {});
vi.mock("./premium.js", () => ({ activateOrExtendPremium, revokePremium, recordPremiumLapse }));

const { applyAppStorePremium, handleAppStorePremiumNotification } = await import(
  "./appstore-premium.js"
);

const EXPIRES = Date.now() + 30 * 24 * 3600_000;
const PURCHASED = Date.now() - 24 * 3600_000;

function tx(over: Partial<AppStoreTransaction> = {}): AppStoreTransaction {
  return {
    transactionId: "tx-1",
    originalTransactionId: "orig-1",
    bundleId: "com.gennety.ios",
    productId: "com.gennety.ios.premium_monthly",
    quantity: 1,
    revocationDate: null,
    expiresDate: EXPIRES,
    purchaseDate: PURCHASED,
    environment: "Production",
    priceCents: 999,
    currency: "USD",
    appAccountToken: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activateOrExtendPremium.mockResolvedValue({ applied: true, premiumUntil: new Date(EXPIRES) });
  ledgerFindFirst.mockResolvedValue(null);
});

describe("applyAppStorePremium", () => {
  it("activates a valid premium subscription transaction", async () => {
    const res = await applyAppStorePremium("u1", tx());
    expect(res.status).toBe("activated");
    expect(activateOrExtendPremium).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        provider: "app_store",
        externalPaymentId: "appstore:tx-1",
        recurringAnchor: "orig-1",
      }),
    );
  });

  it("rejects a wrong bundle", async () => {
    const res = await applyAppStorePremium("u1", tx({ bundleId: "com.evil.app" }));
    expect(res).toEqual({ status: "invalid", reason: "wrong_bundle" });
  });

  it("rejects a non-premium product", async () => {
    const res = await applyAppStorePremium("u1", tx({ productId: "com.gennety.ios.ticket_3" }));
    expect(res).toEqual({ status: "invalid", reason: "not_premium" });
  });

  it("revokes a refunded transaction — only that transaction's period", async () => {
    const res = await applyAppStorePremium("u1", tx({ revocationDate: Date.now() }));
    expect(res.status).toBe("revoked");
    expect(revokePremium).toHaveBeenCalledWith({
      userId: "u1",
      externalPaymentId: "appstore:tx-1:refund",
      provider: "app_store",
      refunded: { start: new Date(PURCHASED), end: new Date(EXPIRES) },
    });
  });

  // A13-M2: App Review buys in the sandbox against the production server, so
  // the purchase is honoured — and labelled, so it is never counted as revenue.
  it("honours a sandbox purchase and labels it", async () => {
    const res = await applyAppStorePremium("u1", tx({ environment: "Sandbox" }));
    expect(res.status).toBe("activated");
    expect(activateOrExtendPremium).toHaveBeenCalledWith(
      expect.objectContaining({ note: "appstore-sandbox", sandbox: true }),
    );
  });

  it("carries no sandbox label on a production purchase", async () => {
    await applyAppStorePremium("u1", tx());
    const arg = activateOrExtendPremium.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("note");
    expect(arg).not.toHaveProperty("sandbox");
  });

  it("rejects a subscription with no expiry", async () => {
    const res = await applyAppStorePremium("u1", tx({ expiresDate: null }));
    expect(res).toEqual({ status: "invalid", reason: "no_expiry" });
  });

  it("reports already-processed on a duplicate", async () => {
    activateOrExtendPremium.mockResolvedValueOnce({ applied: false, premiumUntil: new Date(EXPIRES) });
    const res = await applyAppStorePremium("u1", tx());
    expect(res.status).toBe("already_processed");
  });
});

describe("handleAppStorePremiumNotification", () => {
  it("extends on DID_RENEW for a known owner", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    const res = await handleAppStorePremiumNotification(tx(), "DID_RENEW");
    expect(res.status).toBe("activated");
    expect(userFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { premiumExternalId: "orig-1" } }),
    );
  });

  // Apple sends EXPIRED once the paid-through instant has passed, so the
  // fixture carries a lapsed `expiresDate` — the authoritative fact the verdict
  // is read from.
  //
  // A13-H2: a lapse used to call `revokePremium`, which wrote
  // `premiumUntil: null` and wiped every stacked Stars package and referral /
  // promo month along with the lapsed subscription. It now only records the
  // lapse (auto-renew off); the dates are left alone.
  it("records a lapse on EXPIRED without revoking anything", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    const res = await handleAppStorePremiumNotification(
      tx({ expiresDate: Date.now() - 1000 }),
      "EXPIRED",
    );
    expect(res.status).toBe("lapsed");
    expect(revokePremium).not.toHaveBeenCalled();
    expect(recordPremiumLapse).toHaveBeenCalledWith("u1", "appstore:tx-1:expired", "app_store");
  });

  it("ignores a lapse of a period Apple has already renewed past", async () => {
    // A redelivered notification for an older transaction of a live
    // subscription must not switch its renewal off.
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    ledgerFindFirst.mockResolvedValueOnce({ id: "newer-period" });
    const res = await handleAppStorePremiumNotification(
      tx({ expiresDate: Date.now() - 1000 }),
      "EXPIRED",
    );
    expect(res.status).toBe("already_processed");
    expect(recordPremiumLapse).not.toHaveBeenCalled();
  });

  it("returns unknown_owner when no user holds the anchor", async () => {
    userFindFirst.mockResolvedValueOnce(null);
    const res = await handleAppStorePremiumNotification(tx(), "DID_RENEW");
    expect(res).toEqual({ status: "invalid", reason: "unknown_owner" });
  });

  /**
   * The webhook is unauthenticated and its `signedPayload` signature is not
   * verified, so `notificationType` is attacker-controlled: anyone who can name
   * a transaction id can post `EXPIRED` for it. The entitlement verdict must
   * therefore come from the transaction Apple returned, never from the type
   * string that asked for the lookup — otherwise a forged notification ends a
   * subscription that Apple says is live and paid through.
   */
  it("ignores a forged end-notification for a transaction Apple reports as live", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    const res = await handleAppStorePremiumNotification(tx(), "EXPIRED");
    expect(revokePremium).not.toHaveBeenCalled();
    expect(res.status).toBe("activated");
  });

  it("still revokes when Apple itself reports the purchase revoked", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    const revokedAt = Date.now() - 1000;
    const res = await handleAppStorePremiumNotification(
      tx({ revocationDate: revokedAt }),
      "REFUND",
    );
    expect(res.status).toBe("revoked");
    expect(revokePremium).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", externalPaymentId: "appstore:tx-1:refund" }),
    );
  });
});
