import { describe, it, expect, vi } from "vitest";
import request from "supertest";

/**
 * `GET /admin/analytics/monetization` — маршрут, а не арифметика.
 *
 * Проверяется ровно то, что маршрут обязан гарантировать сам: что он вообще
 * смонтирован, что он кэшируется вместе с остальными аналитическими вкладками
 * и что `?fresh=1` доезжает до кэша. Сами правила подсчёта проверяются в
 * `utils/monetization.test.ts` без базы и без Express.
 */

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "test-secret-key",
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
    ADMIN_TEST_TELEGRAM_IDS: "",
  },
}));

// Built inside `vi.hoisted` because the factory runs before the module body —
// a `const` declared above would still be in its temporal dead zone here.
const loadMonetizationSummary = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    headline: { payers: 1, registeredReal: 19, payingRatePct: 5.3 },
    revenue: { allTimeUsdCents: 700, usdIsEstimate: true },
  }),
);
vi.mock("../utils/monetization-source.js", () => ({ loadMonetizationSummary }));

/** The 4th parameter is the cache context — that is what carries `?fresh=1`. */
type CacheCtx = { req: { query: Record<string, string> }; res: unknown };
const getOrCompute = vi.hoisted(() =>
  vi.fn(
    async (
      _key: string,
      _ttl: number,
      compute: () => Promise<unknown>,
      _ctx?: { req: { query: Record<string, string> }; res: unknown },
    ) => compute(),
  ),
);
vi.mock("../utils/cache.js", () => ({ getOrCompute }));

const { monetizationRouter } = await import("./monetization.js");
const express = (await import("express")).default;

const app = express();
app.use(monetizationRouter);

describe("GET /admin/analytics/monetization", () => {
  it("serves the summary", async () => {
    const res = await request(app).get("/admin/analytics/monetization");
    expect(res.status).toBe(200);
    expect(res.body.headline.registeredReal).toBe(19);
    expect(res.body.revenue.usdIsEstimate).toBe(true);
  });

  it("goes through the shared analytics cache with a 15-minute TTL", async () => {
    getOrCompute.mockClear();
    await request(app).get("/admin/analytics/monetization");
    expect(getOrCompute).toHaveBeenCalledWith(
      "monetization:v1",
      900,
      expect.any(Function),
      expect.objectContaining({ req: expect.anything(), res: expect.anything() }),
    );
  });

  it("hands the request to the cache so ?fresh=1 can bypass it", async () => {
    // The dashboard's Refresh button is only honest if it actually recomputes;
    // the cache reads `?fresh=1` off the request it is given, so passing the
    // request through is the whole mechanism.
    getOrCompute.mockClear();
    await request(app).get("/admin/analytics/monetization?fresh=1");
    const ctx = getOrCompute.mock.calls[0]?.[3] as CacheCtx | undefined;
    expect(ctx?.req.query.fresh).toBe("1");
  });

  it("answers 500 rather than leaking an error body", async () => {
    loadMonetizationSummary.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/admin/analytics/monetization");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
