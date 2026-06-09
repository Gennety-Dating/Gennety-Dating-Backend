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

vi.mock("../config.js", () => ({ env: { BOT_TOKEN } }));

const getTicketState = vi.fn();
const applyTicketPayment = vi.fn();
const useTicketFromBalance = vi.fn();
vi.mock("../handlers/matching/ticket-gate.js", () => ({
  getTicketState: (...a: unknown[]) => getTicketState(...a),
  applyTicketPayment: (...a: unknown[]) => applyTicketPayment(...a),
  useTicketFromBalance: (...a: unknown[]) => useTicketFromBalance(...a),
}));

const createTicketIntent = vi.fn();
const verifyTicketPayment = vi.fn();
vi.mock("../services/ticket-payment.js", () => ({
  createTicketIntent: (...a: unknown[]) => createTicketIntent(...a),
  verifyTicketPayment: (...a: unknown[]) => verifyTicketPayment(...a),
  amountForScope: (scope: string, price: number) => (scope === "both" ? price * 2 : price),
}));

vi.mock("../services/ticket-analytics.js", () => ({ emitTicketEvent: vi.fn() }));

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
  priceCents: 699,
  myGender: "male",
  mySide: "A",
  iPaid: false,
  partnerPaid: false,
  partnerName: "Sam",
  partnerPaidForMe: false,
  bothPaid: false,
  expiresAt: null,
  paymentMode: "mock",
  myBalance: 0,
};

beforeEach(() => {
  getTicketState.mockReset();
  applyTicketPayment.mockReset();
  useTicketFromBalance.mockReset();
  createTicketIntent.mockReset();
  verifyTicketPayment.mockReset();
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
    expect(getTicketState).toHaveBeenCalledWith(5986970093n, VALID_UUID);
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

describe("POST /v1/matches/:id/ticket/intent", () => {
  it("creates a mock intent on the happy path (self)", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    createTicketIntent.mockResolvedValueOnce({ clientSecret: "mock_pi_x", amountCents: 699, mode: "mock" });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/intent`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self" });
    expect(res.status).toBe(200);
    expect(res.body.clientSecret).toBe("mock_pi_x");
    expect(res.body.amountCents).toBe(699);
    expect(createTicketIntent).toHaveBeenCalledWith({
      payerId: "5986970093",
      matchId: VALID_UUID,
      scope: "self",
      amountCents: 699,
    });
  });

  it("charges double for scope 'both' (male)", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    createTicketIntent.mockResolvedValueOnce({ clientSecret: "mock_pi_y", amountCents: 1398, mode: "mock" });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/intent`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "both" });
    expect(res.status).toBe(200);
    expect(createTicketIntent).toHaveBeenCalledWith({
      payerId: "5986970093",
      matchId: VALID_UUID,
      scope: "both",
      amountCents: 1398,
    });
  });

  it("rejects scope 'both' for a female user with 403", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: { ...baseState, myGender: "female" } });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/intent`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "both" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("scope-not-allowed");
    expect(createTicketIntent).not.toHaveBeenCalled();
  });

  it("rejects an invalid scope with 400", async () => {
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/intent`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "free" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/matches/:id/ticket/confirm", () => {
  it("confirms and returns the new state on the happy path", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    verifyTicketPayment.mockResolvedValueOnce({ ok: true });
    applyTicketPayment.mockResolvedValueOnce({
      ok: true,
      state: { ...baseState, iPaid: true, ticketStatus: "partial" },
    });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/confirm`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self", clientSecret: "mock_pi_x" });
    expect(res.status).toBe(200);
    expect(res.body.iPaid).toBe(true);
    expect(res.body.ticketStatus).toBe("partial");
    expect(verifyTicketPayment).toHaveBeenCalledWith({
      clientSecret: "mock_pi_x",
      payerId: "5986970093",
      matchId: VALID_UUID,
      scope: "self",
      amountCents: 699,
    });
    expect(applyTicketPayment).toHaveBeenCalledWith(fakeApi, 5986970093n, VALID_UUID, "self");
  });

  it("returns 400 when the payment can't be verified", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    verifyTicketPayment.mockResolvedValueOnce({ ok: false });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/confirm`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self", clientSecret: "bogus" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("payment-not-verified");
    expect(applyTicketPayment).not.toHaveBeenCalled();
  });

  it("maps a gate scope-not-allowed → 400", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    verifyTicketPayment.mockResolvedValueOnce({ ok: true });
    applyTicketPayment.mockResolvedValueOnce({ ok: false, reason: "scope-not-allowed" });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/confirm`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "both", clientSecret: "mock_pi_x" });
    expect(res.status).toBe(400);
  });

  it("maps not-participant → 403", async () => {
    getTicketState.mockResolvedValueOnce({ ok: true, state: baseState });
    verifyTicketPayment.mockResolvedValueOnce({ ok: true });
    applyTicketPayment.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const res = await request(buildApp())
      .post(`/v1/matches/${VALID_UUID}/ticket/confirm`)
      .set("Authorization", `tma ${signInitData(BOT_TOKEN)}`)
      .send({ scope: "self", clientSecret: "mock_pi_x" });
    expect(res.status).toBe(403);
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
});
