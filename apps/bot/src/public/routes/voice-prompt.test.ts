import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const OWN_KEY = `${USER_ID}/1716000000000-a1b2c3d4e5f6.m4a`;

const env = {
  VOICE_PROMPT_ENABLED: true,
  JWT_SECRET,
  BOT_TOKEN: "123456:test-bot-token",
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  SUPABASE_VOICE_BUCKET: "voice-prompts",
};
vi.mock("../../config.js", () => ({ env }));

// The limiters are exercised in rate-limit.test.ts; here they would only turn
// the eleventh commit of this file into a 429.
vi.mock("../rate-limit.js", () => ({
  voicePromptUploadLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
  voicePromptUploadUrlLimiter: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  validate: vi.fn(),
  logRejection: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  signUpload: vi.fn(),
  signUrl: vi.fn(),
  deleteObject: vi.fn(),
  downloadUpload: vi.fn(),
  uploadBase64: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: { voicePrompt: { findUnique: h.findUnique } },
}));
vi.mock("../../services/profile-media-validation/voice-prompt-validation.js", () => ({
  validateVoicePrompt: h.validate,
}));
vi.mock("../../services/profile-media-validation/rejection-log.js", () => ({
  logMediaValidationRejection: h.logRejection,
}));
vi.mock("../../services/voice-prompt.js", () => ({
  saveVoicePrompt: h.save,
  deleteVoicePrompt: h.remove,
}));
vi.mock("../../services/storage.js", async (importOriginal) => ({
  // The ownership predicate is the thing under test, so it stays real.
  ...(await importOriginal<typeof import("../../services/storage.js")>()),
  createVoicePromptSignedUpload: h.signUpload,
  createVoicePromptSignedUrl: h.signUrl,
  deleteStorageObject: h.deleteObject,
  downloadVoicePromptUpload: h.downloadUpload,
  uploadVoicePrompt: h.uploadBase64,
}));

const { createVoicePromptRouter } = await import("./voice-prompt.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/voice-prompt", createVoicePromptRouter());
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

const ACCEPTED = {
  ok: true as const,
  value: { transcript: "hi, I climb", waveform: [5, 100, 60], durationSeconds: 14 },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.findUnique.mockResolvedValue(null);
  h.validate.mockResolvedValue(ACCEPTED);
  h.logRejection.mockResolvedValue(undefined);
  h.save.mockResolvedValue(undefined);
  h.signUpload.mockResolvedValue({
    uploadUrl: "https://supabase.test/storage/v1/object/upload/sign/voice-prompts/x?token=t",
    path: OWN_KEY,
  });
  h.signUrl.mockImplementation(async (path: string) => `https://signed.test/${path}`);
  h.deleteObject.mockResolvedValue(true);
  h.downloadUpload.mockResolvedValue({ ok: true, audio: Buffer.from("m4a-bytes") });
  h.uploadBase64.mockResolvedValue({ path: `${USER_ID}/1716000000001.m4a` });
});

describe("POST /v1/me/voice-prompt/upload-url", () => {
  it("hands out a signed PUT under the caller's prefix, with the 30 s bounds", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt/upload-url")
      .set(auth())
      .send({ contentType: "audio/mp4" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      uploadUrl: "https://supabase.test/storage/v1/object/upload/sign/voice-prompts/x?token=t",
      uploadPath: OWN_KEY,
      maxBytes: 2 * 1024 * 1024,
      minDurationSec: 3,
      maxDurationSec: 30,
    });
    expect(h.signUpload).toHaveBeenCalledWith(USER_ID, "audio/mp4");
  });

  it("answers uploadUrl: null when storage cannot sign, so the client sends base64", async () => {
    h.signUpload.mockResolvedValue(null);
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt/upload-url")
      .set(auth())
      .send({ contentType: "audio/mp4" });

    expect(res.status).toBe(200);
    expect(res.body.uploadUrl).toBeNull();
    expect(res.body.uploadPath).toBeNull();
  });

  it("refuses anything that is not audio", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt/upload-url")
      .set(auth())
      .send({ contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(h.signUpload).not.toHaveBeenCalled();
  });
});

