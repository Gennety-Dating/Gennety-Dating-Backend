import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runFaceMatchVerification,
  type PersistOutcomeInput,
  type PipelineConfig,
  type PipelineDeps,
  type PipelineUserRow,
} from "./verification-pipeline.js";
import type { FetchSelfieResult } from "./persona-api.js";
import type { FaceMatchResult } from "./face-match.js";

const USER_ID = "user-1";
const INQUIRY_ID = "inq_abc";
const SELFIE_BUFFER = Buffer.from("selfie-bytes");
const PHOTO_PATH_A = "user-1/photo-a.jpg";
const PHOTO_PATH_B = "user-1/photo-b.jpg";
const PHOTO_BUFFER_A = Buffer.from("photo-a-bytes");
const PHOTO_BUFFER_B = Buffer.from("photo-b-bytes");

const CONFIG: PipelineConfig = {
  thresholdVerify: 0.85,
  thresholdReview: 0.75,
  minVerifiedPhotos: 1,
};

interface Harness {
  user: PipelineUserRow;
  persisted: PersistOutcomeInput[];
  notifications: Array<{ telegramId: bigint; message: string }>;
  activationSurfaces: Array<{ userId: string; telegramId: bigint }>;
  deps: PipelineDeps;
}

function makeHarness(
  overrides: {
    user?: Partial<PipelineUserRow>;
    selfie?: FetchSelfieResult;
    photoBuffers?: Record<string, Buffer | null>;
    compareScores?: FaceMatchResult[];
    uploadFails?: boolean;
  } = {},
): Harness {
  const user: PipelineUserRow = {
    id: USER_ID,
    telegramId: 999_001n,
    status: "onboarding",
    gender: "male",
    verificationStatus: "pending",
    personaInquiryId: null,
    faceMatchedAt: null,
    profile: { photos: [PHOTO_PATH_A, PHOTO_PATH_B], eloSeededAt: null },
    ...overrides.user,
  };

  const selfie: FetchSelfieResult = overrides.selfie ?? {
    ok: true,
    selfie: { buffer: SELFIE_BUFFER, mime: "image/jpeg", verificationId: "ver_1" },
  };

  const photoBuffers = overrides.photoBuffers ?? {
    [PHOTO_PATH_A]: PHOTO_BUFFER_A,
    [PHOTO_PATH_B]: PHOTO_BUFFER_B,
  };

  const compareScores = overrides.compareScores ?? [
    { ok: true, similarity: 0.92, faceFound: true },
    { ok: true, similarity: 0.88, faceFound: true },
  ];
  let compareIndex = 0;

  const persisted: PersistOutcomeInput[] = [];
  const notifications: Array<{ telegramId: bigint; message: string }> = [];
  const activationSurfaces: Array<{ userId: string; telegramId: bigint }> = [];

  const deps: PipelineDeps = {
    fetchInquirySelfie: vi.fn(async () => selfie),
    uploadSelfie: vi.fn(async (uid: string, _buf, _mime) => {
      if (overrides.uploadFails) throw new Error("upload failed");
      return { path: `${uid}/selfie-stored.jpg` };
    }),
    downloadProfileImage: vi.fn(async (path: string) => photoBuffers[path] ?? null),
    compareFaces: vi.fn(async () => {
      const r = compareScores[compareIndex++];
      if (!r) throw new Error("compareFaces called more times than expected");
      return r;
    }),
    notify: vi.fn(async (telegramId: bigint, message: string) => {
      notifications.push({ telegramId, message });
    }),
    surfaceVerifiedActivation: vi.fn(async (input) => {
      activationSurfaces.push(input);
    }),
    db: {
      findUser: vi.fn(async () => user),
      persistOutcome: vi.fn(async (input: PersistOutcomeInput) => {
        persisted.push(input);
      }),
    },
  };

  return {
    user,
    persisted,
    notifications,
    activationSurfaces,
    deps,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runFaceMatchVerification — happy path (quorum)", () => {
  it("verifies when all detected-face photos clear the verify threshold", async () => {
    const h = makeHarness();
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    // Representative score is now the MAX detected (most confident), not min.
    expect(outcome.score).toBeCloseTo(0.92, 5);
    expect(outcome.scores).toEqual([0.92, 0.88]);

    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({
      inquiryId: INQUIRY_ID,
      verificationStatus: "verified",
      shouldActivate: true,
      verifiedSelfiePath: "user-1/selfie-stored.jpg",
      photoFaceScores: [0.92, 0.88],
      photosSnapshot: [PHOTO_PATH_A, PHOTO_PATH_B],
    });
    expect(h.persisted[0]!.faceMatchScore).toBeCloseTo(0.92, 5);

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.message).toContain("Verified");
    expect(h.activationSurfaces).toEqual([
      { userId: USER_ID, telegramId: 999_001n },
    ]);
  });

  it("verifies when ONE photo passes and the rest are borderline (quorum=1)", async () => {
    // Old behaviour rejected this (min=0.78 < 0.85). New rule: 1 pass is
    // enough for quorum=1, and there are no impostor (fail) photos.
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.95, faceFound: true }, // pass
        { ok: true, similarity: 0.78, faceFound: true }, // borderline
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.score).toBeCloseTo(0.95, 5);
    expect(h.persisted[0]!.verificationStatus).toBe("verified");
  });

  it("verifies despite a no-face photo (group shot) when quorum is met", async () => {
    // Regression: previously a single faceFound=false dragged minScore to 0
    // and forced rejection. Group photos / scenery should be ignored, not
    // treated as impostor evidence.
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.9, faceFound: true },
        { ok: true, similarity: 0, faceFound: false }, // group shot
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.scores).toEqual([0.9, 0]);
    // Persisted score array still records the 0 so the admin dashboard
    // can spot which photo is the no-face one.
    expect(h.persisted[0]!.photoFaceScores).toEqual([0.9, 0]);
  });
});

