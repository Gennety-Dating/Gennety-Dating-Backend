import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock = { APP_REVIEW_EMAIL: "review@gennety.com", APP_REVIEW_CODE: "583014" };
vi.mock("../config.js", () => ({ env: envMock }));
vi.mock("../workers/embedding-refresh.js", () => ({ refreshUserEmbedding: vi.fn() }));
vi.mock("../services/ticket-wallet.js", () => ({ getBalance: vi.fn(), grantTickets: vi.fn() }));
vi.mock("../services/device-tokens.js", () => ({ signOutDevice: vi.fn() }));
vi.mock("./auth-middleware.js", () => ({ requireAuth: vi.fn() }));

const createAndSendOtp = vi.fn();
const verifyOtp = vi.fn();
vi.mock("./otp.js", () => ({ createAndSendOtp, verifyOtp }));

const findOrCreateMobileUser = vi.fn();
vi.mock("./mobile-user.js", () => ({ findOrCreateMobileUser }));

const passthrough = (_req: unknown, _res: unknown, next: () => void) => next();
vi.mock("./rate-limit.js", () => ({
  otpRequestLimiter: passthrough,
  otpVerifyLimiter: passthrough,
  refreshLimiter: passthrough,
}));
vi.mock("./login-gate.js", () => ({ refuseBannedLogin: vi.fn(() => false) }));
vi.mock("./jwt.js", () => ({
  signAccessToken: vi.fn((id: string) => `access-${id}`),
  createRefreshToken: vi.fn(async () => "refresh-token"),
  rotateRefreshToken: vi.fn(),
  accessTokenTtlSeconds: vi.fn(() => 900),
}));
vi.mock("./routes/serializers.js", () => ({
  serializeUser: vi.fn((u: { id: string }) => ({ id: u.id })),
}));

const ensureAppReviewReviewer = vi.fn();
vi.mock("../services/app-review.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/app-review.js")>()),
  ensureAppReviewReviewer,
}));

const { authRouter } = await import("./routes/auth.js");
const { resetAppReviewFailures } = await import("../services/app-review.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/auth", authRouter);
  return app;
}

beforeEach(() => {
  envMock.APP_REVIEW_EMAIL = "review@gennety.com";
  envMock.APP_REVIEW_CODE = "583014";
  resetAppReviewFailures();
  createAndSendOtp.mockReset();
  verifyOtp.mockReset();
  findOrCreateMobileUser.mockReset();
  ensureAppReviewReviewer.mockReset().mockResolvedValue({ id: "reviewer" });
});

describe("App Store review sign-in", () => {
  it("answers the code request without sending mail", async () => {
    const res = await request(buildApp())
      .post("/v1/auth/otp/request")
      .send({ email: "Review@Gennety.com" });
    expect(res.status).toBe(200);
    expect(createAndSendOtp).not.toHaveBeenCalled();
  });

  it("signs in with the fixed code", async () => {
    const res = await request(buildApp())
      .post("/v1/auth/otp/verify")
      .send({ email: "review@gennety.com", otp: "583014" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accessToken: "access-reviewer", user: { id: "reviewer" } });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(findOrCreateMobileUser).not.toHaveBeenCalled();
  });

  it("refuses a wrong code without touching the account", async () => {
    const res = await request(buildApp())
      .post("/v1/auth/otp/verify")
      .send({ email: "review@gennety.com", otp: "583015" });
    expect(res.status).toBe(401);
    expect(ensureAppReviewReviewer).not.toHaveBeenCalled();
  });

  it("leaves every other address on the ordinary rail", async () => {
    const res = await request(buildApp())
      .post("/v1/auth/otp/verify")
      .send({ email: "someone@gennety.com", otp: "583014" });
    // gennety.com is not a university domain → the ordinary 400.
    expect(res.status).toBe(400);
    expect(ensureAppReviewReviewer).not.toHaveBeenCalled();
  });

  it("is inert while the feature is off", async () => {
    envMock.APP_REVIEW_EMAIL = "";
    envMock.APP_REVIEW_CODE = "";
    const res = await request(buildApp())
      .post("/v1/auth/otp/verify")
      .send({ email: "review@gennety.com", otp: "583014" });
    expect(res.status).toBe(400);
    expect(ensureAppReviewReviewer).not.toHaveBeenCalled();
  });
});
