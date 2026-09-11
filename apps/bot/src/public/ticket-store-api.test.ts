/**
 * Integration test for the `/v1/tickets/*` ticket store / wallet endpoints,
 * focused on the famine single-ticket discount and on where the no-charge
 * settle may exist: `/wallet` exposes the active discount and the rail, the
 * "1 ticket" bundle is recorded at the discounted price and consumes the
 * discount, 3/6 bundles are unaffected, and the settle answers 404 wherever
 * money can move. Mirrors ticket-api.test.ts — HTTP boundary with the service
 * modules mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-store-suite";

vi.mock("../config.js", () => ({ env: { BOT_TOKEN, TICKET_PRICE_CENTS: 849 } }));

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } } }));

/** The rail the route sees; the real function reads the runtime, so it is stubbed. */
let rail: "stars" | "no-charge" | "none" = "no-charge";
vi.mock("../services/ticket-payment.js", () => ({ ticketPurchaseRail: () => rail }));

const grantTickets = vi.fn();
vi.mock("../services/ticket-wallet.js", () => ({ grantTickets: (...a: unknown[]) => grantTickets(...a) }));

const getActiveDiscount = vi.fn();
const consumeActiveDiscount = vi.fn();
vi.mock("../services/ticket-discount.js", () => ({
  getActiveDiscount: (...a: unknown[]) => getActiveDiscount(...a),
  consumeActiveDiscount: (...a: unknown[]) => consumeActiveDiscount(...a),
  // Real math so the discounted amount the route records is exercised end-to-end.
  discountedCents: (price: number, pct: number) =>
    Math.round((price * (100 - Math.min(100, Math.max(0, pct)))) / 100),
}));

const notifyFounderPurchase = vi.fn();
vi.mock("../services/founder-notify.js", () => ({
  notifyFounderPurchase: (...a: unknown[]) => notifyFounderPurchase(...a),
}));

vi.mock("../services/ticket-analytics.js", () => ({ emitTicketEvent: vi.fn() }));

const { createTicketStoreRouter } = await import("./routes/tickets.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/tickets", createTicketStoreRouter());
  return app;
}

function signInitData(botToken: string): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAH_test");
  params.set("user", JSON.stringify({ id: 5986970093, first_name: "Pro", username: "pro" }));
  const dcs = [...params.keys()].sort().map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dcs).digest("hex"));
  return params.toString();
}

const auth = () => signInitData(BOT_TOKEN);
const expiresAt = new Date("2026-07-19T00:00:00.000Z");

beforeEach(() => {
  rail = "no-charge";
  userFindUnique.mockReset();
  grantTickets.mockReset();
  getActiveDiscount.mockReset();
  consumeActiveDiscount.mockReset();
  notifyFounderPurchase.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", ticketBalance: 2 });
  grantTickets.mockResolvedValue(3);
  consumeActiveDiscount.mockResolvedValue({ consumed: true });
});

describe("GET /v1/tickets/wallet", () => {
  it("exposes the active famine discount", async () => {
    getActiveDiscount.mockResolvedValueOnce({ pct: 77, expiresAt });
    const res = await request(buildApp()).get("/v1/tickets/wallet").set("Authorization", `tma ${auth()}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(2);
    expect(res.body.discountPct).toBe(77);
    expect(res.body.discountExpiresAt).toBe(expiresAt.toISOString());
  });

  it("reports no discount when none is active", async () => {
    getActiveDiscount.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get("/v1/tickets/wallet").set("Authorization", `tma ${auth()}`);
    expect(res.body.discountPct).toBe(0);
    expect(res.body.discountExpiresAt).toBeNull();
  });

  it("reports the rail a purchase settles on", async () => {
    getActiveDiscount.mockResolvedValue(null);
    rail = "stars";
    const res = await request(buildApp()).get("/v1/tickets/wallet").set("Authorization", `tma ${auth()}`);
    expect(res.body.rail).toBe("stars");
  });
});

describe("POST /v1/tickets/store/settle-no-charge", () => {
  const settle = (count: unknown) =>
    request(buildApp())
      .post("/v1/tickets/store/settle-no-charge")
      .set("Authorization", `tma ${auth()}`)
      .send({ count });

  it("credits the single bundle at the discounted shelf price and consumes the discount", async () => {
    // First read prices the bundle; the second is the post-consume re-read
    // returned in the response.
    getActiveDiscount.mockResolvedValueOnce({ pct: 77, expiresAt }).mockResolvedValueOnce(null);
    const res = await settle(1);
    expect(res.status).toBe(200);
    expect(grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", count: 1, reason: "store_purchase", amountCents: 195 }),
    );
    expect(consumeActiveDiscount).toHaveBeenCalledWith("u1");
    expect(res.body.balance).toBe(3);
    expect(res.body.discountPct).toBe(0);
    expect(res.body.rail).toBe("no-charge");
    // The founder feed must never read this as a sale.
    expect(notifyFounderPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "no_charge", amountCents: 195 }),
    );
  });

  it("does not consume the discount on a 3-pack", async () => {
    getActiveDiscount.mockResolvedValue({ pct: 77, expiresAt });
    await settle(3);
    expect(grantTickets).toHaveBeenCalledWith(expect.objectContaining({ count: 3, amountCents: 2037 }));
    expect(consumeActiveDiscount).not.toHaveBeenCalled();
  });

  it("does not exist wherever money can move", async () => {
    for (const blocked of ["stars", "none"] as const) {
      rail = blocked;
      const res = await settle(1);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("no-charge-unavailable");
    }
    expect(grantTickets).not.toHaveBeenCalled();
  });

  it("rejects a bundle the shelf does not sell", async () => {
    const res = await settle(4);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown-bundle");
    expect(grantTickets).not.toHaveBeenCalled();
  });
});
