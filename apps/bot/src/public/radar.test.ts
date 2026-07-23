import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";
import { FEMALE_PHOTOS, MALE_PHOTOS } from "@gennety/shared";

const BOT_TOKEN = "123456:test-bot-token-for-radar";
const TELEGRAM_ID = 5986970093;

type DeckCard = {
  photoId: string;
  set: string;
  image: string;
  chips: { like: { id: string }[]; dislike: { id: string }[] };
};

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
    const cleanNoTattoo = byId("m01"); // beard: clean, tattoos: no
    const beardedTattoo = byId("m03"); // beard: beard, tattoos: yes
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
