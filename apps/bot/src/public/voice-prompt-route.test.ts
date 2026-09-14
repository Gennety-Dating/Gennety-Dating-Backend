/**
 * `POST /v1/me/voice-prompt` — the native commit (audit A13-L14).
 *
 * Every commit pays for a Whisper transcription, a moderation call, a storage
 * upload and an embedding refresh, and the route had no per-user ceiling; the
 * stored duration was whatever the client sent. These pin both.
 */
import express from "express";
import request from "supertest";
import { VOICE_PROMPT_UPLOADS_PER_HOUR } from "@gennety/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./auth-middleware.js", () => ({
  requireAuth: (req: { userId?: string; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    req.userId = String(req.headers["x-test-user"]);
    next();
  },
}));

vi.mock("@gennety/db", () => ({
  prisma: { voicePrompt: { findUnique: vi.fn(async () => null), update: vi.fn() } },
}));

const validateVoicePrompt = vi.fn();
vi.mock("../services/profile-media-validation/voice-prompt-validation.js", () => ({
  validateVoicePrompt,
}));
vi.mock("../services/profile-media-validation/rejection-log.js", () => ({
  logMediaValidationRejection: vi.fn(async () => undefined),
}));

const saveVoicePrompt = vi.fn();
vi.mock("../services/voice-prompt.js", () => ({
  saveVoicePrompt,
  deleteVoicePrompt: vi.fn(),
}));
vi.mock("../services/storage.js", () => ({
  uploadVoicePrompt: vi.fn(async (userId: string) => ({ path: `${userId}/voice.m4a` })),
  createVoicePromptSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
  downloadVoicePrompt: vi.fn(),
}));

const { createVoicePromptRouter } = await import("./routes/voice-prompt.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/voice-prompt", createVoicePromptRouter());
  return app;
}

const CLIP = { durationSec: 15, audio: Buffer.from("opus").toString("base64"), mimeType: "audio/mp4" };

beforeEach(() => {
  validateVoicePrompt.mockReset().mockResolvedValue({
    ok: true,
    value: { transcript: "I make coffee every morning", waveform: [1, 2, 3], durationSeconds: 22 },
  });
  saveVoicePrompt.mockReset().mockResolvedValue(undefined);
});

describe("POST /v1/me/voice-prompt", () => {
  it("stores and returns the duration validation derived, not the one the client sent", async () => {
    const res = await request(buildApp())
      .post("/v1/me/voice-prompt")
      .set("x-test-user", "duration-user")
      .send(CLIP);

    expect(res.status).toBe(200);
    expect(res.body.voicePrompt.durationSec).toBe(22);
    expect(saveVoicePrompt).toHaveBeenCalledWith(expect.objectContaining({ durationSec: 22 }));
  });

  it("meters commits per user, and one user's ceiling is not another's", async () => {
    const app = buildApp();
    for (let i = 0; i < VOICE_PROMPT_UPLOADS_PER_HOUR; i += 1) {
      await request(app).post("/v1/me/voice-prompt").set("x-test-user", "busy-user").send(CLIP).expect(200);
    }

    const limited = await request(app).post("/v1/me/voice-prompt").set("x-test-user", "busy-user").send(CLIP);
    expect(limited.status).toBe(429);
    expect(limited.headers["content-type"]).toMatch(/application\/json/);
    // The provider work was not paid for the refused commit.
    expect(validateVoicePrompt).toHaveBeenCalledTimes(VOICE_PROMPT_UPLOADS_PER_HOUR);

    await request(app).post("/v1/me/voice-prompt").set("x-test-user", "other-user").send(CLIP).expect(200);
  });
});
