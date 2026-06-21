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
      psychologicalSummary: "Raw LLM dump…",
      negativeConstraints: null,
      ageRangeMin: 20,
      ageRangeMax: 26,
      photos: [],
      eloScore: 600,
      eloMatchesPlayed: 3,
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
          ? Promise.resolve({
              ...MOCK_USER,
              messageHistory: [{ role: "user", content: "Hi" }],
              personaInquiryId: "inq_xyz",
            })
          : Promise.resolve(null),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    match: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    noMatchNotice: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    report: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

const { runPipeline } = vi.hoisted(() => ({
  runPipeline: vi.fn(async () => ({ kind: "verified" as const })),
}));
vi.mock("../services/verification-pipeline.js", () => ({
  runFaceMatchVerificationDefault: runPipeline,
}));

vi.mock("../services/storage.js", () => ({
  downloadProfileImage: vi.fn(),
  downloadChatImage: vi.fn(),
  downloadTelegramFile: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { downloadChatImage } from "../services/storage.js";
import { app, setAdminBotApi } from "./server.js";

const ENDPOINTS = [
  "/admin/analytics/demographics",
  "/admin/analytics/funnel",
  "/admin/analytics/matches",
  "/admin/analytics/no-match-notices",
  "/admin/reports/stats",
  "/admin/reports",
  "/admin/users",
  `/admin/users/${MOCK_USER.id}`,
  `/admin/users/${MOCK_USER.id}/conversation`,
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

describe("GET /admin/analytics/no-match-notices", () => {
  it("returns empty drops when no notices exist", async () => {
    const res = await request(app).get("/admin/analytics/no-match-notices").set(AUTH);
    expect(res.status).toBe(200);
    expect(res.body.weeks).toBe(8);
    expect(res.body.total).toBe(0);
    expect(res.body.drops).toEqual([]);
  });

  it("groups by drop date and tier, sorted ascending", async () => {
    const findMany = (prisma.noMatchNotice as unknown as { findMany: ReturnType<typeof vi.fn> })
      .findMany;
    findMany.mockResolvedValueOnce([
      { dropDate: new Date("2026-04-23T00:00:00Z"), tier: 1 },
      { dropDate: new Date("2026-04-23T00:00:00Z"), tier: 1 },
      { dropDate: new Date("2026-04-23T00:00:00Z"), tier: 2 },
      { dropDate: new Date("2026-04-30T00:00:00Z"), tier: 1 },
      { dropDate: new Date("2026-04-30T00:00:00Z"), tier: 3 },
      { dropDate: new Date("2026-04-30T00:00:00Z"), tier: 7 },
    ]);

    const res = await request(app).get("/admin/analytics/no-match-notices?weeks=4").set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.weeks).toBe(4);
    expect(res.body.total).toBe(6);
    expect(res.body.drops).toEqual([
      { dropDate: "2026-04-23", total: 3, tier1: 2, tier2: 1, tier3plus: 0 },
      { dropDate: "2026-04-30", total: 3, tier1: 1, tier2: 0, tier3plus: 2 },
    ]);
  });

  it("clamps weeks to [1..26]", async () => {
    const r1 = await request(app).get("/admin/analytics/no-match-notices?weeks=999").set(AUTH);
    expect(r1.status).toBe(200);
    expect(r1.body.weeks).toBe(26);

    const r2 = await request(app).get("/admin/analytics/no-match-notices?weeks=0").set(AUTH);
    expect(r2.status).toBe(400);
  });
});

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
    expect(user.profile.eloScore).toBe(600);
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

describe("GET /admin/users/:id/conversation", () => {
  it("returns 404 for unknown id", async () => {
    const res = await request(app)
      .get("/admin/users/00000000-0000-0000-0000-000000000099/conversation")
      .set(AUTH);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("normalizes messageHistory + Aether rows and exposes a photo gallery", async () => {
    const findUnique = (prisma.user as unknown as { findUnique: ReturnType<typeof vi.fn> })
      .findUnique;
    const messageFindMany = (
      prisma.message as unknown as { findMany: ReturnType<typeof vi.fn> }
    ).findMany;

    findUnique.mockResolvedValueOnce({
      firstName: "Alice",
      surname: "Smith",
      telegramId: 123456789n,
      messageHistory: [
        { role: "system", content: "You are a matchmaker bot" },
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ function: { name: "save_field", arguments: '{"firstName":"Alice"}' } }],
        },
        { role: "tool", content: "ok", tool_call_id: "t1" },
      ],
      profile: { photos: ["file_abc", "user-1/1.jpg"] },
    });
    messageFindMany.mockResolvedValueOnce([
      {
        id: "msg-1",
        role: "user",
        content: "look at this",
        imageUrl: "user-1/2.jpg",
        createdAt: new Date("2026-05-01T10:00:00Z"),
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "nice photo",
        imageUrl: null,
        createdAt: new Date("2026-05-01T10:01:00Z"),
      },
    ]);

    const res = await request(app)
      .get(`/admin/users/${MOCK_USER.id}/conversation`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.telegramId).toBe("123456789"); // BigInt → string
    expect(res.body.displayName).toBe("Alice Smith");

    const msgs = res.body.messages;
    expect(msgs).toHaveLength(6); // 4 telegram + 2 aether

    expect(msgs[0]).toMatchObject({ id: "mh-0", source: "telegram", role: "system", technical: true });
    expect(msgs[1]).toMatchObject({
      id: "mh-1",
      source: "telegram",
      role: "user",
      text: "Hi",
      technical: false,
      createdAt: null,
    });
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      technical: true, // null content → technical
      toolCalls: [{ name: "save_field", arguments: '{"firstName":"Alice"}' }],
    });
    expect(msgs[2].text).toBeNull();
    expect(msgs[3]).toMatchObject({ role: "tool", technical: true });

    expect(msgs[4]).toMatchObject({
      id: "msg-1",
      source: "aether",
      role: "user",
      technical: false,
      createdAt: "2026-05-01T10:00:00.000Z",
      image: { type: "chat", ref: "user-1/2.jpg" },
    });
    expect(msgs[5]).toMatchObject({ id: "msg-2", source: "aether", role: "assistant" });
    expect(msgs[5].image).toBeUndefined();

    expect(res.body.photos).toEqual([
      { type: "photo", ref: "file_abc" },
      { type: "photo", ref: "user-1/1.jpg" },
    ]);
  });
});

