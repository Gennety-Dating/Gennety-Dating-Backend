import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStoreTransaction } from "./appstore.js";

const userFindFirst = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findFirst: userFindFirst } },
}));
vi.mock("../config.js", () => ({
  env: { APPSTORE_BUNDLE_ID: "com.gennety.ios", PREMIUM_APPSTORE_PRODUCT_ID: "premium_monthly" },
}));
const activateOrExtendPremium = vi.fn();
const revokePremium = vi.fn(async () => {});
vi.mock("./premium.js", () => ({ activateOrExtendPremium, revokePremium }));

const { applyAppStorePremium, handleAppStorePremiumNotification } = await import(
  "./appstore-premium.js"
);

const EXPIRES = Date.now() + 30 * 24 * 3600_000;

function tx(over: Partial<AppStoreTransaction> = {}): AppStoreTransaction {
  return {
    transactionId: "tx-1",
    originalTransactionId: "orig-1",
    bundleId: "com.gennety.ios",
    productId: "com.gennety.ios.premium_monthly",
    quantity: 1,
    revocationDate: null,
    expiresDate: EXPIRES,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  activateOrExtendPremium.mockResolvedValue({ applied: true, premiumUntil: new Date(EXPIRES) });
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

  it("revokes a refunded transaction", async () => {
    const res = await applyAppStorePremium("u1", tx({ revocationDate: Date.now() }));
    expect(res.status).toBe("revoked");
    expect(revokePremium).toHaveBeenCalledWith("u1", "appstore:tx-1:refund", "refunded");
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

  it("revokes on EXPIRED", async () => {
    userFindFirst.mockResolvedValueOnce({ id: "u1" });
    const res = await handleAppStorePremiumNotification(tx(), "EXPIRED");
    expect(res.status).toBe("revoked");
    expect(revokePremium).toHaveBeenCalledWith("u1", "appstore:tx-1:expired", "expired");
  });

  it("returns unknown_owner when no user holds the anchor", async () => {
    userFindFirst.mockResolvedValueOnce(null);
    const res = await handleAppStorePremiumNotification(tx(), "DID_RENEW");
    expect(res).toEqual({ status: "invalid", reason: "unknown_owner" });
  });
});
