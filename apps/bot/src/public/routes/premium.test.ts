import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const userFindUnique = vi.fn();
const createInvoiceLink = vi.fn();
const getPremiumState = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => userFindUnique(...a) } },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "123456:test",
    PREMIUM_FEATURE_ENABLED: true,
    PREMIUM_STARS: 750,
    PREMIUM_PRICE_USD_DISPLAY: "$17.99",
    REFERRAL_FEATURE_ENABLED: false,
  },
}));

vi.mock("../init-data.js", () => ({
  validateInitData: () => ({ valid: true, user: { id: 4242 } }),
}));

vi.mock("../server.js", () => ({ getBotApi: () => ({ createInvoiceLink }) }));

const demoMode = vi.hoisted(() => ({ on: false }));
vi.mock("../../demo/config.js", () => ({
  get DEMO_MODE_ENABLED() {
    return demoMode.on;
  },
}));

vi.mock("../../services/premium.js", () => ({
  getPremiumState: (...a: unknown[]) => getPremiumState(...a),
}));

const { createPremiumRouter } = await import("./premium.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/premium", createPremiumRouter());
  return app;
}

const AUTH = ["authorization", "tma query_id=x&user=%7B%22id%22%3A4242%7D"] as const;

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ id: USER_ID, language: "en" });
  getPremiumState.mockResolvedValue({
    active: false,
    premiumUntil: null,
    premiumSince: null,
    provider: null,
    autoRenew: false,
  });
  createInvoiceLink.mockResolvedValue("https://t.me/invoice/abc");
  demoMode.on = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /v1/premium/state", () => {
  it("serves the whole catalog, priced server-side", async () => {
    const res = await request(buildApp()).get("/v1/premium/state").set(...AUTH);

    expect(res.status).toBe(200);
    expect(res.body.plans).toEqual([
      expect.objectContaining({ id: "monthly", months: 1, stars: 750, discountPct: 0 }),
      expect.objectContaining({ id: "months3", months: 3, stars: 1912, discountPct: 15 }),
      expect.objectContaining({ id: "months6", months: 6, stars: 3150, discountPct: 30 }),
    ]);
  });

  it("tells the client which plan renews itself", async () => {
    // The Mini App prints "one payment · no auto-renewal" off this, and that
    // sentence is the single thing a buyer must not be wrong about.
    const res = await request(buildApp()).get("/v1/premium/state").set(...AUTH);
    expect(res.body.plans.map((p: { recurring: boolean }) => p.recurring)).toEqual([
      true,
      false,
      false,
    ]);
  });

  it("keeps the pre-existing monthly fields for older bundles", async () => {
    // A cached client that knows nothing about `plans` must still render.
    const res = await request(buildApp()).get("/v1/premium/state").set(...AUTH);
    expect(res.body).toMatchObject({ priceStars: 750, priceDisplay: "$17.99" });
  });
});

describe("POST /v1/premium/stars-invoice", () => {
  it("mints the monthly plan as a RECURRING subscription", async () => {
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "monthly" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stars: 750, plan: "monthly" });
    const [, , payload, , currency, prices, options] = createInvoiceLink.mock.calls[0];
    expect(payload).toBe("sub:premium");
    expect(currency).toBe("XTR");
    expect(prices[0].amount).toBe(750);
    expect(options).toMatchObject({ subscription_period: 2_592_000 });
  });

  it("mints a package as a ONE-TIME invoice — no subscription_period", async () => {
    // Not an omission: Telegram has no 90/180-day period, so a package cannot
    // be a native renewing subscription at all. Asking for one here would make
    // Telegram bill 6 months every 30 days.
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "months6" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stars: 3150, plan: "months6" });
    const [, , payload, , , prices, options] = createInvoiceLink.mock.calls[0];
    expect(payload).toBe("sub:premium6");
    expect(prices[0].amount).toBe(3150);
    expect(options).not.toHaveProperty("subscription_period");
  });

  it("prices the 3-month package at the discounted rate", async () => {
    await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "months3" });
    expect(createInvoiceLink.mock.calls[0][5][0].amount).toBe(1912);
  });

  it("falls back to monthly when a client sends no plan", async () => {
    // An older bundle only ever meant the subscription; failing it would break
    // purchases for every cached client on the day this ships.
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({});
    expect(res.status).toBe(200);
    expect(createInvoiceLink.mock.calls[0][2]).toBe("sub:premium");
  });

  it("refuses an unknown plan rather than guessing a period", async () => {
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "months12" });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "unknown-plan" });
    expect(createInvoiceLink).not.toHaveBeenCalled();
  });

  it("still 401s without initData", async () => {
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .send({ plan: "months6" });
    expect(res.status).toBe(401);
  });
});

describe("demo mode", () => {
  // The demo has no mock rail for Stars, and this route has never consulted
  // `TICKET_STARS_ENABLED`, so a tap here mints a REAL invoice for a REAL
  // charge. The packages stay out so one accidental tap cannot cost a visitor
  // ~$75 instead of ~$18.
  it("offers the monthly plan only", async () => {
    demoMode.on = true;
    const res = await request(buildApp()).get("/v1/premium/state").set(...AUTH);
    expect(res.body.plans.map((p: { id: string }) => p.id)).toEqual(["monthly"]);
  });

  it("REFUSES a package invoice, not merely hides it", async () => {
    // The catalog is the client's list, not the boundary: a cached bundle (or a
    // hand-made request) still knows the package ids.
    demoMode.on = true;
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "months6" });

    expect(res.status).toBe(400);
    expect(createInvoiceLink).not.toHaveBeenCalled();
  });

  it("still sells the monthly subscription", async () => {
    demoMode.on = true;
    const res = await request(buildApp())
      .post("/v1/premium/stars-invoice")
      .set(...AUTH)
      .send({ plan: "monthly" });
    expect(res.status).toBe(200);
    expect(createInvoiceLink.mock.calls[0][2]).toBe("sub:premium");
  });
});
