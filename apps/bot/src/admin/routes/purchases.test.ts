import { describe, it, expect, vi } from "vitest";
import request from "supertest";

/**
 * `GET /admin/purchases` input validation.
 *
 * `?userId=` reaches Prisma as a `@db.Uuid` filter. A non-UUID does not read as
 * "no rows" — Prisma throws `P2023`, which the route's catch reported as
 * "Internal server error", so a mistyped filter was indistinguishable from a
 * broken server. `utils/uuid.ts` already states this rule for every `:id` on
 * this surface; the query param escaped it because it isn't a path segment.
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

const listPurchases = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    rows: [],
    total: 0,
    totals: { count: 0, stars: 0, usdCents: 0, refundedCount: 0 },
    byKind: [],
  }),
);

vi.mock("../../services/purchases.js", () => ({ listPurchases }));

vi.mock("@gennety/db", () => ({
  prisma: { user: { findMany: vi.fn().mockResolvedValue([]) } },
}));

const { purchasesRouter } = await import("./purchases.js");
const express = (await import("express")).default;

const app = express();
app.use(purchasesRouter);

const KEY = "test-secret-key";
const get = (url: string) => request(app).get(url).set("Authorization", `Bearer ${KEY}`);

describe("GET /admin/purchases", () => {
  it("rejects a non-UUID userId with 400, not 500", async () => {
    const res = await get("/admin/purchases?userId=not-a-uuid");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("UUID");
    // The filter never reached the query layer.
    expect(listPurchases).not.toHaveBeenCalled();
  });

  it("passes a real UUID through as a filter", async () => {
    const id = "00000000-0000-0000-0000-000000000001";
    const res = await get(`/admin/purchases?userId=${id}`);

    expect(res.status).toBe(200);
    expect(listPurchases).toHaveBeenCalledWith(
      expect.objectContaining({ userId: id }),
      expect.anything(),
    );
  });

  it("treats an absent userId as no filter at all", async () => {
    listPurchases.mockClear();
    const res = await get("/admin/purchases");

    expect(res.status).toBe(200);
    expect(listPurchases.mock.calls[0]![0]).not.toHaveProperty("userId");
  });
});
