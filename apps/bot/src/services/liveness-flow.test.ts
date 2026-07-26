import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared identity-verification flow both client surfaces call.
 *
 * The behaviour worth pinning down here is the policy, not the plumbing:
 *   - a check that doesn't clearly pass is RETRYABLE and must never write a
 *     verification status (it is not evidence of an impostor), and
 *   - a pass must hand the reference bytes straight to the pipeline, because
 *     the AWS session that produced them expires 3 minutes after /init.
 */

const env = {
  FACE_LIVENESS_ENABLED: true,
  LIVENESS_STS_ROLE_ARN: "arn:aws:iam::147010141827:role/GennetyLivenessClient",
  AWS_REGION: "eu-central-1",
};
vi.mock("../config.js", () => ({ env }));

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: userFindUnique, update: userUpdate } },
}));

const createLivenessSession = vi.fn();
const getLivenessResult = vi.fn();
vi.mock("./face-liveness.js", () => ({ createLivenessSession, getLivenessResult }));

const mintLivenessCredentials = vi.fn();
vi.mock("./liveness-credentials.js", () => ({ mintLivenessCredentials }));

const runFaceMatchVerificationDefault = vi.fn().mockResolvedValue({ kind: "verified" });
vi.mock("./verification-pipeline.js", () => ({ runFaceMatchVerificationDefault }));

const buildVerificationKeyboard = vi.fn().mockResolvedValue({ inline_keyboard: [] });
vi.mock("./verification-keyboard.js", () => ({ buildVerificationKeyboard }));

const { beginLivenessCheck, completeLivenessCheck } = await import("./liveness-flow.js");

const SESSION_ID = "11111111-2222-3333-4444-555555555555";
const CREDENTIALS = {
  accessKeyId: "ASIA_TEMP",
  secretAccessKey: "temp-secret",
  sessionToken: "temp-token",
  expiration: "2026-07-26T12:15:00.000Z",
};
const REFERENCE = Buffer.from([0xff, 0xd8, 0xff]);

const api = { sendMessage: vi.fn().mockResolvedValue({}) } as never;

beforeEach(() => {
  vi.clearAllMocks();
  env.FACE_LIVENESS_ENABLED = true;
  env.LIVENESS_STS_ROLE_ARN = "arn:aws:iam::147010141827:role/GennetyLivenessClient";
  userFindUnique.mockResolvedValue({
    id: "user-1",
    telegramId: 555n,
    language: "en",
    verificationStatus: "unverified",
  });
  userUpdate.mockResolvedValue({});
  createLivenessSession.mockResolvedValue({ ok: true, sessionId: SESSION_ID });
  mintLivenessCredentials.mockResolvedValue({ ok: true, credentials: CREDENTIALS });
  getLivenessResult.mockResolvedValue({
    ok: true,
    outcome: "passed",
    confidence: 0.97,
    referenceImage: REFERENCE,
  });
  buildVerificationKeyboard.mockResolvedValue({ inline_keyboard: [] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("beginLivenessCheck", () => {
  it("mints a session + credentials and marks the user pending", async () => {
    const result = await beginLivenessCheck("user-1");

    expect(result).toEqual({
      ok: true,
      sessionId: SESSION_ID,
      region: "eu-central-1",
      credentials: CREDENTIALS,
      language: "en",
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { verificationStatus: "pending" },
    });
  });

  it("refuses when the feature flag is off, before touching AWS", async () => {
    env.FACE_LIVENESS_ENABLED = false;
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(createLivenessSession).not.toHaveBeenCalled();
  });

  it("refuses when no STS role is configured", async () => {
    env.LIVENESS_STS_ROLE_ARN = "";
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(createLivenessSession).not.toHaveBeenCalled();
  });

  it("does not burn a session on an already-verified user", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      language: "en",
      verificationStatus: "verified",
    });
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "already_verified" });
    expect(createLivenessSession).not.toHaveBeenCalled();
  });

  it("reports a provider failure rather than returning an empty session", async () => {
    createLivenessSession.mockResolvedValueOnce({ ok: false, error: "api" });
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "provider" });
    expect(mintLivenessCredentials).not.toHaveBeenCalled();
  });

  it("fails the whole begin when credentials cannot be minted", async () => {
    mintLivenessCredentials.mockResolvedValueOnce({ ok: false, error: "api" });
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "provider" });
  });
});

describe("completeLivenessCheck", () => {
  it("passes the reference bytes straight into the face-match pipeline", async () => {
    const result = await completeLivenessCheck("user-1", SESSION_ID, api);

    expect(result).toEqual({ ok: true, outcome: "processing" });
    expect(runFaceMatchVerificationDefault).toHaveBeenCalledWith(
      "user-1",
      SESSION_ID,
      api,
      { capturedSelfie: { buffer: REFERENCE, mime: "image/jpeg" } },
    );
  });

  it.each(["not_live", "expired", "in_progress", "no_reference"] as const)(
    "treats %s as retryable and never touches verification state",
    async (outcome) => {
      getLivenessResult.mockResolvedValueOnce({
        ok: true,
        outcome,
        confidence: 0.2,
        status: "FAILED",
      });

      const result = await completeLivenessCheck("user-1", SESSION_ID, api);

      expect(result).toEqual({ ok: true, outcome: "retry" });
      expect(runFaceMatchVerificationDefault).not.toHaveBeenCalled();
      expect(userUpdate).not.toHaveBeenCalled();
      // The user gets a nudge with a fresh Verify button, not a rejection.
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("skips the retry DM for a mobile-only user", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      telegramId: -42n,
      language: "en",
    });
    getLivenessResult.mockResolvedValueOnce({
      ok: true,
      outcome: "not_live",
      confidence: 0.1,
      status: "FAILED",
    });

    const result = await completeLivenessCheck("user-1", SESSION_ID, api);

    expect(result).toEqual({ ok: true, outcome: "retry" });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a provider read failure instead of guessing", async () => {
    getLivenessResult.mockResolvedValueOnce({ ok: false, error: "api" });

    const result = await completeLivenessCheck("user-1", SESSION_ID, api);

    expect(result).toEqual({ ok: false, error: "provider" });
    expect(runFaceMatchVerificationDefault).not.toHaveBeenCalled();
  });

  it("returns user_not_found for an unknown user", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const result = await completeLivenessCheck("ghost", SESSION_ID, api);
    expect(result).toEqual({ ok: false, error: "user_not_found" });
  });
});
