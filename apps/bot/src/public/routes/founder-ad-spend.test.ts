import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const { env } = vi.hoisted(() => ({ env: { ADMIN_API_KEY: "signing-secret" } }));
vi.mock("../../config.js", () => ({ env }));
vi.mock("../../services/next-batch.js", () => ({ CRON_TIMEZONE: "Europe/Kyiv" }));

const adSpendFindMany = vi.fn();
const adSpendUpsert = vi.fn();
const adSpendDelete = vi.fn();
const userFindMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    adSpend: { findMany: adSpendFindMany, upsert: adSpendUpsert, delete: adSpendDelete },
    user: { findMany: userFindMany },
  },
}));

const { founderAdSpendRouter } = await import("./founder-ad-spend.js");
const { signAdSpendLink } = await import("../../services/founder-ad-spend-link.js");

const WEEK = { weekStart: "2026-08-17", weekEnd: "2026-08-23" };

function buildApp() {
  const app = express();
  app.use("/v1/founder", founderAdSpendRouter);
  return app;
}

function token(): string {
  return signAdSpendLink(WEEK)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  env.ADMIN_API_KEY = "signing-secret";
  adSpendFindMany.mockResolvedValue([]);
  adSpendUpsert.mockResolvedValue({});
  adSpendDelete.mockResolvedValue({});
  userFindMany.mockResolvedValue([{ referralSource: "tg:promo" }, { referralSource: null }]);
});

