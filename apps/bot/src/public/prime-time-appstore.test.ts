/**
 * Route test for `POST /v1/prime-time/appstore/transaction` — the first route
 * test any App Store till has had.
 *
 * The purchase logic belongs to `appstore-prime-time.ts` and is covered there;
 * what this pins is the boundary the iOS client reads: which failures are
 * refused before anything is looked up, and how each service outcome becomes
 * a status the client decides `finish()` on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const MATCH_ID = "33333333-3333-4333-8333-333333333333";

const { env, featureLive, configured, purchasePrimeTimePass } = vi.hoisted(() => ({
  env: { PRIME_TIME_APPSTORE_ENABLED: true },
  featureLive: { value: true },
  configured: { value: true },
  purchasePrimeTimePass: vi.fn(),
}));
vi.mock("../config.js", () => ({ env }));

vi.mock("../services/prime-time.js", () => ({
  primeTimeFeatureLive: () => featureLive.value,
}));

vi.mock("../services/appstore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/appstore.js")>();
  return {
    decodeJwsPayload: actual.decodeJwsPayload,
    appStoreConfigured: () => configured.value,
  };
});

vi.mock("../services/appstore-prime-time.js", () => ({
  purchasePrimeTimePass: (...a: unknown[]) => purchasePrimeTimePass(...a),
}));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = USER_ID;
    next();
  },
}));

const { createPrimeTimeAppStoreRouter } = await import("./routes/prime-time-appstore.js");
const fakeApi = {} as Parameters<typeof createPrimeTimeAppStoreRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/prime-time/appstore", createPrimeTimeAppStoreRouter(fakeApi));
  return app;
}

/** A structurally valid JWS whose payload names a transaction. */
function jwsFor(payload: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "ES256" })}.${part(payload)}.sig`;
}

const post = (body: unknown) =>
  request(buildApp()).post("/v1/prime-time/appstore/transaction").send(body as object);

beforeEach(() => {
  env.PRIME_TIME_APPSTORE_ENABLED = true;
  featureLive.value = true;
  configured.value = true;
  purchasePrimeTimePass.mockReset();
  purchasePrimeTimePass.mockResolvedValue({ status: "settled" });
});

describe("POST /v1/prime-time/appstore/transaction", () => {
  it("does not exist while the rail or the feature is off", async () => {
    env.PRIME_TIME_APPSTORE_ENABLED = false;
    expect((await post({ jws: jwsFor({ transactionId: "1" }), matchId: MATCH_ID })).status).toBe(404);

    env.PRIME_TIME_APPSTORE_ENABLED = true;
    featureLive.value = false;
    expect((await post({ jws: jwsFor({ transactionId: "1" }), matchId: MATCH_ID })).status).toBe(404);
    expect(purchasePrimeTimePass).not.toHaveBeenCalled();
  });

  it("503s without App Store keys rather than refusing the purchase", async () => {
    configured.value = false;
    const res = await post({ jws: jwsFor({ transactionId: "1" }), matchId: MATCH_ID });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("App Store verification not configured");
  });

  it.each([
    ["Missing jws", { matchId: MATCH_ID }],
    ["Missing jws", { jws: "x".repeat(20_001), matchId: MATCH_ID }],
    ["Missing matchId", { jws: jwsFor({ transactionId: "1" }), matchId: "not-a-uuid" }],
    ["Invalid transaction payload", { jws: "a.b.c", matchId: MATCH_ID }],
    ["Invalid transaction payload", { jws: jwsFor({ productId: "prime_time_pass" }), matchId: MATCH_ID }],
  ])("400 %s", async (error, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(error);
    expect(purchasePrimeTimePass).not.toHaveBeenCalled();
  });

  it("hands the service the caller, the match and the transaction id only", async () => {
    const res = await post({ jws: jwsFor({ transactionId: "2000000999" }), matchId: MATCH_ID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(purchasePrimeTimePass).toHaveBeenCalledWith(fakeApi, USER_ID, MATCH_ID, "2000000999");
  });

  it.each([
    [{ status: "unclaimed", reason: "already_unlocked" }, 409, "already_unlocked"],
    [{ status: "unclaimed", reason: "match_closed" }, 409, "match_closed"],
    [{ status: "invalid", reason: "revoked" }, 422, "revoked"],
    [{ status: "invalid", reason: "unknown_product" }, 422, "unknown_product"],
  ])("translates %o into %i with its code", async (result, status, code) => {
    purchasePrimeTimePass.mockResolvedValue(result);
    const res = await post({ jws: jwsFor({ transactionId: "1" }), matchId: MATCH_ID });
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(typeof res.body.error).toBe("string");
  });

  it("503s when Apple (or the first report) is still in flight", async () => {
    purchasePrimeTimePass.mockResolvedValue({ status: "unavailable" });
    const res = await post({ jws: jwsFor({ transactionId: "1" }), matchId: MATCH_ID });
    expect(res.status).toBe(503);
  });
});
