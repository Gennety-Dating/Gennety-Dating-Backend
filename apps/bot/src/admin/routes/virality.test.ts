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
    ADMIN_TEST_TELEGRAM_IDS: "777",
  },
}));

const { dayFindMany, dayFindFirst, cohortFindMany, hdyhauFindMany } = vi.hoisted(() => ({
  dayFindMany: vi.fn(),
  dayFindFirst: vi.fn(),
  cohortFindMany: vi.fn(),
  hdyhauFindMany: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    viralityDay: { findMany: dayFindMany, findFirst: dayFindFirst },
    viralityCohort: { findMany: cohortFindMany },
    hdyhauResponse: { findMany: hdyhauFindMany },
    // Кэш пишется через `system_knowledge`; вечный промах оставляет тесты про
    // эндпоинты, а не про кэш.
    systemKnowledge: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

const { app } = await import("../server.js");

const AUTH = { Authorization: "Bearer test-secret-key" };
const ROLLUP_AT = new Date("2026-06-01T03:40:00.000Z");

interface DayRowInput {
  day: string;
  scope?: string;
  signups?: number;
  organic?: number;
  referral?: number;
  seed?: number;
  baseline?: number | null;
  stdDev?: number | null;
  uplift?: number | null;
  kWom?: number | null;
  womStatus?: string;
}

function dayRow(input: DayRowInput) {
  return {
    day: new Date(`${input.day}T00:00:00.000Z`),
    scope: input.scope ?? "global",
    signups: input.signups ?? 0,
    organicSignups: input.organic ?? 0,
    referralSignups: input.referral ?? 0,
    seedSignups: input.seed ?? 0,
    baselineOrganic: input.baseline ?? null,
    baselineStdDev: input.stdDev ?? null,
    organicUplift: input.uplift ?? null,
    kWom: input.kWom ?? null,
    womStatus: input.womStatus ?? "ok",
    computedAt: ROLLUP_AT,
  };
}

interface CohortRowInput {
  cohortDate: string;
  maturityDay: number;
  scope?: string;
  cohortSize?: number;
  activations?: number;
  kDirect?: number;
  kWom?: number | null;
  kTotal?: number;
  mature?: boolean;
  cycle?: number | null;
}

function cohortRow(input: CohortRowInput) {
  return {
    cohortDate: new Date(`${input.cohortDate}T00:00:00.000Z`),
    maturityDay: input.maturityDay,
    scope: input.scope ?? "global",
    cohortSize: input.cohortSize ?? 10,
    sharers: 2,
    invitesSent: 4,
    linkClicks: 3,
    activations: input.activations ?? 1,
    invitesPerUser: 0.4,
    clickRate: 0.75,
    activationRate: 0.3333,
    kDirect: input.kDirect ?? 0.1,
    cycleTimeMedianHours: input.cycle === undefined ? 30 : input.cycle,
    kWom: input.kWom ?? null,
    kTotal: input.kTotal ?? 0.1,
    mature: input.mature ?? true,
    computedAt: ROLLUP_AT,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dayFindMany.mockResolvedValue([]);
  dayFindFirst.mockResolvedValue({ computedAt: ROLLUP_AT });
  cohortFindMany.mockResolvedValue([]);
  hdyhauFindMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------

describe("авторизация", () => {
  it("закрыт тем же Bearer-гейтом, что и весь admin-API", async () => {
    for (const path of [
      "/admin/analytics/virality/summary",
      "/admin/analytics/virality/cohorts",
      "/admin/analytics/virality/clusters",
      "/admin/analytics/virality/anomalies",
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(401);
    }
  });

  it("отвергает чужой ключ", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/summary")
      .set({ Authorization: "Bearer wrong-key" });
    expect(res.status).toBe(401);
  });
});

describe("валидация параметров", () => {
  it("не принимает дату не в формате YYYY-MM-DD", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=01-05-2026")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("не принимает перевёрнутый диапазон", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2026-05-10&to=2026-05-01")
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/after/);
  });

  it("не принимает диапазон длиннее потолка", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2020-01-01&to=2026-05-01")
      .set(AUTH);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most/);
  });

  it("не принимает чужую гранулярность", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/summary?granularity=hour")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("не принимает день зрелости вне перечня", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/clusters?maturityDay=9")
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("не принимает нечисловую сигму", async () => {
    const res = await request(app)
      .get("/admin/analytics/virality/anomalies?sigma=many")
      .set(AUTH);
    expect(res.status).toBe(400);
  });
});

