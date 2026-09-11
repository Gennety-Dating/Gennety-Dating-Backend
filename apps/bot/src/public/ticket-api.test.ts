/**
 * Integration test for the `/v1/matches/:id/ticket/*` Date Ticket Mini App
 * endpoints. Mirrors calendar.test.ts: focuses on the HTTP boundary (auth,
 * validation, status mapping) with the gate/payment modules mocked. The
 * gate's own logic is covered by ticket-gate behavior in ticket-expiry.test.ts
 * and the pure helpers in the webapp's ticket-state.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-ticket-suite";
const VALID_UUID = "22222222-2222-4222-8222-222222222222";

const env = { BOT_TOKEN, TICKET_STARS_ENABLED: false };
vi.mock("../config.js", () => ({ env }));

const getTicketState = vi.fn();
const applyTicketPayment = vi.fn();
const useTicketFromBalance = vi.fn();
const notePartnerPaidSeen = vi.fn().mockResolvedValue(undefined);
const getTicketPhoto = vi.fn();
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  getTicketState: (...a: unknown[]) => getTicketState(...a),
  getTicketPhoto: (...a: unknown[]) => getTicketPhoto(...a),
  applyTicketPayment: (...a: unknown[]) => applyTicketPayment(...a),
  useTicketFromBalance: (...a: unknown[]) => useTicketFromBalance(...a),
  notePartnerPaidSeen: (...a: unknown[]) => notePartnerPaidSeen(...a),
}));

/** The rail the route sees; the real function reads the runtime, so it is stubbed. */
let rail: "stars" | "no-charge" | "none" = "no-charge";
vi.mock("../services/ticket-payment.js", () => ({
  ticketPurchaseRail: () => rail,
  gateStarsForScope: (scope: string) => (scope === "both" ? 850 : 425),
}));

vi.mock("../services/ticket-analytics.js", () => ({ emitTicketEvent: vi.fn() }));

const downloadProfileImage = vi.fn();
vi.mock("../services/storage.js", () => ({
  downloadProfileImage: (...a: unknown[]) => downloadProfileImage(...a),
}));

const toAvatarThumbnail = vi.fn();
vi.mock("../services/avatar-thumbnail.js", () => ({
  toAvatarThumbnail: (...a: unknown[]) => toAvatarThumbnail(...a),
}));

const { createTicketRouter } = await import("./routes/ticket.js");
const fakeApi = {} as Parameters<typeof createTicketRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/matches/:matchId/ticket", createTicketRouter(fakeApi));
  return app;
}

function signInitData(botToken: string): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAH_test");
  params.set("user", JSON.stringify({ id: 5986970093, first_name: "Pro", username: "pro" }));
  const dcs = [...params.keys()].sort().map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secretKey).update(dcs).digest("hex"));
  return params.toString();
}

const baseState = {
  ticketStatus: "pending",
  priceCents: 849,
  myGender: "male",
  mySide: "A",
  iPaid: false,
  partnerPaid: false,
  partnerName: "Sam",
  partnerPaidForMe: false,
  bothPaid: false,
  expiresAt: null,
  myBalance: 0,
  selfDiscountPct: 0,
  selfPriceCents: 849,
  myPhotoUrl: null,
  partnerPhotoUrl: null,
};

beforeEach(() => {
  getTicketState.mockReset();
  applyTicketPayment.mockReset();
  useTicketFromBalance.mockReset();
  notePartnerPaidSeen.mockReset();
  notePartnerPaidSeen.mockResolvedValue(undefined);
  rail = "no-charge";
  getTicketPhoto.mockReset();
  downloadProfileImage.mockReset();
  toAvatarThumbnail.mockReset();
  env.TICKET_STARS_ENABLED = false;
});

