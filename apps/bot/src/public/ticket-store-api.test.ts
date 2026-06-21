/**
 * Integration test for the `/v1/tickets/*` ticket store / wallet endpoints,
 * focused on the famine single-ticket discount: `/wallet` exposes the active
 * discount, the "1 ticket" bundle is charged the discounted price and consumes
 * the discount on confirm, and 3/6 bundles are unaffected. Mirrors
 * ticket-api.test.ts — HTTP boundary with the service modules mocked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-store-suite";

vi.mock("../config.js", () => ({ env: { BOT_TOKEN, TICKET_PRICE_CENTS: 699 } }));

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } } }));

const createStoreIntent = vi.fn();
const verifyStorePayment = vi.fn();
vi.mock("../services/ticket-payment.js", () => ({
  createStoreIntent: (...a: unknown[]) => createStoreIntent(...a),
  verifyStorePayment: (...a: unknown[]) => verifyStorePayment(...a),
}));

const grantTickets = vi.fn();
vi.mock("../services/ticket-wallet.js", () => ({ grantTickets: (...a: unknown[]) => grantTickets(...a) }));

const getActiveDiscount = vi.fn();
const consumeActiveDiscount = vi.fn();
vi.mock("../services/ticket-discount.js", () => ({
  getActiveDiscount: (...a: unknown[]) => getActiveDiscount(...a),
  consumeActiveDiscount: (...a: unknown[]) => consumeActiveDiscount(...a),
  // Real math so the discounted amount the route charges is exercised end-to-end.
  discountedCents: (price: number, pct: number) =>
    Math.round((price * (100 - Math.min(100, Math.max(0, pct)))) / 100),
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
  userFindUnique.mockReset();
  createStoreIntent.mockReset();
  verifyStorePayment.mockReset();
  grantTickets.mockReset();
  getActiveDiscount.mockReset();
  consumeActiveDiscount.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", ticketBalance: 2 });
  verifyStorePayment.mockResolvedValue({ ok: true });
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
});

describe("POST /v1/tickets/store/intent", () => {
  it("charges the discounted price for the single bundle", async () => {
    getActiveDiscount.mockResolvedValueOnce({ pct: 77, expiresAt });
    createStoreIntent.mockResolvedValueOnce({ clientSecret: "mock_store_pi_x", amountCents: 161, count: 1, mode: "mock" });
    const res = await request(buildApp())
      .post("/v1/tickets/store/intent")
      .set("Authorization", `tma ${auth()}`)
      .send({ count: 1 });
    expect(res.status).toBe(200);
    expect(createStoreIntent).toHaveBeenCalledWith({ userId: "u1", count: 1, amountCents: 161 });
  });

  it("ignores the discount for the 3-pack", async () => {
    getActiveDiscount.mockResolvedValue({ pct: 77, expiresAt });
    createStoreIntent.mockResolvedValueOnce({ clientSecret: "mock_store_pi_y", amountCents: 1647, count: 3, mode: "mock" });
    await request(buildApp())
      .post("/v1/tickets/store/intent")
      .set("Authorization", `tma ${auth()}`)
      .send({ count: 3 });
    expect(createStoreIntent).toHaveBeenCalledWith({ userId: "u1", count: 3, amountCents: 1647 });
  });
});

describe("POST /v1/tickets/store/confirm", () => {
  it("verifies the discounted amount and consumes the discount on a single buy", async () => {
    // First call (intent path inside confirm) resolves the discount; second is
    // the post-consume re-read returned in the response.
    getActiveDiscount.mockResolvedValueOnce({ pct: 77, expiresAt }).mockResolvedValueOnce(null);
    const res = await request(buildApp())
      .post("/v1/tickets/store/confirm")
      .set("Authorization", `tma ${auth()}`)
      .send({ count: 1, clientSecret: "mock_store_pi_x" });
    expect(res.status).toBe(200);
    expect(verifyStorePayment).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", count: 1, amountCents: 161 }),
    );
    expect(grantTickets).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", count: 1, reason: "store_purchase", amountCents: 161 }),
    );
    expect(consumeActiveDiscount).toHaveBeenCalledWith("u1");
    expect(res.body.discountPct).toBe(0);
  });

  it("does not consume the discount on a 3-pack buy", async () => {
    getActiveDiscount.mockResolvedValue({ pct: 77, expiresAt });
    await request(buildApp())
      .post("/v1/tickets/store/confirm")
      .set("Authorization", `tma ${auth()}`)
      .send({ count: 3, clientSecret: "mock_store_pi_y" });
    expect(verifyStorePayment).toHaveBeenCalledWith(
      expect.objectContaining({ count: 3, amountCents: 1647 }),
    );
    expect(consumeActiveDiscount).not.toHaveBeenCalled();
  });
});
