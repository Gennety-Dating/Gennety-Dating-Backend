import { describe, expect, it, vi } from "vitest";
import {
  applyAetherProfilePatch,
  attachAetherProfilePhoto,
} from "./aether-profile-tools.js";

describe("Aether profile tools", () => {
  it("does not change fixed age after onboarding", async () => {
    const updateUser = vi.fn();
    const result = await applyAetherProfilePatch(
      "user-1",
      { age: 27, hobbies: ["climbing"] },
      {
        findUser: vi.fn().mockResolvedValue({ onboardingStep: "completed" }),
        updateUser,
        upsertProfile: vi.fn().mockResolvedValue(undefined),
      },
    );

    expect(result.ok).toBe(true);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("rejects a chat image when the single-face gate fails", async () => {
    const result = await attachAetherProfilePhoto(
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
});