describe("GET /v1/matches/:id/ticket/state", () => {
  it("returns 200 with the flattened state on the happy path", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    const res = await request(buildApp())
      .get(`/v1/matches/${VALID_UUID}/ticket/state`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ticketStatus).toBe("pending");
    expect(res.body.partnerName).toBe("Sam");
    // The client picks its pay path from this, so every state response has it.
    expect(res.body.rail).toBe("no-charge");
    // The third argument is the bot handle, and it is not incidental: it is
    // what lets the state read settle a slot for a caller who bought Premium
    // after the gate opened (§3.5b). Asserted rather than loosened, so dropping
    // it silently disables that self-healing path.
    expect(getTicketState).toHaveBeenCalledWith(5986970093n, VALID_UUID, fakeApi);
    // An uncovered viewer must not trigger the read-receipt (§3.5b takt 2).
    expect(notePartnerPaidSeen).not.toHaveBeenCalled();
  });

  it("fires the goodwill read-receipt when the covered partner opens her reveal", async () => {
    getTicketState.mockResolvedValueOnce({
      ok: true,
      state: { ...baseState, myGender: "female", partnerPaidForMe: true },
    });
    const res = await request(buildApp())
      .get(`/v1/matches/${VALID_UUID}/ticket/state`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`);
    expect(res.status).toBe(200);
    // Her view of the "he covered you ❤️" screen is the seen-signal that lets
    // the payer know she saw his gesture — fired with the bot Api + her id.
    expect(notePartnerPaidSeen).toHaveBeenCalledWith(fakeApi, 5986970093n, VALID_UUID);
  });

  it("returns 401 without auth", async () => {
    const res = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket/state`);
    expect(res.status).toBe(401);
    expect(getTicketState).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-UUID matchId", async () => {
    const res = await request(buildApp())
      .get(`/v1/matches/not-a-uuid/ticket/state`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`);
    expect(res.status).toBe(404);
    expect(getTicketState).not.toHaveBeenCalled();
  });

  it("maps not-participant → 403", async () => {
    getTicketState.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const res = await request(buildApp())
      .get(`/v1/matches/${VALID_UUID}/ticket/state`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`);
    expect(res.status).toBe(403);
  });
});

describe("POST /v1/matches/:id/ticket/settle-no-charge", () => {
  const settle = (scope: unknown) =>
    request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/settle-no-charge`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope });

  it("settles the gate without a charge on the demo / development rail", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    applyTicketPayment.mockResolvedValueOnce({
      ok: true,
      state: { ...baseState, iPaid: true, ticketStatus: "partial" },
    });
    const res = await settle("self");
    expect(res.status).toBe(200);
    expect(res.body.iPaid).toBe(true);
    expect(res.body.ticketStatus).toBe("partial");
    expect(res.body.rail).toBe("no-charge");
    expect(applyTicketPayment).toHaveBeenCalledWith(fakeApi, 5986970093n, VALID_UUID, "self");
  });

  it("does not exist wherever money can move", async () => {
    // Decided by the runtime, not by a config default: neither a Stars
    // deployment nor one that forgot to switch Stars on can reach it.
    for (const blocked of ["stars", "none"] as const) {
      rail = blocked;
      const res = await settle("self");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("no-charge-unavailable");
    }
    expect(getTicketState).not.toHaveBeenCalled();
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("returns 401 without auth", async () => {
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/settle-no-charge`)
      .send({ scope: "self" });
    expect(res.status).toBe(401);
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("rejects scope 'both' for a female user with 403, like the Stars invoice", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: { ...baseState, myGender: "female" } });
    const res = await settle("both");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("scope-not-allowed");
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("refuses to cover a partner who already settled her own slot", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: { ...baseState, partnerPaid: true } });
    const res = await settle("both");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("partner-already-paid");
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("rejects an invalid scope with 400", async () => {
    const res = await settle("free");
    expect(res.status).toBe(400);
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("maps a gate scope-not-allowed → 400", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    applyTicketPayment.mockResolvedValueOnce({ ok: false, reason: "scope-not-allowed" });
    const res = await settle("both");
    expect(res.status).toBe(400);
  });

  it("maps not-participant → 403 before touching the gate", async () => {
    getTicketState.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const res = await settle("self");
    expect(res.status).toBe(403);
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });
});

