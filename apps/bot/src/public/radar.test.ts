import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import jwt from "jsonwebtoken";
import { FEMALE_PHOTOS, MALE_PHOTOS } from "@gennety/shared";

const BOT_TOKEN = "123456:test-bot-token-for-radar";
const TELEGRAM_ID = 5986970093;
const JWT_SECRET = "test-jwt-secret-value-long-enough-for-radar";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WEBAPP_URL = "https://app.example.test/calendar/";

type DeckCard = {
  photoId: string;
  set: string;
  image: string;
  imageUrl: string;
  chips: { like: { id: string }[]; dislike: { id: string }[] };
};

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
    DATABASE_URL: "postgresql://test",
    TYPE_RADAR_ENABLED: true,
    JWT_SECRET,
    WEBAPP_URL,
  },
}));

const userFindUnique = vi.fn();
const profileUpsert = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique },
    profile: { upsert: profileUpsert },
  },
}));

// The chat-side continuation runs detached, after the response — stub it so the
// route's ordering and gating can be asserted without a real bot.
const radarHandler = vi.hoisted(() => ({
  runRadarThinkingThenResume: vi.fn(),
  resumeOnboardingAfterRadar: vi.fn(),
  patchOnboardingSession: vi.fn(),
}));
vi.mock("../handlers/onboarding/type-radar.js", () => radarHandler);

