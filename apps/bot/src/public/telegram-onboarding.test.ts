import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const createAndSendOtp = vi.fn();
const getOtpChallengeState = vi.fn();
const verifyOtp = vi.fn();

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

vi.mock("./otp.js", () => ({
  createAndSendOtp,
  getOtpChallengeState,
  verifyOtp,
}));

vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn(),
}));

vi.mock("../../workers/re-engagement-schedule.js", () => ({
  onboardingActivityPatch: () => ({}),
}));

const { createTelegramOnboardingRouter } = await import("./routes/telegram-onboarding.js");
// The config mock above exposes a mutable env object; the Registration v2
// fork tests flip the phone rail on/off through it.
const mutableEnv = (await import("../config.js")).env as unknown as {
  PHONE_AUTH_ENABLED?: boolean;
};

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
  createAndSendOtp.mockReset();
  getOtpChallengeState.mockReset();
  verifyOtp.mockReset();
  getOtpChallengeState.mockResolvedValue({
    status: "none",
    expiresAt: null,
    resendAvailableAt: null,
    attemptsRemaining: 5,
  });
  fakeApi.sendMessage = vi.fn().mockResolvedValue(undefined);
});

describe("Telegram onboarding city gate", () => {
  it("allows selecting a language before accepting terms", async () => {
    const current = miniUser({
      language: null,
      termsAccepted: false,
      onboardingStep: "consent",
    });
    userFindUnique.mockResolvedValue(current);
    userUpdate.mockResolvedValue(
      miniUser({
        language: "de",
        termsAccepted: false,
        onboardingStep: "language",
      }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/language")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ language: "de" });

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: current.id },
        data: expect.objectContaining({ language: "de" }),
      }),
    );
    expect(res.body.user.language).toBe("de");
    expect(res.body.user.termsAccepted).toBe(false);
  });

  it("still blocks email until terms are accepted", async () => {
    userFindUnique.mockResolvedValue(
      miniUser({
        language: "de",
        termsAccepted: false,
        isEmailVerified: false,
      }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("terms-required");
    expect(createAndSendOtp).not.toHaveBeenCalled();
  });

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

  it("returns an active email challenge so the Mini App can restore the OTP screen", async () => {
    userFindUnique.mockResolvedValue(miniUser({ isEmailVerified: false }));
    getOtpChallengeState.mockResolvedValue({
      status: "pending",
      expiresAt: new Date("2026-06-07T10:10:00.000Z"),
      resendAvailableAt: new Date("2026-06-07T10:00:30.000Z"),
      attemptsRemaining: 4,
    });

    const res = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${signInitData()}`);

    expect(res.status).toBe(200);
    expect(getOtpChallengeState).toHaveBeenCalledWith("alice@stanford.edu");
    expect(res.body.user.emailVerification).toEqual({
      status: "pending",
      expiresAt: "2026-06-07T10:10:00.000Z",
      resendAvailableAt: "2026-06-07T10:00:30.000Z",
      attemptsRemaining: 4,
    });
  });

  it("returns challenge timing after sending an OTP", async () => {
    const current = miniUser({ isEmailVerified: false, email: null });
    userFindUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(null);
    userUpdate.mockResolvedValue(current);
    createAndSendOtp.mockResolvedValue({
      status: "pending",
      expiresAt: new Date("2026-06-07T10:10:00.000Z"),
      resendAvailableAt: new Date("2026-06-07T10:00:30.000Z"),
      attemptsRemaining: 5,
    });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(200);
    expect(createAndSendOtp).toHaveBeenCalledWith("alice@stanford.edu");
    expect(res.body.emailVerification).toEqual({
      status: "pending",
      expiresAt: "2026-06-07T10:10:00.000Z",
      resendAvailableAt: "2026-06-07T10:00:30.000Z",
      attemptsRemaining: 5,
    });
  });

  it("enforces the resend cooldown without creating another challenge", async () => {
    const current = miniUser({ isEmailVerified: false });
    userFindUnique.mockResolvedValueOnce(current).mockResolvedValueOnce(null);
    getOtpChallengeState.mockResolvedValue({
      status: "pending",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      resendAvailableAt: new Date(Date.now() + 30_000),
      attemptsRemaining: 5,
    });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("otp-cooldown");
    expect(createAndSendOtp).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
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

describe("Registration v2 sign-up fork", () => {
  beforeEach(() => {
    mutableEnv.PHONE_AUTH_ENABLED = true;
  });
  afterEach(() => {
    mutableEnv.PHONE_AUTH_ENABLED = false;
  });

  it("404s /track while the phone rail is off (legacy behavior untouched)", async () => {
    mutableEnv.PHONE_AUTH_ENABLED = false;
    userFindUnique.mockResolvedValue(miniUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/track")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ track: "general" });

    expect(res.status).toBe(404);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("rejects an unknown track value", async () => {
    userFindUnique.mockResolvedValue(miniUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/track")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ track: "vip" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-track");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("persists the chosen track and mirrors it (plus the flag) in state", async () => {
    const current = miniUser({ isEmailVerified: false });
    userFindUnique.mockResolvedValue(current);
    userUpdate.mockResolvedValue(
      miniUser({ isEmailVerified: false, registrationTrack: "general" }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/track")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ track: "general" });

    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: current.id },
        data: expect.objectContaining({ registrationTrack: "general" }),
      }),
    );
    expect(res.body.user.registrationTrack).toBe("general");
    expect(res.body.user.phoneAuthEnabled).toBe(true);
  });

  it("gates /complete on phone for the general track", async () => {
    const user = miniUser({
      isEmailVerified: false,
      registrationTrack: "general",
      phone: null,
      phoneVerifiedAt: null,
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
    expect(res.body.error).toBe("phone-required");
  });

  it("keeps the email gate for the student track even when a phone is on file", async () => {
    const user = miniUser({
      isEmailVerified: false,
      registrationTrack: "student",
      phone: "+15551234567",
      phoneVerifiedAt: new Date(),
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
    expect(res.body.error).toBe("email-required");
  });

  it("lets a phone-verified general user pass the contact gate", async () => {
    const user = miniUser({
      isEmailVerified: false,
      registrationTrack: "general",
      phone: "+15551234567",
      phoneVerifiedAt: new Date(),
      profile: null,
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

    // Contact gate passes; the next unmet gate is the home city.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("location-required");
  });
});
