/**
 * Integration tests for the Verification Mini App API
 * (`/v1/verification/mini-app/*`).
 *
 * Same shape as location.test.ts — real Express + supertest, mocked Prisma
 * and the verification-pipeline pull-fallback helper. We verify:
 *   - TMA initData auth on both endpoints (missing / wrong scheme / wrong token).
 *   - GET /init 503s when Persona feature flag is off OR when template/env ids are missing.
 *   - GET /init 409s when the user is already verified.
 *   - GET /init flips verificationStatus to `pending` on the happy path
 *     and returns the Persona SDK config blob.
 *   - POST /event invalid `kind` returns 400.
 *   - POST /event `complete` writes personaInquiryId (idempotent CAS on null)
 *     and triggers `pullVerificationStatus` exactly once.
 *   - POST /event `complete` second time without overwriting an existing
 *     personaInquiryId — the CAS is enforced via `updateMany` with `null` filter.
 *   - POST /event `cancel` does NOT change verificationStatus or call the pipeline.
 *   - POST /event `error` does NOT change verificationStatus or call the pipeline.
 *
 * Trust boundary kept invisible to this layer: even on `complete`, the route
 * only updates personaInquiryId and triggers the existing pull-fallback —
 * which itself only writes `verified` after Persona's REST API says approved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { createHmac } from "node:crypto";

const BOT_TOKEN = "123456:test-bot-token-for-verification-mini-app";

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN,
    ENABLE_PERSONA_VERIFICATION: true,
    PERSONA_TEMPLATE_ID: "itmpl_test_template",
    PERSONA_ENVIRONMENT_ID: "env_test_environment",
  },
}));

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      update: userUpdate,
      updateMany: userUpdateMany,
    },
  },
}));

const pullVerificationStatus = vi.fn().mockResolvedValue({ kind: "still_pending" });
vi.mock("../services/verification-pipeline.js", () => ({
  pullVerificationStatus,
}));

const { createVerificationMiniAppRouter } = await import(
  "./routes/verification-mini-app.js"
);

const fakeApi = {} as Parameters<typeof createVerificationMiniAppRouter>[0];

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/verification/mini-app", createVerificationMiniAppRouter(fakeApi));
  return app;
}

function signInitData(
  botToken: string,
  overrides: { authDate?: number; user?: Record<string, unknown> } = {},
): string {
  const params = new URLSearchParams();
  params.set(
    "auth_date",
    String(overrides.authDate ?? Math.floor(Date.now() / 1000)),
  );
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

beforeEach(async () => {
  userFindUnique.mockReset();
  userUpdate.mockReset();
  userUpdateMany.mockReset();
  pullVerificationStatus.mockReset();
  pullVerificationStatus.mockResolvedValue({ kind: "still_pending" });
  // The route flips verificationStatus to `pending`; let it succeed by default.
  userUpdate.mockResolvedValue({});
  // Re-mock the env between tests so cases that disable Persona stay scoped.
  const cfg = (await import("../config.js")) as unknown as {
    env: Record<string, unknown>;
  };
  cfg.env.ENABLE_PERSONA_VERIFICATION = true;
  cfg.env.PERSONA_TEMPLATE_ID = "itmpl_test_template";
  cfg.env.PERSONA_ENVIRONMENT_ID = "env_test_environment";
});

describe("GET /v1/verification/mini-app/init", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp()).get("/v1/verification/mini-app/init");
    expect(res.status).toBe(401);
  });

  it("returns 401 when initData was signed by a different bot token", async () => {
    const initData = signInitData("999:other-token");
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(401);
  });

  it("returns 503 when the Persona feature flag is off", async () => {
    const cfg = (await import("../config.js")) as unknown as {
      env: Record<string, unknown>;
    };
    cfg.env.ENABLE_PERSONA_VERIFICATION = false;
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(503);
    expect(userFindUnique).not.toHaveBeenCalled();
  });

  it("returns 503 when PERSONA_TEMPLATE_ID is empty (half-configured deploy)", async () => {
    const cfg = (await import("../config.js")) as unknown as {
      env: Record<string, unknown>;
    };
    cfg.env.PERSONA_TEMPLATE_ID = "";
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(503);
  });

  it("returns 404 when the Telegram user has no DB row", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("user-not-found");
  });

  it("returns 409 when the user is already verified — no Persona re-launch", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "uid-1",
      language: "en",
      verificationStatus: "verified",
    });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already-verified");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("flips verificationStatus to `pending` and returns Persona SDK config", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "uid-1",
      language: "ru",
      verificationStatus: "unverified",
    });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      referenceId: "uid-1",
      templateId: "itmpl_test_template",
      environmentId: "env_test_environment",
      language: "ru",
    });
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const updateArg = userUpdate.mock.calls[0]![0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(updateArg.where.id).toBe("uid-1");
    expect(updateArg.data).toEqual({ verificationStatus: "pending" });
  });

  it("defaults missing language to `en` (mirrors `User.language ?? \"en\"` everywhere)", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "uid-1",
      language: null,
      verificationStatus: "unverified",
    });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .get("/v1/verification/mini-app/init")
      .set("Authorization", `tma ${initData}`);
    expect(res.status).toBe(200);
    expect(res.body.language).toBe("en");
  });
});

describe("POST /v1/verification/mini-app/event", () => {
  it("returns 401 when Authorization is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .send({ kind: "complete" });
    expect(res.status).toBe(401);
  });

  it("returns 400 on an invalid kind", async () => {
    const initData = signInitData(BOT_TOKEN);
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", personaInquiryId: null });
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "🐢" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid-kind");
  });

  it("returns 404 when the Telegram user has no DB row", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "complete", inquiryId: "inq_x" });
    expect(res.status).toBe(404);
    expect(pullVerificationStatus).not.toHaveBeenCalled();
  });

  it("`complete` writes personaInquiryId on null-CAS and triggers pull-fallback", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", personaInquiryId: null });
    userUpdateMany.mockResolvedValueOnce({ count: 1 });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "complete", inquiryId: "inq_abc", status: "approved" });

    expect(res.status).toBe(200);
    expect(userUpdateMany).toHaveBeenCalledTimes(1);
    const casArg = userUpdateMany.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(casArg.where).toEqual({ id: "uid-1", personaInquiryId: null });
    expect(casArg.data).toEqual({ personaInquiryId: "inq_abc" });
    // Wait for the void Promise to settle before asserting on the pipeline call.
    await new Promise((r) => setTimeout(r, 0));
    expect(pullVerificationStatus).toHaveBeenCalledTimes(1);
    expect(pullVerificationStatus).toHaveBeenCalledWith("uid-1", fakeApi);
  });

  it("`complete` skips the personaInquiryId write when it's already set (idempotent)", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "uid-1",
      personaInquiryId: "inq_prior",
    });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "complete", inquiryId: "inq_new" });

    expect(res.status).toBe(200);
    expect(userUpdateMany).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(pullVerificationStatus).toHaveBeenCalledTimes(1);
  });

  it("`cancel` does not call the pipeline or write inquiryId", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", personaInquiryId: null });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "cancel" });

    expect(res.status).toBe(200);
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(pullVerificationStatus).not.toHaveBeenCalled();
  });

  it("`error` does not call the pipeline or write inquiryId", async () => {
    userFindUnique.mockResolvedValueOnce({ id: "uid-1", personaInquiryId: null });
    const initData = signInitData(BOT_TOKEN);
    const res = await request(buildApp())
      .post("/v1/verification/mini-app/event")
      .set("Authorization", `tma ${initData}`)
      .send({ kind: "error", message: "camera denied" });

    expect(res.status).toBe(200);
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(pullVerificationStatus).not.toHaveBeenCalled();
  });
});
