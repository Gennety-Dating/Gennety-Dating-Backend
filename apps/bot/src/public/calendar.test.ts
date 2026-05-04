/**
 * Integration test for the `/v1/calendar/pick` endpoint.
 *
 * The endpoint authenticates Mini App requests via Telegram `initData` HMAC
 * (validated by `validateInitData` — its own unit tests in
 * `init-data.test.ts`) and delegates to `processCalendarSlotPick` for the
 * DB / scheduling logic. So this test focuses on:
 *   - Auth surface: missing header, malformed scheme, signed by wrong token.
 *   - Body validation: missing `matchId` / `pickedIso`.
 *   - HTTP status mapping for each `processCalendarSlotPick` failure reason.
 *   - Happy path: 200 with `{ awaitingPeer, bothPicked }`.
 *
 * The scheduler logic itself is exhaustively covered by
 * `handlers/matching/scheduler.test.ts` — here we mock the function so the
 * test stays focused on the HTTP boundary.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-calendar-suite";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
  },
}));

const processSlot = vi.fn();
vi.mock("../handlers/matching/scheduler.js", () => ({
  processCalendarSlotPick: processSlot,
}));

const { createCalendarRouter } = await import("./routes/calendar.js");

const fakeApi = {} as Parameters<typeof createCalendarRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/calendar", createCalendarRouter(fakeApi));
  return app;
}

function signInitData(
  botToken: string,
  overrides: { authDate?: number; user?: Record<string, unknown> } = {},
): string {
  const params = new URLSearchParams();
  params.set("auth_date", String(overrides.authDate ?? Math.floor(Date.now() / 1000)));
  params.set("query_id", "AAH_test");
  params.set(
    "user",
    JSON.stringify(
      overrides.user ?? {
        id: 5986970093,
        first_name: "Pro",
        username: "pro",
      },
    ),
  );
  const sortedKeys = [...params.keys()].sort();
  const dcs = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secretKey).update(dcs).digest("hex");
  params.set("hash", hash);
  return params.toString();
}

describe("POST /v1/calendar/pick", () => {
  beforeEach(() => {
    processSlot.mockReset();
  });

  it("returns 200 and the pick result on the happy path", async () => {
    processSlot.mockResolvedValueOnce({ ok: true, awaitingPeer: true, bothPicked: false });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "2026-05-09T19:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, awaitingPeer: true, bothPicked: false });
    expect(processSlot).toHaveBeenCalledWith(
      fakeApi,
      5986970093n,
      "11111111-1111-4111-8111-111111111111",
      "2026-05-09T19:00:00.000Z",
    );
  });

  it("forwards bothPicked=true when the peer had already picked", async () => {
    processSlot.mockResolvedValueOnce({ ok: true, awaitingPeer: false, bothPicked: true });
    const initData = signInitData(BOT_TOKEN);

    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "2026-05-09T19:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.bothPicked).toBe(true);
  });

  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "i" });
    expect(res.status).toBe(401);
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("returns 401 when Authorization uses a non-tma scheme", async () => {
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", "Bearer something")
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "i" });
    expect(res.status).toBe(401);
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const initData = signInitData("999:other-token");
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "i" });
    expect(res.status).toBe(401);
    expect(res.body.reason).toBe("bad-hash");
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("returns 400 when matchId is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ pickedIso: "2026-05-09T19:00:00.000Z" });
    expect(res.status).toBe(400);
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("returns 400 when pickedIso is missing", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "m" });
    expect(res.status).toBe(400);
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("maps match-not-found → 404", async () => {
    processSlot.mockResolvedValueOnce({ ok: false, reason: "match-not-found" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({
        matchId: "22222222-2222-4222-8222-222222222222",
        pickedIso: "2026-05-09T19:00:00.000Z",
      });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("match-not-found");
  });

  it("maps not-participant → 403", async () => {
    processSlot.mockResolvedValueOnce({ ok: false, reason: "not-participant" });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "2026-05-09T19:00:00.000Z" });
    expect(res.status).toBe(403);
  });

  it("rejects a non-UUID matchId with 404 (so Prisma never gets a chance to throw)", async () => {
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/calendar/pick")
      .set("Authorization", `tma ${initData}`)
      .send({ matchId: "test-smoke-99999", pickedIso: "2026-05-09T19:00:00.000Z" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("match-not-found");
    expect(processSlot).not.toHaveBeenCalled();
  });

  it("maps wrong-state, invalid-slot, invalid-iso → 400", async () => {
    const initData = signInitData(BOT_TOKEN);
    for (const reason of ["wrong-state", "invalid-slot", "invalid-iso"] as const) {
      processSlot.mockResolvedValueOnce({ ok: false, reason });
      const res = await request(buildApp())
        .post("/v1/calendar/pick")
        .set("Authorization", `tma ${initData}`)
        .send({ matchId: "11111111-1111-4111-8111-111111111111", pickedIso: "2026-05-09T19:00:00.000Z" });
      expect(res.status, `for ${reason}`).toBe(400);
      expect(res.body.error).toBe(reason);
    }
  });
});
