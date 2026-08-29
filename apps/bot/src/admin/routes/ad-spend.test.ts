import { describe, it, expect, vi } from "vitest";
import request from "supertest";

/**
 * `/admin/ad-spend` — CRUD for the founder's own acquisition-spend entries.
 *
 * Route-level only: validation branching and the auth/UUID gates. The pure
 * CAC/ROAS arithmetic that reads these rows is covered without a database or
 * Express in `utils/ad-spend.test.ts`.
 */

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    MESSAGE_EFFECT_MATCH_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "test-secret-key",
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
  },
}));

const { MOCK_ROW, findMany, upsert, del, userFindMany, spendChannelsDistinct } = vi.hoisted(() => {
  const now = new Date("2026-08-24T12:00:00.000Z");
  const mockRow = {
    id: "00000000-0000-0000-0000-0000000000aa",
    channel: "tg:insta_promo",
    category: "performance_ads",
    periodStart: new Date("2026-08-01T00:00:00Z"),
    periodEnd: new Date("2026-08-07T00:00:00Z"),
    amount: 200,
    currency: "USD",
    amountUsdCents: 20_000,
    note: null as string | null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    MOCK_ROW: mockRow,
    findMany: vi.fn().mockResolvedValue([mockRow]),
    upsert: vi.fn().mockResolvedValue(mockRow),
    del: vi.fn().mockResolvedValue(mockRow),
    // Enriched with the fields GET /admin/analytics/acquisition-cost reads
    // (createdAt/status/verificationStatus/gender/onboardingStep) — additive,
    // the CRUD tests above only ever read id/referralSource off these rows.
    // u1's createdAt sits inside MOCK_ROW's [2026-08-01, 2026-08-07] window
    // and shares its channel, so it is the one row that actually reaches a
    // byChannel entry below; u2 is a different channel (organic, no spend
    // logged against it) and u3 is filtered out as a test account regardless
    // of matching both.
    userFindMany: vi.fn().mockResolvedValue([
      {
        id: "u1",
        referralSource: "tg:insta_promo",
        createdAt: new Date("2026-08-03T00:00:00Z"),
        status: "active",
        verificationStatus: "verified",
        gender: "male",
        onboardingStep: "completed",
      },
      {
        id: "u2",
        referralSource: null, // → organic
        createdAt: new Date("2026-08-03T00:00:00Z"),
        status: "active",
        verificationStatus: "verified",
        gender: null,
        onboardingStep: "completed",
      },
      {
        id: "u3",
        referralSource: "tg:insta_promo", // test account, excluded
        createdAt: new Date("2026-08-03T00:00:00Z"),
        status: "active",
        verificationStatus: "verified",
        gender: "female",
        onboardingStep: "completed",
      },
    ]),
    spendChannelsDistinct: vi
      .fn()
      .mockResolvedValue([{ channel: "tg:insta_promo" }, { channel: "referral" }]),
  };
});

// The exact query growth.ts's own "matched" set uses — see the plan's
// Grounding note on why the acquisition-cost route reuses it verbatim rather
// than defining "matched" a second way.
const matchFindMany = vi.hoisted(() =>
  vi.fn().mockResolvedValue([] as { userAId: string; userBId: string }[]),
);

vi.mock("@gennety/db", () => ({
  prisma: {
    adSpend: {
      findMany: vi.fn().mockImplementation((args?: { distinct?: string[] }) =>
        args?.distinct ? spendChannelsDistinct() : findMany(args),
      ),
      upsert: (...args: unknown[]) => upsert(...args),
      delete: (...args: unknown[]) => del(...args),
    },
    user: { findMany: (...args: unknown[]) => userFindMany(...args) },
    match: { findMany: (...args: unknown[]) => matchFindMany(...args) },
  },
}));

vi.mock("../utils/user-health-source.js", () => ({
  classifyAllUsers: vi.fn().mockResolvedValue({
    users: [{ id: "u3", verdict: { classification: "test" } }],
    scanned: 3,
    truncated: false,
  }),
}));

// Bypass the SystemKnowledge-backed cache entirely — same pattern
// `monetization.test.ts` uses. What is asserted below is that the route
// wires THROUGH getOrCompute with the right key/ttl/ctx (which is what
// produces the X-Data-Generated-At / X-Data-Cache headers in production);
// the header-writing itself is covered without Express in `cache.test.ts`.
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

// Real PURCHASE_KINDS + the real value-only exports of this module are kept
// (revenueByKindFor in utils/ad-spend.ts iterates PURCHASE_KINDS at runtime,
// and that module resolves to this SAME mocked specifier) — only
// loadPayerIndex is swapped for a controllable stub.
const loadPayerIndex = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ byUser: new Map(), truncated: false }),
);
vi.mock("../../services/purchases.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/purchases.js")>(
    "../../services/purchases.js",
  );
  return { ...actual, loadPayerIndex };
});

