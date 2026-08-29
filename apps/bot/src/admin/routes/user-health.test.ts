import { describe, it, expect, vi } from "vitest";
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
  },
}));

const { ROWS } = vi.hoisted(() => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  let n = 0;
  const row = (
    id: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    n++;
    return {
      id,
      telegramId: BigInt(id.slice(-4)),
      firstName: "Anna",
      email: null,
      status: "active",
      onboardingStep: "completed",
      verificationStatus: "verified",
      faceMatchScore: 0.95,
      faceMatchedAt: new Date(now - 5 * day),
      // Регистрации разнесены по дням: иначе сработало бы правило про пачку
      // регистраций и все четверо стали бы suspicious.
      createdAt: new Date(now - (20 + n) * day),
      lastMessageAt: new Date(now - day),
      profile: { photos: ["a", "b", "c"] },
      ...over,
    };
  };

  return {
    ROWS: [
      // Живой
      row("00000000-0000-0000-0000-000000001111"),
      // Застрял в онбординге
      row("00000000-0000-0000-0000-000000002222", {
        status: "onboarding",
        onboardingStep: "conversational",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        profile: { photos: [] },
        lastMessageAt: new Date(now - 3 * day),
      }),
      // Открыл и ушёл
      row("00000000-0000-0000-0000-000000003333", {
        status: "onboarding",
        onboardingStep: "consent",
        verificationStatus: "unverified",
        faceMatchScore: null,
        faceMatchedAt: null,
        profile: { photos: [] },
        lastMessageAt: null,
      }),
      // Тестовый
      row("00000000-0000-0000-0000-000000004444", { firstName: "Test QA" }),
    ],
  };
});

