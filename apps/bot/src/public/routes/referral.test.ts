import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";

const BOT_TOKEN = "123456:test-bot-token";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const userFindUnique = vi.fn();
const referralCardImage = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => userFindUnique(...args) } },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN,
    BOT_USERNAME: "gennetybot",
    PUBLIC_BASE_URL: "https://dating-api.gennety.com",
    REFERRAL_INVITEE_PREMIUM_MONTHS: 1,
  },
}));

vi.mock("../../services/referral-card/index.js", () => ({
  referralCardImage: (...args: unknown[]) => referralCardImage(...args),
}));

const { createReferralRouter } = await import("./referral.js");

/** The JPEG the mocked renderer hands back — SOI … EOI, so it is a whole file. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  Buffer.alloc(64, 0x41),
  Buffer.from([0xff, 0xd9]),
]);
const VERSION = "abc123def456";

function buildApp() {
  const app = express();
  app.use("/v1/referral", createReferralRouter());
  return app;
}

function sign(payload: string): string {
  return createHmac("sha256", BOT_TOKEN).update(payload).digest("hex").slice(0, 24);
}

beforeEach(() => {
  vi.clearAllMocks();
  userFindUnique.mockResolvedValue({ firstName: "Anna", language: "ru" });
  referralCardImage.mockResolvedValue({ jpeg: JPEG, width: 900, height: 1000, version: VERSION });
});

describe("GET /v1/referral/card", () => {
  it("serves the card as a complete JPEG with a declared length", async () => {
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, v: VERSION, sig: sign(`referral-card:${USER_ID}:${VERSION}`) });

    expect(res.status).toBe(200);
    // Bot API requires photo_url to be JPEG, and a stated Content-Length is
    // what lets Telegram tell a cut-short body from a complete one instead of
    // decoding the partial image it happened to receive.
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["content-length"]).toBe(String(JPEG.length));
    expect(Buffer.from(res.body).equals(JPEG)).toBe(true);
  });

  it("caches a versioned URL hard — its bytes can never change", async () => {
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, v: VERSION, sig: sign(`referral-card:${USER_ID}:${VERSION}`) });

    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("still honours a pre-versioning URL, so an in-flight share keeps working", async () => {
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, sig: sign(`referral-card:${USER_ID}`) });

    expect(res.status).toBe(200);
    // Its bytes CAN change (a rename re-renders it), so it is not immutable.
    expect(res.headers["cache-control"]).not.toContain("immutable");
  });

  it("rejects a signature minted for a different version", async () => {
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, v: "deadbeef0000", sig: sign(`referral-card:${USER_ID}:${VERSION}`) });

    expect(res.status).toBe(403);
  });

  it("rejects an unsigned or wrong-length signature without throwing", async () => {
    const app = buildApp();
    expect((await request(app).get("/v1/referral/card").query({ u: USER_ID })).status).toBe(400);
    expect(
      (await request(app).get("/v1/referral/card").query({ u: USER_ID, sig: "short" })).status,
    ).toBe(403);
  });

  it("404s an unknown referrer instead of rendering someone else's card", async () => {
    userFindUnique.mockResolvedValue(null);
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, v: VERSION, sig: sign(`referral-card:${USER_ID}:${VERSION}`) });

    expect(res.status).toBe(404);
    expect(referralCardImage).not.toHaveBeenCalled();
  });

  it("500s rather than serving a partial body when the render fails", async () => {
    referralCardImage.mockResolvedValue(null);
    const res = await request(buildApp())
      .get("/v1/referral/card")
      .query({ u: USER_ID, v: VERSION, sig: sign(`referral-card:${USER_ID}:${VERSION}`) });

    expect(res.status).toBe(500);
  });
});