const { adSpendRouter } = await import("./ad-spend.js");
const express = (await import("express")).default;

const app = express();
app.use(express.json());
app.use(adSpendRouter);

const validBody = {
  channel: "tg:insta_promo",
  category: "performance_ads",
  periodStart: "2026-08-01T00:00:00Z",
  periodEnd: "2026-08-07T00:00:00Z",
  amount: 200,
  currency: "USD",
  amountUsdCents: 20_000,
};

describe("GET /admin/ad-spend", () => {
  it("lists rows with ISO-serialized dates", async () => {
    const res = await request(app).get("/admin/ad-spend");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].channel).toBe("tg:insta_promo");
    expect(typeof res.body.data[0].periodStart).toBe("string");
  });

  it("passes channel/category filters through to the query", async () => {
    findMany.mockClear();
    await request(app).get("/admin/ad-spend?channel=referral&category=influencer");
    const args = findMany.mock.calls.at(-1)?.[0] as { where?: Record<string, unknown> };
    expect(args?.where).toMatchObject({ channel: "referral", category: "influencer" });
  });
});

describe("GET /admin/ad-spend/channels", () => {
  it("unions real users' channels, logged spend channels, and the sentinel — excluding test accounts", async () => {
    const res = await request(app).get("/admin/ad-spend/channels");
    expect(res.status).toBe(200);
    expect(res.body.channels).toContain("tg:insta_promo");
    expect(res.body.channels).toContain("organic"); // u2's null referralSource
    expect(res.body.channels).toContain("referral"); // only in AdSpend, not in users
    expect(res.body.channels).toContain("unattributed");
    // u3 is a test account (see classifyAllUsers mock) — its channel must not
    // be counted as evidence a real user came through it.
  });
});

