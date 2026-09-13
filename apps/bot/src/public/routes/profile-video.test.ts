import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const env = {
  PROFILE_VIDEO_API_ENABLED: true,
  JWT_SECRET,
  BOT_TOKEN: "123456:test-bot-token",
};
vi.mock("../../config.js", () => ({ env }));

const h = vi.hoisted(() => ({ save: vi.fn(), remove: vi.fn() }));
vi.mock("../../services/native-profile-video.js", () => ({
  saveNativeProfileVideo: h.save,
  removeNativeProfileVideo: h.remove,
}));
// The limiter is a separate concern with its own tests; a shared in-memory
// window would make the order of these cases matter.
vi.mock("../rate-limit.js", () => ({
  videoUploadLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const { createProfileVideoRouter, profileVideoErrorStatus } = await import("./profile-video.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

/** Mirrors the gate in server.ts, so the 404-before-auth contract is tested here. */
function gated(router: Router) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!env.PROFILE_VIDEO_API_ENABLED) {
      res.status(404).json({ error: "profile-video-disabled" });
      return;
    }
    router(req, res, next);
  };
}

function buildApp() {
  const app = express();
  app.use("/v1/me/video", gated(createProfileVideoRouter()));
  return app;
}

function auth(): { Authorization: string } {
  const token = jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
  return { Authorization: `Bearer ${token}` };
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42", "latin1"), Buffer.alloc(16)]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);

function post() {
  return request(buildApp())
    .post("/v1/me/video")
    .set(auth())
    .attach("video", MP4, { filename: "video.mp4", contentType: "video/mp4" })
    .attach("thumb", JPEG, { filename: "thumb.jpg", contentType: "image/jpeg" });
}

beforeEach(() => {
  env.PROFILE_VIDEO_API_ENABLED = true;
  h.save.mockReset().mockResolvedValue({
    ok: true,
    videoUrl: "https://signed.test/v.mp4",
    thumbUrl: "https://signed.test/t.jpg",
    duration: 24.5,
    bonusGranted: true,
  });
  h.remove.mockReset().mockResolvedValue({ removed: true });
});

describe("gate and auth", () => {
  it("answers 404 before auth while the kill switch is off", async () => {
    env.PROFILE_VIDEO_API_ENABLED = false;
    expect((await request(buildApp()).delete("/v1/me/video")).status).toBe(404);
    expect(h.remove).not.toHaveBeenCalled();
  });

  it("needs a JWT", async () => {
    expect((await request(buildApp()).delete("/v1/me/video")).status).toBe(401);
    expect((await request(buildApp()).post("/v1/me/video")).status).toBe(401);
  });
});

describe("POST /v1/me/video", () => {
  it("201 with the documented body", async () => {
    const res = await post();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      videoUrl: "https://signed.test/v.mp4",
      thumbUrl: "https://signed.test/t.jpg",
      duration: 24.5,
      bonusGranted: true,
    });
    expect(h.save).toHaveBeenCalledWith({
      userId: USER_ID,
      video: expect.any(Buffer),
      thumb: expect.any(Buffer),
    });
  });

  it("400 when either part is missing", async () => {
    const res = await request(buildApp())
      .post("/v1/me/video")
      .set(auth())
      .attach("video", MP4, { filename: "video.mp4", contentType: "video/mp4" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "invalid_media", retryable: false });
    expect(h.save).not.toHaveBeenCalled();
  });

  it("413 with `video_too_large` over 50 MB, before the service runs", async () => {
    const big = Buffer.concat([MP4, Buffer.alloc(50 * 1024 * 1024)]);
    const res = await request(buildApp())
      .post("/v1/me/video")
      .set(auth())
      .attach("video", big, { filename: "video.mp4", contentType: "video/mp4" })
      .attach("thumb", JPEG, { filename: "thumb.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ code: "video_too_large", retryable: false });
    expect(h.save).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_media", 400],
    ["profile_missing", 404],
    ["video_too_long", 413],
    ["video_too_large_to_check", 413],
    ["video_too_short", 422],
    ["unsafe_content", 422],
    ["storage_unavailable", 502],
    ["processing_unavailable", 503],
  ])("maps %s to %i with the code in the body", async (error, status) => {
    h.save.mockResolvedValue({ ok: false, error, retryable: status >= 500 });
    const res = await post();
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ code: error, retryable: status >= 500 });
    expect(typeof res.body.error).toBe("string");
  });

  it("treats an unknown future validation reason as a refusal, not a server error", () => {
    expect(profileVideoErrorStatus("video_something_new")).toBe(422);
  });
});

describe("DELETE /v1/me/video", () => {
  it("200 and reports whether anything was removed", async () => {
    const res = await request(buildApp()).delete("/v1/me/video").set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(h.remove).toHaveBeenCalledWith(USER_ID);
  });
});
