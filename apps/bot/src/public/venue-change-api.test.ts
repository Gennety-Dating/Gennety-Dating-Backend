/**
 * HTTP-boundary test for the `/v1/venue-change/*` Mini App endpoints. Mirrors
 * ticket-api.test.ts: the handler module is mocked, so this focuses on auth,
 * validation, and result→status mapping. The handler/eligibility logic itself
 * is covered by venue-change.test.ts (services) and the handler unit test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-venue-change";
const VALID_UUID = "33333333-3333-4333-8333-333333333333";

vi.mock("../config.js", () => ({ env: { BOT_TOKEN } }));

const getVenueChangeState = vi.fn();
const getVenueChangeCatalog = vi.fn();
const proposeVenueChange = vi.fn();
vi.mock("../handlers/matching/venue-change.js", () => ({
  getVenueChangeState: (...a: unknown[]) => getVenueChangeState(...a),
  getVenueChangeCatalog: (...a: unknown[]) => getVenueChangeCatalog(...a),
  proposeVenueChange: (...a: unknown[]) => proposeVenueChange(...a),
}));

const { createVenueChangeRouter } = await import("./routes/venue-change.js");
const fakeApi = {} as Parameters<typeof createVenueChangeRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/venue-change", createVenueChangeRouter(fakeApi));
  return app;
}

/** Build valid initData signed with BOT_TOKEN (raw query-string form). */
function rawInitData(userId = 555): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("user", JSON.stringify({ id: userId, first_name: "Test" }));
  const dataCheckString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

/** Build a valid `tma <initData>` header signed with BOT_TOKEN. */
function tmaHeader(userId = 555): string {
  return `tma ${rawInitData(userId)}`;
}

beforeEach(() => {
  getVenueChangeState.mockReset();
  getVenueChangeCatalog.mockReset();
  proposeVenueChange.mockReset();
});

describe("GET /v1/venue-change/state", () => {
  it("401 without initData", async () => {
    const res = await request(buildApp()).get(`/v1/venue-change/state?match=${VALID_UUID}`);
    expect(res.status).toBe(401);
  });

  it("404 on a malformed match id", async () => {
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=not-a-uuid`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(404);
  });

  it("200 returns the state view", async () => {
    getVenueChangeState.mockResolvedValue({
      ok: true,
      state: { status: "none", eligible: true, ineligibleReason: null, minCommentLength: 10, original: null },
    });
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, eligible: true, minCommentLength: 10 });
  });

  it("403 for a non-participant", async () => {
    getVenueChangeState.mockResolvedValue({ ok: false, reason: "not-participant" });
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/venue-change/catalog", () => {
  it("403 when not the eligible female", async () => {
    getVenueChangeCatalog.mockResolvedValue({ ok: false, reason: "not-female-initiator" });
    const res = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(403);
  });

  it("409 past the cutoff", async () => {
    getVenueChangeCatalog.mockResolvedValue({ ok: false, reason: "past-cutoff" });
    const res = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(409);
  });

  it("200 returns the venue list", async () => {
    getVenueChangeCatalog.mockResolvedValue({ ok: true, venues: [{ name: "Cafe" }] });
    const res = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(200);
    expect(res.body.venues).toHaveLength(1);
  });
});

describe("GET /v1/venue-change/photo", () => {
  it("401 without initData", async () => {
    const res = await request(buildApp()).get(`/v1/venue-change/photo?ref=places/x/photos/y`);
    expect(res.status).toBe(401);
  });

  it("400 on a non-Places ref (no open proxy)", async () => {
    const res = await request(buildApp())
      .get(`/v1/venue-change/photo?ref=${encodeURIComponent("https://evil.example/img.jpg")}&tma=${encodeURIComponent(rawInitData())}`);
    expect(res.status).toBe(400);
  });

  it("404 when PLACES_API_KEY is not configured", async () => {
    const prev = process.env.PLACES_API_KEY;
    delete process.env.PLACES_API_KEY;
    const res = await request(buildApp())
      .get(`/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&tma=${encodeURIComponent(rawInitData())}`);
    expect(res.status).toBe(404);
    if (prev !== undefined) process.env.PLACES_API_KEY = prev;
  });
});

describe("POST /v1/venue-change/propose", () => {
  const validBody = {
    matchId: VALID_UUID,
    name: "New Cafe",
    address: "1 St",
    lat: 50.45,
    lng: 30.52,
    comment: "It's much cozier there",
  };

  it("404 on a malformed match id", async () => {
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send({ ...validBody, matchId: "nope" });
    expect(res.status).toBe(404);
  });

  it("400 on a missing venue name", async () => {
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send({ ...validBody, name: "" });
    expect(res.status).toBe(400);
    expect(proposeVenueChange).not.toHaveBeenCalled();
  });

  it("400 maps comment-too-short", async () => {
    proposeVenueChange.mockResolvedValue({ ok: false, reason: "comment-too-short" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it("409 maps already-used (one-shot)", async () => {
    proposeVenueChange.mockResolvedValue({ ok: false, reason: "already-used" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send(validBody);
    expect(res.status).toBe(409);
  });

  it("400 maps out-of-range", async () => {
    proposeVenueChange.mockResolvedValue({ ok: false, reason: "out-of-range" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send(validBody);
    expect(res.status).toBe(400);
  });

  it("200 on success", async () => {
    proposeVenueChange.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post(`/v1/venue-change/propose`)
      .set("Authorization", tmaHeader())
      .send(validBody);
    expect(res.status).toBe(200);
    expect(proposeVenueChange).toHaveBeenCalledOnce();
  });
});