describe("summary", () => {
  it("отдаёт K по самому длинному дню зрелости, где есть зрелые когорты", async () => {
    cohortFindMany.mockResolvedValue([
      cohortRow({ cohortDate: "2026-05-01", maturityDay: 1, cohortSize: 100, activations: 1 }),
      cohortRow({ cohortDate: "2026-05-01", maturityDay: 7, cohortSize: 100, activations: 5 }),
      // Незрелая D30 не должна становиться заголовочной, даже будучи длиннее.
      cohortRow({
        cohortDate: "2026-05-01",
        maturityDay: 30,
        cohortSize: 100,
        activations: 0,
        mature: false,
      }),
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2026-05-01&to=2026-05-20")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.kpi.maturityDay).toBe(7);
    expect(res.body.kpi.kDirect).toBe(0.05);
    expect(res.body.byMaturity["30"].matureCohorts).toBe(0);
    expect(res.body.byMaturity["30"].kDirect).toBeNull();
  });

  it("на пустых данных отдаёт null, а не нули", async () => {
    const res = await request(app).get("/admin/analytics/virality/summary").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.kpi.kDirect).toBeNull();
    expect(res.body.kpi.kTotal).toBeNull();
    expect(res.body.kpi.maturityDay).toBeNull();
    expect(res.body.wom.kWomBaseline).toBeNull();
    expect(res.body.shareFunnel).toBeNull();
  });

  it("складывает K_total из прямого и сарафанного", async () => {
    dayFindMany.mockResolvedValue([
      dayRow({ day: "2026-05-02", organic: 10, seed: 5, baseline: 4, uplift: 6, kWom: 1.2 }),
    ]);
    cohortFindMany.mockResolvedValue([
      cohortRow({ cohortDate: "2026-05-02", maturityDay: 7, cohortSize: 10, activations: 2 }),
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2026-05-01&to=2026-05-20")
      .set(AUTH);

    expect(res.body.wom.kWomBaseline).toBe(1.2);
    expect(res.body.kpi.kDirect).toBe(0.2);
    expect(res.body.kpi.kTotal).toBe(1.4);
  });

  it("сворачивает ряд в недели по требованию", async () => {
    dayFindMany.mockResolvedValue([
      // 2026-05-04 — понедельник; оба дня попадают в одну неделю.
      dayRow({ day: "2026-05-04", signups: 3, organic: 3 }),
      dayRow({ day: "2026-05-06", signups: 2, organic: 2 }),
      dayRow({ day: "2026-05-11", signups: 7, organic: 7 }),
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2026-05-01&to=2026-05-20&granularity=week")
      .set(AUTH);

    expect(res.body.series).toHaveLength(2);
    expect(res.body.series[0]).toMatchObject({ bucket: "2026-05-04", signups: 5 });
    expect(res.body.series[1]).toMatchObject({ bucket: "2026-05-11", signups: 7 });
  });

  it("сообщает свежесть предагрегата и помечает протухший", async () => {
    dayFindFirst.mockResolvedValue({ computedAt: new Date("2026-01-01T00:00:00.000Z") });
    const res = await request(app).get("/admin/analytics/virality/summary").set(AUTH);
    expect(res.body.stale).toBe(true);
    expect(res.body.rollupAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("никогда не считался — не молчит, а говорит об этом", async () => {
    dayFindFirst.mockResolvedValue(null);
    const res = await request(app).get("/admin/analytics/virality/summary").set(AUTH);
    expect(res.body.rollupAt).toBeNull();
    expect(res.body.stale).toBe(true);
  });

  it("в ответе нет ни одного пользовательского идентификатора", async () => {
    dayFindMany.mockResolvedValue([dayRow({ day: "2026-05-02", signups: 3, organic: 3 })]);
    cohortFindMany.mockResolvedValue([
      cohortRow({ cohortDate: "2026-05-02", maturityDay: 7 }),
    ]);
    hdyhauFindMany.mockResolvedValue([
      { answer: "friend_in_person", answeredAt: new Date(), user: { referralSource: null } },
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/summary?from=2026-05-01&to=2026-05-20")
      .set(AUTH);

    const body = JSON.stringify(res.body);
    for (const forbidden of ["userId", "user_id", "telegram", "email", "phone", "referrerId"]) {
      expect(body).not.toContain(forbidden);
    }
  });
});

describe("cohorts", () => {
  it("складывает матрицу «когорта × день зрелости» и выносит размер наверх", async () => {
    cohortFindMany.mockResolvedValue([
      cohortRow({ cohortDate: "2026-05-01", maturityDay: 1, cohortSize: 20 }),
      cohortRow({ cohortDate: "2026-05-01", maturityDay: 7, cohortSize: 20 }),
      cohortRow({ cohortDate: "2026-05-02", maturityDay: 1, cohortSize: 5 }),
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/cohorts?from=2026-05-01&to=2026-05-10")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.cohorts).toHaveLength(2);
    expect(res.body.cohorts[0].cohortDate).toBe("2026-05-01");
    expect(res.body.cohorts[0].cohortSize).toBe(20);
    expect(Object.keys(res.body.cohorts[0].byMaturity)).toEqual(["1", "7"]);
  });

  it("незрелая ячейка возвращается помеченной, а не выбрасывается", async () => {
    cohortFindMany.mockResolvedValue([
      cohortRow({ cohortDate: "2026-05-30", maturityDay: 30, mature: false }),
    ]);
    const res = await request(app)
      .get("/admin/analytics/virality/cohorts?from=2026-05-01&to=2026-05-31")
      .set(AUTH);
    expect(res.body.cohorts[0].byMaturity["30"].mature).toBe(false);
  });
});

describe("clusters", () => {
  it("возвращает только запрошенное измерение и сортирует по объёму", async () => {
    dayFindMany.mockImplementation((args: { distinct?: string[] }) => {
      if (args?.distinct) {
        return Promise.resolve([
          { scope: "city:kyiv" },
          { scope: "city:lviv" },
          { scope: "global" },
          { scope: "university:kpi.ua" },
        ]);
      }
      return Promise.resolve([
        dayRow({ day: "2026-05-02", scope: "city:kyiv", signups: 3, organic: 3 }),
        dayRow({ day: "2026-05-02", scope: "city:lviv", signups: 30, organic: 30 }),
      ]);
    });
    cohortFindMany.mockResolvedValue([]);

    const res = await request(app)
      .get("/admin/analytics/virality/clusters?from=2026-05-01&to=2026-05-10&dimension=city")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.clusters.map((c: { scope: string }) => c.scope)).toEqual([
      "city:lviv",
      "city:kyiv",
    ]);
    expect(res.body.clusters[0].key).toBe("lviv");
  });
});

describe("anomalies", () => {
  it("находит всплеск сверх порога и ставит сильнейший первым", async () => {
    dayFindMany.mockResolvedValue([
      dayRow({ day: "2026-05-02", organic: 12, baseline: 4, stdDev: 1 }), // z = 8
      dayRow({ day: "2026-05-03", organic: 7, baseline: 4, stdDev: 1 }), // z = 3
      dayRow({ day: "2026-05-04", organic: 5, baseline: 4, stdDev: 1 }), // z = 1 — не аномалия
    ]);

    const res = await request(app)
      .get("/admin/analytics/virality/anomalies?from=2026-05-01&to=2026-05-10")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.anomalies[0].at).toBe("2026-05-02");
    expect(res.body.anomalies[0].zScore).toBe(8);
    expect(res.body.pointsChecked).toBe(3);
  });

  it("уважает переданную сигму", async () => {
    dayFindMany.mockResolvedValue([
      dayRow({ day: "2026-05-03", organic: 7, baseline: 4, stdDev: 1 }), // z = 3
    ]);
    const strict = await request(app)
      .get("/admin/analytics/virality/anomalies?sigma=4&from=2026-05-01&to=2026-05-10")
      .set(AUTH);
    expect(strict.body.count).toBe(0);
  });
});