describe("runFaceMatchVerification — quorum gating", () => {
  it("pending_review when nothing passes (all borderline)", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.8, faceFound: true },
        { ok: true, similarity: 0.84, faceFound: true },
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("borderline_score");
    // Representative score for borderline route = average of detected.
    expect(outcome.score).toBeCloseTo(0.82, 5);
    expect(h.persisted[0]!.verificationStatus).toBe("pending_review");
    expect(h.persisted[0]!.shouldActivate).toBe(false);
    expect(h.notifications[0]!.message).toContain("double-checking");
    expect(h.activationSurfaces).toHaveLength(0);
  });

  it("respects minVerifiedPhotos > 1 (one pass + one borderline → pending_review)", async () => {
    const strict: PipelineConfig = { ...CONFIG, minVerifiedPhotos: 2 };
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.95, faceFound: true }, // pass
        { ok: true, similarity: 0.8, faceFound: true }, // borderline
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, strict);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("borderline_score");
  });

  it("pending_review (no_detected_faces) when every photo is a group shot", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0, faceFound: false },
        { ok: true, similarity: 0, faceFound: false },
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("no_detected_faces");
    expect(h.persisted[0]!.verificationStatus).toBe("pending_review");
    // The 0 scores are still persisted for admin visibility.
    expect(h.persisted[0]!.photoFaceScores).toEqual([0, 0]);
  });
});