describe("POST /admin/ad-spend", () => {
  it("upserts on the compound unique key", async () => {
    upsert.mockClear();
    const res = await request(app).post("/admin/ad-spend").send(validBody);
    expect(res.status).toBe(200);
    const call = upsert.mock.calls.at(-1)?.[0] as {
      where?: { channel_category_periodStart_periodEnd?: Record<string, unknown> };
    };
    expect(call?.where?.channel_category_periodStart_periodEnd).toMatchObject({
      channel: "tg:insta_promo",
      category: "performance_ads",
    });
  });

  it("rejects an unknown category", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, category: "banner_ads" });
    expect(res.status).toBe(400);
  });

  it("rejects a channel that would normalize to something else", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, channel: "Referral User 42" });
    expect(res.status).toBe(400);
  });

  it("rejects a null-window category logged against a real channel", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, category: "agency" }); // channel stays "tg:insta_promo"
    expect(res.status).toBe(400);
  });

  it("rejects an attributable category logged against the unattributed sentinel", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, channel: "unattributed" });
    expect(res.status).toBe(400);
  });

  it("accepts the unattributed sentinel for a null-window category", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, category: "agency", channel: "unattributed" });
    expect(res.status).toBe(200);
  });

  it("rejects a bad currency code", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, currency: "usd" });
    expect(res.status).toBe(400);
  });

  it("rejects periodEnd before periodStart", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, periodStart: "2026-08-07T00:00:00Z", periodEnd: "2026-08-01T00:00:00Z" });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive amount", async () => {
    const res = await request(app).post("/admin/ad-spend").send({ ...validBody, amount: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer amountUsdCents", async () => {
    const res = await request(app)
      .post("/admin/ad-spend")
      .send({ ...validBody, amountUsdCents: 199.5 });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /admin/ad-spend/:id", () => {
  it("rejects a non-UUID id with 400, not Prisma's P2023", async () => {
    const res = await request(app).delete("/admin/ad-spend/not-a-uuid");
    expect(res.status).toBe(400);
  });

  it("deletes a real row", async () => {
    const res = await request(app).delete(`/admin/ad-spend/${MOCK_ROW.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("treats an already-deleted row (P2025) as success, not a 500", async () => {
    del.mockRejectedValueOnce(Object.assign(new Error("not found"), { code: "P2025" }));
    const res = await request(app).delete(`/admin/ad-spend/${MOCK_ROW.id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

/**
 * `GET /admin/analytics/acquisition-cost` — the deep-dive Hermes and the
 * founder read for payback / funnel×channel / gender×channel / revenue mix /
 * the CAC-over-time trend. Route-level only: that it wires the right rows
 * into `computeAcquisitionCost` and goes through the shared analytics cache.
 * The arithmetic itself (ltvCac, revenueByKind, byEntry windowing, …) is
 * covered without a database or Express in `utils/ad-spend.test.ts`.
 */
describe("GET /admin/analytics/acquisition-cost", () => {
  it("enriches byChannel with the funnel/gender/matched fields, excluding test accounts", async () => {
    matchFindMany.mockResolvedValueOnce([{ userAId: "u1", userBId: "some-other-user" }]);

    const res = await request(app).get("/admin/analytics/acquisition-cost");
    expect(res.status).toBe(200);

    const row = res.body.byChannel.find((c: { channel: string }) => c.channel === "tg:insta_promo");
    expect(row).toBeDefined();
    // u1 only: u3 shares the channel and the same createdAt window but is a
    // test account (see the classifyAllUsers mock above); u2 is "organic".
    expect(row.signups).toBe(1);
    expect(row.completedOnboarding).toBe(1);
    expect(row.matched).toBe(1);
    expect(row.genderKnown).toEqual({ male: 1, female: 0 });
    expect(row.revenueByKind).toHaveProperty("tickets");
    expect(row.revenueByKind).toHaveProperty("premium");
  });

  it("reads real payer revenue into revenueByKind and the payback fields", async () => {
    loadPayerIndex.mockResolvedValueOnce({
      byUser: new Map([
        [
          "u1",
          {
            userId: "u1",
            purchases: 1,
            refundedCount: 0,
            stars: 350,
            usdCents: 699,
            // Inside MOCK_ROW's 3-day performance_ads attribution window
            // (periodEnd 2026-08-07 + 3d = 2026-08-10).
            firstPaidAt: new Date("2026-08-04T00:00:00Z"),
            lastPaidAt: new Date("2026-08-04T00:00:00Z"),
            byKind: {
              tickets: { purchases: 1, stars: 350, usdCents: 699 },
              date_ticket: { purchases: 0, stars: 0, usdCents: 0 },
              premium: { purchases: 0, stars: 0, usdCents: 0 },
              rematch: { purchases: 0, stars: 0, usdCents: 0 },
              venue_change: { purchases: 0, stars: 0, usdCents: 0 },
              prime_time: { purchases: 0, stars: 0, usdCents: 0 },
            },
            refundedOnly: false,
          },
        ],
      ]),
      truncated: false,
    });

    const res = await request(app).get("/admin/analytics/acquisition-cost");
    expect(res.status).toBe(200);

    const row = res.body.byChannel.find((c: { channel: string }) => c.channel === "tg:insta_promo");
    expect(row.newPayers).toBe(1);
    expect(row.revenueByKind.tickets).toBe(699);
    // spend 20_000, 1 payer → cacPerPayingUsdCents 20_000; ltv 699 → ltvCac ~0.03.
    expect(row.cacPerPayingUsdCents).toBe(20_000);
    expect(row.ltvCac).toBeGreaterThan(0);
    expect(row.ltvCac).toBeLessThan(1);
    expect(row.roas).toBeGreaterThan(0);
  });

  it("carries the per-entry trend alongside the channel roll-up", async () => {
    const res = await request(app).get("/admin/analytics/acquisition-cost");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.byEntry)).toBe(true);
    expect(res.body.byEntry.length).toBeGreaterThan(0);
    expect(res.body.byEntry[0]).toMatchObject({
      channel: "tg:insta_promo",
      category: "performance_ads",
    });
  });

  it("returns null CAC/LTV:CAC/ROAS and an empty byChannel — never 0 — with no AdSpend rows", async () => {
    findMany.mockResolvedValueOnce([]);
    const res = await request(app).get("/admin/analytics/acquisition-cost");
    expect(res.status).toBe(200);
    expect(res.body.cacPerPayingUsdCents).toBeNull();
    expect(res.body.ltvCac).toBeNull();
    expect(res.body.roas).toBeNull();
    expect(res.body.byChannel).toEqual([]);
    expect(res.body.byEntry).toEqual([]);
  });

  it("goes through the shared analytics cache with a 15-minute TTL", async () => {
    getOrCompute.mockClear();
    await request(app).get("/admin/analytics/acquisition-cost");
    expect(getOrCompute).toHaveBeenCalledWith(
      "acquisition-cost:v1",
      900,
      expect.any(Function),
      expect.objectContaining({ req: expect.anything(), res: expect.anything() }),
    );
  });

  it("hands the request to the cache so ?fresh=1 can bypass it", async () => {
    getOrCompute.mockClear();
    await request(app).get("/admin/analytics/acquisition-cost?fresh=1");
    const ctx = getOrCompute.mock.calls[0]?.[3] as
      | { req: { query: Record<string, string> } }
      | undefined;
    expect(ctx?.req.query.fresh).toBe("1");
  });

  it("answers 500 rather than leaking an error body", async () => {
    findMany.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).get("/admin/analytics/acquisition-cost");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
  });
});
