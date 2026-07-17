import { describe, expect, it } from "vitest";
import {
  hasTrackVerifiedContact,
  unresolvedTrackContactGate,
} from "./contact-verification.js";

describe("track-aware contact verification", () => {
  it("requires email for student and legacy users even when a phone exists", () => {
    const phoneOnly = { phoneVerifiedAt: new Date(), isEmailVerified: false, email: null };
    expect(hasTrackVerifiedContact({ ...phoneOnly, registrationTrack: "student" })).toBe(false);
    expect(hasTrackVerifiedContact({ ...phoneOnly, registrationTrack: null })).toBe(false);
    expect(unresolvedTrackContactGate({ ...phoneOnly, registrationTrack: "student" })).toBe(
      "email-required",
    );
  });

  it("requires a phone for general users even when an email exists", () => {
    const emailOnly = {
      registrationTrack: "general",
      email: "student@stanford.edu",
      isEmailVerified: true,
      phoneVerifiedAt: null,
    };
    expect(hasTrackVerifiedContact(emailOnly)).toBe(false);
    expect(unresolvedTrackContactGate(emailOnly)).toBe("phone-required");
  });

  it("accepts only the credential assigned to the selected track", () => {
    expect(
      hasTrackVerifiedContact({
        registrationTrack: "student",
        email: "student@stanford.edu",
        isEmailVerified: true,
      }),
    ).toBe(true);
    expect(
      hasTrackVerifiedContact({ registrationTrack: "general", phoneVerifiedAt: new Date() }),
    ).toBe(true);
  });
});