describe("runFaceMatchVerification — impostor detection", () => {
  it("rejected when a detected face is below review threshold (impostor)", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.9, faceFound: true },
        { ok: true, similarity: 0.3, faceFound: true }, // wrong-person photo
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.score).toBeCloseTo(0.3, 5);
    expect(h.persisted[0]!.verificationStatus).toBe("rejected");
    expect(h.notifications[0]!.message).toContain("don't appear to match");
    expect(h.activationSurfaces).toHaveLength(0);
  });

  it("rejects even if quorum was otherwise met (any fail outvotes pass)", async () => {
    // 3 of 4 photos pass, but one is a different-person face. Hard reject
    // — the security threat model is "one fake photo is enough to mislead a
    // match", so a verified pass count cannot rescue an impostor.
    const fourPathUser: Partial<PipelineUserRow> = {
      profile: {
        photos: ["a", "b", "c", "d"],
        eloSeededAt: null,
      },
    };
    const h = makeHarness({
      user: fourPathUser,
      photoBuffers: {
        a: Buffer.from("a"),
        b: Buffer.from("b"),
        c: Buffer.from("c"),
        d: Buffer.from("d"),
      },
      compareScores: [
        { ok: true, similarity: 0.95, faceFound: true },
        { ok: true, similarity: 0.92, faceFound: true },
        { ok: true, similarity: 0.9, faceFound: true },
        { ok: true, similarity: 0.4, faceFound: true }, // impostor
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("rejected");
  });

  it("all photos below review threshold → rejected", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.6, faceFound: true },
        { ok: true, similarity: 0.7, faceFound: true },
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("rejected");
    expect(h.persisted[0]!.verificationStatus).toBe("rejected");
    expect(h.persisted[0]!.shouldActivate).toBe(false);
  });
});

