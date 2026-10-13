import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `GET /v1/me/after-date` — the morning check and the live mutual offers.
 *
 * The offers are built together (perf 2026-10-13) rather than one after the
 * other; what this pins is that the answer is the one the loop gave: the ids'
 * newest-first order, refusals left out, each offer serialized as before.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = { JWT_SECRET, MORNING_AFTER_ENABLED: true, WISHLIST_APPSTORE_ENABLED: false };
vi.mock("../../config.js", () => ({ env }));

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: async () => ({ language: "en" }) } },
}));

const pendingMorningAfterFor = vi.fn(async (_userId: string): Promise<unknown> => null);
const recentMutualMatchIds = vi.fn(async (_userId: string) => ["m-3", "m-2", "m-1"]);
vi.mock("../../services/morning-after.js", () => ({
  announceMutual: vi.fn(),
  pendingMorningAfterFor: (userId: string) => pendingMorningAfterFor(userId),
  recentMutualMatchIds: (userId: string) => recentMutualMatchIds(userId),
  recordMorningAfter: vi.fn(),
}));

function offer(matchId: string) {
  return {
    matchId,
    mutualAt: new Date("2026-10-12T08:00:00.000Z"),
    partner: { firstName: `P-${matchId}`, gender: "female", photoUrl: null },
    title: "t",
    body: "b",
    timing: "ti",
    gift: "g",
    flowersHint: null,
    wishlistLine: null,
    wishlist: null,
  };
}

/** Resolves in reverse order of the ids, so a loop-order bug would show. */
const delays: Record<string, number> = { "m-3": 30, "m-2": 15, "m-1": 0 };
const events: string[] = [];
const mutualOfferFor = vi.fn(async (matchId: string, _viewer: string, _language: string) => {
  events.push(`start ${matchId}`);
  await new Promise((resolve) => setTimeout(resolve, delays[matchId] ?? 0));
  events.push(`end ${matchId}`);
  return matchId === "m-2"
    ? { ok: false as const, error: "not-mutual" as const }
    : { ok: true as const, offer: offer(matchId) };
});
vi.mock("../../services/wishlist.js", () => ({
  mutualOfferFor: (matchId: string, viewer: string, language: string) =>
    mutualOfferFor(matchId, viewer, language),
}));

vi.mock("../../handlers/date/morning-after.js", () => ({ sendMutualOfferDm: vi.fn() }));
vi.mock("../../services/main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("../../services/appstore.js", () => ({
  appStoreConfigured: () => false,
  decodeJwsPayload: () => null,
}));
vi.mock("../../services/appstore-wishlist.js", () => ({ purchaseWishlistSheet: vi.fn() }));
vi.mock("../../services/storage.js", () => ({
  createProfilePhotoSignedUrl: async (path: string) => `https://signed.test/photo/${path}`,
}));

const { createAfterDateRouter, serializeOffer } = await import("./after-date.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function get() {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  const app = express();
  app.use(express.json());
  app.use("/v1/me/after-date", createAfterDateRouter());
  return request(app).get("/v1/me/after-date").set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  events.length = 0;
  mutualOfferFor.mockClear();
  pendingMorningAfterFor.mockReset();
  pendingMorningAfterFor.mockResolvedValue(null);
});

describe("GET /v1/me/after-date — offers", () => {
  it("keeps the ids' order and leaves refusals out, whatever order they settle in", async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      check: null,
      offers: JSON.parse(JSON.stringify([serializeOffer(offer("m-3")), serializeOffer(offer("m-1"))])),
    });
    expect(mutualOfferFor.mock.calls.map((call) => call.slice(1))).toEqual([
      [USER_ID, "en"],
      [USER_ID, "en"],
      [USER_ID, "en"],
    ]);
  });

  it("builds the offers together, not one after another", async () => {
    await get();
    // All three were asked for before any settled.
    expect(events.slice(0, 3)).toEqual(["start m-3", "start m-2", "start m-1"]);
  });

  it("answers the check with the partner photo signed for an hour", async () => {
    pendingMorningAfterFor.mockResolvedValue({
      matchId: "m-9",
      partnerFirstName: "Anna",
      partnerPhotoPath: "u/p.jpg",
      venueName: "Kavarnia",
      agreedTime: new Date("2026-10-12T18:00:00.000Z"),
    });
    recentMutualMatchIds.mockResolvedValueOnce([]);

    const res = await get();

    expect(res.body.offers).toEqual([]);
    expect(res.body.check).toMatchObject({
      matchId: "m-9",
      partnerFirstName: "Anna",
      partnerPhotoUrl: "https://signed.test/photo/u/p.jpg",
      venueName: "Kavarnia",
      agreedTime: "2026-10-12T18:00:00.000Z",
    });
  });

  it("is empty while the feature is off", async () => {
    env.MORNING_AFTER_ENABLED = false;
    try {
      const res = await get();
      expect(res.body).toEqual({ check: null, offers: [] });
      expect(mutualOfferFor).not.toHaveBeenCalled();
    } finally {
      env.MORNING_AFTER_ENABLED = true;
    }
  });
});
