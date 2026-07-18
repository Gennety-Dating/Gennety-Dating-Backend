import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userFindUniqueOrThrow = vi.fn();
const userUpdate = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      findUniqueOrThrow: userFindUniqueOrThrow,
      update: userUpdate,
    },
  },
}));

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string }, _res: unknown, next: () => void) => {
    req.userId = "user-1";
    next();
  },
}));

vi.mock("./routes/serializers.js", () => ({
  serializeUser: vi.fn((u: { id?: string; status?: string }) => ({
    id: u.id ?? "user-1",
    status: u.status,
  })),
  serializeProfile: vi.fn(() => ({})),
}));

const cancelInFlightMatchesForUser = vi.fn();
vi.mock("../services/cancel-in-flight-matches.js", () => ({
  cancelInFlightMatchesForUser,
}));

const notifyFounderAccountClosed = vi.fn(async () => {});
vi.mock("../services/founder-notify.js", () => ({ notifyFounderAccountClosed }));

const unpinStatusBanner = vi.fn(async () => {});
vi.mock("../services/status-banner.js", () => ({ unpinStatusBanner }));

const getBotApi = vi.fn(() => null);
vi.mock("./server.js", () => ({ getBotApi }));

const { accountStatusRouter } = await import("./routes/account-status.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me", accountStatusRouter);
  return app;
}

beforeEach(() => {
  userFindUnique.mockReset();
  userFindUniqueOrThrow.mockReset().mockResolvedValue({
    id: "user-1",
    status: "active",
    profile: null,
  });
  userUpdate.mockReset().mockResolvedValue({});
  cancelInFlightMatchesForUser.mockReset().mockResolvedValue(undefined);
  notifyFounderAccountClosed.mockClear();
  unpinStatusBanner.mockClear();
  getBotApi.mockReturnValue(null);
});

describe("PATCH /v1/me/status", () => {
  it("pauses an active user", async () => {
    userFindUnique.mockResolvedValue({ status: "active" });
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { status: "paused" },
    });
  });

  it("resumes from paused and silently reactivates from frozen", async () => {
    for (const from of ["paused", "frozen"]) {
      userUpdate.mockClear();
      userFindUnique.mockResolvedValue({ status: from });
      const res = await request(buildApp()).patch("/v1/me/status").send({ status: "active" });
      expect(res.status, `from ${from}`).toBe(200);
      expect(userUpdate).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { status: "active" },
      });
    }
  });

  it("is idempotent for same-state requests", async () => {
    userFindUnique.mockResolvedValue({ status: "paused" });
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses transitions owned by other flows", async () => {
    for (const from of ["onboarding", "suspended", "banned", "pending_investigation"]) {
      userFindUnique.mockResolvedValue({ status: from });
      const res = await request(buildApp()).patch("/v1/me/status").send({ status: "active" });
      expect(res.status, `from ${from}`).toBe(409);
    }
  });

  it("rejects unknown statuses", async () => {
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "frozen" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/me/freeze", () => {
  it("cancels in-flight matches, flips to frozen, fires side effects", async () => {
    userFindUnique.mockResolvedValue({ status: "active", telegramId: -42n });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(200);
    expect(cancelInFlightMatchesForUser).toHaveBeenCalledWith("user-1", null);
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { status: "frozen" },
    });
    expect(notifyFounderAccountClosed).toHaveBeenCalledWith("frozen");
  });

  it("is idempotent when already frozen", async () => {
    userFindUnique.mockResolvedValue({ status: "frozen", telegramId: -42n });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(200);
    expect(cancelInFlightMatchesForUser).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses freeze from non-freezable states", async () => {
    userFindUnique.mockResolvedValue({ status: "onboarding", telegramId: -42n });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(409);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