describe("runFaceMatchVerification — infrastructure failures", () => {
  it("pending_review when Persona selfie fetch fails", async () => {
    const h = makeHarness({
      selfie: { ok: false, error: "api" },
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({
      kind: "pending_review",
      userId: USER_ID,
      reason: "selfie_fetch_failed",
    });
    expect(h.persisted[0]).toMatchObject({
      verificationStatus: "pending_review",
      faceMatchScore: null,
      verifiedSelfiePath: null,
    });
  });

  it("pending_review when Persona selfie has no source face (Persona pipeline bug)", async () => {
    const h = makeHarness({
      compareScores: [{ ok: false, error: "no_source_face" }],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({
      kind: "pending_review",
      userId: USER_ID,
      reason: "no_source_face",
    });
  });

  it("pending_review when a photo fails to download (preserves partial scores)", async () => {
    const h = makeHarness({
      photoBuffers: {
        [PHOTO_PATH_A]: PHOTO_BUFFER_A,
        [PHOTO_PATH_B]: null, // S3 transient outage
      },
      compareScores: [{ ok: true, similarity: 0.9, faceFound: true }],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("photo_download_failed");
    expect(outcome.scores).toEqual([0.9, 0]);
  });

  it("pending_review when Rekognition errors mid-flight", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.9, faceFound: true },
        { ok: false, error: "api" },
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("comparison_error");
  });

  it("non-fatal: continues when uploading selfie to storage fails", async () => {
    const h = makeHarness({ uploadFails: true });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.persisted[0]!.verifiedSelfiePath).toBeNull();
  });
});

describe("runFaceMatchVerification — preconditions", () => {
  it("pending_review when user has zero profile photos", async () => {
    const h = makeHarness({ user: { profile: { photos: [], eloSeededAt: null } } });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({
      kind: "pending_review",
      userId: USER_ID,
      reason: "no_profile_photos",
    });
    expect(h.deps.fetchInquirySelfie).not.toHaveBeenCalled();
    // Snapshot is empty array; persistOutcome receives it.
    expect(h.persisted[0]!.photosSnapshot).toEqual([]);
  });

  it("pending_review when user has no profile at all", async () => {
    const h = makeHarness({ user: { profile: null } });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("no_profile_photos");
  });

  it("skipped_user_missing when the userId isn't in the DB", async () => {
    const h = makeHarness();
    h.deps.db.findUser = vi.fn(async () => null);

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);
    expect(outcome).toEqual({ kind: "skipped_user_missing", userId: USER_ID });
  });
});

describe("runFaceMatchVerification — idempotency", () => {
  it("skips when the same inquiry already ran (faceMatchedAt set)", async () => {
    const h = makeHarness({
      user: {
        verificationStatus: "verified",
        personaInquiryId: INQUIRY_ID,
        faceMatchedAt: new Date("2026-04-29T10:00:00Z"),
      },
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({ kind: "skipped_idempotent", userId: USER_ID });
    expect(h.deps.fetchInquirySelfie).not.toHaveBeenCalled();
    expect(h.persisted).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
    expect(h.activationSurfaces).toHaveLength(0);
  });

  it("re-runs when a NEW inquiry arrives for a previously verified user", async () => {
    const h = makeHarness({
      user: {
        personaInquiryId: "inq_old",
        faceMatchedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });

    const outcome = await runFaceMatchVerification(USER_ID, "inq_new", h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.deps.fetchInquirySelfie).toHaveBeenCalledWith("inq_new");
  });

  it("re-runs when the rerun helper has cleared faceMatchedAt", async () => {
    // triggerVerificationRerun clears faceMatchedAt before launching the
    // pipeline; same inquiry id should re-run, not idempotent-skip.
    const h = makeHarness({
      user: {
        personaInquiryId: INQUIRY_ID,
        faceMatchedAt: null,
      },
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.deps.fetchInquirySelfie).toHaveBeenCalledWith(INQUIRY_ID);
  });
});

describe("runFaceMatchVerification — DM behavior", () => {
  it("does not DM when telegramId is non-positive (mobile-only user)", async () => {
    const h = makeHarness({ user: { telegramId: -1n } });
    await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);
    expect(h.notifications).toHaveLength(0);
    expect(h.activationSurfaces).toHaveLength(0);
  });

  it("swallows DM errors (does not change the pipeline outcome)", async () => {
    let i = 0;
    const h = makeHarness();
    const swallowedErr = new Error("Telegram API down");
    h.deps.notify = vi.fn(async () => {
      i++;
      throw swallowedErr;
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);
    expect(outcome.kind).toBe("verified");
    expect(i).toBe(1);
    expect(h.activationSurfaces).toHaveLength(1);
  });

  it("swallows post-verification surface errors (does not change the pipeline outcome)", async () => {
    const h = makeHarness();
    h.deps.surfaceVerifiedActivation = vi.fn(async () => {
      throw new Error("Telegram menu down");
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.persisted[0]!.verificationStatus).toBe("verified");
    expect(h.notifications[0]!.message).toContain("Verified");
  });
});

describe("runFaceMatchVerification — Elo seeding hook", () => {
  it("calls seedEloFromVision with all profile photos on the verified branch", async () => {
    const h = makeHarness();
    const seed = vi.fn(async () => ({ ok: true as const, elo: 650, score: 75 }));
    h.deps.seedEloFromVision = seed;

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed).toHaveBeenCalledWith(USER_ID, [PHOTO_PATH_A, PHOTO_PATH_B]);
  });

  it("skips seeding when eloSeededAt is already set (admin rerun)", async () => {
    const h = makeHarness({
      user: {
        profile: {
          photos: [PHOTO_PATH_A, PHOTO_PATH_B],
          eloSeededAt: new Date("2026-01-15T10:00:00Z"),
        },
      },
    });
    const seed = vi.fn(async () => ({ ok: true as const, elo: 999, score: 99 }));
    h.deps.seedEloFromVision = seed;

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(seed).not.toHaveBeenCalled();
  });

  it("skips seeding entirely when seedEloFromVision is not provided (flag off)", async () => {
    const h = makeHarness();
    expect(h.deps.seedEloFromVision).toBeUndefined();

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    // No throw, no behavior change — verification still completes cleanly.
    expect(h.persisted[0]!.verificationStatus).toBe("verified");
  });

  it("does NOT seed on pending_review or rejected branches", async () => {
    const seed = vi.fn(async () => ({ ok: true as const, elo: 700, score: 80 }));

    const borderline = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.8, faceFound: true },
        { ok: true, similarity: 0.82, faceFound: true },
      ],
    });
    borderline.deps.seedEloFromVision = seed;
    await runFaceMatchVerification(USER_ID, INQUIRY_ID, borderline.deps, CONFIG);

    const rejected = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.5, faceFound: true },
        { ok: true, similarity: 0.6, faceFound: true },
      ],
    });
    rejected.deps.seedEloFromVision = seed;
    await runFaceMatchVerification(USER_ID, INQUIRY_ID, rejected.deps, CONFIG);

    expect(seed).not.toHaveBeenCalled();
  });

  it("verification still succeeds when the seed throws (failure is non-fatal)", async () => {
    const h = makeHarness();
    h.deps.seedEloFromVision = vi.fn(async () => {
      throw new Error("vision API down");
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.persisted[0]!.verificationStatus).toBe("verified");
    expect(h.notifications[0]!.message).toContain("Verified");
  });

  it("verification still succeeds when the seed returns { ok: false }", async () => {
    const h = makeHarness();
    h.deps.seedEloFromVision = vi.fn(async () => ({
      ok: false as const,
      error: "vision" as const,
    }));

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
  });

  it("verification still succeeds when photos change during Elo scoring", async () => {
    const h = makeHarness();
    h.deps.seedEloFromVision = vi.fn(async () => ({
      ok: false as const,
      error: "photos_changed" as const,
    }));

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    expect(h.persisted[0]!.verificationStatus).toBe("verified");
  });
});

