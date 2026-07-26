import { downloadSelfie } from "./storage.js";

export interface VerifiedIdentityUser {
  verificationStatus: string;
  verifiedSelfiePath: string | null;
}

export type VerifiedIdentityReferenceResult =
  /** User isn't verified — there is nothing to enforce yet. */
  | { kind: "not_required" }
  | { kind: "available"; buffer: Buffer; source: "storage" }
  /**
   * The 90-day retention scrub already deleted the reference selfie. Distinct
   * from `unavailable`: nothing is broken and retrying won't help — the user
   * needs to run one more liveness check. Callers surface that, rather than a
   * generic error.
   */
  | { kind: "reference_expired" }
  /** Storage should have the object but didn't return it. Transient. */
  | { kind: "unavailable" };

export interface VerifiedIdentityReferenceDeps {
  downloadSelfie: typeof downloadSelfie;
}

const LOG_PREFIX = "[verified-identity-reference]";

/**
 * Resolve the authoritative selfie used to gate a new profile photo.
 *
 * Under Persona this had a second arm: if our stored copy was gone we
 * re-fetched the selfie from the provider for that one comparison. AWS Face
 * Liveness has no such arm — a session and its reference image expire three
 * minutes after creation — so our own storage is the only source, and the
 * retention scrub genuinely ends the reference's life.
 *
 * Still fail-closed: a verified user's photo is never published without an
 * authoritative reference to check it against.
 */
export async function resolveVerifiedIdentityReference(
  user: VerifiedIdentityUser,
  deps: VerifiedIdentityReferenceDeps = { downloadSelfie },
): Promise<VerifiedIdentityReferenceResult> {
  if (user.verificationStatus !== "verified") {
    return { kind: "not_required" };
  }

  if (!user.verifiedSelfiePath) {
    return { kind: "reference_expired" };
  }

  const stored = await deps.downloadSelfie(user.verifiedSelfiePath);
  if (stored) {
    return { kind: "available", buffer: stored, source: "storage" };
  }

  console.warn(`${LOG_PREFIX} stored selfie unavailable`, {
    path: user.verifiedSelfiePath,
  });
  return { kind: "unavailable" };
}