vi.mock("@gennety/db", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    user: {
      // Соседей по окну регистрации нет — правило про пачку не срабатывает.
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue(ROWS),
      findUnique: vi.fn().mockImplementation((args: { where: { id: string } }) =>
        Promise.resolve(ROWS.find((r) => r.id === args.where.id) ?? null),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    chatEvent: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    match: { groupBy: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    noMatchNotice: { findMany: vi.fn().mockResolvedValue([]) },
    report: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    ticketLedger: {
      findMany: vi.fn().mockResolvedValue([]),
      // Возвраты по матчам — вход нетто-конверсии (`match-conversion.ts`).
      groupBy: vi.fn().mockResolvedValue([]),
    },
    subscriptionLedger: { findMany: vi.fn().mockResolvedValue([]) },
    rematchPurchase: { findMany: vi.fn().mockResolvedValue([]) },
    venueChangePurchase: { findMany: vi.fn().mockResolvedValue([]) },
    primeTimePurchase: { findMany: vi.fn().mockResolvedValue([]) },
    profilerAnswer: { findMany: vi.fn().mockResolvedValue([]) },
    // Read by ops.ts's computeAcquisitionCost() call for /admin/dashboard's
    // derived CAC/LTV:CAC/ROAS block — empty spend history is the norm here.
    adSpend: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("../../services/verification-pipeline.js", () => ({
  runFaceMatchVerificationDefault: vi.fn(),
}));

vi.mock("../../services/storage.js", () => ({
  downloadProfileImage: vi.fn(),
  downloadChatImage: vi.fn(),
  downloadTelegramFile: vi.fn(),
}));

import { app } from "../server.js";

const KEY = "test-secret-key";
const get = (url: string) => request(app).get(url).set("Authorization", `Bearer ${KEY}`);

const LIVE_ID = "00000000-0000-0000-0000-000000001111";
const STUCK_ID = "00000000-0000-0000-0000-000000002222";

describe("GET /admin/users/:id/health", () => {
  it("требует админский ключ", async () => {
    const res = await request(app).get(`/admin/users/${LIVE_ID}/health`);
    expect(res.status).toBe(401);
  });

  it("отвечает 400 на не-UUID, а не 500", async () => {
    const res = await get("/admin/users/not-a-uuid/health");
    expect(res.status).toBe(400);
  });

  it("отвечает 404 на неизвестного пользователя", async () => {
    const res = await get("/admin/users/00000000-0000-0000-0000-00000000dead/health");
    expect(res.status).toBe(404);
  });

  it("возвращает класс, причину и сработавшие правила", async () => {
    const res = await get(`/admin/users/${STUCK_ID}/health`);
    expect(res.status).toBe(200);
    expect(res.body.user_id).toBe(STUCK_ID);
    expect(res.body.classification).toBe("stuck_onboarding");
    expect(res.body.subclass).toBe("conversational");
    expect(res.body.matchmaking_eligible).toBe(false);
    expect(typeof res.body.reason).toBe("string");
    expect(Array.isArray(res.body.rules_fired)).toBe(true);
  });

  it("отдаёт только счётчики и метаданные — без переписки", async () => {
    const res = await get(`/admin/users/${LIVE_ID}/health`);
    expect(res.body.classification).toBe("live");
    expect(res.body.matchmaking_eligible).toBe(true);
    expect(res.body.user_summary).toMatchObject({
      first_name: "Anna",
      status: "active",
      verification_status: "verified",
      message_count_in: 0,
    });
    expect(typeof res.body.user_summary.days_since_last_message).toBe("number");
    // Ни переписки, ни истории сообщений в ответе быть не должно.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain("messageHistory");
    expect(serialized).not.toContain("psychologicalSummary");
  });
});

describe("GET /admin/stats — секция здоровья базы", () => {
  it("раскладывает базу по классам и сходится с общим числом", async () => {
    const res = await get("/admin/stats");
    expect(res.status).toBe(200);
    const byClass = res.body.userHealth.byClass;
    expect(byClass.live).toBe(1);
    expect(byClass.stuck_onboarding).toBe(1);
    expect(byClass.cold_open_unengaged).toBe(1);
    expect(byClass.test).toBe(1);
    const sum = Object.values(byClass).reduce((a, b) => Number(a) + Number(b), 0);
    expect(sum).toBe(ROWS.length);
  });

  it("ликвидность считается от реальных пользователей, без тестовых", () => {
    return get("/admin/stats").then((res) => {
      expect(res.body.userHealth.matchmaking_eligible).toEqual({ count: 1, of_total: 3 });
    });
  });

  it("воронка делит на реальных пользователей", async () => {
    const res = await get("/admin/stats");
    expect(res.body.funnel).toMatchObject({
      registered_real: 3,
      gave_consent: 2,
      completed_onboarding: 1,
      active_verified: 1,
    });
    // 1/3 и 1/2 — знаменатели без тестового аккаунта.
    expect(res.body.funnel.conversion_registered_to_active_pct).toBe(33.3);
    expect(res.body.funnel.conversion_consent_to_active_pct).toBe(50);
  });
});

describe("GET /admin/dashboard — исправленный activeRate", () => {
  it("activeRate делится на реальных, а не на всех", async () => {
    const res = await get("/admin/dashboard");
    expect(res.status).toBe(200);
    // 1 активный верифицированный из 3 реальных = 0.3333, НЕ 1/4 = 0.25.
    expect(res.body.derived.activeRate).toBe(0.3333);
    expect(res.body.derived.matchmakingEligibleCount).toBe(1);
    expect(res.body.derived.conversionRegisteredToActivePct).toBe(33.3);
    expect(res.body.derived.conversionConsentToActivePct).toBe(50);
  });
});

describe("GET /admin/users — фильтр и бейджи", () => {
  it("каждая строка несёт класс здоровья", async () => {
    const res = await get("/admin/users");
    expect(res.status).toBe(200);
    expect(res.body.data[0].health.classification).toBeTruthy();
  });

  it("отклоняет неизвестный класс, а не отдаёт пустой список", async () => {
    const res = await get("/admin/users?health=bogus");
    expect(res.status).toBe(400);
  });

  it("принимает короткие алиасы вкладок", async () => {
    const res = await get("/admin/users?health=cold_open");
    expect(res.status).toBe(200);
  });
});

describe("смоук: соседние эндпоинты не сломались", () => {
  it.each(["/admin/users", "/admin/dialogs", "/admin/matches", "/admin/health"])(
    "%s отвечает 200",
    async (url) => {
      const res = await get(url);
      expect(res.status).toBe(200);
    },
  );
});
