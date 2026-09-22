/**
 * HTTP-boundary test for the `/v1/venue-change/*` Mini App endpoints (v2 —
 * paid multiplayer board). Mirrors ticket-api.test.ts: the handler module is
 * mocked, so this focuses on auth, validation, and result→status mapping. The
 * board/payment state machine itself is covered by the handler unit test.
 */
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-venue-change";
const VALID_UUID = "33333333-3333-4333-8333-333333333333";
const originalPlacesKey = process.env.PLACES_API_KEY;

vi.mock("../config.js", () => ({
  env: { BOT_TOKEN, VENUE_CHANGE_STARS: 150, PUBLIC_BASE_URL: "https://api.example.test" },
}));

// The catalog is read for the place sheet's profile (`boardPlaceProfiles`) —
// and, in the shape test, by the city guide's own route for the same row.
const venueFindMany = vi.fn();
const venueFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn().mockResolvedValue({ language: "en" }) },
    curatedVenue: {
      findMany: (...a: unknown[]) => venueFindMany(...a),
      findUnique: (...a: unknown[]) => venueFindUnique(...a),
    },
  },
}));

// The city guide's list authenticates through the canvas rail; stubbed the way
// `venues-api.test.ts` stubs it.
vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "me";
    next();
  },
}));

const getVenueBoardState = vi.fn();
const getVenueChangeCatalog = vi.fn();
const submitVenueLikes = vi.fn();
const confirmVenueAgreement = vi.fn();
const offerPartnerPay = vi.fn();
const declineVenuePay = vi.fn();
const mintExpressChange = vi.fn();
const settleFreeVenueChange = vi.fn();
const createVenueInvoiceLink = vi.fn();
vi.mock("../handlers/matching/venue-change.js", () => ({
  getVenueBoardState: (...a: unknown[]) => getVenueBoardState(...a),
  getVenueChangeCatalog: (...a: unknown[]) => getVenueChangeCatalog(...a),
  submitVenueLikes: (...a: unknown[]) => submitVenueLikes(...a),
  confirmVenueAgreement: (...a: unknown[]) => confirmVenueAgreement(...a),
  offerPartnerPay: (...a: unknown[]) => offerPartnerPay(...a),
  declineVenuePay: (...a: unknown[]) => declineVenuePay(...a),
  mintExpressChange: (...a: unknown[]) => mintExpressChange(...a),
  settleFreeVenueChange: (...a: unknown[]) => settleFreeVenueChange(...a),
  createVenueInvoiceLink: (...a: unknown[]) => createVenueInvoiceLink(...a),
}));

