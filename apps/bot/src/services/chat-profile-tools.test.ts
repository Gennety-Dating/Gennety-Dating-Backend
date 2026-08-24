import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyChatProfilePatch,
  attachChatProfilePhoto,
} from "./chat-profile-tools.js";
import { env } from "../config.js";

const mutableValidationEnv = env as unknown as {
  PROFILE_MEDIA_VALIDATION_ENABLED: boolean;
  PROFILE_MEDIA_VALIDATION_FAIL_OPEN: boolean;
};

afterEach(() => {
  mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = false;
  mutableValidationEnv.PROFILE_MEDIA_VALIDATION_FAIL_OPEN = false;
});

describe("chat agent profile tools", () => {
  it("does not change fixed age after onboarding", async () => {
    const updateUser = vi.fn();
    const result = await applyChatProfilePatch(
      "user-1",
      { age: 27, hobbies: ["climbing"] },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser,
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.ok).toBe(true);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses to change gender after onboarding — it is an authorization input", async () => {
    // `User.gender` decides who may pay for both Date Tickets and who gets the
    // female-exclusive express venue swap, so a chat message that flips it
    // would hand the sender another cohort's entitlements.
    const updateUser = vi.fn();
    const result = await applyChatProfilePatch(
      "user-1",
      { gender: "female" },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser,
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.ok).toBe(true);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("still records gender during onboarding, where it is genuinely being collected", async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const result = await applyChatProfilePatch(
      "user-1",
      { gender: "female" },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "conversational" }),
        updateUser,
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.ok).toBe(true);
    expect(updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ gender: "female" }),
    );
  });

  it("keeps partner preference editable after onboarding — it is a choice, not identity", async () => {
    const updateUser = vi.fn().mockResolvedValue(undefined);
    const result = await applyChatProfilePatch(
      "user-1",
      { preference: "both" },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser,
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.ok).toBe(true);
    expect(updateUser).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ preference: "both" }),
    );
  });

  it("refreshes matching data immediately after an embedding-feeding edit", async () => {
    const refreshEmbedding = vi.fn().mockResolvedValue(undefined);
    const result = await applyChatProfilePatch(
      "user-1",
      { partnerPreferences: "kind and curious" },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser: vi.fn(),
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding,
      },
    );

    expect(result.ok).toBe(true);
    expect(refreshEmbedding).toHaveBeenCalledWith("user-1");
  });

  it("keeps a saved profile edit successful when immediate refresh fails", async () => {
    const result = await applyChatProfilePatch(
      "user-1",
      { hobbies: ["climbing"] },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser: vi.fn(),
        upsertProfile: vi.fn().mockResolvedValue(undefined),
        refreshEmbedding: vi.fn().mockRejectedValue(new Error("OpenAI down")),
      },
    );

    expect(result).toEqual({ ok: true });
  });

  it("enforces the shared partner-preferences length contract", async () => {
    const upsertProfile = vi.fn();
    const result = await applyChatProfilePatch(
      "user-1",
      { partnerPreferences: "x".repeat(501) },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser: vi.fn(),
        upsertProfile,
        refreshEmbedding: vi.fn(),
      },
    );

    expect(result.ok).toBe(false);
    expect(upsertProfile).not.toHaveBeenCalled();
  });

  it("rejects a chat image when the single-face gate fails", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = false;
    const result = await attachChatProfilePhoto(
      "user-1",
      { imageUrl: "user-1/chat.jpg" },
      {
        findOwnedMessageImage: vi.fn().mockResolvedValue({ imageUrl: "user-1/chat.jpg" }),
        downloadChatImage: vi.fn().mockResolvedValue(Buffer.from("image")),
        validateSingleFace: vi.fn().mockResolvedValue({ ok: true, valid: false }),
        gateProfilePhoto: vi.fn(),
        findProfile: vi.fn(),
        uploadProfilePhoto: vi.fn(),
        upsertProfile: vi.fn(),
        deleteStorageObject: vi.fn(),
        queueVerificationRerun: vi.fn(),
      },
    );

    expect(result).toEqual({ ok: false, detail: "Photo must contain exactly one clear face" });
  });

  it("uses the unified identity gate when media validation is enabled", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_FAIL_OPEN = false;
    const validateProfilePhoto = vi.fn().mockResolvedValue({
      ok: false,
      reason: "identity_mismatch",
      retryable: false,
    });

    const result = await attachChatProfilePhoto(
      "user-1",
      { imageUrl: "user-1/chat.jpg" },
      {
        findOwnedMessageImage: vi.fn().mockResolvedValue({ imageUrl: "user-1/chat.jpg" }),
        downloadChatImage: vi.fn().mockResolvedValue(Buffer.from("image")),
        validateSingleFace: vi.fn(),
        gateProfilePhoto: vi.fn(),
        validateProfilePhoto,
        findProfile: vi.fn().mockResolvedValue({
          photos: ["user-1/existing.jpg"],
          profileMedia: [],
          photoFaceScores: [0.9],
        }),
        uploadProfilePhoto: vi.fn(),
        upsertProfile: vi.fn(),
        deleteStorageObject: vi.fn(),
        queueVerificationRerun: vi.fn(),
      },
    );

    expect(validateProfilePhoto).toHaveBeenCalledWith({
      userId: "user-1",
      candidate: Buffer.from("image"),
      mime: "image/jpeg",
      existingPhotoRefs: ["user-1/existing.jpg"],
      existingPhotoHashes: [],
    });
    expect(result).toEqual({
      ok: false,
      detail: "All photos must belong to the same person",
    });
  });

  it("routes a validated chat image through consensus before attaching it", async () => {
    mutableValidationEnv.PROFILE_MEDIA_VALIDATION_ENABLED = true;
    const commitProfilePhotoCandidate = vi.fn().mockResolvedValue({
      status: "pending",
      photos: [],
      profileMedia: [],
      uploadedPhotoHashes: [],
      photoFaceScores: [],
      pendingCandidates: [],
      acceptedCount: 0,
      pendingCount: 1,
      rejectedCount: 0,
      rejectedCandidates: [],
    });
    const upsertProfile = vi.fn();

    const result = await attachChatProfilePhoto(
      "user-1",
      { imageUrl: "user-1/chat.jpg" },
      {
        findOwnedMessageImage: vi.fn().mockResolvedValue({ imageUrl: "user-1/chat.jpg" }),
        downloadChatImage: vi.fn().mockResolvedValue(Buffer.from("image")),
        validateSingleFace: vi.fn(),
        gateProfilePhoto: vi.fn(),
        validateProfilePhoto: vi.fn().mockResolvedValue({
          ok: true,
          value: {
            fingerprint: { sha256: "sha", differenceHash: "abc" },
            identitySimilarity: null,
          },
        }),
        findProfile: vi.fn().mockResolvedValue({
          photos: [],
          profileMedia: [],
          photoFaceScores: [],
          uploadedPhotoHashes: [],
        }),
        uploadProfilePhoto: vi.fn().mockResolvedValue({ path: "user-1/profile.jpg" }),
        commitProfilePhotoCandidate,
        upsertProfile,
        deleteStorageObject: vi.fn(),
        queueVerificationRerun: vi.fn(),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      detail: expect.stringContaining("identity is not fixed yet"),
    });
    expect(commitProfilePhotoCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        photoRef: "user-1/profile.jpg",
        perceptualHash: "abc",
        source: "mobile_chat",
      }),
    );
    expect(upsertProfile).not.toHaveBeenCalled();
  });
});