describe("POST /v1/me/voice-prompt — committing a signed upload", () => {
  it("validates the stored object and saves it in place, without a second upload", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 14 });

    expect(res.status).toBe(200);
    expect(h.downloadUpload).toHaveBeenCalledWith(OWN_KEY, 2 * 1024 * 1024);
    expect(h.uploadBase64).not.toHaveBeenCalled();
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER_ID,
        storagePath: OWN_KEY,
        durationSec: 14,
        mimeType: "audio/mp4",
        waveform: [5, 100, 60],
      }),
    );
    expect(res.body).toEqual({
      voicePrompt: {
        durationSec: 14,
        waveform: [5, 100, 60],
        audioUrl: `https://signed.test/${OWN_KEY}`,
      },
    });
    // The transcript feeds matching; it never goes back to a client.
    expect(JSON.stringify(res.body)).not.toContain("climb");
  });

  it.each([
    ["someone else's key", `${OTHER_ID}/1716000000000-a1b2c3d4e5f6.m4a`],
    ["a traversal out of the prefix", `${USER_ID}/../${OTHER_ID}/1716000000000.m4a`],
    ["a nested key under the prefix", `${USER_ID}/nested/1716000000000.m4a`],
  ])("403s %s and never touches the object", async (_label, uploadPath) => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath, durationSec: 14 });

    expect(res.status).toBe(403);
    expect(h.downloadUpload).not.toHaveBeenCalled();
    expect(h.deleteObject).not.toHaveBeenCalled();
    expect(h.validate).not.toHaveBeenCalled();
  });

  it("409s when nothing arrived under the key, so the client retries the PUT", async () => {
    h.downloadUpload.mockResolvedValue({ ok: false, reason: "missing" });
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 14 });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "upload-missing" });
    expect(h.validate).not.toHaveBeenCalled();
  });

  it("refuses and removes an oversized object before buffering it", async () => {
    h.downloadUpload.mockResolvedValue({ ok: false, reason: "too_large" });
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 14 });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "voice_too_long" });
    expect(h.deleteObject).toHaveBeenCalledWith("voice-prompts", OWN_KEY);
  });

  it("removes a recording the moderator refused", async () => {
    h.validate.mockResolvedValue({ ok: false, reason: "unsafe_content", retryable: false });
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 14 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "unsafe_content", retryable: false });
    expect(h.deleteObject).toHaveBeenCalledWith("voice-prompts", OWN_KEY);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("keeps the object when processing was unavailable, so the same clip can be re-sent", async () => {
    h.validate.mockResolvedValue({ ok: false, reason: "processing_unavailable", retryable: true });
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 14 });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "processing_unavailable", retryable: true });
    expect(h.deleteObject).not.toHaveBeenCalled();
  });

  it("never deletes the live recording when a re-commit of its own key is refused", async () => {
    h.findUnique.mockResolvedValue({ storagePath: OWN_KEY });
    h.validate.mockResolvedValue({ ok: false, reason: "voice_too_long", retryable: true });
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ uploadPath: OWN_KEY, durationSec: 45 });

    expect(res.status).toBe(422);
    expect(h.deleteObject).not.toHaveBeenCalled();
  });
});

describe("POST /v1/me/voice-prompt — the base64 fallback", () => {
  it("still uploads the body itself when no key is named", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ audio: Buffer.from("m4a-bytes").toString("base64"), durationSec: 14, mimeType: "audio/mp4" });

    expect(res.status).toBe(200);
    expect(h.downloadUpload).not.toHaveBeenCalled();
    expect(h.uploadBase64).toHaveBeenCalledWith(USER_ID, Buffer.from("m4a-bytes"), "audio/mp4");
    expect(h.save).toHaveBeenCalledWith(
      expect.objectContaining({ storagePath: `${USER_ID}/1716000000001.m4a` }),
    );
  });

  it("400s a request that names neither transport", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set(auth())
      .send({ durationSec: 14 });
    expect(res.status).toBe(400);
  });
});
