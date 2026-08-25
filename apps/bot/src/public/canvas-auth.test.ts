import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: userFindUnique } },
}));

const verifyAccessToken = vi.fn();
vi.mock("./jwt.js", () => ({ verifyAccessToken }));

const validateInitData = vi.fn();
vi.mock("./init-data.js", () => ({ validateInitData }));

vi.mock("../config.js", () => ({ env: { BOT_TOKEN: "bot-token" } }));

const { requireCanvasAuth } = await import("./canvas-auth.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/probe", requireCanvasAuth, (req, res) => {
    res.json({ userId: req.userId });
  });
  return app;
}

const probe = () => request(buildApp()).get("/probe");

describe("requireCanvasAuth", () => {
  beforeEach(() => {
    userFindUnique.mockReset();
    verifyAccessToken.mockReset();
    validateInitData.mockReset();
  });

  it("refuses a request with no credential at all", async () => {
    const res = await probe();
    expect(res.status).toBe(401);
    expect(verifyAccessToken).not.toHaveBeenCalled();
    expect(validateInitData).not.toHaveBeenCalled();
  });

  describe("the JWT rail", () => {
    it("resolves the caller straight from the token's subject", async () => {
      verifyAccessToken.mockReturnValue({ sub: "user-1" });
      const res = await probe().set("authorization", "Bearer good");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: "user-1" });
      // The JWT path is stateless — a lookup here would be a cost with no
      // question behind it.
      expect(userFindUnique).not.toHaveBeenCalled();
    });

    it("refuses an invalid token", async () => {
      verifyAccessToken.mockImplementation(() => {
        throw new Error("expired");
      });
      expect((await probe().set("authorization", "Bearer bad")).status).toBe(401);
    });
  });

  describe("the initData rail", () => {
    it("resolves the caller by Telegram id", async () => {
      validateInitData.mockReturnValue({ valid: true, user: { id: 4242 } });
      userFindUnique.mockResolvedValue({ id: "user-2" });
      const res = await probe().set("authorization", "tma raw=payload");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ userId: "user-2" });
      expect(validateInitData).toHaveBeenCalledWith("raw=payload", "bot-token");
      // BigInt, because `User.telegramId` is one — a number here silently
      // matches nothing.
      expect(userFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { telegramId: BigInt(4242) } }),
      );
    });

    it("refuses an empty or unsigned payload", async () => {
      expect((await probe().set("authorization", "tma ")).status).toBe(401);
      expect(validateInitData).not.toHaveBeenCalled();

      validateInitData.mockReturnValue({ valid: false, reason: "bad-hash" });
      const res = await probe().set("authorization", "tma tampered");
      expect(res.status).toBe(401);
      expect(userFindUnique).not.toHaveBeenCalled();
    });

    // 401, not 404: the signature was valid and the account is not ours, which
    // from the caller's side is "you are not signed in here". A 404 would also
    // let this endpoint distinguish "no such user" from "not your match",
    // which the routes behind it deliberately refuse to do.
    it("answers 401 for a valid signature on an unknown account", async () => {
      validateInitData.mockReturnValue({ valid: true, user: { id: 7 } });
      userFindUnique.mockResolvedValue(null);
      const res = await probe().set("authorization", "tma raw");
      expect(res.status).toBe(401);
      expect(res.body.error).not.toMatch(/not found/i);
    });
  });

  it("never lets one rail fall through to the other", async () => {
    // A Bearer header must not be re-read as initData when the token is bad,
    // or a rejected token would get a second chance at a different door.
    verifyAccessToken.mockImplementation(() => {
      throw new Error("nope");
    });
    await probe().set("authorization", "Bearer tma raw");
    expect(validateInitData).not.toHaveBeenCalled();
  });
});
