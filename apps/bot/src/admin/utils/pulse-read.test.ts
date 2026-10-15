import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({
  env: { ADMIN_TEST_TELEGRAM_IDS: "", CLIENT_EVENTS_ENABLED: true },
}));
vi.mock("../../services/onboarding-collector.js", () => ({
  ONBOARDING_QUESTIONS: ["first_name_age", "photos", "complete"],
}));

const s = vi.hoisted(() => ({
  lastClientEventAt: vi.fn(),
  lastRollupAt: vi.fn(),
  loadClientEvents: vi.fn(),
  loadExcludedUserIds: vi.fn(),
  loadJourneyBundle: vi.fn(),
  loadStuckPeople: vi.fn(),
  optInShareNow: vi.fn(),
  readMetricDays: vi.fn(),
  recentlyActiveUserIds: vi.fn(),
}));
vi.mock("../../services/pulse/source.js", () => s);

const p = vi.hoisted(() => ({ loadPayerIndex: vi.fn() }));
vi.mock("../../services/purchases.js", () => p);

const insightFindMany = vi.hoisted(() => vi.fn());
vi.mock("@gennety/db", () => ({ prisma: { insight: { findMany: insightFindMany } } }));

const { buildBrief, buildFunnels, buildJourney, buildScreenDetail, buildScreens, dataFreshness } = await import(
  "./pulse-read.js"
);

const NOW = new Date("2026-10-15T09:00:00.000Z"); // asOf = 2026-10-14
const AS_OF = "2026-10-14";
const row = (day: string, metric: string, dim: string, value: number, n = value) => ({ day, metric, dim, value, n });

function insight(over: Record<string, unknown>) {
  return {
    id: "i",
    key: "k",
    kind: "screen_friction",
    severity: 2,
    scope: "city",
    title: "t",
    value: 1,
    baseline: null,
    n: 5,
    smallSample: true,
    evidence: { userIds: ["u1"] },
    codeHint: null,
    firstSeenAt: new Date("2026-10-01T00:00:00Z"),
    lastSeenAt: new Date("2026-10-15T01:10:00Z"),
    resolvedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  s.lastClientEventAt.mockResolvedValue(new Date("2026-10-15T08:00:00Z"));
  s.lastRollupAt.mockResolvedValue(new Date("2026-10-15T01:10:00Z"));
  s.optInShareNow.mockResolvedValue({ share: 0.4, n: 30 });
  s.loadExcludedUserIds.mockResolvedValue(new Set(["test-user"]));
  s.readMetricDays.mockResolvedValue([]);
  s.loadStuckPeople.mockResolvedValue([]);
  s.loadClientEvents.mockResolvedValue({ rows: [], truncated: false });
  s.loadJourneyBundle.mockResolvedValue({ users: [], events: new Map(), steps: new Map(), matchEvents: new Map() });
  insightFindMany.mockResolvedValue([]);
  p.loadPayerIndex.mockResolvedValue({ byUser: new Map(), truncated: false });
});

describe("dataFreshness", () => {
  it("reports a stale or missing rollup", async () => {
    expect((await dataFreshness(NOW)).rollupStale).toBe(false);
    s.lastRollupAt.mockResolvedValueOnce(new Date("2026-10-13T01:10:00Z"));
    expect((await dataFreshness(NOW)).rollupStale).toBe(true);
    s.lastRollupAt.mockResolvedValueOnce(null);
    const f = await dataFreshness(NOW);
    expect(f).toMatchObject({ rollupStale: true, lastRollupAt: null, clientEventsEnabled: true, optInShare: 0.4, optInN: 30 });
  });
});