describe("GET /v1/founder/ad-spend/:token", () => {
  it("renders the form prefilled with the week the link names", async () => {
    const res = await request(buildApp()).get(`/v1/founder/ad-spend/${token()}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // The whole ergonomic point: the founder never types the dates.
    expect(res.text).toContain('name="periodStart" type="date" value="2026-08-17"');
    expect(res.text).toContain('name="periodEnd" type="date" value="2026-08-23"');
    expect(res.text).toContain("17 августа");
  });

  it("never lets a token page get cached or indexed", async () => {
    const res = await request(buildApp()).get(`/v1/founder/ad-spend/${token()}`);
    expect(res.headers["cache-control"]).toContain("no-store");
    expect(res.headers["x-robots-tag"]).toContain("noindex");
  });

  it("offers real channels as suggestions, including the sentinel", async () => {
    adSpendFindMany.mockResolvedValue([]);
    const res = await request(buildApp()).get(`/v1/founder/ad-spend/${token()}`);
    expect(res.text).toContain('<option value="tg:promo">');
    expect(res.text).toContain('<option value="organic">');
    expect(res.text).toContain('<option value="unattributed">');
  });

  it("shows what is already logged for the week, with a total", async () => {
    adSpendFindMany.mockResolvedValue([
      {
        id: "row-1",
        channel: "tg:promo",
        category: "performance_ads",
        amount: 5000,
        currency: "UAH",
        amountUsdCents: 12_000,
        note: null,
      },
    ]);
    const res = await request(buildApp()).get(`/v1/founder/ad-spend/${token()}`);
    expect(res.text).toContain("tg:promo");
    expect(res.text).toContain("5000 UAH");
    expect(res.text).toContain("$120.00");
  });

  it("404s on a forged, expired or malformed token — never a 401 that confirms the route", async () => {
    const app = buildApp();
    for (const bad of ["nope", "a.b", `${token()}x`]) {
      const res = await request(app).get(`/v1/founder/ad-spend/${bad}`);
      expect(res.status).toBe(404);
    }
  });

  it("404s once the signing key rotates", async () => {
    const live = token();
    env.ADMIN_API_KEY = "rotated";
    const res = await request(buildApp()).get(`/v1/founder/ad-spend/${live}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /v1/founder/ad-spend/:token", () => {
  const good = {
    category: "performance_ads",
    channel: "tg:promo",
    periodStart: "2026-08-17",
    periodEnd: "2026-08-23",
    amount: "5000",
    currency: "UAH",
    note: "август",
  };

  it("saves a spend row and redirects instead of re-rendering", async () => {
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send(good);
    // 303 so pull-to-refresh on a phone cannot double-post.
    expect(res.status).toBe(303);
    expect(adSpendUpsert).toHaveBeenCalledTimes(1);
    const args = adSpendUpsert.mock.calls[0]![0];
    expect(args.create).toMatchObject({
      channel: "tg:promo",
      category: "performance_ads",
      amount: 5000,
      currency: "UAH",
    });
    // Period bounds must be the same UTC midnights the admin route produces.
    expect(args.create.periodStart.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(args.create.periodEnd.toISOString()).toBe("2026-08-23T00:00:00.000Z");
  });

  it("computes the USD equivalent when the field is left blank", async () => {
    await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send(good);
    // 5000 UAH × 0.024 = $120.00
    expect(adSpendUpsert.mock.calls[0]![0].create.amountUsdCents).toBe(12_000);
  });

  it("keeps a typed USD figure instead of recomputing it", async () => {
    await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, amountUsd: "137.50" });
    expect(adSpendUpsert.mock.calls[0]![0].create.amountUsdCents).toBe(13_750);
  });

  it("rounds a decimal amount rather than dying inside Prisma", async () => {
    // `AdSpend.amount` is an Int; the admin route used to pass a float straight
    // through and surface the failure as an opaque 500.
    await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, amount: "4999.6" });
    expect(adSpendUpsert.mock.calls[0]![0].create.amount).toBe(5000);
  });

  it("forces content/agency spend onto the unattributed channel", async () => {
    await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, category: "agency", channel: "tg:promo" });
    expect(adSpendUpsert.mock.calls[0]![0].create.channel).toBe("unattributed");
  });

  it("refuses free text that no signup could ever match", async () => {
    // `isSelfNormalizedChannel` passes this on its own — `normalizeChannel` is
    // the identity function for anything that isn't referral/web:/mobile — so
    // this is the check the page adds on top, and the reason it exists.
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, channel: "Instagram Ads" });
    expect(res.status).toBe(400);
    expect(adSpendUpsert).not.toHaveBeenCalled();
    expect(res.text).toContain("не похож на ключ кампании");
    // The rejected values come back in the form so nothing is retyped.
    expect(res.text).toContain("5000");
  });

  it("still accepts a brand-new campaign slug that has no signups yet", async () => {
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, channel: "tg:launch_sept" });
    expect(res.status).toBe(303);
    expect(adSpendUpsert.mock.calls[0]![0].create.channel).toBe("tg:launch_sept");
  });

  it("requires a note where a bare number would be unreadable later", async () => {
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, category: "influencer", note: "" });
    expect(res.status).toBe(400);
    expect(adSpendUpsert).not.toHaveBeenCalled();
  });

  it("rejects a zero or negative amount", async () => {
    for (const amount of ["0", "-5", "abc"]) {
      const res = await request(buildApp())
        .post(`/v1/founder/ad-spend/${token()}`)
        .type("form")
        .send({ ...good, amount });
      expect(res.status).toBe(400);
    }
    expect(adSpendUpsert).not.toHaveBeenCalled();
  });

  it("rejects a period that ends before it starts", async () => {
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .type("form")
      .send({ ...good, periodStart: "2026-08-23", periodEnd: "2026-08-17" });
    expect(res.status).toBe(400);
    expect(adSpendUpsert).not.toHaveBeenCalled();
  });

  it("refuses a cross-site form post", async () => {
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}`)
      .set("Origin", "https://evil.example")
      .type("form")
      .send(good);
    expect(res.status).toBe(403);
    expect(adSpendUpsert).not.toHaveBeenCalled();
  });

  it("404s on a bad token before touching the database", async () => {
    const res = await request(buildApp())
      .post("/v1/founder/ad-spend/nope")
      .type("form")
      .send(good);
    expect(res.status).toBe(404);
    expect(adSpendUpsert).not.toHaveBeenCalled();
  });
});

describe("POST /v1/founder/ad-spend/:token/delete", () => {
  it("deletes a row this week's link actually shows", async () => {
    adSpendFindMany.mockResolvedValue([
      {
        id: "row-1",
        channel: "tg:promo",
        category: "performance_ads",
        amount: 1,
        currency: "USD",
        amountUsdCents: 100,
        note: null,
      },
    ]);
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}/delete`)
      .type("form")
      .send({ id: "row-1" });
    expect(res.status).toBe(303);
    expect(adSpendDelete).toHaveBeenCalledWith({ where: { id: "row-1" } });
  });

  it("will not delete a row outside the week the token authorizes", async () => {
    adSpendFindMany.mockResolvedValue([]);
    const res = await request(buildApp())
      .post(`/v1/founder/ad-spend/${token()}/delete`)
      .type("form")
      .send({ id: "some-other-week-row" });
    expect(res.status).toBe(303);
    expect(adSpendDelete).not.toHaveBeenCalled();
  });
});
