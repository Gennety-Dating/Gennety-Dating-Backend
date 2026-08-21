/**
 * Integration test for the NATIVE `/v1/matches/:id/ticket-gate*` surface — the
 * JWT twin of the initData-authed Mini App router (`ticket-api.test.ts`).
 *
 * Same shape as that suite: the HTTP boundary (auth, validation, status
 * mapping, the projection) with the gate module mocked. The gate's own settle
 * logic is already covered by `ticket-expiry.test.ts`; what is worth asserting
 * here is that iOS is served a NARROWER state than Telegram — the Stars/mock
 * payment rails do not exist for it — and that the male-only cover rule is
 * decided by the server rather than by the client.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const VALID_UUID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("../config.js", () => ({
  env: { BOT_TOKEN: "123456:test", PUBLIC_BASE_URL: "https://api.example.test" },
}));

const getTicketState = vi.fn();
const useTicketFromBalance = vi.fn();
const notePartnerPaidSeen = vi.fn().mockResolvedValue(undefined);
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  getTicketState: (...a: unknown[]) => getTicketState(...a),
  useTicketFromBalance: (...a: unknown[]) => useTicketFromBalance(...a),
  notePartnerPaidSeen: (...a: unknown[]) => notePartnerPaidSeen(...a),
}));

const findUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));

// `requireAuth` verifies a real JWT; the token plumbing is already covered by
// jwt.test.ts, so this suite injects the caller directly.
vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = USER_ID;
    next();
  },
}));

const { createNativeTicketGateRouter } = await import("./routes/ticket-gate.js");
const fakeApi = {} as Parameters<typeof createNativeTicketGateRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/matches/:matchId/ticket-gate", createNativeTicketGateRouter(fakeApi));
  return app;
}

const baseState = {
  ticketStatus: "pending",
  priceCents: 699,
  myGender: "male" as "male" | "female" | null,
  mySide: "A",
  iPaid: false,
  partnerPaid: false,
  partnerName: "Sam",
  partnerPaidForMe: false,
  iCoveredPartner: false,
  bothPaid: false,
  expiresAt: null,
  paymentMode: "mock",
  myBalance: 2,
  selfDiscountPct: 0,
  selfPriceCents: 699,
  myPhotoUrl: `/v1/matches/${VALID_UUID}/ticket/photo/self`,
  partnerPhotoUrl: `/v1/matches/${VALID_UUID}/ticket/photo/partner`,
};

beforeEach(() => {
  getTicketState.mockReset();
  useTicketFromBalance.mockReset();
  notePartnerPaidSeen.mockReset();
  notePartnerPaidSeen.mockResolvedValue(undefined);
  findUnique.mockReset();
  findUnique.mockResolvedValue({ telegramId: -42n });
});

describe("GET /v1/matches/:id/ticket-gate", () => {
  it("projects the gate state without the rails iOS does not have", async () => {
    getTicketState.mockResolvedValue({ ok: true, state: baseState });

    const res = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "pending",
      iPaid: false,
      partnerPaid: false,
      partnerFirstName: "Sam",
      balance: 2,
      priceCents: 699,
    });
    // The Telegram-only rails must not leak: a client that branched on them
    // would be branching on a currency it can never charge in.
    expect(res.body).not.toHaveProperty("paymentMode");
    expect(res.body).not.toHaveProperty("starsEnabled");
    expect(res.body).not.toHaveProperty("selfDiscountPct");
    // The photo is re-signed as an absolute URL an image loader can take;
    // the Mini App's relative initData path would 401 on iOS.
    expect(res.body.partnerPhotoUrl).toContain("/v1/match-media/partner-photo?");
  });

  it("resolves the mobile-first caller by their synthetic negative telegramId", async () => {
    getTicketState.mockResolvedValue({ ok: true, state: baseState });

    await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { telegramId: true },
    });
    // See the Mini App twin: the api handle carries the Premium settle-on-read,
    // so the native GET has to pass it too or an iOS subscriber's slot never
    // closes when the subscription lands mid-gate.
    expect(getTicketState).toHaveBeenCalledWith(-42n, VALID_UUID, expect.anything());
  });

  it("decides canCoverPartner server-side: offered to a man, never to a woman", async () => {
    getTicketState.mockResolvedValue({ ok: true, state: baseState });
    const male = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(male.body.canCoverPartner).toBe(true);

    getTicketState.mockResolvedValue({ ok: true, state: { ...baseState, myGender: "female" } });
    const female = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(female.body.canCoverPartner).toBe(false);
  });

  it("withdraws the cover offer once the partner has settled their own slot", async () => {
    getTicketState.mockResolvedValue({ ok: true, state: { ...baseState, partnerPaid: true } });

    const res = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);

    expect(res.body.canCoverPartner).toBe(false);
  });

  it("fires the cover read-receipt for the covered side, and only for them", async () => {
    getTicketState.mockResolvedValue({ ok: true, state: { ...baseState, partnerPaidForMe: true } });
    await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(notePartnerPaidSeen).toHaveBeenCalledWith(fakeApi, -42n, VALID_UUID);

    notePartnerPaidSeen.mockClear();
    getTicketState.mockResolvedValue({ ok: true, state: baseState });
    await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(notePartnerPaidSeen).not.toHaveBeenCalled();
  });

  it("answers 403 for a non-participant and 404 for an unknown match", async () => {
    getTicketState.mockResolvedValue({ ok: false, reason: "not-participant" });
    const forbidden = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(forbidden.status).toBe(403);

    getTicketState.mockResolvedValue({ ok: false, reason: "match-not-found" });
    const missing = await request(buildApp()).get(`/v1/matches/${VALID_UUID}/ticket-gate`);
    expect(missing.status).toBe(404);
  });

  it("rejects a non-UUID match id before touching the gate", async () => {
    const res = await request(buildApp()).get("/v1/matches/not-a-uuid/ticket-gate");
    expect(res.status).toBe(404);
    expect(getTicketState).not.toHaveBeenCalled();
  });
});

describe("POST /v1/matches/:id/ticket-gate/use", () => {
  it("spends from the wallet and answers with the new state", async () => {
    useTicketFromBalance.mockResolvedValue({
      ok: true,
      state: { ...baseState, iPaid: true, myBalance: 1 },
    });

    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket-gate/use`)
      .send({ scope: "self" });

    expect(res.status).toBe(200);
    expect(useTicketFromBalance).toHaveBeenCalledWith(fakeApi, -42n, VALID_UUID, "self");
    // The response IS the re-render — a client that had to re-fetch would show
    // a stale screen for the round trip.
    expect(res.body).toMatchObject({ iPaid: true, balance: 1 });
  });

  it("maps an empty wallet to 409 and a refused scope to 403", async () => {
    useTicketFromBalance.mockResolvedValue({ ok: false, reason: "insufficient-balance" });
    const broke = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket-gate/use`)
      .send({ scope: "both" });
    expect(broke.status).toBe(409);

    useTicketFromBalance.mockResolvedValue({ ok: false, reason: "not-participant" });
    const foreign = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket-gate/use`)
      .send({ scope: "self" });
    expect(foreign.status).toBe(403);
  });

  it("refuses an unknown scope without spending anything", async () => {
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket-gate/use`)
      .send({ scope: "everyone" });

    expect(res.status).toBe(400);
    expect(useTicketFromBalance).not.toHaveBeenCalled();
  });
});

describe("POST /v1/matches/:id/ticket-gate/seen", () => {
  it("is idempotent and never fails the caller", async () => {
    notePartnerPaidSeen.mockRejectedValueOnce(new Error("telegram is down"));

    const res = await request(buildApp()).post(`/v1/matches/${VALID_UUID}/ticket-gate/seen`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
