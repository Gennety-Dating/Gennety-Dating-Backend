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
    // AI-memory export kill switch (default-on); flipped per test via mutableEnv.
    AI_MEMORY_EXPORT_ENABLED: true,
  },
}));

const userFindUnique = vi.fn();
const userFindUniqueOrThrow = vi.fn();
const userCreate = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
const profileUpsert = vi.fn();
const cityWaitlistUpsert = vi.fn();
const cityWaitlistDeleteMany = vi.fn();
const createAndSendOtp = vi.fn();
const getOtpChallengeState = vi.fn();
const verifyOtp = vi.fn();
const discardOtpDelivery = vi.fn(async () => {});

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      findUniqueOrThrow: userFindUniqueOrThrow,
      create: userCreate,
      update: userUpdate,
      updateMany: userUpdateMany,
    },
    profile: {
      upsert: profileUpsert,
    },
    cityWaitlistEntry: {
      upsert: cityWaitlistUpsert,
      deleteMany: cityWaitlistDeleteMany,
    },
  },
}));

vi.mock("./otp.js", () => ({
  createAndSendOtp,
  getOtpChallengeState,
  verifyOtp,
  discardOtpDelivery,
}));

vi.mock("../../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn(),
}));

// The collector owns the actual write + progress advance (its own test covers
// that); here we only care that the route authenticates, gates, shape-checks,
// and maps a rejection onto a 400.
// NB: `vi.mock` paths resolve relative to THIS file, not to the module doing
// the importing — so it is `../services/…` even though the route says `../../`.
const applyOnboardingFacts = vi.fn();
vi.mock("../services/onboarding-collector.js", () => ({
  applyOnboardingFacts,
}));

vi.mock("../../workers/re-engagement-schedule.js", () => ({
  onboardingActivityPatch: () => ({}),
}));

const { createTelegramOnboardingRouter } = await import("./routes/telegram-onboarding.js");
// The config mock above exposes a mutable env object; the Registration v2
// fork tests flip the phone rail on/off through it.
const mutableEnv = (await import("../config.js")).env as unknown as {
  PHONE_AUTH_ENABLED?: boolean;
  AI_MEMORY_EXPORT_ENABLED?: boolean;
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
    firstName: null,
    age: null,
    gender: null,
    preference: null,
    profile: null,
    cityWaitlistEntry: null,
    ...overrides,
  };
}

/**
 * `user.findUnique` answers two different questions in the email routes: the
 * caller's own row (by `telegramId`) and whoever holds an address (by `email`).
 */
function routeUserLookups(
  current: ReturnType<typeof miniUser>,
  holders: Record<string, { id: string; isEmailVerified: boolean }> = {},
) {
  userFindUnique.mockImplementation(
    async ({ where }: { where: { telegramId?: bigint; email?: string } }) => {
      if (where.telegramId !== undefined) return current;
      if (where.email !== undefined) return holders[where.email] ?? null;
      return null;
    },
  );
}

/** A user who has cleared every gate the profile screens sit behind. */
function profileReadyUser(overrides: Record<string, unknown> = {}) {
  return miniUser({
    onboardingStep: "conversational",
    profile: {
      height: null,
      homeCity: "Kyiv",
      homeCountryCode: "UA",
      homeCityKey: "ua:kyiv",
      homePlaceId: null,
      latitude: 50.45,
      longitude: 30.52,
      locationUpdatedAt: new Date("2026-08-05T10:00:00.000Z"),
    },
    ...overrides,
  });
}

function collectorSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    language: "en",
    completedFields: [],
    skippedFields: [],
    askedFields: [],
    currentQuestion: "gender",
    revision: 2,
    acceptedFields: ["first_name"],
    rejectedFields: [],
    needsClarification: false,
    unparsedAnswer: false,
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
  userUpdateMany.mockReset();
  userUpdateMany.mockResolvedValue({ count: 0 });
  profileUpsert.mockReset();
  cityWaitlistUpsert.mockReset();
  cityWaitlistDeleteMany.mockReset();
  cityWaitlistDeleteMany.mockResolvedValue({ count: 0 });
  createAndSendOtp.mockReset();
  getOtpChallengeState.mockReset();
  verifyOtp.mockReset();
  applyOnboardingFacts.mockReset();
  applyOnboardingFacts.mockResolvedValue(collectorSnapshot());
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

  it("never echoes an unverified email or its challenge state", async () => {
    // A legacy row written by the old request step still carries an address it
    // never proved. Echoing it (with the live code timing of that mailbox) is
    // what the fix stopped trusting — audit A13-C1.
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
    expect(getOtpChallengeState).not.toHaveBeenCalled();
    expect(res.body.user.email).toBeNull();
    expect(res.body.user.emailVerification.status).toBe("none");
  });

  it("echoes a verified email", async () => {
    userFindUnique.mockResolvedValue(miniUser({ isEmailVerified: true }));

    const res = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${signInitData()}`);

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("alice@stanford.edu");
    expect(res.body.user.isEmailVerified).toBe(true);
  });

  it("returns challenge timing after sending an OTP, without writing the address to the user", async () => {
    const current = miniUser({ isEmailVerified: false, email: null });
    routeUserLookups(current);
    userUpdate.mockResolvedValue(current);
    createAndSendOtp.mockResolvedValue({
      ok: true,
      sent: true,
      state: {
        status: "pending",
        expiresAt: new Date("2026-06-07T10:10:00.000Z"),
        resendAvailableAt: new Date("2026-06-07T10:00:30.000Z"),
        attemptsRemaining: 5,
      },
    });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(200);
    expect(createAndSendOtp).toHaveBeenCalledWith("alice@stanford.edu", { plusAlias: "refuse" });
    expect(res.body.emailVerification).toEqual({
      status: "pending",
      expiresAt: "2026-06-07T10:10:00.000Z",
      resendAvailableAt: "2026-06-07T10:00:30.000Z",
      attemptsRemaining: 5,
    });
    // Regression, audit A13-C1: the request step used to write `email`,
    // `universityDomain` and `isEmailVerified: false` here — which is how an
    // unproven address squatted a row. Only activity bookkeeping remains.
    for (const [call] of userUpdate.mock.calls) {
      expect(call.data).not.toHaveProperty("email");
      expect(call.data).not.toHaveProperty("universityDomain");
      expect(call.data).not.toHaveProperty("isEmailVerified");
    }
  });

  it("enforces the resend cooldown without creating another challenge", async () => {
    const current = miniUser({ isEmailVerified: false });
    routeUserLookups(current);
    createAndSendOtp.mockResolvedValue({
      ok: true,
      sent: false,
      state: {
        status: "pending",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        resendAvailableAt: new Date(Date.now() + 30_000),
        attemptsRemaining: 5,
      },
    });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("otp-cooldown");
    expect(res.body.emailVerification.status).toBe("pending");
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
    // Launched markets ride along so the Mini App can offer them in one tap.
    expect(res.body.user.supportedCities).toMatchObject([{ homeCityKey: "ua:kyiv" }]);
  });

  it("waitlists a city on the expansion list instead of saving it as home", async () => {
    // The load-bearing assertion is `profileUpsert` NOT being called: a
    // waitlist key in `Profile.homeCityKey` is the matching boundary, and the
    // second person waiting in Berlin would be paired with the first for a
    // date in a city with no venues.
    const user = miniUser();
    const entry = {
      cityKey: "de:berlin",
      city: "Berlin",
      countryCode: "DE",
      createdAt: new Date("2026-09-04T10:00:00.000Z"),
    };
    userFindUnique.mockResolvedValue(user);
    cityWaitlistUpsert.mockResolvedValue(entry);
    userUpdate.mockResolvedValue(miniUser({ cityWaitlistEntry: entry }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/city/select")
      .set("Authorization", `tma ${signInitData()}`)
      .send({
        homeCity: "Berlin",
        homeCountryCode: "DE",
        homeCityKey: "de:berlin",
        latitude: 52.52,
        longitude: 13.405,
      });

    expect(res.status).toBe(200);
    expect(profileUpsert).not.toHaveBeenCalled();
    expect(cityWaitlistUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: user.id },
        // Name and country come from our catalog, never from the request.
        create: { userId: user.id, cityKey: "de:berlin", city: "Berlin", countryCode: "DE" },
      }),
    );
    expect(res.body.user.cityWaitlist).toMatchObject({
      cityKey: "de:berlin",
      city: "Berlin",
      countryCode: "DE",
    });
    expect(res.body.user.homeLocation).toBeNull();
  });

  it("refuses a city that is in neither tier of the catalog", async () => {
    userFindUnique.mockResolvedValue(miniUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/city/select")
      .set("Authorization", `tma ${signInitData()}`)
      .send({
        homeCity: "Warsaw",
        homeCountryCode: "PL",
        homeCityKey: "pl:warsaw",
        latitude: 52.2297,
        longitude: 21.0122,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("city-not-supported");
    expect(profileUpsert).not.toHaveBeenCalled();
    expect(cityWaitlistUpsert).not.toHaveBeenCalled();
  });

  it("clears a waitlist row when the user settles on a launched market", async () => {
    const user = miniUser({
      cityWaitlistEntry: {
        cityKey: "de:berlin",
        city: "Berlin",
        countryCode: "DE",
        createdAt: new Date("2026-09-04T10:00:00.000Z"),
      },
    });
    const savedProfile = {
      homeCity: "Kyiv",
      homeCountryCode: "UA",
      homeCityKey: "ua:kyiv",
      homePlaceId: null,
      latitude: 50.4501,
      longitude: 30.5234,
      locationUpdatedAt: new Date("2026-09-04T11:00:00.000Z"),
    };
    userFindUnique.mockResolvedValue(user);
    profileUpsert.mockResolvedValue(savedProfile);
    userFindUniqueOrThrow.mockResolvedValue(
      miniUser({ profile: savedProfile, cityWaitlistEntry: null }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/city/select")
      .set("Authorization", `tma ${signInitData()}`)
      .send({
        homeCity: "Kyiv",
        homeCountryCode: "UA",
        homeCityKey: "ua:kyiv",
        latitude: 50.4501,
        longitude: 30.5234,
      });

    expect(res.status).toBe(200);
    // Left behind, the row would keep routing this Kyiv user to the waitlist
    // screen forever and inflate Berlin's demand count.
    expect(cityWaitlistDeleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
    expect(res.body.user.cityWaitlist).toBeNull();
  });

  it("leaves the waitlist on request and routes back to the picker", async () => {
    const user = miniUser({
      cityWaitlistEntry: {
        cityKey: "de:berlin",
        city: "Berlin",
        countryCode: "DE",
        createdAt: new Date("2026-09-04T10:00:00.000Z"),
      },
    });
    userFindUnique.mockResolvedValue(user);
    userUpdate.mockResolvedValue(miniUser({ cityWaitlistEntry: null }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/city/waitlist/leave")
      .set("Authorization", `tma ${signInitData()}`)
      .send({});

    expect(res.status).toBe(200);
    expect(cityWaitlistDeleteMany).toHaveBeenCalledWith({ where: { userId: user.id } });
    expect(res.body.user.cityWaitlist).toBeNull();
  });

  it("offers the whole catalog in search, each hit carrying its status", async () => {
    userFindUnique.mockResolvedValue(miniUser());
    const app = buildApp();

    const kyiv = await request(app)
      .get("/v1/telegram-onboarding/city/search?q=Киев")
      .set("Authorization", `tma ${signInitData()}`);
    expect(kyiv.body.results).toMatchObject([
      { homeCityKey: "ua:kyiv", status: "active" },
    ]);

    const berlin = await request(app)
      .get("/v1/telegram-onboarding/city/search?q=Berlin")
      .set("Authorization", `tma ${signInitData()}`);
    expect(berlin.body.results).toMatchObject([
      { homeCityKey: "de:berlin", status: "waitlist" },
    ]);

    // A city in neither tier is still not a city this product knows.
    const warsaw = await request(app)
      .get("/v1/telegram-onboarding/city/search?q=Warsaw")
      .set("Authorization", `tma ${signInitData()}`);
    expect(warsaw.body.results).toEqual([]);
  });

  it("names a waitlist city for geolocation without calling it supported", async () => {
    userFindUnique.mockResolvedValue(miniUser());
    const app = buildApp();

    const inside = await request(app)
      .post("/v1/telegram-onboarding/city/resolve")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ latitude: 50.4501, longitude: 30.5234 });
    expect(inside.body).toMatchObject({
      supported: true,
      city: { homeCityKey: "ua:kyiv" },
    });

    // `supported` still means "launched", so an older cached bundle reads it
    // first and shows its "not launched here" note rather than saving.
    const berlin = await request(app)
      .post("/v1/telegram-onboarding/city/resolve")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ latitude: 52.52, longitude: 13.405 });
    expect(berlin.body).toMatchObject({
      supported: false,
      city: { homeCityKey: "de:berlin", status: "waitlist" },
    });

    const nowhere = await request(app)
      .post("/v1/telegram-onboarding/city/resolve")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ latitude: 52.2297, longitude: 21.0122 });
    expect(nowhere.body).toMatchObject({ supported: false, city: null });
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

describe("AI-memory export kill switch (AI_MEMORY_EXPORT_ENABLED)", () => {
  afterEach(() => {
    mutableEnv.AI_MEMORY_EXPORT_ENABLED = true;
  });

  it("404s /ai-memory while the feature is off and persists nothing", async () => {
    mutableEnv.AI_MEMORY_EXPORT_ENABLED = false;
    userFindUnique.mockResolvedValue(miniUser({}));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/ai-memory")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ preference: "accepted" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("ai-memory-export-disabled");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("mirrors the flag to the Mini App in /state", async () => {
    mutableEnv.AI_MEMORY_EXPORT_ENABLED = false;
    userFindUnique.mockResolvedValue(miniUser({}));

    const res = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${signInitData()}`);

    expect(res.status).toBe(200);
    expect(res.body.user.aiMemoryExportEnabled).toBe(false);
    // The stored preference is untouched by the flag — flipping it back on
    // must restore the branch with no backfill.
    expect(res.body.user.aiMemoryExportPreference).toBe("undecided");
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

describe("Telegram onboarding profile screens", () => {
  it("rejects an unauthenticated save", async () => {
    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .send({ firstName: "Alice" });

    expect(res.status).toBe(401);
    expect(applyOnboardingFacts).not.toHaveBeenCalled();
  });

  it("refuses to save before the dating city is set", async () => {
    userFindUnique.mockResolvedValue(miniUser({ profile: null }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ firstName: "Alice" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("location-required");
    expect(applyOnboardingFacts).not.toHaveBeenCalled();
  });

  it("saves one field per screen and mirrors it back in state", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());
    userFindUniqueOrThrow.mockResolvedValue(profileReadyUser({ firstName: "Alice" }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ firstName: "Alice" });

    expect(res.status).toBe(200);
    expect(applyOnboardingFacts).toHaveBeenCalledWith(BigInt(TELEGRAM_ID), {
      first_name: "Alice",
    });
    expect(res.body.user.profileBasics.firstName).toBe("Alice");
    expect(res.body.user.profileBasics.height).toBeNull();
  });

  it("passes the relationship intents through to the collector", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());
    userFindUniqueOrThrow.mockResolvedValue(profileReadyUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ relationshipIntents: ["spark", "falling"] });

    expect(res.status).toBe(200);
    // Whitelisted and canonicalised downstream by `validateFactValue`, not here
    // — the route only shape-checks, so one list of legal ids and one ordering
    // govern every write path.
    expect(applyOnboardingFacts).toHaveBeenCalledWith(BigInt(TELEGRAM_ID), {
      relationship_intent: ["spark", "falling"],
    });
  });

  it("shape-checks a non-array intent before the collector sees it", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ relationshipIntents: "spark" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-relationship-intent");
    expect(applyOnboardingFacts).not.toHaveBeenCalled();
  });

  it("shape-checks a non-string member before the collector sees it", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ relationshipIntents: ["spark", 3] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-relationship-intent");
    expect(applyOnboardingFacts).not.toHaveBeenCalled();
  });

  it("maps a value the collector rejected onto a 400 naming the field", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());
    applyOnboardingFacts.mockResolvedValue(
      collectorSnapshot({
        acceptedFields: [],
        rejectedFields: [{ field: "age", reason: "age_out_of_range" }],
      }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ age: 12 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "age_out_of_range", field: "age" });
  });

  it("shape-checks before the collector sees anything", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());

    const bad = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ age: "twenty" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid-age");

    const empty = await request(buildApp())
      .post("/v1/telegram-onboarding/profile")
      .set("Authorization", `tma ${signInitData()}`)
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("no-fields");

    expect(applyOnboardingFacts).not.toHaveBeenCalled();
  });

  it("serves the age and height bounds so the bundle never inlines them", async () => {
    userFindUnique.mockResolvedValue(profileReadyUser());

    const res = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${signInitData()}`);

    expect(res.status).toBe(200);
    expect(res.body.user.profileLimits).toEqual({
      minAge: 18,
      maxAge: 55,
      minHeightCm: 140,
      maxHeightCm: 220,
    });
  });

  it("hands off to the chat even with every profile field still empty", async () => {
    // Fail-open by design (PRODUCT_SPEC §1.3): a cached older bundle, the iOS
    // rail and a legacy mid-flight user must not dead-end at the handoff — the
    // chat asks for whatever the Mini App never delivered.
    const user = profileReadyUser({
      onboardingStep: "conversational",
      aiMemoryExportPreference: "declined",
      messageHistory: [{ role: "assistant", content: "What are you into?" }],
    });
    userFindUnique.mockResolvedValue(user);
    userUpdate.mockResolvedValue(user);
    const initData = signInitData();

    const state = await request(buildApp())
      .get("/v1/telegram-onboarding/state")
      .set("Authorization", `tma ${initData}`);
    expect(state.body.user.profileBasics.firstName).toBeNull();

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/complete")
      .set("Authorization", `tma ${initData}`)
      .send({ completedVisualIntro: true, flowToken: state.body.flowToken });

    expect(res.status).toBe(200);
    expect(res.body.botTookOver).toBe(true);
  });
});

describe("Telegram onboarding email ownership (audit A13)", () => {
  const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
  const sentState = {
    ok: true,
    sent: true,
    state: {
      status: "pending",
      expiresAt: new Date("2026-06-07T10:10:00.000Z"),
      resendAvailableAt: new Date("2026-06-07T10:00:30.000Z"),
      attemptsRemaining: 5,
    },
  };

  it("answers a request for an address linked to another account exactly like a normal send — and delivers nothing", async () => {
    const current = miniUser({ isEmailVerified: false, email: null });
    routeUserLookups(current, {
      "victim@stanford.edu": { id: OTHER_ACCOUNT_ID, isEmailVerified: true },
    });
    userUpdate.mockResolvedValue(current);
    createAndSendOtp.mockResolvedValue(sentState);

    const linked = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "victim@stanford.edu" });

    // Regression, A13-M10: this used to be 409 `email-linked-to-other-account`,
    // telling any Telegram account that the student has a dating profile.
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({
      ok: true,
      alreadyVerified: false,
      emailVerification: {
        status: "pending",
        expiresAt: "2026-06-07T10:10:00.000Z",
        resendAvailableAt: "2026-06-07T10:00:30.000Z",
        attemptsRemaining: 5,
      },
    });
    // The same state machine runs, but no code reaches the owner's mailbox.
    expect(createAndSendOtp).toHaveBeenCalledWith("victim@stanford.edu", {
      plusAlias: "refuse",
      send: discardOtpDelivery,
    });
  });

  it("treats an UNVERIFIED holder elsewhere as no owner and sends a real code", async () => {
    const current = miniUser({ isEmailVerified: false, email: null });
    routeUserLookups(current, {
      "alice@stanford.edu": { id: OTHER_ACCOUNT_ID, isEmailVerified: false },
    });
    userUpdate.mockResolvedValue(current);
    createAndSendOtp.mockResolvedValue(sentState);

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(200);
    expect(createAndSendOtp).toHaveBeenCalledWith("alice@stanford.edu", { plusAlias: "refuse" });
  });

  it("maps a spent daily budget to 429 otp-daily-limit", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false, email: null }));
    createAndSendOtp.mockResolvedValue({ ok: false, reason: "daily_cap" });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu" });

    expect(res.status).toBe(429);
    expect(res.body.error).toBe("otp-daily-limit");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses a plus-tagged address with 400 email-plus-alias", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false, email: null }));
    createAndSendOtp.mockResolvedValue({ ok: false, reason: "plus_alias" });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/request")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice+2@stanford.edu" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("email-plus-alias");
  });

  it("verifies the address from the request body, not a stale one on the row", async () => {
    // The row carries an address written by the OLD request step and never
    // proven. It must play no part: the code is checked against — and the
    // account receives — the address the client is verifying.
    const current = miniUser({
      isEmailVerified: false,
      email: "squatted@stanford.edu",
      onboardingStep: "language",
    });
    routeUserLookups(current);
    verifyOtp.mockResolvedValue({ ok: true });
    userUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      miniUser({ ...data, isEmailVerified: true }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "Alice@Stanford.edu", code: "123456" });

    expect(res.status).toBe(200);
    expect(verifyOtp).toHaveBeenCalledWith("alice@stanford.edu", "123456");
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: current.id },
        data: expect.objectContaining({
          email: "alice@stanford.edu",
          universityDomain: "stanford.edu",
          isEmailVerified: true,
          registrationTrack: "student",
        }),
      }),
    );
    expect(res.body.user.email).toBe("alice@stanford.edu");
  });

  it("refuses verify without an address in the body", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false }));

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ code: "123456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-email");
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("fails like any wrong code for an address whose code was never delivered", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false, email: null }), {
      "victim@stanford.edu": { id: OTHER_ACCOUNT_ID, isEmailVerified: true },
    });
    verifyOtp.mockResolvedValue({ ok: false, reason: "mismatch" });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "victim@stanford.edu", code: "000000" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mismatch");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses to attach a proven address that another account verified first", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false, email: null }), {
      "alice@stanford.edu": { id: OTHER_ACCOUNT_ID, isEmailVerified: true },
    });
    verifyOtp.mockResolvedValue({ ok: true });

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu", code: "123456" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email-linked-to-other-account");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("maps a unique collision from a concurrent verification to linked-elsewhere, not a 500", async () => {
    routeUserLookups(miniUser({ isEmailVerified: false, email: null }));
    verifyOtp.mockResolvedValue({ ok: true });
    userUpdate.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
        code: "P2002",
      }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu", code: "123456" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("email-linked-to-other-account");
  });

  it("takes a proven address off a row that only squatted it", async () => {
    const current = miniUser({ isEmailVerified: false, email: null });
    routeUserLookups(current, {
      "alice@stanford.edu": { id: OTHER_ACCOUNT_ID, isEmailVerified: false },
    });
    verifyOtp.mockResolvedValue({ ok: true });
    userUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
      miniUser({ ...data, isEmailVerified: true }),
    );

    const res = await request(buildApp())
      .post("/v1/telegram-onboarding/email/verify")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ email: "alice@stanford.edu", code: "123456" });

    expect(res.status).toBe(200);
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: {
        email: "alice@stanford.edu",
        isEmailVerified: false,
        id: { not: current.id },
      },
      data: { email: null, universityDomain: null },
    });
  });
});
