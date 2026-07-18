import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const userUpdateMany = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: userFindUnique, update: userUpdate, updateMany: userUpdateMany },
  },
}));

const envMock = {
  ENABLE_PERSONA_VERIFICATION: true,
  PERSONA_TEMPLATE_ID: "itmpl_1",
  PERSONA_ENVIRONMENT_ID: "env_1",
  PERSONA_HOSTED_URL_BASE: "https://withpersona.com/verify",
};
vi.mock("../../config.js", () => ({ env: envMock }));
vi.mock("../config.js", () => ({ env: envMock }));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "user-1";
    next();
  },
}));

const pullVerificationStatus = vi.fn(async () => ({ outcome: "pending" }));
vi.mock("../services/verification-pipeline.js", () => ({ pullVerificationStatus }));

const getBotApi = vi.fn(() => ({ fake: "api" }));
vi.mock("./server.js", () => ({ getBotApi }));

vi.mock("../services/persona.js", () => ({
  buildPersonaHostedUrl: (id: string) => `https://persona/${id}`,
}));

const { verificationRouter } = await import("./routes/verification.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/verification", verificationRouter);
  return app;
}

beforeEach(() => {
  userFindUnique.mockReset();
  userUpdate.mockReset().mockResolvedValue({});
  userUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  pullVerificationStatus.mockClear();
  getBotApi.mockReturnValue({ fake: "api" });
  envMock.ENABLE_PERSONA_VERIFICATION = true;
  envMock.PERSONA_TEMPLATE_ID = "itmpl_1";
});

describe("GET /v1/me/verification/native-init", () => {
  it("returns SDK config and flips status to pending", async () => {
    userFindUnique.mockResolvedValue({
      id: "user-1",
      language: "ru",
      verificationStatus: "unverified",
    });
    const res = await request(buildApp()).get("/v1/me/verification/native-init");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      referenceId: "user-1",
      templateId: "itmpl_1",
      environmentId: "env_1",
      language: "ru",
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { verificationStatus: "pending" },
    });
  });

  it("409s when already verified and 503s when unconfigured", async () => {
    userFindUnique.mockResolvedValue({
      id: "user-1",
      language: "en",
      verificationStatus: "verified",
    });
    expect((await request(buildApp()).get("/v1/me/verification/native-init")).status).toBe(409);

    envMock.PERSONA_TEMPLATE_ID = "";
    expect((await request(buildApp()).get("/v1/me/verification/native-init")).status).toBe(503);
  });
});

describe("POST /v1/me/verification/native-event", () => {
  it("complete CAS-writes the inquiry id and fires the pull fallback", async () => {
    userFindUnique.mockResolvedValue({ id: "user-1", personaInquiryId: null });
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete", inquiryId: "inq_123" });
    expect(res.status).toBe(200);
    expect(userUpdateMany).toHaveBeenCalledWith({
      where: { id: "user-1", personaInquiryId: null },
      data: { personaInquiryId: "inq_123" },
    });
    expect(pullVerificationStatus).toHaveBeenCalledWith("user-1", { fake: "api" });
  });

  it("never overwrites an existing inquiry id", async () => {
    userFindUnique.mockResolvedValue({ id: "user-1", personaInquiryId: "inq_prior" });
    const res = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "complete", inquiryId: "inq_other" });
    expect(res.status).toBe(200);
    expect(userUpdateMany).not.toHaveBeenCalled();
    expect(pullVerificationStatus).toHaveBeenCalled();
  });

  it("logs cancel/error without touching state and rejects unknown kinds", async () => {
    userFindUnique.mockResolvedValue({ id: "user-1", personaInquiryId: null });
    const cancel = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "cancel" });
    expect(cancel.status).toBe(200);
    expect(pullVerificationStatus).not.toHaveBeenCalled();

    const bad = await request(buildApp())
      .post("/v1/me/verification/native-event")
      .send({ kind: "nonsense" });
    expect(bad.status).toBe(400);
  });
});
