/**
 * HTTP-boundary test for the `/v1/venue-change/*` Mini App endpoints (v2 —
 * paid multiplayer board). Mirrors ticket-api.test.ts: the handler module is
 * mocked, so this focuses on auth, validation, and result→status mapping. The
 * board/payment state machine itself is covered by the handler unit test.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-venue-change";
const VALID_UUID = "33333333-3333-4333-8333-333333333333";

vi.mock("../config.js", () => ({
  env: { BOT_TOKEN, VENUE_CHANGE_STARS: 150 },
}));

vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: vi.fn().mockResolvedValue({ language: "en" }) } },
}));

const getVenueBoardState = vi.fn();
const getVenueChangeCatalog = vi.fn();
const submitVenueLikes = vi.fn();
const confirmVenueAgreement = vi.fn();
const offerPartnerPay = vi.fn();
const declineVenuePay = vi.fn();
const mintExpressChange = vi.fn();
const createVenueInvoiceLink = vi.fn();
vi.mock("../handlers/matching/venue-change.js", () => ({
  getVenueBoardState: (...a: unknown[]) => getVenueBoardState(...a),
  getVenueChangeCatalog: (...a: unknown[]) => getVenueChangeCatalog(...a),
  submitVenueLikes: (...a: unknown[]) => submitVenueLikes(...a),
  confirmVenueAgreement: (...a: unknown[]) => confirmVenueAgreement(...a),
  offerPartnerPay: (...a: unknown[]) => offerPartnerPay(...a),
  declineVenuePay: (...a: unknown[]) => declineVenuePay(...a),
  mintExpressChange: (...a: unknown[]) => mintExpressChange(...a),
  createVenueInvoiceLink: (...a: unknown[]) => createVenueInvoiceLink(...a),
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

/** A minimal agreed-state board view for the invoice route. */
function agreedState(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    state: {
      status: "agreed",
      open: false,
      closedReason: null,
      original: { name: "Old", address: "Old St", mapsUri: null },
      myLikes: [],
      peerLikes: [],
      agreed: { key: "p1", name: "New Cafe", address: "1 St", mapsUri: null, expiresAt: null },
      myAction: "pay",
      priceStars: 150,
      canOfferPartner: false,
      offerSent: false,
      payDeclined: false,
      expressAvailable: false,
      settled: null,
      ...over,
    },
  };
}

beforeEach(() => {
  getVenueBoardState.mockReset();
  getVenueChangeCatalog.mockReset();
  submitVenueLikes.mockReset();
  confirmVenueAgreement.mockReset();
  offerPartnerPay.mockReset();
  declineVenuePay.mockReset();
  mintExpressChange.mockReset();
  createVenueInvoiceLink.mockReset();
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

  it("200 returns the board view", async () => {
    getVenueBoardState.mockResolvedValue(agreedState());
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "agreed", myAction: "pay" });
  });

  it("403 for a non-participant", async () => {
    getVenueBoardState.mockResolvedValue({ ok: false, reason: "not-participant" });
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(403);
  });
});

describe("GET /v1/venue-change/catalog", () => {
  it("409 once the venue has already been changed", async () => {
    getVenueChangeCatalog.mockResolvedValue({ ok: false, reason: "already-changed" });
    const res = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(409);
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

describe("POST /v1/venue-change/like", () => {
  it("400 on a malformed keys payload", async () => {
    const res = await request(buildApp())
      .post(`/v1/venue-change/like`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, keys: [1, 2] });
    expect(res.status).toBe(400);
    expect(submitVenueLikes).not.toHaveBeenCalled();
  });

  it("200 relays agreed + overlapCandidates", async () => {
    submitVenueLikes.mockResolvedValue({ ok: true, agreed: false, overlapCandidates: ["p1", "p2"] });
    const res = await request(buildApp())
      .post(`/v1/venue-change/like`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, keys: ["p1", "p2"] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agreed: false, overlapCandidates: ["p1", "p2"] });
  });

  it("400 maps invalid-venue", async () => {
    submitVenueLikes.mockResolvedValue({ ok: false, reason: "invalid-venue" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/like`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, keys: ["evil"] });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/venue-change/confirm", () => {
  it("409 maps not-overlapping", async () => {
    confirmVenueAgreement.mockResolvedValue({ ok: false, reason: "not-overlapping" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/confirm`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, key: "p1" });
    expect(res.status).toBe(409);
  });

  it("200 on success", async () => {
    confirmVenueAgreement.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post(`/v1/venue-change/confirm`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, key: "p1" });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/venue-change/offer-pay", () => {
  it("409 maps already-offered / pay-declined", async () => {
    offerPartnerPay.mockResolvedValue({ ok: false, reason: "already-offered" });
    let res = await request(buildApp())
      .post(`/v1/venue-change/offer-pay`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(409);

    offerPartnerPay.mockResolvedValue({ ok: false, reason: "pay-declined" });
    res = await request(buildApp())
      .post(`/v1/venue-change/offer-pay`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(409);
  });

  it("403 maps not-allowed (male caller)", async () => {
    offerPartnerPay.mockResolvedValue({ ok: false, reason: "not-allowed" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/offer-pay`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(403);
  });

  it("200 on success", async () => {
    offerPartnerPay.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post(`/v1/venue-change/offer-pay`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(200);
  });
});

describe("POST /v1/venue-change/stars-invoice", () => {
  it("400 without a mode", async () => {
    const res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(400);
  });

  it("agreed: 409 when the caller has no paying action", async () => {
    getVenueBoardState.mockResolvedValue(agreedState({ myAction: "wait", priceStars: null }));
    const res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "agreed" });
    expect(res.status).toBe(409);
    expect(createVenueInvoiceLink).not.toHaveBeenCalled();
  });

  it("agreed: 200 mints the link for a payer", async () => {
    getVenueBoardState.mockResolvedValue(agreedState());
    createVenueInvoiceLink.mockResolvedValue("https://t.me/invoice/x");
    const res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "agreed" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, link: "https://t.me/invoice/x", stars: 150 });
  });

  it("express: 400 without a key; 403 when not allowed; 200 after a mint", async () => {
    let res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "express" });
    expect(res.status).toBe(400);

    mintExpressChange.mockResolvedValue({ ok: false, reason: "not-allowed" });
    res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "express", key: "p1" });
    expect(res.status).toBe(403);

    mintExpressChange.mockResolvedValue({ ok: true, venueName: "New Cafe" });
    createVenueInvoiceLink.mockResolvedValue("https://t.me/invoice/y");
    res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "express", key: "p1" });
    expect(res.status).toBe(200);
    expect(res.body.link).toBe("https://t.me/invoice/y");
  });
});
