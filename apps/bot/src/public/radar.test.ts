import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { FEMALE_PHOTOS, MALE_PHOTOS } from "@gennety/shared";

const BOT_TOKEN = "123456:test-bot-token-for-radar";
const TELEGRAM_ID = 5986970093;

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
    DATABASE_URL: "postgresql://test",
    TYPE_RADAR_ENABLED: true,
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

const { createRadarRouter } = await import("./routes/radar.js");
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
  app.use("/v1/radar", createRadarRouter());
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

  it("returns the female deck + chips for a women-preferring viewer", async () => {
    userFindUnique.mockResolvedValue({ age: 24, preference: "women", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    expect(res.body.band).toBe("a");
    expect(res.body.cards).toHaveLength(FEMALE_PHOTOS.length);
    expect(res.body.cards.every((c: { set: string }) => c.set === "female")).toBe(true);
    expect(res.body.cards[0].image).toMatch(/^radar\/a\/[a-z0-9]+\.jpg$/);
    expect(res.body.chips.female.like.length).toBeGreaterThan(0);
    expect(res.body.chips.male).toBeUndefined();
  });

  it("returns both sets for a `both` viewer", async () => {
    userFindUnique.mockResolvedValue({ age: 40, preference: "both", language: "en" });
    const res = await request(buildApp())
      .get("/v1/radar/deck")
      .set("Authorization", `tma ${signInitData()}`);
    expect(res.status).toBe(200);
    expect(res.body.band).toBe("c");
    expect(res.body.cards).toHaveLength(FEMALE_PHOTOS.length + MALE_PHOTOS.length);
    expect(res.body.chips.female).toBeDefined();
    expect(res.body.chips.male).toBeDefined();
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
});
