import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { PHONE_AUTH_ENABLED: true };
vi.mock("../../config.js", () => ({ env: envMock }));
vi.mock("../config.js", () => ({ env: envMock }));

const requestPhoneCode = vi.fn();
const verifyPhoneCode = vi.fn();
vi.mock("../services/phone-verification.js", () => ({
  requestPhoneCode,
  verifyPhoneCode,
}));

const findOrCreateMobileUserByPhone = vi.fn();
vi.mock("./mobile-user.js", () => ({
  findOrCreateMobileUserByPhone,
}));

vi.mock("./jwt.js", () => ({
  signAccessToken: vi.fn(() => "access-token"),
  createRefreshToken: vi.fn(async () => "refresh-token"),
  accessTokenTtlSeconds: vi.fn(() => 900),
}));

vi.mock("./routes/serializers.js", () => ({
  serializeUser: vi.fn((u: { id: string }) => ({ id: u.id })),
}));

const { phoneAuthRouter } = await import("./routes/phone-auth.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/auth/phone", phoneAuthRouter);
  return app;
}

beforeEach(() => {
  envMock.PHONE_AUTH_ENABLED = true;
  requestPhoneCode.mockReset();
  verifyPhoneCode.mockReset();
  findOrCreateMobileUserByPhone.mockReset();
});

describe("/v1/auth/phone", () => {
  it("404s everything while PHONE_AUTH_ENABLED is off", async () => {
    envMock.PHONE_AUTH_ENABLED = false;
    const res = await request(buildApp())
      .post("/v1/auth/phone/request")
      .send({ phone: "+380631234567" });
    expect(res.status).toBe(404);
    expect(requestPhoneCode).not.toHaveBeenCalled();
  });

  it("passes deliveredVia through on a successful request", async () => {
    const now = new Date();
    requestPhoneCode.mockResolvedValue({
      ok: true,
      deliveredVia: "telegram",
      expiresAt: now,
      resendAvailableAt: now,
    });
    const res = await request(buildApp())
      .post("/v1/auth/phone/request")
      .send({ phone: "+380631234567" });
    expect(res.status).toBe(200);
    expect(res.body.deliveredVia).toBe("telegram");
  });

  it("forwards the forced-SMS channel to the service", async () => {
    const now = new Date();
    requestPhoneCode.mockResolvedValue({
      ok: true,
      deliveredVia: "sms",
      expiresAt: now,
      resendAvailableAt: now,
    });
    await request(buildApp())
      .post("/v1/auth/phone/request")
      .send({ phone: "+380631234567", channel: "sms" });
    expect(requestPhoneCode).toHaveBeenCalledWith("+380631234567", { forceSms: true });
  });

  it("maps cooldown to 429 with resendAvailableAt", async () => {
    const at = new Date();
    requestPhoneCode.mockResolvedValue({ ok: false, reason: "cooldown", resendAvailableAt: at });
    const res = await request(buildApp())
      .post("/v1/auth/phone/request")
      .send({ phone: "+380631234567" });
    expect(res.status).toBe(429);
    expect(res.body.resendAvailableAt).toBe(at.toISOString());
  });

  it("mints tokens for a verified code", async () => {
    verifyPhoneCode.mockResolvedValue({ ok: true, phone: "+380631234567" });
    findOrCreateMobileUserByPhone.mockResolvedValue({ id: "user-1" });
    const res = await request(buildApp())
      .post("/v1/auth/phone/verify")
      .send({ phone: "+380631234567", code: "123456" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresIn: 900,
      user: { id: "user-1" },
    });
  });

  it("maps mismatch to 401 and keeps the account untouched", async () => {
    verifyPhoneCode.mockResolvedValue({ ok: false, reason: "mismatch" });
    const res = await request(buildApp())
      .post("/v1/auth/phone/verify")
      .send({ phone: "+380631234567", code: "000000" });
    expect(res.status).toBe(401);
    expect(findOrCreateMobileUserByPhone).not.toHaveBeenCalled();
  });
});