const { createRadarRouter, radarImageUrl } = await import("./routes/radar.js");
const { dispatchToChat, waitForChatQueueIdle } = await import("../chat-queue.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("./jwt.js");

function bearer(sub: string = USER_ID): string {
  const token = jwt.sign({ sub, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  return `Bearer ${token}`;
}
const mutableEnv = (await import("../config.js")).env as unknown as {
  TYPE_RADAR_ENABLED: boolean;
};

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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/radar", createRadarRouter(null));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mutableEnv.TYPE_RADAR_ENABLED = true;
});

describe("GET /v1/radar/deck", () => {
  it("401s without initData", async () => {
    const res = await request(buildApp()).get("/v1/radar/deck");
    expect(res.status).toBe(401);
  });

  it("404s when the feature is off", async () => {
    mutableEnv.TYPE_RADAR_ENABLED = false;
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("type-radar-disabled");
  });

  it("409s when age/preference are not yet collected", async () => {
    userFindUnique.mockResolvedValue({ age: null, preference: null, language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("profile-not-ready");
  });

  it("returns the female deck with per-card chips for a women-preferring viewer", async () => {
    userFindUnique.mockResolvedValue({ age: 24, preference: "women", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    expect(res.body.band).toBe("a");
    const cards = res.body.cards as DeckCard[];
    expect(cards).toHaveLength(FEMALE_PHOTOS.length);
    expect(cards.every((c) => c.set === "female")).toBe(true);
    expect(cards[0]!.image).toMatch(/^radar\/a\/[a-z0-9]+\.jpg$/);
    // Chips are per-card now, not a top-level set map.
    expect(res.body.chips).toBeUndefined();
    expect(cards[0]!.chips.like.length).toBeGreaterThan(0);
    expect(cards[0]!.chips.dislike.length).toBeGreaterThan(0);
    // The female set never offers a beard chip on any card.
    expect(cards.every((c) => c.chips.like.every((ch) => ch.id !== "beard"))).toBe(true);
  });

  it("returns both sets, each card carrying its own chips, for a `both` viewer", async () => {
    userFindUnique.mockResolvedValue({ age: 26, preference: "both", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    expect(res.body.band).toBe("a");
    const cards = res.body.cards as DeckCard[];
    expect(cards).toHaveLength(FEMALE_PHOTOS.length + MALE_PHOTOS.length);
    const sets = new Set(cards.map((c) => c.set));
    expect(sets.has("female")).toBe(true);
    expect(sets.has("male")).toBe(true);
    expect(
      cards.every((c) => Array.isArray(c.chips.like) && Array.isArray(c.chips.dislike)),
    ).toBe(true);
  });

  it("scopes reason chips to each photo — no beard/tattoo chip when the person lacks them", async () => {
    userFindUnique.mockResolvedValue({ age: 24, preference: "men", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    const cards = res.body.cards as DeckCard[];
    const byId = (id: string): DeckCard => cards.find((c) => c.photoId === id)!;
    const ids = (c: DeckCard, v: "like" | "dislike"): string[] => c.chips[v].map((x) => x.id);
    // Found by predicate rather than by id: the matrix is a product decision
    // that moves, and a hardcoded id turns a deck edit into a mystery failure
    // in a test that is not about the deck.
    const cleanNoTattoo = byId(
      MALE_PHOTOS.find((p) => p.attrs.beard === "clean" && p.attrs.tattoos === "no")!.id,
    );
    const beardedTattoo = byId(
      MALE_PHOTOS.find((p) => p.attrs.beard === "beard" && p.attrs.tattoos === "yes")!.id,
    );
    // Clean-shaven with no tattoos → neither chip is offered, on like or dislike.
    expect(ids(cleanNoTattoo, "like")).not.toContain("beard");
    expect(ids(cleanNoTattoo, "like")).not.toContain("tattoo");
    expect(ids(cleanNoTattoo, "dislike")).not.toContain("beard");
    expect(ids(cleanNoTattoo, "dislike")).not.toContain("tattoo");
    // Bearded + tattooed → both chips are offered.
    expect(ids(beardedTattoo, "like")).toContain("beard");
    expect(ids(beardedTattoo, "like")).toContain("tattoo");
  });

  it("409s when the viewer's age band has no deployed portrait set (v1 = band A only)", async () => {
    userFindUnique.mockResolvedValue({ age: 45, preference: "women", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("band-not-live");
  });
});

describe("POST /v1/radar/submit", () => {
  it("400s on an empty answer list", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", age: 24, preference: "women" });
    const res = await request(buildApp())
      .post("/v1/radar/submit")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ answers: [] });
    expect(res.status).toBe(400);
  });

  it("compiles a per-set vector and upserts it, ignoring foreign-set photos", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", age: 24, preference: "women" });
    profileUpsert.mockResolvedValue(undefined);
    const answers = [
      // like every blonde, dislike the rest — clean female-set signal
      ...FEMALE_PHOTOS.map((p) => ({
        photoId: p.id,
        verdict: p.attrs.hairColor === "blonde" ? "like" : "dislike",
      })),
      // a male photo id must be ignored for a women-preferring viewer
      { photoId: MALE_PHOTOS[0]!.id, verdict: "like" },
    ];
    const res = await request(buildApp())
      .post("/v1/radar/submit")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ answers });
    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(FEMALE_PHOTOS.length); // male photo excluded

    expect(profileUpsert).toHaveBeenCalledTimes(1);
    const arg = profileUpsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ userId: "u1" });
    expect(arg.update.typeRadarAgeBand).toBe("a");
    expect(arg.update.typePrefTags.female).toBeDefined();
    expect(arg.update.typePrefTags.male).toBeUndefined();
    // The blonde preference must be positive in the compiled vector.
    expect(arg.update.typePrefTags.female.hairColor.blonde.weight).toBeGreaterThan(0);
    expect(arg.update.typeRadarAnswers).toHaveLength(FEMALE_PHOTOS.length);
  });

  it("rejects an invalid verdict", async () => {
    userFindUnique.mockResolvedValue({ id: "u1", age: 24, preference: "women" });
    const res = await request(buildApp())
      .post("/v1/radar/submit")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ answers: [{ photoId: FEMALE_PHOTOS[0]!.id, verdict: "maybe" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-verdict");
  });

  it("(RADAR-1) merges into the existing typePrefTags instead of overwriting a retake that only rates one set", async () => {
    // A `both`-preference viewer already has a compiled male-set vector on
    // file (e.g. from an earlier full pass); this submission only rates the
    // female set. The previously-stored male vector must survive.
    const existingMaleVector = { hairColor: { black: { weight: 0.4, count: 3 } } };
    userFindUnique.mockResolvedValue({
      id: "u1",
      age: 24,
      preference: "both",
      profile: { typePrefTags: { male: existingMaleVector } },
    });
    profileUpsert.mockResolvedValue(undefined);

    const answers = FEMALE_PHOTOS.map((p) => ({
      photoId: p.id,
      verdict: p.attrs.hairColor === "blonde" ? "like" : "dislike",
    }));
    const res = await request(buildApp())
      .post("/v1/radar/submit")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ answers });

    expect(res.status).toBe(200);
    const arg = profileUpsert.mock.calls[0]![0];
    // The freshly-rated female set is compiled...
    expect(arg.update.typePrefTags.female).toBeDefined();
    // ...and the previously-stored male set is preserved, not dropped.
    expect(arg.update.typePrefTags.male).toEqual(existingMaleVector);
  });
});

// ---------------------------------------------------------------------------
// The chat-side continuation: the ~10s thinking sequence, then the onboarding
// resume (TYPE_RADAR_PRODUCT_SPEC.md). It runs DETACHED, after the response.
// ---------------------------------------------------------------------------
describe("POST /v1/radar/submit — chat continuation", () => {
  const api = {} as never;

  function appWithBot() {
    const app = express();
    app.use(express.json());
    app.use("/v1/radar", createRadarRouter(api));
    return app;
  }

  const answers = FEMALE_PHOTOS.map((p) => ({ photoId: p.id, verdict: "like" }));

  function submit() {
    return request(appWithBot())
      .post("/v1/radar/submit")
      .set("Authorization", `tma ${signInitData()}`)
      .send({ answers });
  }

  beforeEach(() => {
    profileUpsert.mockResolvedValue(undefined);
    radarHandler.runRadarThinkingThenResume.mockResolvedValue({ sessionPatch: { expectingPhoto: true } });
    radarHandler.resumeOnboardingAfterRadar.mockResolvedValue({ sessionPatch: { expectingPhoto: true } });
    radarHandler.patchOnboardingSession.mockResolvedValue(undefined);
  });

  it("answers the Mini App BEFORE playing the ~10s sequence", async () => {
    let resolveSequence: (v: unknown) => void = () => {};
    radarHandler.runRadarThinkingThenResume.mockReturnValue(
      new Promise((r) => {
        resolveSequence = r;
      }),
    );
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "conversational", profile: null,
    });

    // Blocking the response on the sequence would strand the user on the Mini
    // App's spinner and then play the beats to a chat they can't see yet.
    const res = await submit();
    expect(res.status).toBe(200);
    expect(radarHandler.patchOnboardingSession).not.toHaveBeenCalled();

    resolveSequence({ sessionPatch: { expectingPhoto: true } });
    await vi.waitFor(() => expect(radarHandler.patchOnboardingSession).toHaveBeenCalled());
  });

  it("plays the sequence on the first completion", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "conversational",
      profile: { typePrefTags: null, typeRadarCompletedAt: null },
    });

    await submit();

    await vi.waitFor(() => expect(radarHandler.runRadarThinkingThenResume).toHaveBeenCalledTimes(1));
    expect(radarHandler.resumeOnboardingAfterRadar).not.toHaveBeenCalled();
    expect(radarHandler.patchOnboardingSession).toHaveBeenCalledWith(
      BigInt(TELEGRAM_ID),
      { expectingPhoto: true },
    );
  });

  it("resumes without replaying the sequence on a re-submit", async () => {
    // Sitting through a ~10s animation a second time is worse than no animation.
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "conversational",
      profile: { typePrefTags: null, typeRadarCompletedAt: new Date("2026-07-27T10:00:00Z") },
    });

    await submit();

    await vi.waitFor(() => expect(radarHandler.resumeOnboardingAfterRadar).toHaveBeenCalledTimes(1));
    expect(radarHandler.runRadarThinkingThenResume).not.toHaveBeenCalled();
  });

  it("touches neither on a post-onboarding retake", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "completed",
      profile: { typePrefTags: null, typeRadarCompletedAt: null },
    });

    const res = await submit();
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(profileUpsert).toHaveBeenCalled());
    expect(radarHandler.runRadarThinkingThenResume).not.toHaveBeenCalled();
    expect(radarHandler.resumeOnboardingAfterRadar).not.toHaveBeenCalled();
  });

  // A13-M25: `patchOnboardingSession` is a read-modify-write of the session row.
  // Outside the chat's queue it raced an update the user sent during the ~10s
  // sequence, whose session middleware then wrote its stale copy over the patch.
  it("waits for the chat's in-flight update before resuming and patching the session", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "conversational",
      profile: { typePrefTags: null, typeRadarCompletedAt: null },
    });
    let releaseUpdate: () => void = () => {};
    const updateInFlight = dispatchToChat(
      TELEGRAM_ID,
      () => new Promise<void>((r) => {
        releaseUpdate = r;
      }),
    );

    const res = await submit();
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(radarHandler.runRadarThinkingThenResume).not.toHaveBeenCalled();

    releaseUpdate();
    await updateInFlight;
    await waitForChatQueueIdle(2_000);
    expect(radarHandler.runRadarThinkingThenResume).toHaveBeenCalledTimes(1);
    expect(radarHandler.patchOnboardingSession).toHaveBeenCalledTimes(1);
  });

  it("swallows a failure in the detached continuation", async () => {
    // An escaping rejection here is an unhandled promise rejection, which takes
    // the whole bot process down.
    userFindUnique.mockResolvedValue({
      id: "u1", age: 24, preference: "women", onboardingStep: "conversational", profile: null,
    });
    radarHandler.runRadarThinkingThenResume.mockRejectedValue(new Error("agent down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await submit();
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(warn.mock.calls[0]![0]).toContain("[radar] onboarding resume after submit failed");
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// The native rail. The iOS client has no initData — it signs in with a JWT —
// and has no Mini App page to resolve a relative image path against.
// ---------------------------------------------------------------------------
describe("native client rail (JWT bearer)", () => {
  const api = {} as never;

  function appWithBot() {
    const app = express();
    app.use(express.json());
    app.use("/v1/radar", createRadarRouter(api));
    return app;
  }

  it("serves the deck to a bearer, looked up by user id, with absolute image URLs", async () => {
    userFindUnique.mockResolvedValue({
      telegramId: BigInt(TELEGRAM_ID), age: 24, preference: "women", language: "ru",
    });
    const res = await request(buildApp()).get("/v1/radar/deck").set("Authorization", bearer());

    expect(res.status).toBe(200);
    expect(userFindUnique.mock.calls[0]![0].where).toEqual({ id: USER_ID });
    const cards = res.body.cards as DeckCard[];
    expect(cards).toHaveLength(FEMALE_PHOTOS.length);
    for (const card of cards) {
      // The same file the Mini App resolves relatively, next to radar.html.
      expect(card.imageUrl).toBe(`https://app.example.test/calendar/${card.image}`);
    }
  });

  it("shows the same card order on both rails — the seed is the account, not the client", async () => {
    const row = { telegramId: BigInt(TELEGRAM_ID), age: 24, preference: "women", language: "ru" };
    userFindUnique.mockResolvedValue(row);
    const viaApp = await request(buildApp()).get("/v1/radar/deck").set("Authorization", bearer());
    const viaMiniApp = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);

    const order = (body: { cards: DeckCard[] }) => body.cards.map((c) => c.photoId);
    expect(order(viaApp.body)).toEqual(order(viaMiniApp.body));
    expect(userFindUnique.mock.calls[1]![0].where).toEqual({ telegramId: BigInt(TELEGRAM_ID) });
  });

  it("401s a bad bearer without reading the database or trying the other rail", async () => {
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", "Bearer not-a-token");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid or expired token");
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("401s a request with neither credential", async () => {
    const res = await request(buildApp()).post("/v1/radar/submit").send({ answers: [] });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Missing bearer token or initData");
  });

  it("saves a bearer's submit but never starts the Telegram chat continuation", async () => {
    // Mid-onboarding and a first completion: on the tma rail exactly this row
    // plays the ~10s sequence. From the app it must save and stay silent — the
    // person is not in that chat, and a mobile-first account has no chat at all.
    userFindUnique.mockResolvedValue({
      id: USER_ID, age: 24, preference: "women", onboardingStep: "conversational",
      profile: { typePrefTags: null, typeRadarCompletedAt: null },
    });
    profileUpsert.mockResolvedValue(undefined);
    const answers = FEMALE_PHOTOS.map((p, i) => ({
      photoId: p.id,
      verdict: i % 2 === 0 ? "like" : "dislike",
      ...(i === 0 ? { chipId: "hair" } : {}),
    }));

    const res = await request(appWithBot())
      .post("/v1/radar/submit")
      .set("Authorization", bearer())
      .send({ answers });

    expect(res.status).toBe(200);
    expect(res.body.counted).toBe(FEMALE_PHOTOS.length);
    expect(Number.isNaN(Date.parse(res.body.completedAt))).toBe(false);
    expect(userFindUnique.mock.calls[0]![0].where).toEqual({ id: USER_ID });
    const arg = profileUpsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ userId: USER_ID });
    expect(arg.update.typeRadarCompletedAt.toISOString()).toBe(res.body.completedAt);
    // An omitted chip is stored as "no reason", exactly like the Mini App's null.
    expect(arg.update.typeRadarAnswers[1]).toEqual({
      photoId: FEMALE_PHOTOS[1]!.id, verdict: "dislike", chipId: null,
    });

    await new Promise((r) => setTimeout(r, 20));
    await waitForChatQueueIdle(2_000);
    expect(radarHandler.runRadarThinkingThenResume).not.toHaveBeenCalled();
    expect(radarHandler.resumeOnboardingAfterRadar).not.toHaveBeenCalled();
    expect(radarHandler.patchOnboardingSession).not.toHaveBeenCalled();
  });
});

describe("GET /v1/radar/state", () => {
  it("404s when the feature is off — the client hides the entry", async () => {
    mutableEnv.TYPE_RADAR_ENABLED = false;
    const res = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("type-radar-disabled");
  });

  it("says a viewer in a live band may take it and has not yet", async () => {
    userFindUnique.mockResolvedValue({ age: 22, preference: "men", profile: null });
    const res = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, available: true, calibrated: false });
  });

  it("carries the completion stamp and whether a vector was compiled", async () => {
    const stamp = new Date("2026-09-01T12:00:00.000Z");
    userFindUnique.mockResolvedValue({
      age: 22, preference: "men",
      profile: { typePrefTags: { male: {} }, typeRadarCompletedAt: stamp },
    });
    const res = await request(buildApp())
      .get("/v1/radar/state")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, available: true, completedAt: stamp.toISOString(), calibrated: true,
    });
  });

  it("tells a Telegram skip apart from a calibration", async () => {
    // The skip button stamps completion and compiles nothing.
    userFindUnique.mockResolvedValue({
      age: 22, preference: "men",
      profile: { typePrefTags: null, typeRadarCompletedAt: new Date("2026-09-01T12:00:00Z") },
    });
    const res = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(res.body.completedAt).toBeDefined();
    expect(res.body.calibrated).toBe(false);
  });

  it("is unavailable, with the deck's own reasons, before age/preference and outside a live band", async () => {
    userFindUnique.mockResolvedValue({ age: null, preference: null, profile: null });
    const notReady = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(notReady.body).toMatchObject({ available: false, unavailableReason: "profile-not-ready" });

    userFindUnique.mockResolvedValue({ age: 41, preference: "women", profile: null });
    const notLive = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(notLive.body).toMatchObject({ available: false, unavailableReason: "band-not-live" });
  });

  it("404s an unknown account", async () => {
    userFindUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get("/v1/radar/state").set("Authorization", bearer());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user-not-found");
  });
});

describe("radarImageUrl", () => {
  it("puts the file next to radar.html whatever the base's trailing slash", () => {
    expect(radarImageUrl("radar/a/fp1.jpg", "https://dating-calendar.gennety.com")).toBe(
      "https://dating-calendar.gennety.com/radar/a/fp1.jpg",
    );
    expect(radarImageUrl("radar/a/fp1.jpg", "https://host.test/calendar//")).toBe(
      "https://host.test/calendar/radar/a/fp1.jpg",
    );
    expect(radarImageUrl("radar/a/fp1.jpg", "https://host.test/calendar?x=1#y")).toBe(
      "https://host.test/calendar/radar/a/fp1.jpg",
    );
  });
});
