import { afterEach, describe, expect, it, vi } from "vitest";
import { gateProfilePhoto, type GateDeps } from "./face-match-gate.js";
import type { FaceMatchResult } from "./face-match.js";

const USER_ID = "user-1";
const SELFIE_PATH = "user-1/selfie.jpg";
const SELFIE_BUFFER = Buffer.from("selfie");
const PHOTO_BUFFER = Buffer.from("candidate");
const VERIFY_THRESHOLD = 0.85;

interface MakeOpts {
  verifiedSelfiePath?: string | null;
  selfieBytes?: Buffer | null;
  match?: FaceMatchResult;
}

function makeDeps(opts: MakeOpts = {}): GateDeps {
  // `??` would coerce explicit `null` (the "unverified user / missing
  // selfie" sentinel) back to the default — use `in` checks instead so
  // tests can opt into null without leaking past the fallback.
  const path = "verifiedSelfiePath" in opts ? opts.verifiedSelfiePath : SELFIE_PATH;
  const bytes = "selfieBytes" in opts ? opts.selfieBytes : SELFIE_BUFFER;
  const match = opts.match ?? ({ ok: true, similarity: 0.9, faceFound: true } as FaceMatchResult);

  return {
    findUser: vi.fn(async () => ({ verifiedSelfiePath: path ?? null })),
    downloadSelfie: vi.fn(async () => bytes ?? null),
    compareFaces: vi.fn(async () => match),
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("gateProfilePhoto — pass-through cases", () => {
  it("allows when user has no verifiedSelfiePath (unverified)", async () => {
    const deps = makeDeps({ verifiedSelfiePath: null });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result).toEqual({ kind: "allowed", score: null });
    expect(deps.compareFaces).not.toHaveBeenCalled();
  });

  it("allows (fail-open) when the verified selfie can't be downloaded", async () => {
    const deps = makeDeps({ selfieBytes: null });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result).toEqual({ kind: "allowed", score: null });
    expect(deps.compareFaces).not.toHaveBeenCalled();
  });

  it("allows (fail-open) when Rekognition errors", async () => {
    const deps = makeDeps({ match: { ok: false, error: "api" } });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result).toEqual({ kind: "allowed", score: null });
  });

  it("allows when score is at or above the verify threshold", async () => {
    const deps = makeDeps({
      match: { ok: true, similarity: 0.86, faceFound: true },
    });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result.kind).toBe("allowed");
    if (result.kind !== "allowed") return;
    expect(result.score).toBeCloseTo(0.86, 5);
  });
});

describe("gateProfilePhoto — block cases", () => {
  it("blocks when score is below the verify threshold", async () => {
    const deps = makeDeps({
      match: { ok: true, similarity: 0.5, faceFound: true },
    });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") return;
    expect(result.reason).toBe("mismatch");
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it("blocks when faceFound=false (treats absent face as score 0)", async () => {
    const deps = makeDeps({
      match: { ok: true, similarity: 0, faceFound: false },
    });
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result).toEqual({ kind: "blocked", reason: "mismatch", score: 0 });
  });
});

describe("gateProfilePhoto — user lookup", () => {
  it("allows when the user lookup returns null", async () => {
    const deps = makeDeps();
    deps.findUser = vi.fn(async () => null);
    const result = await gateProfilePhoto(USER_ID, PHOTO_BUFFER, {
      deps,
      thresholdVerify: VERIFY_THRESHOLD,
    });
    expect(result).toEqual({ kind: "allowed", score: null });
  });
});