describe("GET /admin/media", () => {
  // NOTE: this block runs before the rerun-verification block, so the
  // module-scoped botApi is still null here — required for the 503 case.
  it("rejects requests without Authorization header", async () => {
    const res = await request(app).get("/admin/media?type=chat&ref=user-1%2F1.jpg");
    expect(res.status).toBe(401);
  });

  it("returns 400 for an unknown media type", async () => {
    const res = await request(app).get("/admin/media?type=bogus&ref=user-1%2F1.jpg").set(AUTH);
    expect(res.status).toBe(400);
  });

  it("returns 400 for a traversal ref", async () => {
    const res = await request(app)
      .get(`/admin/media?type=chat&ref=${encodeURIComponent("../secret/x.jpg")}`)
      .set(AUTH);
    expect(res.status).toBe(400);
  });

  it("returns 503 for type=telegram when the bot api isn't registered", async () => {
    const res = await request(app).get("/admin/media?type=telegram&ref=BAADfileid123").set(AUTH);
    expect(res.status).toBe(503);
  });

  it("streams image bytes on success (chat)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    vi.mocked(downloadChatImage).mockResolvedValueOnce(png);

    const res = await request(app)
      .get(`/admin/media?type=chat&ref=${encodeURIComponent("user-1/1.jpg")}`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.headers["cache-control"]).toContain("private");
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect((res.body as Buffer).equals(png)).toBe(true);
  });

  it("returns 404 when the image is missing/expired", async () => {
    vi.mocked(downloadChatImage).mockResolvedValueOnce(null);
    const res = await request(app)
      .get(`/admin/media?type=chat&ref=${encodeURIComponent("user-1/missing.jpg")}`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/users/:id/rerun-verification", () => {
  it("returns 503 when bot api isn't registered (test boot path)", async () => {
    runPipeline.mockClear();
    const res = await request(app)
      .post(`/admin/users/${MOCK_USER.id}/rerun-verification`)
      .set(AUTH);
    expect(res.status).toBe(503);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("kicks the verification pipeline and returns the outcome", async () => {
    setAdminBotApi({} as never);
    runPipeline.mockClear();

    const res = await request(app)
      .post(`/admin/users/${MOCK_USER.id}/rerun-verification`)
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toEqual({ kind: "verified" });
    expect(runPipeline).toHaveBeenCalledWith(MOCK_USER.id, "inq_xyz", expect.anything());
  });

  it("returns 404 for unknown user id", async () => {
    setAdminBotApi({} as never);
    const res = await request(app)
      .post(`/admin/users/00000000-0000-0000-0000-000000000099/rerun-verification`)
      .set(AUTH);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/reports", () => {
  it("returns paginated reports with moderation context for both users", async () => {
    const findMany = (prisma.report as unknown as { findMany: ReturnType<typeof vi.fn> })
      .findMany;
    const count = (prisma.report as unknown as { count: ReturnType<typeof vi.fn> }).count;

    findMany.mockResolvedValueOnce([
      {
        id: "report-1",
        tier: 3,
        rawText: "He threatened me after the date.",
        reasonSummary: "Threatening behavior after the date",
        adminReviewed: false,
        createdAt: new Date("2026-05-10T12:00:00Z"),
        reporter: {
          id: "user-reporter",
          firstName: "Alice",
          surname: "Smith",
          telegramId: 123456789n,
          email: "alice@stanford.edu",
          status: "active",
          verificationStatus: "verified",
          isEmailVerified: true,
          strikes: 0,
          profile: {
            height: 165,
            hobbies: ["jazz", "running"],
            partnerPreferences: "Curious\nKind",
            psychologicalSummary: "Structured, reflective, direct communicator.",
            negativeConstraints: "Smokers",
            ageRangeMin: 20,
            ageRangeMax: 27,
            photos: ["a.jpg", "b.jpg"],
          },
        },
        reported: {
          id: "user-reported",
          firstName: "Bob",
          surname: "Stone",
          telegramId: 987654321n,
          email: "bob@berkeley.edu",
          status: "pending_investigation",
          verificationStatus: "pending_review",
          isEmailVerified: true,
          strikes: 2,
          profile: {
            height: 182,
            hobbies: ["boxing"],
            partnerPreferences: "Outgoing, witty",
            psychologicalSummary: null,
            negativeConstraints: "Long-distance; flaky",
            ageRangeMin: 19,
            ageRangeMax: 25,
            photos: ["x.jpg"],
          },
        },
        match: {
          id: "match-12345678-abcdef",
          status: "completed",
        },
      },
    ]);
    count.mockResolvedValueOnce(1);

    const res = await request(app)
      .get("/admin/reports?limit=20&offset=0&tier=3&reviewed=false")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: "report-1",
      tier: 3,
      adminReviewed: false,
      reporter: {
        telegramId: "123456789",
        email: "alice@stanford.edu",
        status: "active",
        verificationStatus: "verified",
        isEmailVerified: true,
        profile: {
          partnerPreferences: ["Curious", "Kind"],
          negativeConstraints: ["Smokers"],
          photos: ["a.jpg", "b.jpg"],
        },
      },
      reported: {
        telegramId: "987654321",
        email: "bob@berkeley.edu",
        status: "pending_investigation",
        verificationStatus: "pending_review",
        strikes: 2,
        profile: {
          partnerPreferences: ["Outgoing", "witty"],
          negativeConstraints: ["Long-distance", "flaky"],
          photos: ["x.jpg"],
        },
      },
      match: {
        id: "match-12345678-abcdef",
        status: "completed",
      },
    });
  });
});

describe("PATCH /admin/reports/:id/review", () => {
  it("marks a report as reviewed", async () => {
    const findUnique = (prisma.report as unknown as { findUnique: ReturnType<typeof vi.fn> })
      .findUnique;
    const update = (prisma.report as unknown as { update: ReturnType<typeof vi.fn> }).update;

    findUnique.mockResolvedValueOnce({ id: "report-1" });

    const res = await request(app)
      .patch("/admin/reports/report-1/review")
      .set(AUTH);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: "report-1" },
      data: { adminReviewed: true },
    });
  });

  it("returns 404 for unknown report id", async () => {
    const findUnique = (prisma.report as unknown as { findUnique: ReturnType<typeof vi.fn> })
      .findUnique;

    findUnique.mockResolvedValueOnce(null);

    const res = await request(app)
      .patch("/admin/reports/missing-report/review")
      .set(AUTH);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
