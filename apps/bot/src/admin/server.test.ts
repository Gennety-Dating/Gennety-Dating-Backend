import { describe, it, expect, vi } from "vitest";
import request from "supertest";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
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

// vi.hoisted ensures MOCK_USER is available inside the vi.mock factory
// even though vi.mock calls are hoisted to the top of the file.
const { MOCK_USER } = vi.hoisted(() => ({
  MOCK_USER: {
    id: "00000000-0000-0000-0000-000000000001",
    telegramId: BigInt("123456789"),
    firstName: "Alice",
    surname: "Smith",
    age: 21,
    gender: "female",
    preference: "men",
    major: "Computer Science",
    language: "en",
    status: "active",
    onboardingStep: "completed",
    universityDomain: "stanford.edu",
    email: "alice@stanford.edu",
    createdAt: new Date("2026-04-01T10:00:00Z"),
    profile: {
      height: 165,
      hobbies: ["jazz"],
      partnerPreferences: "Someone curious",
      visualPreferences: null,
      psychologicalSummary: "Raw LLM dump…",
      negativeConstraints: null,
      ageRangeMin: 20,
      ageRangeMax: 26,
      photos: [],
    },
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([]),
      findMany: vi.fn().mockResolvedValue([MOCK_USER]),
      findUnique: vi.fn().mockImplementation(({ where }: { where: { id: string } }) =>
        where.id === MOCK_USER.id
          ? Promise.resolve({ ...MOCK_USER, messageHistory: [{ role: "user", content: "Hi" }] })
          : Promise.resolve(null),
      ),
    },
    match: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import { app } from "./server.js";

const ENDPOINTS = [
  "/admin/analytics/demographics",
  "/admin/analytics/funnel",
  "/admin/analytics/matches",
  "/admin/users",
  `/admin/users/${MOCK_USER.id}`,
];

describe("Admin API auth", () => {
  it.each(ENDPOINTS)("rejects requests without Authorization header — %s", async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing Authorization/);
  });

  it.each(ENDPOINTS)("rejects requests with invalid API key — %s", async (url) => {
    const res = await request(app).get(url).set("Authorization", "Bearer wrong-key");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid API key/);
  });

  it.each(ENDPOINTS)("accepts requests with valid API key — %s", async (url) => {
    const res = await request(app).get(url).set("Authorization", "Bearer test-secret-key");
    expect(res.status).toBe(200);
  });
});

const AUTH = { Authorization: "Bearer test-secret-key" };

describe("GET /admin/users", () => {
  it("returns paginated list with total", async () => {
    const res = await request(app).get("/admin/users").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.limit).toBe(20);
    expect(res.body.offset).toBe(0);
    expect(res.body.data).toHaveLength(1);

    const user = res.body.data[0];
    expect(user.telegramId).toBe("123456789"); // BigInt serialised as string
    expect(user.profile.psychologicalSummary).toBe("Raw LLM dump…");
    expect(user).not.toHaveProperty("messageHistory"); // excluded from list view
    expect(user.profile).not.toHaveProperty("embedding");
    expect(user.profile).not.toHaveProperty("visualVector");
  });

  it("respects limit/offset query params", async () => {
    const res = await request(app).get("/admin/users?limit=5&offset=10").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(5);
    expect(res.body.offset).toBe(10);
  });

  it("clamps limit to 100", async () => {
    const res = await request(app).get("/admin/users?limit=999").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });
});

describe("GET /admin/users/:id", () => {
  it("returns full user detail including messageHistory", async () => {
    const res = await request(app).get(`/admin/users/${MOCK_USER.id}`).set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.telegramId).toBe("123456789");
    expect(res.body.messageHistory).toEqual([{ role: "user", content: "Hi" }]);
    expect(res.body.profile.psychologicalSummary).toBe("Raw LLM dump…");
  });

  it("returns 404 for unknown id", async () => {
    const res = await request(app)
      .get("/admin/users/00000000-0000-0000-0000-000000000099")
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
