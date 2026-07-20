import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUniqueOrThrow = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUniqueOrThrow: userFindUniqueOrThrow,
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

const transitionAccountStatus = vi.fn();
const freezeAccount = vi.fn();
vi.mock("../services/account-status-transitions.js", () => ({
  transitionAccountStatus,
  freezeAccount,
}));

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
  userFindUniqueOrThrow.mockReset().mockResolvedValue({
    id: "user-1",
    status: "active",
    profile: null,
  });
  transitionAccountStatus.mockReset();
  freezeAccount.mockReset();
  getBotApi.mockReturnValue(null);
});

describe("PATCH /v1/me/status", () => {
  it("pauses an active user", async () => {
    transitionAccountStatus.mockResolvedValue({ kind: "changed", status: "paused" });
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(transitionAccountStatus).toHaveBeenCalledWith({ id: "user-1" }, "pause");
  });

  it("resumes from paused and silently reactivates from frozen", async () => {
    for (const from of ["paused", "frozen"]) {
      transitionAccountStatus.mockReset();
      transitionAccountStatus.mockResolvedValueOnce(
        from === "paused"
          ? { kind: "changed", status: "active" }
          : { kind: "forbidden", status: "frozen" },
      );
      if (from === "frozen") {
        transitionAccountStatus.mockResolvedValueOnce({ kind: "changed", status: "active" });
      }
      const res = await request(buildApp()).patch("/v1/me/status").send({ status: "active" });
      expect(res.status, `from ${from}`).toBe(200);
      expect(transitionAccountStatus).toHaveBeenCalledWith(
        { id: "user-1" },
        from === "paused" ? "resume" : "return_from_freeze",
      );
    }
  });

  it("is idempotent for same-state requests", async () => {
    transitionAccountStatus.mockResolvedValue({ kind: "already", status: "paused" });
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "paused" });
    expect(res.status).toBe(200);
    expect(transitionAccountStatus).toHaveBeenCalledTimes(1);
  });

  it("refuses transitions owned by other flows", async () => {
    for (const from of ["onboarding", "suspended", "banned", "pending_investigation"]) {
      transitionAccountStatus.mockResolvedValue({ kind: "forbidden", status: from });
      const res = await request(buildApp()).patch("/v1/me/status").send({ status: "active" });
      expect(res.status, `from ${from}`).toBe(409);
    }
  });

  it("rejects unknown statuses", async () => {
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "frozen" });
    expect(res.status).toBe(400);
  });

  it("preserves the existing not-found response", async () => {
    transitionAccountStatus.mockResolvedValue({ kind: "not_found" });
    const res = await request(buildApp()).patch("/v1/me/status").send({ status: "paused" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });
});

describe("POST /v1/me/freeze", () => {
  it("cancels in-flight matches, flips to frozen, fires side effects", async () => {
    freezeAccount.mockResolvedValue({ kind: "changed", status: "frozen" });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(200);
    expect(freezeAccount).toHaveBeenCalledWith({ id: "user-1" }, null);
  });

  it("is idempotent when already frozen", async () => {
    freezeAccount.mockResolvedValue({ kind: "already", status: "frozen" });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(200);
    expect(freezeAccount).toHaveBeenCalledTimes(1);
  });

  it("refuses freeze from non-freezable states", async () => {
    freezeAccount.mockResolvedValue({ kind: "forbidden", status: "onboarding" });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(409);
    expect(freezeAccount).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing not-found response", async () => {
    freezeAccount.mockResolvedValue({ kind: "not_found" });
    const res = await request(buildApp()).post("/v1/me/freeze").send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found" });
  });
});
