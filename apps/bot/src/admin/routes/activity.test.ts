import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

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
    // Excluded from every count below unless ?includeTest=1.
    ADMIN_TEST_TELEGRAM_IDS: "777",
  },
}));

const { activityFindMany, activityFindFirst, userFindMany, userCount } = vi.hoisted(
  () => ({
    activityFindMany: vi.fn(),
    activityFindFirst: vi.fn(),
    userFindMany: vi.fn(),
    userCount: vi.fn(),
  }),
);

vi.mock("@gennety/db", () => ({
  prisma: {
    userActivityDay: { findMany: activityFindMany, findFirst: activityFindFirst },
    user: { findMany: userFindMany, count: userCount },
    // The cache helper writes through `system_knowledge`; stubbing it to a
    // permanent miss keeps these tests about the endpoints.
    systemKnowledge: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

const { app } = await import("../server.js");

const AUTH = { Authorization: "Bearer test-secret-key" };

function row(date: string, userId: string, platform = "telegram") {
  return { activityDate: new Date(`${date}T00:00:00.000Z`), userId, platform };
}

beforeEach(() => {
  activityFindMany.mockReset();
  activityFindMany.mockResolvedValue([]);
  activityFindFirst.mockReset();
  // Default: the table covers everything, so cohort cells are measurable.
  activityFindFirst.mockResolvedValue({ activityDate: new Date("2020-01-01T00:00:00.000Z") });
  userFindMany.mockReset();
  userFindMany.mockResolvedValue([]);
  userCount.mockReset();
  userCount.mockResolvedValue(0);
});

describe("GET /admin/analytics/dau", () => {
  it("requires the admin bearer", async () => {
    await request(app).get("/admin/analytics/dau").expect(401);
  });

  it("returns DAU with the WAU/MAU windows that give it scale", async () => {
    activityFindMany.mockResolvedValue([
      row("2026-08-27", "a"),
      row("2026-08-27", "b"),
      row("2026-08-25", "c"),
      row("2026-08-05", "d"),
    ]);
    const res = await request(app)
      .get("/admin/analytics/dau?date=2026-08-27")
      .set(AUTH)
      .expect(200);
    expect(res.body).toMatchObject({
      date: "2026-08-27",
      timezone: "UTC",
      dau: 2,
      wau: 3,
      mau: 4,
      stickinessPct: 50,
    });
  });

  it("rejects a malformed date instead of guessing a day", async () => {
    const res = await request(app)
      .get("/admin/analytics/dau?date=27-08-2026")
      .set(AUTH)
      .expect(400);
    expect(res.body.error).toContain("YYYY-MM-DD");
  });

  it("excludes test and synthetic accounts by default", async () => {
    await request(app).get("/admin/analytics/dau?date=2026-08-27").set(AUTH).expect(200);
    const where = activityFindMany.mock.calls[0]?.[0]?.where;
    expect(where.user).toMatchObject({ syntheticAt: null });
    expect(where.user.telegramId.notIn.map(String)).toEqual(["777"]);
  });

  it("includes them on ?includeTest=1, for debugging a mismatch", async () => {
    await request(app)
      .get("/admin/analytics/dau?date=2026-08-27&includeTest=1")
      .set(AUTH)
      .expect(200);
    expect(activityFindMany.mock.calls[0]?.[0]?.where.user).toBeUndefined();
  });

  it("defaults to YESTERDAY, so the number is not a half-filled day", async () => {
    // Defaulting to today shows a figure that climbs all day and is lowest
    // right after UTC midnight, which reads as a crash every morning.
    const res = await request(app).get("/admin/analytics/dau").set(AUTH).expect(200);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(res.body.date).toBe(yesterday);
  });
});

describe("GET /admin/analytics/mau", () => {
  it("defaults to a rolling 30-day window, not a calendar month", async () => {
    const res = await request(app).get("/admin/analytics/mau").set(AUTH).expect(200);
    expect(res.body).toMatchObject({ mode: "rolling", days: 30 });
  });

  it("serves a calendar month when one is asked for", async () => {
    activityFindMany.mockResolvedValue([row("2026-02-10", "a"), row("2026-02-11", "a")]);
    const res = await request(app)
      .get("/admin/analytics/mau?month=2026-02")
      .set(AUTH)
      .expect(200);
    expect(res.body).toMatchObject({
      mode: "calendar_month",
      from: "2026-02-01",
      to: "2026-02-28",
      days: 28,
      // One human active on two days is one monthly active user.
      mau: 1,
    });
  });

  it("rejects an out-of-range window instead of scanning the table", async () => {
    await request(app).get("/admin/analytics/mau?days=9999").set(AUTH).expect(400);
    await request(app).get("/admin/analytics/mau?days=0").set(AUTH).expect(400);
  });
});

describe("GET /admin/analytics/active", () => {
  it("returns a zero-filled series plus the headline block", async () => {
    activityFindMany.mockResolvedValue([row("2026-08-25", "a"), row("2026-08-27", "b")]);
    const res = await request(app)
      .get("/admin/analytics/active?from=2026-08-25&to=2026-08-27")
      .set(AUTH)
      .expect(200);
    expect(res.body.series).toEqual([
      { date: "2026-08-25", dau: 1 },
      { date: "2026-08-26", dau: 0 },
      { date: "2026-08-27", dau: 1 },
    ]);
    expect(res.body.summary).toMatchObject({ date: "2026-08-27", dau: 1, mau: 2 });
  });

  it("loads back to the MAU window even when the series starts later", async () => {
    // The headline block needs 30 days ending on `to`; loading only the series
    // range would report a MAU that is really a 3-day count.
    await request(app)
      .get("/admin/analytics/active?from=2026-08-25&to=2026-08-27")
      .set(AUTH)
      .expect(200);
    const gte = activityFindMany.mock.calls[0]?.[0]?.where.activityDate.gte as Date;
    expect(gte.toISOString().slice(0, 10)).toBe("2026-07-29");
  });

  it("rejects a reversed range", async () => {
    await request(app)
      .get("/admin/analytics/active?from=2026-08-27&to=2026-08-25")
      .set(AUTH)
      .expect(400);
  });
});

describe("GET /admin/analytics/active.csv", () => {
  it("exports the series as CSV", async () => {
    activityFindMany.mockResolvedValue([row("2026-08-26", "a")]);
    const res = await request(app)
      .get("/admin/analytics/active.csv?from=2026-08-26&to=2026-08-27")
      .set(AUTH)
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toBe("date,dau\n2026-08-26,1\n2026-08-27,0\n");
  });
});

// ---------------------------------------------------------------------------
// Cohort retention
// ---------------------------------------------------------------------------

function cohortUser(id: string, createdAt: string, referralSource: string | null = null) {
  return { id, createdAt: new Date(`${createdAt}T09:00:00.000Z`), referralSource };
}

describe("GET /admin/analytics/cohort-retention", () => {
  it("requires the admin bearer", async () => {
    await request(app).get("/admin/analytics/cohort-retention").expect(401);
  });

  it("rejects a bucket it does not know", async () => {
    const res = await request(app)
      .get("/admin/analytics/cohort-retention?bucket=quarter")
      .set(AUTH)
      .expect(400);
    expect(res.body.error).toMatch(/bucket/);
  });

  it("rejects a milestone whose window would reach into day 0", async () => {
    // `7:8` means "the 8 days ending on day 7", which includes the signup
    // session itself — the one thing retention must never count.
    const res = await request(app)
      .get("/admin/analytics/cohort-retention?milestones=7:8")
      .set(AUTH)
      .expect(400);
    expect(res.body.error).toMatch(/windowDays/);
  });

  it("widens a bare milestone list rather than reading it as exact days", async () => {
    // A caller asking for `30` gets the trailing week, because an exact-day
    // reading at day 30 measures the weekly drop schedule, not the user.
    const res = await request(app)
      .get("/admin/analytics/cohort-retention?milestones=1,30")
      .set(AUTH)
      .expect(200);
    expect(res.body.milestones).toEqual([
      { day: 1, windowDays: 1 },
      { day: 30, windowDays: 7 },
    ]);
  });

  it("returns the matrix and the same measurement per channel", async () => {
    userFindMany.mockResolvedValue([
      cohortUser("a", "2026-04-01", "tg:spring"),
      cohortUser("b", "2026-04-01", "tg:spring"),
      cohortUser("c", "2026-04-01", null),
    ]);
    activityFindMany.mockResolvedValue([
      row("2026-04-02", "a"), // day 1
      row("2026-04-02", "c"), // day 1
    ]);

    const res = await request(app)
      .get("/admin/analytics/cohort-retention?bucket=day&from=2026-04-01&to=2026-04-01&milestones=1")
      .set(AUTH)
      .expect(200);

    expect(res.body.overall.rows).toHaveLength(1);
    const cell = res.body.overall.rows[0].cells[0];
    expect(cell).toMatchObject({ status: "ok", retained: 2, retainedPct: 66.7, churnedPct: 33.3 });
    // Small cohorts are flagged rather than hidden.
    expect(res.body.overall.rows[0].lowSample).toBe(true);

    const paid = res.body.byChannel.find((r: { channel: string }) => r.channel === "tg:spring");
    const organic = res.body.byChannel.find((r: { channel: string }) => r.channel === "organic");
    expect(paid).toMatchObject({ signups: 2 });
    expect(paid.cells[0].retainedPct).toBe(50);
    expect(organic.cells[0].retainedPct).toBe(100);
  });

  it("reports no-data, not 0%, when the activity table starts after the cohort", async () => {
    // The failure mode this endpoint exists to avoid: instrumentation began
    // in August, so an April cohort with no rows is unobserved, not churned.
    userFindMany.mockResolvedValue([cohortUser("a", "2026-04-01")]);
    activityFindMany.mockResolvedValue([]);
    activityFindFirst.mockResolvedValue({
      activityDate: new Date("2026-08-29T00:00:00.000Z"),
    });

    const res = await request(app)
      .get("/admin/analytics/cohort-retention?bucket=day&from=2026-04-01&to=2026-04-01&milestones=1")
      .set(AUTH)
      .expect(200);

    expect(res.body.coverage.activityFrom).toBe("2026-08-29");
    expect(res.body.overall.rows[0].cells[0]).toMatchObject({
      status: "no-data",
      retainedPct: null,
      churnedPct: null,
    });
  });

  it("says the table is empty rather than reporting a collapse", async () => {
    userFindMany.mockResolvedValue([cohortUser("a", "2026-04-01")]);
    activityFindFirst.mockResolvedValue(null);

    const res = await request(app)
      .get("/admin/analytics/cohort-retention?bucket=day&from=2026-04-01&to=2026-04-01")
      .set(AUTH)
      .expect(200);

    expect(res.body.coverage.activityFrom).toBeNull();
    for (const cell of res.body.overall.rows[0].cells) {
      expect(cell.status).toBe("no-data");
    }
  });

  it("excludes test accounts by default and states how many", async () => {
    userCount.mockResolvedValueOnce(5).mockResolvedValueOnce(3);
    userFindMany.mockResolvedValue([cohortUser("a", "2026-04-01")]);

    const res = await request(app)
      .get("/admin/analytics/cohort-retention?bucket=day&from=2026-04-01&to=2026-04-01")
      .set(AUTH)
      .expect(200);

    expect(res.body.includeTest).toBe(false);
    expect(res.body.excludedTestUsers).toBe(2);
    // The users query must carry the same exclusion the activity query does,
    // or a retention rate can exceed 100%.
    expect(userFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ syntheticAt: null }) }),
    );
  });
});
