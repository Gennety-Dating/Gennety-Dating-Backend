import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `/v1/me/share/*` — the iOS share sheet for a short video (decision journal
 * 2026-10-24): the switch, the read, the question and «＋ Интерес».
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = {
  JWT_SECRET,
  OPENAI_API_KEY: "k",
  WISHLIST_FEATURE_ENABLED: true,
  SHORT_VIDEO_FETCH_TIMEOUT_MS: 8000,
};
vi.mock("../../config.js", () => ({ env }));
vi.mock("../../services/usage-limiter.js", () => ({
  usageLimiter: { isOverDailyBudget: () => false, isGlobalBudgetExceeded: () => false },
}));

let hobbies: string[] | null = ["Бег"];
const profileUpdates: unknown[] = [];
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: async () => ({
        status: "active",
        onboardingStep: "completed",
        suspendedUntil: null,
        language: "ru",
        profile: { homeCityKey: "kyiv" },
      }),
    },
    profile: {
      findUnique: async () => (hobbies ? { hobbies } : null),
      update: async (args: { data: { hobbies: string[] } }) => {
        profileUpdates.push(args.data);
        hobbies = args.data.hobbies;
        return {};
      },
    },
  },
}));

const { createShareRouter } = await import("./share.js");
const { clearShareVideoCache } = await import("../../services/share-video/read.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

let analyzeCalls = 0;
let askAnswer = "Это Mad Heads на Ярославовом Валу, 15.";
let metadataGone = false;

function app() {
  const a = express();
  a.use(express.json());
  a.use(
    "/v1/me/share",
    createShareRouter({
      read: {
        metadata: async (ref) =>
          metadataGone ? null : { ref, caption: "Флэт уайт на Подоле", author: "kyiv.coffee" },
        poster: async () => null,
        analyze: async () => {
          analyzeCalls += 1;
          return {
            safe: true,
            title: "Лучший флэт уайт на Подоле",
            summary: "Кофейня у окна.",
            coverDescription: "",
            interest: "Спешелти-кофе",
            item: { title: "Mad Heads", kind: "place", category: "place", query: "Mad Heads Kyiv" },
            questions: ["Где это?"],
          };
        },
      },
      ask: { complete: async () => askAnswer },
    }),
  );
  return a;
}

const auth = () => ({
  Authorization: `Bearer ${jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});

const REEL = "https://www.instagram.com/reel/C9xYzAbc/?igsh=abc";

beforeEach(() => {
  env.WISHLIST_FEATURE_ENABLED = true;
  hobbies = ["Бег"];
  profileUpdates.length = 0;
  analyzeCalls = 0;
  askAnswer = "Это Mad Heads на Ярославовом Валу, 15.";
  metadataGone = false;
  clearShareVideoCache();
});

describe("switch and auth", () => {
  it("404 feature-disabled while the wishlist is off", async () => {
    env.WISHLIST_FEATURE_ENABLED = false;
    const res = await request(app()).post("/v1/me/share/video").set(auth()).send({ url: REEL });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "feature-disabled" });
  });

  it("401 without a token", async () => {
    const res = await request(app()).post("/v1/me/share/video").send({ url: REEL });
    expect(res.status).toBe(401);
  });
});

describe("POST /video", () => {
  it("reads a reel", async () => {
    const res = await request(app()).post("/v1/me/share/video").set(auth()).send({ url: REEL });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "read",
      platform: "instagram",
      url: "https://www.instagram.com/reel/C9xYzAbc/",
      author: "kyiv.coffee",
      title: "Лучший флэт уайт на Подоле",
      interest: { label: "Спешелти-кофе" },
      item: { title: "Mad Heads", kind: "place", category: "place", query: "Mad Heads Kyiv" },
      questions: ["Где это?"],
    });
    expect(res.body.posterUrl).toBeUndefined();
  });

  it("a shop link → 400 not-video; no url → 400 bad-request", async () => {
    const shop = await request(app()).post("/v1/me/share/video").set(auth()).send({ url: "https://www.cos.com/x" });
    expect(shop.status).toBe(400);
    expect(shop.body).toEqual({ error: "not-video" });
    const empty = await request(app()).post("/v1/me/share/video").set(auth()).send({});
    expect(empty.body).toEqual({ error: "bad-request" });
  });

  it("closed video → status closed", async () => {
    metadataGone = true;
    const res = await request(app()).post("/v1/me/share/video").set(auth()).send({ url: REEL });
    expect(res.body).toEqual({ status: "closed", platform: "instagram", url: "https://www.instagram.com/reel/C9xYzAbc/", questions: [] });
  });
});

describe("POST /video/ask", () => {
  it("answers from the cached read", async () => {
    const a = app();
    await request(a).post("/v1/me/share/video").set(auth()).send({ url: REEL });
    const res = await request(a)
      .post("/v1/me/share/video/ask")
      .set(auth())
      .send({ url: REEL, question: "Где это?", history: [{ question: "Что это?", answer: "Кофейня." }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ answer: "Это Mad Heads на Ярославовом Валу, 15." });
    expect(analyzeCalls).toBe(1);
  });

  it("bad body → 400; closed → 422; empty answer → 503", async () => {
    const tooMuch = Array.from({ length: 5 }, () => ({ question: "q", answer: "a" }));
    expect((await request(app()).post("/v1/me/share/video/ask").set(auth()).send({ url: REEL, question: "q", history: tooMuch })).status).toBe(400);
    expect((await request(app()).post("/v1/me/share/video/ask").set(auth()).send({ url: REEL, question: "" })).status).toBe(400);

    askAnswer = "";
    expect((await request(app()).post("/v1/me/share/video/ask").set(auth()).send({ url: REEL, question: "q" })).status).toBe(503);

    clearShareVideoCache();
    metadataGone = true;
    expect((await request(app()).post("/v1/me/share/video/ask").set(auth()).send({ url: REEL, question: "q" })).status).toBe(422);
  });
});

describe("POST /interest", () => {
  it("appends one topic; a repeat is added:false", async () => {
    const first = await request(app()).post("/v1/me/share/interest").set(auth()).send({ label: "Спешелти-кофе" });
    expect(first.body).toEqual({ hobbies: ["Бег", "Спешелти-кофе"], added: true });
    const again = await request(app()).post("/v1/me/share/interest").set(auth()).send({ label: "спешелти-кофе" });
    expect(again.body).toEqual({ hobbies: ["Бег", "Спешелти-кофе"], added: false });
    expect(profileUpdates).toHaveLength(1);
  });

  it("409 too-many at ten; 400 for an empty label", async () => {
    hobbies = Array.from({ length: 10 }, (_, i) => `h${i}`);
    const full = await request(app()).post("/v1/me/share/interest").set(auth()).send({ label: "Новое" });
    expect(full.status).toBe(409);
    expect(full.body).toEqual({ error: "too-many" });
    const empty = await request(app()).post("/v1/me/share/interest").set(auth()).send({ label: " " });
    expect(empty.status).toBe(400);
  });
});
