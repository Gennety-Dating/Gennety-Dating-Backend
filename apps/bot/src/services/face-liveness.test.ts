import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CreateFaceLivenessSessionCommand,
  GetFaceLivenessSessionResultsCommand,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";

// Pin env so the module never reaches for real AWS creds — `.env` may hold
// live keys. Every test injects its own client double.
vi.mock("../config.js", () => ({
  env: {
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_REGION: "eu-central-1",
    FACE_LIVENESS_REGION: "eu-west-1",
    FACE_LIVENESS_MIN_CONFIDENCE: 0.8,
  },
}));

const { createLivenessSession, getLivenessResult } = await import("./face-liveness.js");

type AnyCommand =
  | CreateFaceLivenessSessionCommand
  | GetFaceLivenessSessionResultsCommand;

function makeClient(output: Record<string, unknown> | Error): {
  client: Pick<RekognitionClient, "send">;
  commands: AnyCommand[];
} {
  const commands: AnyCommand[] = [];
  const client = {
    send: vi.fn(async (command: AnyCommand) => {
      commands.push(command);
      if (output instanceof Error) throw output;
      return { $metadata: {}, ...output };
    }) as unknown as RekognitionClient["send"],
  };
  return { client, commands };
}

function namedError(name: string): Error {
  const err = new Error(name);
  err.name = name;
  return err;
}

const SESSION = "11111111-2222-3333-4444-555555555555";

// The service logs the real AWS error name on every `api` failure (that log is
// the only way to tell an IAM problem from an outage in production). Keep it
// out of the test output.
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLivenessSession", () => {
  it("returns the session id and asks for zero audit images", async () => {
    const { client, commands } = makeClient({ SessionId: SESSION });

    const result = await createLivenessSession({ client });

    expect(result).toEqual({ ok: true, sessionId: SESSION });
    // Audit images are extra biometric artefacts we have no use for; the
    // reference image alone drives face-matching.
    expect(
      (commands[0] as CreateFaceLivenessSessionCommand).input.Settings
        ?.AuditImagesLimit,
    ).toBe(0);
  });

  it("reports not_configured without credentials or an injected client", async () => {
    const result = await createLivenessSession();
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });

  it("maps an aborted call to timeout", async () => {
    const { client } = makeClient(namedError("AbortError"));
    const result = await createLivenessSession({ client });
    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("treats a response without a SessionId as an API failure", async () => {
    const { client } = makeClient({});
    const result = await createLivenessSession({ client });
    expect(result).toEqual({ ok: false, error: "api" });
  });
});

describe("getLivenessResult", () => {
  it("passes when SUCCEEDED and confidence clears the threshold", async () => {
    const { client, commands } = makeClient({
      Status: "SUCCEEDED",
      Confidence: 93.5,
      ReferenceImage: { Bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
    });

    const result = await getLivenessResult(SESSION, { client });

    expect(result).toMatchObject({ ok: true, outcome: "passed" });
    // AWS speaks 0..100; the rest of the codebase speaks 0..1.
    expect(result).toMatchObject({ confidence: 0.935 });
    if (result.ok && result.outcome === "passed") {
      expect(result.referenceImage).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    }
    expect(
      (commands[0] as GetFaceLivenessSessionResultsCommand).input.SessionId,
    ).toBe(SESSION);
  });

  it("is not_live — never rejected — when SUCCEEDED but under threshold", async () => {
    const { client } = makeClient({
      Status: "SUCCEEDED",
      Confidence: 61,
      ReferenceImage: { Bytes: new Uint8Array([1]) },
    });

    const result = await getLivenessResult(SESSION, { client });

    expect(result).toEqual({
      ok: true,
      outcome: "not_live",
      confidence: 0.61,
      status: "SUCCEEDED",
    });
  });

  it("honours an explicit threshold override", async () => {
    const { client } = makeClient({
      Status: "SUCCEEDED",
      Confidence: 61,
      ReferenceImage: { Bytes: new Uint8Array([1]) },
    });

    const result = await getLivenessResult(SESSION, {
      client,
      minConfidence: 0.5,
    });

    expect(result).toMatchObject({ ok: true, outcome: "passed" });
  });

  it("maps FAILED to not_live", async () => {
    const { client } = makeClient({ Status: "FAILED", Confidence: 12 });
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toMatchObject({ outcome: "not_live", status: "FAILED" });
  });

  it("maps EXPIRED to the retryable expired outcome", async () => {
    const { client } = makeClient({ Status: "EXPIRED" });
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toMatchObject({ outcome: "expired", confidence: null });
  });

  it("maps IN_PROGRESS to in_progress", async () => {
    const { client } = makeClient({ Status: "IN_PROGRESS" });
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toMatchObject({ outcome: "in_progress" });
  });

  it("reports no_reference when the pass carries no reference image", async () => {
    const { client } = makeClient({ Status: "SUCCEEDED", Confidence: 99 });
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toMatchObject({ outcome: "no_reference", confidence: 0.99 });
  });

  it("turns SessionNotFoundException into expired, not an infra error", async () => {
    // The 3-minute window closed. From the user's side that is a timeout they
    // can retry, not an outage we should apologise for.
    const { client } = makeClient(namedError("SessionNotFoundException"));
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toEqual({
      ok: true,
      outcome: "expired",
      confidence: null,
      status: "EXPIRED",
    });
  });

  it("surfaces a genuine API failure as ok:false", async () => {
    const { client } = makeClient(namedError("InternalServerError"));
    const result = await getLivenessResult(SESSION, { client });
    expect(result).toEqual({ ok: false, error: "api" });
  });
});