describe("buildBrief", () => {
  it("KPIs this week vs last, revenue without excluded payers, insights by severity × n", async () => {
    s.readMetricDays.mockResolvedValue([
      row(AS_OF, "signups", "telegram", 4),
      row("2026-10-10", "signups", "mobile", 2),
      row("2026-10-05", "signups", "telegram", 3), // last week
      row(AS_OF, "onboarding_completed", "bot", 2),
      row(AS_OF, "onboarding_completed", "ios", 9), // client track — not in the KPI
      row(AS_OF, "date_funnel", "time_agreed", 1, 3),
    ]);
    p.loadPayerIndex.mockResolvedValueOnce({
      byUser: new Map([
        ["u1", { usdCents: 849 }],
        ["test-user", { usdCents: 10_000 }],
      ]),
      truncated: false,
    });
    insightFindMany.mockResolvedValue([
      insight({ id: "a", severity: 3, n: 2, scope: "city" }),
      insight({ id: "b", severity: 1, n: 20, scope: "date:shown" }),
      insight({ id: "c", severity: 2, n: 1, kind: "stuck_people", scope: "paywall" }),
    ]);

    const brief = await buildBrief(NOW);
    expect(brief.asOf).toBe(AS_OF);
    expect(brief.thisWeek).toEqual({ from: "2026-10-08", to: AS_OF });
    expect(brief.lastWeek).toEqual({ from: "2026-10-01", to: "2026-10-07" });
    const k = Object.fromEntries(brief.kpis.map((x) => [x.key, x]));
    expect(k["new_users"]).toMatchObject({ thisWeek: 6, lastWeek: 3, smallSample: true });
    expect(k["onboarding_completed"]!.thisWeek).toBe(2);
    expect(k["dates_scheduled"]!.thisWeek).toBe(1);
    expect(k["revenue_usd"]!.thisWeek).toBe(8.49);
    expect(brief.insights.map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(brief.openInsights).toBe(3);
    expect(brief.next.map((n) => n.endpoint)).toEqual(
      expect.arrayContaining(["/admin/pulse/screens/city", "/admin/pulse/journeys?stuck=1&limit=5"]),
    );
    // compact: no evidence in the brief
    expect(JSON.stringify(brief)).not.toContain("userIds");
  });

  it("revenue failure does not take the brief down", async () => {
    p.loadPayerIndex.mockRejectedValue(new Error("slow"));
    const brief = await buildBrief(NOW);
    expect(brief.kpis.find((x) => x.key === "revenue_usd")!.thisWeek).toBeNull();
  });
});

describe("buildScreens / buildScreenDetail", () => {
  it("screens sorted by 7-day friction with registry titles", async () => {
    s.readMetricDays.mockResolvedValue([
      row(AS_OF, "screen_views", "map", 50),
      row(AS_OF, "screen_views", "paywall", 10),
      row(AS_OF, "screen_dead_taps", "paywall", 5, 10),
      row(AS_OF, "screen_views", "new_unknown_screen", 3),
    ]);
    const r = await buildScreens(NOW);
    expect(r.screens[0]!.screen).toBe("paywall");
    expect(r.screens[0]!.title).toBe("Пейвол");
    expect(r.screens[0]!.d7.friction).toBe(12.5);
    expect(r.screens.find((x) => x.screen === "new_unknown_screen")!.known).toBe(false);
  });

  it("detail returns tap points, dead and rage subsets and per-version counts", async () => {
    const mk = (id: string, type: string, props: Record<string, unknown>, ms: number, appVersion = "1.0") => ({
      id,
      userId: null,
      installId: "i1",
      type,
      props: { screen: "city", ...props },
      occurredAt: new Date(Date.UTC(2026, 9, 14, 10, 0, 0, ms)),
      platform: "ios",
      screen: "city",
      appVersion,
    });
    s.loadClientEvents.mockResolvedValue({
      rows: [
        mk("v1", "screen_view", {}, 0),
        mk("t1", "tap", { element: "next", x: 0.5, y: 0.5 }, 100),
        mk("t2", "dead_tap", { x: 0.51, y: 0.5 }, 300),
        mk("t3", "dead_tap", { x: 0.5, y: 0.51 }, 500),
        mk("v2", "screen_view", {}, 9000, "1.1"),
      ],
      truncated: false,
    });
    const r = await buildScreenDetail("city", NOW);
    expect(s.loadClientEvents.mock.calls[0]![3]).toMatchObject({ screen: "city" });
    expect(r.taps.total).toBe(3);
    expect(r.taps.points[0]).toEqual([0.5, 0.51]); // newest first
    expect(r.taps.dead).toHaveLength(2);
    expect(r.taps.rage).toHaveLength(3);
    expect(r.elements).toEqual([{ element: "next", taps: 1 }]);
    expect(r.versions).toEqual(
      expect.arrayContaining([
        { appVersion: "1.0", views: 1, quickBack: 0, deadTaps: 2 },
        { appVersion: "1.1", views: 1, quickBack: 0, deadTaps: 0 },
      ]),
    );
    expect(r.codeHint).toContain("CityView.swift");
  });
});

describe("buildFunnels", () => {
  it("per-track steps with conversions hidden under n=30", async () => {
    s.readMetricDays.mockResolvedValue([
      row(AS_OF, "date_funnel", "shown", 40, 40),
      row(AS_OF, "date_funnel", "accepted", 30, 40),
      row(AS_OF, "date_funnel", "mutual", 10, 40),
      row(AS_OF, "money_shown", "paywall:today", 4),
      row(AS_OF, "money_dismissed", "paywall:today", 3, 4),
    ]);
    const r = await buildFunnels(NOW);
    const date = r.funnels.find((f) => f.id === "date")!;
    expect(date.enteredD7).toBe(40);
    expect(date.steps[1]).toMatchObject({ step: "accepted", d7: 30, conversionD7: 0.75 });
    // mutual: 10 of 30 entered — n = 30, not small → shown
    expect(date.steps[2]!.conversionD7).toBe(0.3333);
    expect(r.funnels.map((f) => f.id)).toEqual([
      "onboarding_ios",
      "onboarding_miniapp",
      "onboarding_bot",
      "onboarding_ios_server",
      "date",
    ]);
    expect(r.money).toEqual([{ dim: "paywall:today", shown: 4, dismissed: 3 }]);
  });
});

describe("buildJourney", () => {
  it("null for an unknown / excluded user", async () => {
    expect(await buildJourney("0b8f6d0e-3f0a-4a51-9a59-2a9a1d3a6c11", NOW)).toBeNull();
  });

  it("id + platform + signup DAY only, with the stuck block", async () => {
    const userId = "0b8f6d0e-3f0a-4a51-9a59-2a9a1d3a6c11";
    s.loadJourneyBundle.mockResolvedValue({
      users: [{ id: userId, createdAt: new Date("2026-10-01T13:37:00Z"), verifiedAt: null, platform: "telegram" }],
      events: new Map(),
      steps: new Map(),
      matchEvents: new Map(),
    });
    s.loadStuckPeople.mockResolvedValue([
      { userId, phase: "onboarding", where: "step:photos", lastMovementAt: new Date("2026-10-10T00:00:00Z") },
    ]);
    const r = (await buildJourney(userId, NOW))!;
    expect(r.journey).toMatchObject({
      userId,
      platform: "bot",
      signupDate: "2026-10-01",
      stuck: { where: "step:photos", whereTitle: "шаг анкеты photos", phase: "onboarding" },
    });
    expect(JSON.stringify(r)).not.toContain("13:37");
  });
});
