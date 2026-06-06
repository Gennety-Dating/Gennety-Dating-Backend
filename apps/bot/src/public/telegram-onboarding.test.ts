import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-telegram-onboarding";
const TELEGRAM_ID = 5986970093;

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
    DATABASE_URL: "postgresql://test",
  },
}));

const userFindUnique = vi.fn();
const userFindUniqueOrThrow = vi.fn();
const userCreate = vi.fn();
const userUpdate = vi.fn();
const profileUpsert = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      findUniqueOrThrow: userFindUniqueOrThrow,
      create: userCreate,
      update: userUpdate,
    },
    profile: {
      upsert: profileUpsert,
    },
  },
}));

vi.mock("../otp.js", () => ({
  createAndSendOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn(),
}));

vi.mock("../../workers/re-engagement-schedule.js", () => ({
  onboardingActivityPatch: () => ({}),
}));

const { createTelegramOnboardingRouter } = await import("./routes/telegram-onboarding.js");

const fakeApi = {
  sendMessage: vi.fn().mockResolvedValue(undefined),
} as unknown as Parameters<typeof createTelegramOnboardingRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/telegram-onboarding", createTelegramOnboardingRouter(fakeApi));
  return app;
}

function miniUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    telegramId: BigInt(TELEGRAM_ID),
    email: "alice@stanford.edu",
    language: "en",
    onboardingStep: "language",
    aiMemoryExportPreference: "undecided",
    aiMemoryExportPreferenceAt: null,
    termsAccepted: true,
    researchOptIn: false,
    isEmailVerified: true,
    messageHistory: [],
    profile: null,
    ...overrides,
  };
}

function signInitData(): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAH_test");
  params.set("user", JSON.stringify({ id: TELEGRAM_ID, first_name: "Alice" }));
  const sortedKeys = [...params.keys()].sort();
  const dcs = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secretKey).update(dcs).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

beforeEach(() => {
  userFindUnique.mockReset();
  userFindUniqueOrThrow.mockReset();
  userCreate.mockReset();
  userUpdate.mockReset();
  profileUpsert.mockReset();
  fakeApi.sendMessage = vi.fn().mockResolvedValue(undefined);
});

describe("Telegram onboarding city gate", () => {
  it("returns AI memory preference in state", async () => {
    userFindUnique.mockResolvedValue(
      miniUser({
        aiMemoryExportPreference: "accepted",
        aiMemoryExportPreferenceAt: new Date("2026-06-06T10:00:00.000Z"),
      }),
    );

    const res = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${signInitData()}`);

    expect(res.status).toBe(200);
    expect(res.body.user.aiMemoryExportPreference).toBe("accepted");
    expect(res.body.user.aiMemoryExportPreferenceAt).toBe("2026-06-06T10:00:00.000Z");
  });

  it("rejects complete handoff when home city is missing", async () => {
    const user = miniUser();
    userFindUnique.mockResolvedValue(user);
    const initData = signInitData();

    const state = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${initData}`);
    expect(state.status).toBe(200);

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/complete")
      .set("Authorization", `tma ${initData}`)
      .send({ completedVisualIntro: true, flowToken: state.body.flowToken });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("location-required");
    expect(fakeApi.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects complete handoff until AI memory preference is chosen", async () => {
    const user = miniUser({
      profile: {
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: null,
        latitude: 50.4501,
        longitude: 30.5234,
        locationUpdatedAt: new Date(),
      },
    });
    userFindUnique.mockResolvedValue(user);
    const initData = signInitData();

    const state = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${initData}`);
    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/complete")
      .set("Authorization", `tma ${initData}`)
      .send({ completedVisualIntro: true, flowToken: state.body.flowToken });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ai-memory-preference-required");
    expect(fakeApi.sendMessage).not.toHaveBeenCalled();
  });

  it("persists selected home city and returns it in state", async () => {
    const user = miniUser();
    const savedProfile = {
      homeCity: "Kyiv",
      homeCountryCode: "UA",
      homeCityKey: "ua:kyiv",
      homePlaceId: "places/kyiv",
      latitude: 50.4501,
      longitude: 30.5234,
      locationUpdatedAt: new Date("2026-06-03T12:00:00.000Z"),
    };
    userFindUnique.mockResolvedValue(user);
    profileUpsert.mockResolvedValue(savedProfile);
    userFindUniqueOrThrow.mockResolvedValue(miniUser({ profile: savedProfile }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/city/select")
      .set("Authorization", `tma ${signInitData()}`)
      .send({
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: "places/kyiv",
        latitude: 50.4501,
        longitude: 30.5234,
      });

    expect(res.status).toBe(200);
    expect(profileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: user.id },
        update: expect.objectContaining({ homeCityKey: "ua:kyiv" }),
      }),
    );
    expect(res.body.user.homeLocation.homeCityKey).toBe("ua:kyiv");
    expect(res.body.user.homeLocation.homeCity).toBe("Kyiv");
  });

  it.each(["accepted", "declined"] as const)(
    "persists %s AI memory preference",
    async (preference) => {
      const profile = {
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        homePlaceId: "places/kyiv",
        latitude: 50.4501,
        longitude: 30.5234,
        locationUpdatedAt: new Date("2026-06-06T10:00:00.000Z"),
      };
      const user = miniUser({ profile });
      userFindUnique.mockResolvedValue(user);
      userUpdate.mockResolvedValue(
        miniUser({
          profile,
          aiMemoryExportPreference: preference,
          aiMemoryExportPreferenceAt: new Date("2026-06-06T10:05:00.000Z"),
        }),
      );

      const res = await request(buildApp())
        .post("/v1/telegram-onboarding/ai-memory")
        .set("Authorization", `tma ${signInitData()}`)
        .send({ preference });

      expect(res.status).toBe(200);
      expect(userUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: user.id },
          data: expect.objectContaining({
            aiMemoryExportPreference: preference,
            aiMemoryExportPreferenceAt: expect.any(Date),
          }),
        }),
      );
      expect(res.body.user.aiMemoryExportPreference).toBe(preference);
    },
  );

  it("rejects an invalid AI memory preference", async () => {
    userFindUnique.mockResolvedValue(
      miniUser({
        profile: {
          homeCity: "Kyiv",
          homeCountryCode: "UA",
          homeCityKey: "ua:kyiv",
          homePlaceId: null,
          latitude: 50.4501,
          longitude: 30.5234,
          locationUpdatedAt: new Date(),
        },
      }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/ai-memory")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ preference: "maybe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-ai-memory-preference");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("requires all pre-handoff gates before AI memory selection", async () => {
    userFindUnique.mockResolvedValue(miniUser({ profile: null }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/ai-memory")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ preference: "declined" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("location-required");
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