const { createVenueChangeRouter } = await import("./routes/venue-change.js");
const { venuesRouter, resetVenuePhotoCache } = await import("./routes/venues.js");
const { resetShowcaseCache } = await import("../services/curated-venue.js");
const { __resetBoardProfileCacheForTests } = await import("../services/venue-change.js");
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
    agreementNonce: "0a1b2c3d4e",
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
  settleFreeVenueChange.mockReset();
  createVenueInvoiceLink.mockReset();
  venueFindMany.mockReset().mockResolvedValue([]);
  venueFindUnique.mockReset();
  __resetBoardProfileCacheForTests();
  resetShowcaseCache();
  resetVenuePhotoCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPlacesKey === undefined) delete process.env.PLACES_API_KEY;
  else process.env.PLACES_API_KEY = originalPlacesKey;
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

  it("proxies only bounded image responses with a timeout", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("image", { headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await request(buildApp())
      .get(`/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&tma=${encodeURIComponent(rawInitData())}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(fetchMock.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });

  // ── Width, which is a billing parameter (2026-09-04) ─────────────────────
  //
  // The width goes into the upstream URL, so each distinct width is a
  // SEPARATELY BILLED Place Photo request for the same photograph. It used to
  // be free-form, clamped to anything in 200…1600, behind nothing but a valid
  // initData — i.e. an authenticated caller could multiply the Places bill
  // ~1400× one pixel at a time, and every request would look legitimate.
  it("asks Google only for the two widths the Mini App renders", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("image", { headers: { "content-type": "image/jpeg" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const widthFor = async (w: string): Promise<number> => {
      fetchMock.mockClear();
      await request(buildApp()).get(
        `/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&w=${w}&tma=${encodeURIComponent(rawInitData())}`,
      );
      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      return Number(url.searchParams.get("maxWidthPx"));
    };

    // The two the client actually uses pass through untouched.
    expect(await widthFor("240")).toBe(240);
    expect(await widthFor("1200")).toBe(1200);
    // Everything else SNAPS to the nearest of them rather than being honoured.
    // Snapping, not rejecting: an older cached bundle asks for 1000 and 1600
    // (the pre-unification gallery/viewer widths) and must still get a picture
    // — it just shares a cache entry, and a bill, with everyone else's.
    expect(await widthFor("1000")).toBe(1200);
    expect(await widthFor("1600")).toBe(1200);
    expect(await widthFor("241")).toBe(240);
    expect(await widthFor("999999")).toBe(1200);
    expect(await widthFor("not-a-number")).toBe(1200);
  });

  it("rejects a non-image upstream response", async () => {
    process.env.PLACES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not an image", { headers: { "content-type": "text/html" } }),
      ),
    );

    const res = await request(buildApp())
      .get(`/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&tma=${encodeURIComponent(rawInitData())}`);
    expect(res.status).toBe(502);
  });

  it("rejects an oversized upstream image", async () => {
    process.env.PLACES_API_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("x", {
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(10 * 1024 * 1024 + 1),
          },
        }),
      ),
    );

    const res = await request(buildApp())
      .get(`/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&tma=${encodeURIComponent(rawInitData())}`);
    expect(res.status).toBe(502);
  });

  // ── Retry (PRODUCT_SPEC §3.7b) ────────────────────────────────────────────
  // The failure this exists for, measured on the droplet 2026-08-08: occasional
  // ETIMEDOUT connecting to Google's photo CDN, in production as well as demo.
  // The board opens ~13 tiles at once, so one blip left visible holes.
  const photoRequest = () =>
    request(buildApp()).get(
      `/v1/venue-change/photo?ref=${encodeURIComponent("places/x/photos/y")}&tma=${encodeURIComponent(rawInitData())}`,
    );
  const jpeg = () => new Response("image", { headers: { "content-type": "image/jpeg" } });

  it("retries a dropped connection and serves the photo", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    const fetchMock = vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(jpeg());
    vi.stubGlobal("fetch", fetchMock);

    const res = await photoRequest();

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and a 429, which are the upstream saying 'not now'", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValueOnce(jpeg());
    vi.stubGlobal("fetch", fetchMock);

    const res = await photoRequest();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a 403 — a verdict does not change on the second ask", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await photoRequest();

    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does NOT retry a non-image body", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("nope", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await photoRequest()).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does NOT retry an oversized image — re-downloading it is not a fix", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("x", {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(10 * 1024 * 1024 + 1),
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect((await photoRequest()).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops at the attempt ceiling instead of hammering a dead upstream", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    expect((await photoRequest()).status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("logs every failure — a silent 502 is what made this invisible", async () => {
    // Both non-throwing failure branches used to answer 502 without a line in
    // the log, so a systematic upstream problem looked like nothing at all.
    process.env.PLACES_API_KEY = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 403 })));

    await photoRequest();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
    warn.mockRestore();
  });

  it("logs a rescued blip, the only signal the upstream is degrading", async () => {
    process.env.PLACES_API_KEY = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(err).mockResolvedValueOnce(jpeg()));

    expect((await photoRequest()).status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ETIMEDOUT"));
    warn.mockRestore();
  });

  // The board is served from a different host to this API, so a card thumbnail
  // is a cross-origin no-cors subresource. Without an explicit CORP the browser
  // discards the 200 and the client swaps in the category glyph — the same
  // symptom as an upstream failure, which is what the retries above were built
  // for. See public/cross-origin-image.ts.
  it("serves the photo with a cross-origin resource policy", async () => {
    process.env.PLACES_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jpeg()));

    const res = await photoRequest();

    expect(res.status).toBe(200);
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
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

  it("502 maps send-failed, so the Mini App can say it did NOT land", async () => {
    offerPartnerPay.mockResolvedValue({ ok: false, reason: "send-failed" });
    const res = await request(buildApp())
      .post(`/v1/venue-change/offer-pay`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("send-failed");
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
    // A13-L6: the link is pinned to the agreement the state read described.
    expect(createVenueInvoiceLink.mock.calls[0]![5]).toBe("0a1b2c3d4e");
  });

  it("agreed: 409 rather than an unpinned link when the read names no agreement", async () => {
    getVenueBoardState.mockResolvedValue({ ...agreedState(), agreementNonce: null });
    const res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "agreed" });
    expect(res.status).toBe(409);
    expect(createVenueInvoiceLink).not.toHaveBeenCalled();
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

    mintExpressChange.mockResolvedValue({ ok: true, venueName: "New Cafe", agreementNonce: "5f6e7d8c9b" });
    createVenueInvoiceLink.mockResolvedValue("https://t.me/invoice/y");
    res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "express", key: "p1" });
    expect(res.status).toBe(200);
    expect(res.body.link).toBe("https://t.me/invoice/y");
    expect(createVenueInvoiceLink.mock.calls[0]![5]).toBe("5f6e7d8c9b");
  });
});

// A13-M33: agreeing to KEEP the original venue is free, and the Mini App can
// only tell it from an agreement to change (which leads to payment) by `kept`.
// The routes used to strip it, so "keep" showed the "one more step" screen.
describe("`kept` reaches the Mini App", () => {
  it("/like relays kept", async () => {
    submitVenueLikes.mockResolvedValue({ ok: true, agreed: true, kept: true, overlapCandidates: [] });
    const res = await request(buildApp())
      .post(`/v1/venue-change/like`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, keys: ["__keep__"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, agreed: true, kept: true, overlapCandidates: [] });
  });

  it("/confirm relays kept, and false for a real change", async () => {
    confirmVenueAgreement.mockResolvedValue({ ok: true, kept: true });
    let res = await request(buildApp())
      .post(`/v1/venue-change/confirm`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, key: "__keep__" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, kept: true });

    confirmVenueAgreement.mockResolvedValue({ ok: true, kept: false });
    res = await request(buildApp())
      .post(`/v1/venue-change/confirm`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, key: "p1" });
    expect(res.body).toEqual({ ok: true, kept: false });
  });
});

// A13-L16: the Mini App used to build `/photo?ref=…&tma=<initData>` itself.
describe("signed gallery links for the Mini App", () => {
  const REFS = ["places/A1/photos/p1", "places/A1/photos/p2"];

  function expectSignedGallery(urls: string[]): void {
    expect(urls).toHaveLength(REFS.length);
    urls.forEach((url, i) => {
      const parsed = new URL(url);
      expect(parsed.origin).toBe("https://api.example.test");
      // One opaque segment per ref, in `photoRefs` order, at the ONE gallery width.
      expect(Buffer.from(parsed.pathname.split("/").pop() ?? "", "base64url").toString()).toBe(REFS[i]);
      expect(parsed.searchParams.get("w")).toBe("1200");
      expect(parsed.searchParams.get("sig")).toMatch(/^[0-9a-f]{24}$/);
      expect(url).not.toContain("tma");
    });
  }

  it("/state signs every photo of the assigned venue", async () => {
    getVenueBoardState.mockResolvedValue(
      agreedState({ original: { name: "Old", address: "Old St", mapsUri: null, photoRefs: REFS } }),
    );
    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(200);
    expectSignedGallery(res.body.original.photoUrls);
    // The first-photo links the native client reads are still there.
    expect(res.body.original.thumbnailUrl).toContain("w=240");
  });

  it("/catalog signs every photo of every row, and an empty list for none", async () => {
    getVenueChangeCatalog.mockResolvedValue({
      ok: true,
      venues: [
        { name: "Cafe", address: "1 St", placeId: "A1", photoRefs: REFS },
        { name: "Park", address: "2 St", placeId: null, photoRefs: [] },
      ],
    });
    const res = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(res.status).toBe(200);
    expectSignedGallery(res.body.venues[0].photoUrls);
    expect(res.body.venues[1].photoUrls).toEqual([]);
  });

  it("a minted link opens the signed photo route with no initData", async () => {
    process.env.PLACES_API_KEY = "test-key";
    getVenueChangeCatalog.mockResolvedValue({
      ok: true,
      venues: [{ name: "Cafe", address: "1 St", placeId: "A1", photoRefs: REFS }],
    });
    const catalog = await request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    const link = new URL(String(catalog.body.venues[0].photoUrls[1]));

    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
      ),
    );
    const res = await request(buildApp()).get(`${link.pathname}${link.search}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
  });
});

