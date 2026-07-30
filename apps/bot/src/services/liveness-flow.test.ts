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
  // Deliberately different values: liveness runs in its own region because
  // eu-central-1 does not serve Face Liveness. See the region test below.
  AWS_REGION: "eu-central-1",
  FACE_LIVENESS_REGION: "eu-west-1",
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

const api = { sendMessage: vi.fn().mockResolvedValue({}) };
const apiArg = api as unknown as Parameters<typeof completeLivenessCheck>[2];

beforeEach(() => {
  vi.clearAllMocks();
  env.FACE_LIVENESS_ENABLED = true;
  env.LIVENESS_STS_ROLE_ARN = "arn:aws:iam::147010141827:role/GennetyLivenessClient";
  userFindUnique.mockResolvedValue({
    id: "user-1",
    telegramId: 555n,
    language: "en",
    verificationStatus: "unverified",
    // The session this user minted at /init. `complete()` refuses anything else.
    pendingLivenessSessionId: SESSION_ID,
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
      region: "eu-west-1",
      credentials: CREDENTIALS,
      language: "en",
    });
    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      // The session is bound to the user here so `complete()` can refuse a
      // session id the caller did not mint.
      data: { verificationStatus: "pending", pendingLivenessSessionId: SESSION_ID },
    });
  });

  it("hands the client FACE_LIVENESS_REGION, never AWS_REGION", async () => {
    // Regression guard for a real incident (2026-07-26). Face Liveness is not
    // served in our AWS_REGION (eu-central-1) — and a region that lacks it
    // answers with a MESSAGE-LESS AccessDeniedException, which reads exactly
    // like an IAM denial and burned a debugging session. The detector opens its
    // WebSocket against whatever region we return here, so returning the
    // face-match region would fail every check in the field while every unit
    // test still passed.
    const result = await beginLivenessCheck("user-1");

    expect(result).toMatchObject({ region: env.FACE_LIVENESS_REGION });
    expect(result).not.toMatchObject({ region: env.AWS_REGION });
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
      verifiedSelfiePath: "selfies/user-1.jpg",
    });
    const result = await beginLivenessCheck("user-1");
    expect(result).toEqual({ ok: false, error: "already_verified" });
    expect(createLivenessSession).not.toHaveBeenCalled();
  });

  it("lets a verified user re-run once the 90-day scrub took their reference", async () => {
    // The dead end this closes: every photo surface answers `reference_expired`
    // with "verify again to change your photos", and this was the call that
    // refused to let them. AWS cannot re-issue an expired reference image, so a
    // fresh liveness check is the only way back — on Telegram and iOS alike.
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      language: "en",
      verificationStatus: "verified",
      verifiedSelfiePath: null,
    });

    const result = await beginLivenessCheck("user-1");

    expect(result).toMatchObject({ ok: true, sessionId: SESSION_ID });
  });

  it("keeps that user verified while they re-run, so matching never drops them", async () => {
    // Matching admits `verified` and nothing else (§3.2 filter). Flipping a
    // long-tenured user to `pending` for the duration would take them out of
    // the pool over a photo edit — the same reason `triggerVerificationRerun`
    // bails before its own `pending` flip.
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      language: "en",
      verificationStatus: "verified",
      verifiedSelfiePath: null,
    });

    await beginLivenessCheck("user-1");

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { pendingLivenessSessionId: SESSION_ID },
    });
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
    const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

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

      const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

      expect(result).toEqual({ ok: true, outcome: "retry" });
      expect(runFaceMatchVerificationDefault).not.toHaveBeenCalled();
      // The ONLY write on a retryable outcome is releasing the session binding
      // — `verificationStatus` must be untouched, because a failed capture is
      // not evidence of an impostor.
      for (const call of userUpdate.mock.calls) {
        expect(call[0].data).toEqual({ pendingLivenessSessionId: null });
      }
      // The user gets a nudge with a fresh Verify button, not a rejection.
      expect(api.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it("skips the retry DM for a mobile-only user", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      telegramId: -42n,
      language: "en",
      pendingLivenessSessionId: SESSION_ID,
    });
    getLivenessResult.mockResolvedValueOnce({
      ok: true,
      outcome: "not_live",
      confidence: 0.1,
      status: "FAILED",
    });

    const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

    expect(result).toEqual({ ok: true, outcome: "retry" });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("surfaces a provider read failure instead of guessing", async () => {
    getLivenessResult.mockResolvedValueOnce({ ok: false, error: "api" });

    const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

    expect(result).toEqual({ ok: false, error: "provider" });
    expect(runFaceMatchVerificationDefault).not.toHaveBeenCalled();
  });

  it("returns user_not_found for an unknown user", async () => {
    userFindUnique.mockResolvedValueOnce(null);
    const result = await completeLivenessCheck("ghost", SESSION_ID, apiArg);
    expect(result).toEqual({ ok: false, error: "user_not_found" });
  });

  it("refuses a session id this user did not mint, before calling AWS", async () => {
    // The client reports only "I finished" and the verdict comes from AWS — but
    // the session id is client-supplied. Without this binding a caller could
    // name someone else's session and have that person's reference selfie fed
    // into their own face-match run.
    const result = await completeLivenessCheck(
      "user-1",
      "99999999-9999-4999-8999-999999999999",
      apiArg,
    );

    expect(result).toEqual({ ok: false, error: "session_mismatch" });
    expect(getLivenessResult).not.toHaveBeenCalled();
    expect(runFaceMatchVerificationDefault).not.toHaveBeenCalled();
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("refuses when the user has no session in flight at all", async () => {
    userFindUnique.mockResolvedValueOnce({
      id: "user-1",
      telegramId: 555n,
      language: "en",
      pendingLivenessSessionId: null,
    });

    const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

    expect(result).toEqual({ ok: false, error: "session_mismatch" });
    expect(getLivenessResult).not.toHaveBeenCalled();
  });

  it("releases the binding once the session reaches a terminal state", async () => {
    await completeLivenessCheck("user-1", SESSION_ID, apiArg);

    expect(userUpdate).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { pendingLivenessSessionId: null },
    });
  });

  it("keeps the binding when the provider read fails (not a terminal outcome)", async () => {
    getLivenessResult.mockResolvedValueOnce({ ok: false, error: "api" });

    const result = await completeLivenessCheck("user-1", SESSION_ID, apiArg);

    expect(result).toEqual({ ok: false, error: "provider" });
    // The session may still be readable within its 3-minute life, so a blip
    // must not force the user to start over.
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
