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
};

interface Harness {
  user: PipelineUserRow;
  persisted: PersistOutcomeInput[];
  notifications: Array<{ telegramId: bigint; message: string }>;
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
    personaInquiryId: null,
    faceMatchedAt: null,
    profile: { photos: [PHOTO_PATH_A, PHOTO_PATH_B] },
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

  const deps: PipelineDeps = {
    fetchInquirySelfie: vi.fn(async () => selfie),
    uploadSelfie: vi.fn(async (uid: string, _buf, _mime) => {
      if (overrides.uploadFails) throw new Error("upload failed");
      return { path: `${uid}/selfie-stored.jpg` };
    }),
    downloadProfilePhoto: vi.fn(async (path: string) => photoBuffers[path] ?? null),
    compareFaces: vi.fn(async () => {
      const r = compareScores[compareIndex++];
      if (!r) throw new Error("compareFaces called more times than expected");
      return r;
    }),
    notify: vi.fn(async (telegramId: bigint, message: string) => {
      notifications.push({ telegramId, message });
    }),
    db: {
      findUser: vi.fn(async () => user),
      persistOutcome: vi.fn(async (input: PersistOutcomeInput) => {
        persisted.push(input);
      }),
    },
  };

  return { user, persisted, notifications, deps };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("runFaceMatchVerification — happy path", () => {
  it("verifies when all photos clear the verify threshold", async () => {
    const h = makeHarness();
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("verified");
    if (outcome.kind !== "verified") return;
    expect(outcome.minScore).toBeCloseTo(0.88, 5);
    expect(outcome.scores).toEqual([0.92, 0.88]);

    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0]).toMatchObject({
      verificationStatus: "verified",
      shouldActivate: true,
      verifiedSelfiePath: "user-1/selfie-stored.jpg",
      photoFaceScores: [0.92, 0.88],
    });
    expect(h.persisted[0]!.faceMatchScore).toBeCloseTo(0.88, 5);

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]!.message).toContain("Verification complete");
  });

  it("counts the MIN score across photos (one weak photo blocks verification)", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.95, faceFound: true },
        { ok: true, similarity: 0.78, faceFound: true }, // borderline
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    if (outcome.kind !== "pending_review") return;
    expect(outcome.reason).toBe("borderline_score");
    expect(outcome.minScore).toBeCloseTo(0.78, 5);
  });
});

describe("runFaceMatchVerification — decision boundaries", () => {
  it("pending_review for borderline scores in [REVIEW, VERIFY)", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.8, faceFound: true },
        { ok: true, similarity: 0.84, faceFound: true },
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("pending_review");
    expect(h.persisted[0]!.verificationStatus).toBe("pending_review");
    expect(h.persisted[0]!.shouldActivate).toBe(false);
    expect(h.notifications[0]!.message).toContain("double-checking");
  });

  it("rejected when minScore < REVIEW threshold", async () => {
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
    expect(h.notifications[0]!.message).toContain("don't appear to match");
  });

  it("rejected when a photo has no face (similarity=0 → below floor)", async () => {
    const h = makeHarness({
      compareScores: [
        { ok: true, similarity: 0.9, faceFound: true },
        { ok: true, similarity: 0, faceFound: false }, // photo without a face
      ],
    });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.scores).toEqual([0.9, 0]);
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
    const h = makeHarness({ user: { profile: { photos: [] } } });
    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({
      kind: "pending_review",
      userId: USER_ID,
      reason: "no_profile_photos",
    });
    expect(h.deps.fetchInquirySelfie).not.toHaveBeenCalled();
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
        personaInquiryId: INQUIRY_ID,
        faceMatchedAt: new Date("2026-04-29T10:00:00Z"),
      },
    });

    const outcome = await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);

    expect(outcome).toEqual({ kind: "skipped_idempotent", userId: USER_ID });
    expect(h.deps.fetchInquirySelfie).not.toHaveBeenCalled();
    expect(h.persisted).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
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
});

describe("runFaceMatchVerification — DM behavior", () => {
  it("does not DM when telegramId is non-positive (mobile-only user)", async () => {
    const h = makeHarness({ user: { telegramId: -1n } });
    await runFaceMatchVerification(USER_ID, INQUIRY_ID, h.deps, CONFIG);
    expect(h.notifications).toHaveLength(0);
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
});