// The board's place sheet (founder, 2026-09-22): every card, and the pinned
// `original`, carries the city guide's profile of the same place.
describe("place sheet profile (`profile` = ShowcaseVenue)", () => {
  const ROW_ID = "44444444-4444-4444-8444-444444444444";

  /** A catalog row of the board-only tier — the one the guide's list leaves out. */
  function catalogRow(over: Record<string, unknown> = {}) {
    return {
      id: ROW_ID,
      placeId: "ChIJ-sens",
      name: "Sens",
      address: "Mykilskyi Ln, 1, Kyiv",
      category: "cafe",
      tier: "alternative",
      primaryType: null,
      priority: 1,
      lat: 50.4401,
      lng: 30.5486,
      editorialSummary: "Books and coffee.",
      vibeTags: ["books", "quiet"],
      facetTags: ["quiet"],
      utcOffsetMinutes: 180,
      openingHours: {
        periods: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
      },
      photoRefs: Array.from({ length: 12 }, (_, i) => `places/ChIJ-sens/photos/${i}`),
      rating: 4.7,
      userRatingCount: 812,
      priceLevel: "PRICE_LEVEL_INEXPENSIVE",
      googleMapsUri: "https://maps.google.com/?cid=42",
      ...over,
    };
  }

  /** A board card as the handler hands it over. */
  function boardVenue(placeId: string | null, name: string, source = "curated") {
    return {
      source,
      placeId,
      name,
      address: `${name} St`,
      lat: 50.44,
      lng: 30.54,
      mapsUri: null,
      category: "cafe",
      tier: "alternative",
      distanceKm: 0.4,
      photoRefs: [`places/${placeId ?? "x"}/photos/card`],
      rating: null,
      userRatingCount: null,
      editorialSummary: null,
    };
  }

  async function getCatalog() {
    return request(buildApp())
      .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
  }

  it("carries the profile on a card whose place is in the catalog, and null on one that is not", async () => {
    venueFindMany.mockResolvedValue([catalogRow()]);
    getVenueChangeCatalog.mockResolvedValue({
      ok: true,
      venues: [boardVenue("ChIJ-sens", "Sens"), boardVenue("ChIJ-fallback", "Elsewhere", "places")],
    });

    const res = await getCatalog();

    expect(res.status).toBe(200);
    const [sens, fallback] = res.body.venues;
    expect(sens.profile).toMatchObject({
      id: ROW_ID,
      placeId: "ChIJ-sens",
      editorialSummary: "Books and coffee.",
      vibeTags: ["books", "quiet"],
      utcOffsetMinutes: 180,
      openingHours: [{ open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } }],
      priceLevel: "inexpensive",
      rating: 4.7,
      userRatingCount: 812,
      mapsUri: "https://maps.google.com/?cid=42",
    });
    // The profile's gallery is the guide's: capped at ten, cover first, the
    // row id in the PATH — and no Places resource name on the wire.
    expect(sens.profile.photoUrls).toHaveLength(10);
    expect(sens.profile.photoUrls[0]).toBe(sens.profile.photoUrl);
    expect(new URL(sens.profile.photoUrl).pathname).toBe(`/v1/venues/${ROW_ID}/photo`);
    expect(new URL(sens.profile.photoUrls[9]).pathname).toBe(`/v1/venues/${ROW_ID}/photo/9`);
    expect(JSON.stringify(sens.profile)).not.toContain("places/ChIJ-sens/photos");
    // The card's own fields are untouched.
    expect(sens.key).toBe("ChIJ-sens");
    expect(sens.photoUrls).toHaveLength(1);
    // An explicit null, never an absent key.
    expect(fallback).toHaveProperty("profile", null);
  });

  it("reads the catalog once for the whole board, never once per card", async () => {
    getVenueChangeCatalog.mockResolvedValue({
      ok: true,
      venues: [boardVenue("a", "A"), boardVenue("b", "B"), boardVenue(null, "Hand")],
    });

    await getCatalog();

    expect(venueFindMany).toHaveBeenCalledTimes(1);
    expect(venueFindMany.mock.calls[0][0].where).toEqual({
      OR: [{ placeId: { in: ["a", "b"] } }, { placeId: null, name: "Hand", address: "Hand St" }],
      active: true,
    });
  });

  it("is exactly the object the city guide serves for the same row", async () => {
    // Tier `base` here, so the guide's own list shows the row too.
    venueFindMany.mockResolvedValue([catalogRow({ tier: "base" })]);
    getVenueChangeCatalog.mockResolvedValue({ ok: true, venues: [boardVenue("ChIJ-sens", "Sens")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const app = express();
    app.use(express.json());
    app.use("/v1/venue-change", createVenueChangeRouter(fakeApi));
    app.use("/v1/venues", venuesRouter);

    try {
      const guide = await request(app).get("/v1/venues/showcase?cityKey=ua:kyiv");
      const board = await request(app)
        .get(`/v1/venue-change/catalog?match=${VALID_UUID}`)
        .set("Authorization", tmaHeader());

      expect(guide.body.venues).toHaveLength(1);
      expect(board.body.venues[0].profile).toEqual(guide.body.venues[0]);
    } finally {
      warn.mockRestore();
    }
  });

  it("a profile photo link opens the guide's photo route with no header — either rail can use it", async () => {
    process.env.PLACES_API_KEY = "test-key";
    venueFindMany.mockResolvedValue([catalogRow()]);
    venueFindUnique.mockResolvedValue({ active: true, photoRefs: catalogRow().photoRefs });
    getVenueChangeCatalog.mockResolvedValue({ ok: true, venues: [boardVenue("ChIJ-sens", "Sens")] });
    const catalog = await getCatalog();
    const link = new URL(String(catalog.body.venues[0].profile.photoUrls[3]));

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const app = express();
    app.use("/v1/venues", venuesRouter);
    const res = await request(app).get(`${link.pathname}${link.search}`);

    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain("places/ChIJ-sens/photos/3/media");
  });

  it("never fails the board when the catalog cannot be read", async () => {
    venueFindMany.mockRejectedValue(new Error("db down"));
    getVenueChangeCatalog.mockResolvedValue({ ok: true, venues: [boardVenue("ChIJ-sens", "Sens")] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const res = await getCatalog();
      expect(res.status).toBe(200);
      expect(res.body.venues[0]).toHaveProperty("profile", null);
    } finally {
      warn.mockRestore();
    }
  });

  it("/state: the pinned original carries its place's profile", async () => {
    venueFindMany.mockResolvedValue([catalogRow()]);
    getVenueBoardState.mockResolvedValue({
      ...agreedState({ original: { name: "Sens", address: "Sens St", mapsUri: null, photoRefs: [] } }),
      originalVenue: { placeId: "ChIJ-sens", name: "Sens", address: "Sens St" },
    });

    const res = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());

    expect(res.status).toBe(200);
    expect(res.body.original).toMatchObject({ name: "Sens", photoUrl: null });
    expect(res.body.original.profile).toMatchObject({ id: ROW_ID, placeId: "ChIJ-sens", priceLevel: "inexpensive" });
    expect(res.body.original.profile.photoUrls).toHaveLength(10);
    // Server-side only, like the agreement nonce.
    expect(res.body).not.toHaveProperty("originalVenue");
    expect(res.body).not.toHaveProperty("agreementNonce");
  });

  it("/state: null when the assigned place has no catalog row, or there is no venue yet", async () => {
    getVenueBoardState.mockResolvedValue({
      ...agreedState(),
      originalVenue: { placeId: "ChIJ-uncatalogued", name: "Old", address: "Old St" },
    });
    const uncatalogued = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(uncatalogued.body.original).toHaveProperty("profile", null);

    venueFindMany.mockClear();
    getVenueBoardState.mockResolvedValue({ ...agreedState(), originalVenue: null });
    const none = await request(buildApp())
      .get(`/v1/venue-change/state?match=${VALID_UUID}`)
      .set("Authorization", tmaHeader());
    expect(none.body.original).toHaveProperty("profile", null);
    expect(venueFindMany).not.toHaveBeenCalled();
  });

  it("/state: the ~4 s poll does not re-read the catalog for the same place", async () => {
    venueFindMany.mockResolvedValue([catalogRow()]);
    getVenueBoardState.mockResolvedValue({
      ...agreedState(),
      originalVenue: { placeId: "ChIJ-sens", name: "Sens", address: "Sens St" },
    });

    for (let i = 0; i < 3; i += 1) {
      const res = await request(buildApp())
        .get(`/v1/venue-change/state?match=${VALID_UUID}`)
        .set("Authorization", tmaHeader());
      expect(res.body.original.profile?.id).toBe(ROW_ID);
    }
    expect(venueFindMany).toHaveBeenCalledTimes(1);
  });
});

// A13-H16: a free (Premium) express swap settles on the spot and has no invoice.
describe("POST /v1/venue-change/stars-invoice — free express", () => {
  it("answers settled with no link, and mints no invoice", async () => {
    mintExpressChange.mockResolvedValue({ ok: true, free: true, venueName: "New Cafe" });
    settleFreeVenueChange.mockResolvedValue({ ok: true });
    const res = await request(buildApp())
      .post(`/v1/venue-change/stars-invoice`)
      .set("Authorization", tmaHeader())
      .send({ matchId: VALID_UUID, mode: "express", key: "p1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, settled: true, free: true });
    expect(createVenueInvoiceLink).not.toHaveBeenCalled();
  });
});
