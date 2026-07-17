import { describe, expect, it, vi } from "vitest";
import {
  resolveVerifiedIdentityReference,
  type VerifiedIdentityReferenceDeps,
  type VerifiedIdentityUser,
} from "./verified-identity-reference.js";

const VERIFIED_USER: VerifiedIdentityUser = {
  verificationStatus: "verified",
  verifiedSelfiePath: "user-1/selfie.jpg",
  personaInquiryId: "inq_1",
};

function makeDeps(): VerifiedIdentityReferenceDeps {
  return {
    downloadSelfie: vi.fn(async () => Buffer.from("stored")),
    fetchInquirySelfie: vi.fn(async () => ({
      ok: true as const,
      selfie: {
        buffer: Buffer.from("persona"),
        mime: "image/jpeg",
        verificationId: "ver_1",
      },
    })),
  };
}

describe("resolveVerifiedIdentityReference", () => {
  it("does not require a reference before verification", async () => {
    const deps = makeDeps();
    const result = await resolveVerifiedIdentityReference(
      { ...VERIFIED_USER, verificationStatus: "pending" },
      deps,
    );

    expect(result).toEqual({ kind: "not_required" });
    expect(deps.downloadSelfie).not.toHaveBeenCalled();
    expect(deps.fetchInquirySelfie).not.toHaveBeenCalled();
  });

  it("uses the retained storage copy when available", async () => {
    const deps = makeDeps();
    const result = await resolveVerifiedIdentityReference(VERIFIED_USER, deps);

    expect(result).toEqual({
      kind: "available",
      buffer: Buffer.from("stored"),
      source: "storage",
    });
    expect(deps.fetchInquirySelfie).not.toHaveBeenCalled();
  });

  it("re-fetches from Persona after the retained copy was scrubbed", async () => {
    const deps = makeDeps();
    vi.mocked(deps.downloadSelfie).mockResolvedValue(null);

    const result = await resolveVerifiedIdentityReference(VERIFIED_USER, deps);

    expect(result).toEqual({
      kind: "available",
      buffer: Buffer.from("persona"),
      source: "persona",
    });
    expect(deps.fetchInquirySelfie).toHaveBeenCalledWith("inq_1");
  });

  it("fails closed when neither retained nor Persona selfie is available", async () => {
    const deps = makeDeps();
    vi.mocked(deps.downloadSelfie).mockResolvedValue(null);
    vi.mocked(deps.fetchInquirySelfie).mockResolvedValue({
      ok: false,
      error: "api",
    });

    const result = await resolveVerifiedIdentityReference(VERIFIED_USER, deps);

    expect(result).toEqual({ kind: "unavailable" });
  });
});