describe("POST /v1/matches/:id/ticket/use", () => {
  it("spends a wallet ticket and returns the new state", async () => {
    useTicketFromBalance.mockResolvedValueOnce({
      ok: true,
      state: { ...baseState, iPaid: true, ticketStatus: "partial" },
    });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.iPaid).toBe(true);
    expect(useTicketFromBalance).toHaveBeenCalledWith(
      expect.anything(),
      5986970093n,
      VALID_UUID,
      "self",
    );
  });

  it("accepts scope 'partner' for the cover-your-date flow", async () => {
    useTicketFromBalance.mockResolvedValueOnce({ ok: true, state: baseState });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "partner" });
    expect(res.status).toBe(200);
    expect(useTicketFromBalance).toHaveBeenCalledWith(expect.anything(), 5986970093n, VALID_UUID, "partner");
  });

  // Regression: the Mini App re-renders from THIS response instead of
  // re-fetching /state, so dropping the Stars fields here made the next screen
  // believe Stars was off and sent the male "cover both" combo's follow-up
  // partner payment into the mock /intent rail, which 404s under PAY-1.
  it("carries the Stars fields so the follow-up screen keeps the Stars rail", async () => {
    env.TICKET_STARS_ENABLED = true;
    useTicketFromBalance.mockResolvedValueOnce({
      ok: true,
      state: { ...baseState, iPaid: true, ticketStatus: "partial" },
    });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self" });
    expect(res.status).toBe(200);
    expect(res.body.starsEnabled).toBe(true);
    expect(res.body.stars).toEqual({ self: 425, both: 850, partner: 425 });
  });

  it("maps insufficient-balance → 409", async () => {
    useTicketFromBalance.mockResolvedValueOnce({ ok: false, reason: "insufficient-balance" });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("insufficient-balance");
  });

  it("rejects an unknown scope with 400", async () => {
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "nonsense" });
    expect(res.status).toBe(400);
    expect(useTicketFromBalance).not.toHaveBeenCalled();
  });

  it("returns 401 without auth", async () => {
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use`)
      .send({ scope: "self" });
    expect(res.status).toBe(401);
    expect(useTicketFromBalance).not.toHaveBeenCalled();
  });

  it("rejects initData passed in the query string (spend must use the header)", async () => {
    // initData is a bearer-equivalent credential valid for two hours, and a
    // query string leaks into proxy logs, browser history and Referer headers.
    // The `?a=` form exists only for `<img>` on the photo route.
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/use?a=${encodeURIComponent(initData)}`)
      .send({ scope: "self" });
    expect(res.status).toBe(401);
    expect(useTicketFromBalance).not.toHaveBeenCalled();
  });
});

describe("GET /v1/matches/:id/ticket/photo/:side", () => {
  it("still accepts initData via ?a= (an <img> cannot send a header)", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp()).get(
      `/v1/matches/${VALID_UUID}/ticket/photo/self?a=${encodeURIComponent(initData)}`,
    );
    // Auth passed — we get the route's own not-found/participant answer, not 401.
    expect(res.status).not.toBe(401);
  });

  it("returns 401 for a query param that isn't validly signed", async () => {
    const res = await request(buildApp()).get(
      `/v1/matches/${VALID_UUID}/ticket/photo/self?a=${encodeURIComponent("user=%7B%22id%22%3A1%7D&hash=deadbeef")}`,
    );
    expect(res.status).toBe(401);
  });

  // The Mini App is served from a DIFFERENT host to this API, so an avatar is a
  // cross-origin no-cors subresource: helmet's default `same-origin` CORP makes
  // the browser discard a perfectly good 200 and the client falls back to a
  // monogram. Nothing else in this suite can see that — supertest, curl and
  // every server-side probe ignore CORP entirely — which is exactly how the bug
  // survived two rounds of diagnosis. See public/cross-origin-image.ts.
  it("serves the avatar with a cross-origin resource policy", async () => {
    getTicketPhoto.mockResolvedValueOnce({ ok: true, ref: "file_123" });
    downloadProfileImage.mockResolvedValueOnce(Buffer.from("original-bytes"));
    toAvatarThumbnail.mockResolvedValueOnce(Buffer.from("thumb-bytes"));

    const res = await request(buildApp()).get(
      `/v1/matches/${VALID_UUID}/ticket/photo/partner?a=${encodeURIComponent(signInitData(BOT_TOKEN))}`,
    );

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });
});
