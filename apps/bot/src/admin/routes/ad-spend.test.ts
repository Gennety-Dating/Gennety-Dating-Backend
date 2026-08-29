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
    userFindMany: vi.fn().mockResolvedValue([
      { id: "u1", referralSource: "tg:insta_promo" },
      { id: "u2", referralSource: null }, // → organic
      { id: "u3", referralSource: "tg:insta_promo" }, // test account, excluded
    ]),
    spendChannelsDistinct: vi
      .fn()
      .mockResolvedValue([{ channel: "tg:insta_promo" }, { channel: "referral" }]),
  };
});

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
  },
}));

vi.mock("../utils/user-health-source.js", () => ({
  classifyAllUsers: vi.fn().mockResolvedValue({
    users: [{ id: "u3", verdict: { classification: "test" } }],
    scanned: 3,
    truncated: false,
  }),
}));

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
