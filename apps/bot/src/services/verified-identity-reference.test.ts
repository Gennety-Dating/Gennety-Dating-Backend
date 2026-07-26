import { describe, expect, it, vi } from "vitest";
import {
  resolveVerifiedIdentityReference,
  type VerifiedIdentityReferenceDeps,
  type VerifiedIdentityUser,
} from "./verified-identity-reference.js";

const VERIFIED_USER: VerifiedIdentityUser = {
  verificationStatus: "verified",
  verifiedSelfiePath: "user-1/selfie.jpg",
};

function makeDeps(): VerifiedIdentityReferenceDeps {
  return {
    downloadSelfie: vi.fn(async () => Buffer.from("stored")),
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
  });

  it("uses the retained storage copy when available", async () => {
    const deps = makeDeps();
    const result = await resolveVerifiedIdentityReference(VERIFIED_USER, deps);

    expect(result).toEqual({
      kind: "available",
      buffer: Buffer.from("stored"),
      source: "storage",
    });
  });

  it("reports reference_expired once the 90-day scrub cleared the path", async () => {
    // Distinct from `unavailable` on purpose: AWS cannot re-issue the selfie
    // (a liveness session dies after 3 minutes), so retrying is pointless and
    // callers must ask for a fresh liveness check instead.
    const deps = makeDeps();

    const result = await resolveVerifiedIdentityReference(
      { ...VERIFIED_USER, verifiedSelfiePath: null },
      deps,
    );

    expect(result).toEqual({ kind: "reference_expired" });
    expect(deps.downloadSelfie).not.toHaveBeenCalled();
  });

  it("fails closed when storage should have the object but doesn't return it", async () => {
    const deps = makeDeps();
    vi.mocked(deps.downloadSelfie).mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await resolveVerifiedIdentityReference(VERIFIED_USER, deps);

    expect(result).toEqual({ kind: "unavailable" });
  });
});
