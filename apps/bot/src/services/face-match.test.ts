import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompareFacesCommand,
  type CompareFacesCommandOutput,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";

// Pin env to "no AWS creds" — `.env` may contain live keys (production deploy
// flow keeps them around), but face-match unit tests assume an empty-creds
// baseline and inject a mock client per-test where needed.
vi.mock("../config.js", () => ({
  env: {
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
    AWS_REGION: "eu-central-1",
    FACE_MATCH_PROVIDER: "rekognition",
  },
}));

const {
  __resetClientForTests,
  compareFaces,
  DISABLED_PROVIDER_RESULT,
} = await import("./face-match.js");

const REF = Buffer.from([0xff, 0xd8, 0xff]); // tiny JPEG header — bytes irrelevant, mock doesn't decode
const CAND = Buffer.from([0xff, 0xd8, 0xff]);

interface SendCall {
  command: CompareFacesCommand;
}

/**
 * In-memory Rekognition client double. Returns whatever `output` it's
 * given on each `send` call and records the command for assertion.
 */
function makeClient(
  output: Partial<CompareFacesCommandOutput> | Error,
): { client: Pick<RekognitionClient, "send">; calls: SendCall[] } {
  const calls: SendCall[] = [];
  const client = {
    send: vi.fn(async (command: CompareFacesCommand) => {
      calls.push({ command });
      if (output instanceof Error) throw output;
      // The SDK populates $metadata at runtime; tests don't need it.
      return { $metadata: {}, ...output } as CompareFacesCommandOutput;
    }) as unknown as RekognitionClient["send"],
  };
  return { client, calls };
}

afterEach(() => {
  __resetClientForTests();
});

describe("compareFaces — disabled provider", () => {
  it("short-circuits to similarity=1 without touching the client", async () => {
    const { client, calls } = makeClient({});
    const result = await compareFaces(REF, CAND, {
      provider: "disabled",
      client,
    });

    expect(result).toEqual(DISABLED_PROVIDER_RESULT);
    expect(calls).toHaveLength(0);
  });
});

describe("compareFaces — rekognition provider", () => {
  it("returns similarity normalised to [0,1] for the strongest match", async () => {
    const { client, calls } = makeClient({
      SourceImageFace: { BoundingBox: {}, Confidence: 99 },
      FaceMatches: [
        { Similarity: 72.4, Face: {} },
        { Similarity: 91.8, Face: {} },
        { Similarity: 88.0, Face: {} },
      ],
      UnmatchedFaces: [],
    });

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.faceFound).toBe(true);
    expect(result.similarity).toBeCloseTo(0.918, 3);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.command.input;
    expect(input.SourceImage?.Bytes).toBe(REF);
    expect(input.TargetImage?.Bytes).toBe(CAND);
  });

  it("returns similarity=0 + faceFound=true when candidate has a face but it's a different person", async () => {
    const { client } = makeClient({
      SourceImageFace: { BoundingBox: {}, Confidence: 99 },
      FaceMatches: [],
      UnmatchedFaces: [{ BoundingBox: {}, Confidence: 95 }],
    });

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result).toEqual({ ok: true, similarity: 0, faceFound: true });
  });

  it("returns similarity=0 + faceFound=false when candidate has no face at all", async () => {
    const { client } = makeClient({
      SourceImageFace: { BoundingBox: {}, Confidence: 99 },
      FaceMatches: [],
      UnmatchedFaces: [],
    });

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result).toEqual({ ok: true, similarity: 0, faceFound: false });
  });

  it("returns no_source_face when Persona selfie has no detectable face", async () => {
    const { client } = makeClient({
      // SourceImageFace omitted entirely → upstream pipeline bug
      FaceMatches: [],
    });

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result).toEqual({ ok: false, error: "no_source_face" });
  });

  it("translates SDK errors to { ok: false, error: 'api' }", async () => {
    const err = new Error("AccessDenied");
    err.name = "AccessDeniedException";
    const { client } = makeClient(err);

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result).toEqual({ ok: false, error: "api" });
  });

  it("translates abort/timeout errors to { ok: false, error: 'timeout' }", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    const { client } = makeClient(err);

    const result = await compareFaces(REF, CAND, {
      provider: "rekognition",
      client,
    });

    expect(result).toEqual({ ok: false, error: "timeout" });
  });

  it("returns not_configured when no client can be built (no AWS creds, no override)", async () => {
    // No `client` override + env has empty creds in tests.
    const result = await compareFaces(REF, CAND, { provider: "rekognition" });
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });
});