describe("runFaceMatchVerification — persistence shape", () => {
  it("populates photoFaceScores in array order matching profile.photos", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.91, faceFound: true },
        { ok: true, similarity: 0.87, faceFound: true },
      ],
    });

    await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(h.persisted[0]!.photoFaceScores).toEqual([0.91, 0.87]);
  });

  it("hands the photos snapshot to persistOutcome (race-detection input)", async () => {
    // The snapshot is what the production wiring uses to gate the
    // `photoFaceScores` write. We only verify the wiring contract here —
    // the conditional update itself lives in runFaceMatchVerificationDefault
    // and is integration-tested via the real Prisma client.
    const h = makeHarness();
    await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(h.persisted[0]!.photosSnapshot).toEqual([PHOTO_PATH_A, PHOTO_PATH_B]);
  });
});

// Contract test for the source-aware downloader dep. The pipeline must
// invoke `downloadProfileImage` once per `Profile.photos[]` entry, in
// order. This catches future regressions if the dep shape (e.g. batch
// download, parallel fan-out) ever changes.
//
// The original "Telegram-photos broken since the Supabase migration" bug
// lived BELOW this seam — the pipeline was calling its dep correctly but
// the dep itself only knew about Supabase. Pair this contract test with
// `storage.test.ts` for routing coverage.
describe("runFaceMatchVerification — downloadProfileImage contract", () => {
  it("calls the downloader once per photo, in order", async () => {
    const TG_FILE_ID = "AgACAgIA_telegram_no_slash";
    const SUPA_PATH = "user-1/photo.jpg";

    const h = makeHarness({
      user: {
        profile: { photos: [TG_FILE_ID, SUPA_PATH], eloSeededAt: null },
      },
      photoBuffers: {
        [TG_FILE_ID]: Buffer.from("tg-bytes"),
        [SUPA_PATH]: Buffer.from("supa-bytes"),
      },
      compareScores: [
        { ok: true, similarity: 0.95, faceFound: true },
        { ok: true, similarity: 0.88, faceFound: true },
      ],
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    // Representative score is the MAX across detected faces, not the min.
    expect(outcome.score).toBeCloseTo(0.95, 5);

    const downloader = h.deps.downloadProfileImage as ReturnType<typeof vi.fn>;
    expect(downloader).toHaveBeenCalledTimes(2);
    expect(downloader).toHaveBeenNthCalledWith(1, TG_FILE_ID);
    expect(downloader).toHaveBeenNthCalledWith(2, SUPA_PATH);
  });
});
